const express = require("express");
const rateLimit = require("express-rate-limit");
const { query } = require("../db");
const config = require("../config");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { encryptSecret, decryptSecret, maskToken } = require("../security/secrets");
const { normalizePhoneNumber } = require("../utils/phone");
const {
  adapter,
  sendDeviceCommand,
  publishCommand,
  health: mqttHealth,
  subscribeAll,
  releaseExtension,
  setExtensionStatus,
} = require("../mqtt/brokerService");
const { liveBus } = require("../realtime/liveBus");

const router = express.Router();

const ACTIVE_CALL_STATUSES = [
  "requested",
  "published",
  "acknowledged",
  "extension_ringing",
  "customer_dialling",
  "customer_ringing",
  "answered",
];

function isBusyExtensionError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("not idle") ||
    msg.includes("in use") ||
    msg.includes("inuse") ||
    msg.includes("busy")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const clickLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.clickToCallRateLimitPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many call attempts. Slow down." },
});

async function audit(action, { deviceId, userId, detail }) {
  await query(
    `INSERT INTO pbx_audit_log (pbx_device_id, crm_user_id, action, detail_json)
     VALUES (?, ?, ?, ?)`,
    [deviceId || null, userId || null, action, detail ? JSON.stringify(detail) : null]
  );
}

function publicDevice(row) {
  if (!row) return null;
  const token = decryptSecret(row.mqtt_token_enc || row.mqtt_token);
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    serial: row.serial,
    location: row.location,
    firmware_version: row.firmware_version,
    integration_mode: row.integration_mode,
    api_type: row.api_type,
    api_enabled: row.api_enabled,
    status: row.status,
    connection_status: row.connection_status || row.status,
    last_seen_at: row.last_seen_at,
    default_gateway: row.default_gateway,
    mqtt_client_id: row.mqtt_client_id,
    mqtt_host: row.mqtt_host,
    mqtt_port: row.mqtt_port,
    token_masked: maskToken(token),
    has_token: Boolean(token),
    organization_id: row.organization_id || 1,
  };
}

async function getDevice(id) {
  const rows = await query("SELECT * FROM devices WHERE id = ?", [id]);
  return rows[0] || null;
}

async function getPrimaryBrokerDevice() {
  const rows = await query(
    `SELECT * FROM devices
     WHERE api_enabled = 1 AND (integration_mode = 'broker' OR api_type = 'broker')
     ORDER BY id ASC LIMIT 1`
  );
  if (rows[0]) return rows[0];
  const any = await query("SELECT * FROM devices ORDER BY id ASC LIMIT 1");
  return any[0] || null;
}

function deviceOnline(device) {
  if (!device?.last_seen_at) return false;
  const age = Date.now() - new Date(device.last_seen_at).getTime();
  return age <= config.deviceOnlineTimeoutSec * 1000;
}

function deviceReadyForDial(device) {
  // Neron may stay connected to the broker without publishing events.
  // last_seen_at alone is too strict — allow dial when token exists and CRM MQTT is up.
  if (!device) return false;
  if (device.api_enabled === 0) return false;
  const token = device.mqtt_token || device.mqtt_token_enc;
  return Boolean(token);
}

// SSE live stream
router.get("/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  liveBus.add(res, { userId: req.user.id, role: req.user.role });
});

router.get("/mqtt/health", requireAuth, (req, res) => {
  res.json({ status: "success", data: mqttHealth() });
});

router.get("/extensions", requireAuth, async (req, res, next) => {
  try {
    const device = await getPrimaryBrokerDevice();
    if (!device) {
      return res.json({ status: "success", data: [] });
    }
    const rows = await query(
      `SELECT e.*,
              (SELECT c.call_status FROM pbx_calls c
               WHERE c.extension_number = e.extension_number
                 AND c.call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})
               ORDER BY c.id DESC LIMIT 1) AS active_call_status,
              (SELECT c.customer_number FROM pbx_calls c
               WHERE c.extension_number = e.extension_number
                 AND c.call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})
               ORDER BY c.id DESC LIMIT 1) AS active_customer
       FROM pbx_extensions e
       WHERE e.pbx_device_id = ?
       ORDER BY e.extension_number ASC`,
      [...ACTIVE_CALL_STATUSES, ...ACTIVE_CALL_STATUSES, device.id]
    );
    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/extensions/:extension", requireAuth, async (req, res, next) => {
  try {
    const extension = String(req.params.extension || "").trim();
    const device = await getPrimaryBrokerDevice();
    if (!device) {
      return res.status(404).json({ status: "error", message: "No PBX device" });
    }
    let rows = await query(
      `SELECT * FROM pbx_extensions
       WHERE pbx_device_id = ? AND extension_number = ?
       LIMIT 1`,
      [device.id, extension]
    );
    const active = await query(
      `SELECT id, call_id, call_status, customer_number, started_at, answered_at
       FROM pbx_calls
       WHERE extension_number = ?
         AND call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})
       ORDER BY id DESC LIMIT 1`,
      [extension, ...ACTIVE_CALL_STATUSES]
    );
    let status = rows[0]?.current_status || "idle";
    if (active[0] && (!status || status === "idle" || status === "unknown")) {
      status = active[0].call_status === "answered" ? "inuse" : "ringing";
    }
    if (!rows[0]) {
      rows = [
        {
          pbx_device_id: device.id,
          extension_number: extension,
          current_status: status,
          last_status_at: null,
        },
      ];
    } else {
      rows[0].current_status = status;
    }
    res.json({
      status: "success",
      data: {
        ...rows[0],
        active_call: active[0] || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/extensions/:extension/release", requireAuth, async (req, res, next) => {
  try {
    const extension = String(req.params.extension || "").trim();
    const device = await getPrimaryBrokerDevice();
    if (!device) {
      return res.status(404).json({ status: "error", message: "No PBX device" });
    }
    if (!mqttHealth().connected) {
      return res.status(503).json({
        status: "error",
        message: "MQTT broker not connected on server",
      });
    }
    device._crmUserId = req.user.id;
    const result = await releaseExtension(device, extension);
    await audit("release_extension", {
      deviceId: device.id,
      userId: req.user.id,
      detail: result,
    });
    res.json({
      status: "success",
      data: result,
      message: `Extension ${extension} cleared`,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/devices", requireAuth, async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM devices ORDER BY id ASC");
    res.json({ status: "success", data: rows.map(publicDevice) });
  } catch (err) {
    next(err);
  }
});

router.get("/devices/:id/status", requireAuth, async (req, res, next) => {
  try {
    const device = await getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    res.json({
      status: "success",
      data: {
        ...publicDevice(device),
        online: deviceOnline(device),
        mqtt: mqttHealth(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/devices/:id/test", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const device = await getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    device._crmUserId = req.user.id;
    const result = await sendDeviceCommand(device, (requestId) =>
      adapter.getDeviceInfo(requestId)
    );
    await audit("test_connection", {
      deviceId: device.id,
      userId: req.user.id,
      detail: { requestId: result.requestId, ok: true },
    });
    res.json({
      status: "success",
      message: "deviceInfo OK",
      data: { requestId: result.requestId, response: result.response },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/devices/:id/sync", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const device = await getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    device._crmUserId = req.user.id;
    const ext = await sendDeviceCommand(device, (requestId) =>
      adapter.getExtensions(requestId)
    );
    let trunks = null;
    try {
      trunks = await sendDeviceCommand(device, (requestId) =>
        adapter.getTrunks(requestId)
      );
    } catch {
      trunks = { error: "trunk_list not supported or timed out" };
    }
    await subscribeAll();
    await audit("sync_device", { deviceId: device.id, userId: req.user.id });
    res.json({
      status: "success",
      data: { extensions: ext.response, trunks: trunks?.response || trunks },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/devices/:id/extensions", requireAuth, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT * FROM pbx_extensions WHERE pbx_device_id = ? ORDER BY extension_number`,
      [req.params.id]
    );
    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/devices/:id/trunks", requireAuth, async (req, res, next) => {
  try {
    const device = await getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    device._crmUserId = req.user.id;
    const result = await sendDeviceCommand(device, (requestId) =>
      adapter.getTrunks(requestId)
    );
    res.json({ status: "success", data: result.response });
  } catch (err) {
    next(err);
  }
});

router.put("/devices/:id/broker", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const device = await getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    const body = req.body || {};
    let tokenEnc = device.mqtt_token_enc;
    let tokenPlain = device.mqtt_token;
    if (body.device_token && body.device_token !== "********") {
      tokenPlain = String(body.device_token).trim();
      tokenEnc = encryptSecret(tokenPlain);
    }
    await query(
      `UPDATE devices SET
         name = ?, serial = ?, location = ?, default_gateway = ?,
         integration_mode = 'broker', api_type = 'broker', api_enabled = 1,
         mqtt_token = ?, mqtt_token_enc = ?, mqtt_client_id = ?,
         mqtt_username = COALESCE(?, mqtt_username),
         notes = ?
       WHERE id = ?`,
      [
        body.name || device.name,
        body.serial ?? device.serial,
        body.location ?? device.location,
        body.default_gateway ?? device.default_gateway,
        tokenPlain || device.mqtt_token,
        tokenEnc || device.mqtt_token_enc,
        body.mqtt_client_id || device.mqtt_client_id,
        body.mqtt_username || null,
        body.notes ?? device.notes,
        device.id,
      ]
    );
    await subscribeAll();
    const updated = await getDevice(device.id);
    await audit("configure_broker", { deviceId: device.id, userId: req.user.id });
    res.json({ status: "success", data: publicDevice(updated) });
  } catch (err) {
    next(err);
  }
});

router.get("/calls", requireAuth, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT * FROM pbx_calls ORDER BY id DESC LIMIT 200`
    );
    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/calls/:id", requireAuth, async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM pbx_calls WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows[0]) {
      return res.status(404).json({ status: "error", message: "Call not found" });
    }
    res.json({ status: "success", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/calls", requireAuth, clickLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const device = body.deviceId
      ? await getDevice(body.deviceId)
      : await getPrimaryBrokerDevice();
    if (!device) {
      return res.status(404).json({ status: "error", message: "No PBX device" });
    }
    if (device.integration_mode !== "broker" && device.api_type !== "broker") {
      return res.status(400).json({
        status: "error",
        message:
          "Device is not in broker mode. Set API integration mode to Broker (public MQTT).",
      });
    }
    if (!mqttHealth().connected) {
      return res.status(503).json({
        status: "error",
        message: "MQTT broker not connected on server. Check MQTT_BROKER_URL.",
      });
    }
    if (!deviceReadyForDial(device)) {
      return res.status(400).json({
        status: "error",
        message:
          "Device token missing or API disabled. Save Token in API integration (Broker mode).",
      });
    }

    const extension = String(body.extension || req.user.extension || "").trim();
    if (!extension) {
      return res.status(400).json({
        status: "error",
        message: "No extension mapped to your user",
      });
    }

    const phone = normalizePhoneNumber(body.phoneNumber || body.caller_id_number);
    if (!phone.ok) {
      return res.status(400).json({ status: "error", message: phone.error });
    }

    const requestId = adapter.newRequestId();
    const gateway = body.gateway || device.default_gateway || null;

    await query(
      `INSERT INTO pbx_call_requests
        (pbx_device_id, crm_user_id, contact_id, request_id, extension_number,
         customer_number, gateway, direction, command_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', 'extnCall', 'requested')`,
      [
        device.id,
        req.user.id,
        body.contactId || null,
        requestId,
        extension,
        phone.dial,
        gateway,
      ]
    );

    const legacy = await query(
      `INSERT INTO calls
        (device_id, user_id, type, extension, caller_id_number, gateway, dialer_mode, status, message)
       VALUES (?, ?, 'extnCall', ?, ?, ?, 'auto_answer', 'dispatching', ?)`,
      [
        device.id,
        req.user.id,
        extension,
        phone.dial,
        gateway,
        `Broker dial: ext ${extension} → ${phone.dial}`,
      ]
    );

    const callInsert = await query(
      `INSERT INTO pbx_calls
        (pbx_device_id, crm_user_id, contact_id, legacy_call_id, request_id,
         extension_number, customer_number, direction, call_status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', 'requested', NOW())`,
      [
        device.id,
        req.user.id,
        body.contactId || null,
        legacy.insertId,
        requestId,
        extension,
        phone.dial,
      ]
    );

    const built = adapter.initiateExtensionCall({
      requestId,
      extension,
      phoneNumber: phone.dial,
      gateway,
      autoAnswer: true,
    });

    device._crmUserId = req.user.id;
    await query(
      `UPDATE pbx_calls SET call_status = 'published' WHERE id = ?`,
      [callInsert.insertId]
    );

    // If CRM thinks the line is busy, clear stuck channels before dialing
    const extStatusRows = await query(
      `SELECT current_status FROM pbx_extensions
       WHERE pbx_device_id = ? AND extension_number = ? LIMIT 1`,
      [device.id, extension]
    );
    const extSt = String(extStatusRows[0]?.current_status || "").toLowerCase();
    if (
      body.forceRelease ||
      ["inuse", "in use", "busy", "ringing"].includes(extSt)
    ) {
      try {
        await releaseExtension(device, extension);
        await sleep(900);
      } catch {
        /* still attempt dial */
      }
    }

    let result;
    try {
      result = await publishCommand(device, built.topicSuffix, built.payload, {
        wait: true,
      });
    } catch (err) {
      if (isBusyExtensionError(err)) {
        try {
          await setExtensionStatus(device.id, extension, "inuse");
          await releaseExtension(device, extension);
          await sleep(1000);
          const retryRequestId = adapter.newRequestId();
          await query(
            `UPDATE pbx_calls SET request_id = ?, call_status = 'published', ended_at = NULL WHERE id = ?`,
            [retryRequestId, callInsert.insertId]
          );
          await query(
            `UPDATE pbx_call_requests SET request_id = ?, status = 'requested', error_message = NULL WHERE request_id = ?`,
            [retryRequestId, requestId]
          );
          result = await publishCommand(
            device,
            built.topicSuffix,
            { ...built.payload, request_id: retryRequestId },
            { wait: true }
          );
        } catch (retryErr) {
          await query(
            `UPDATE pbx_calls SET call_status = 'timed_out', ended_at = NOW() WHERE id = ?`,
            [callInsert.insertId]
          );
          await query(
            `UPDATE pbx_call_requests SET status = 'timed_out', error_message = ? WHERE request_id = ? OR request_id = ?`,
            [retryErr.message, requestId, requestId]
          );
          await query(`UPDATE calls SET status = 'failed', message = ? WHERE id = ?`, [
            retryErr.message,
            legacy.insertId,
          ]);
          throw retryErr;
        }
      } else {
        await query(
          `UPDATE pbx_calls SET call_status = 'timed_out', ended_at = NOW() WHERE id = ?`,
          [callInsert.insertId]
        );
        await query(
          `UPDATE pbx_call_requests SET status = 'timed_out', error_message = ? WHERE request_id = ?`,
          [err.message, requestId]
        );
        await query(`UPDATE calls SET status = 'failed', message = ? WHERE id = ?`, [
          err.message,
          legacy.insertId,
        ]);
        throw err;
      }
    }

    const callId = result.response?.callid || result.response?.uuid || null;
    await query(
      `UPDATE pbx_calls
       SET call_status = 'acknowledged', call_id = COALESCE(?, call_id)
       WHERE id = ?`,
      [callId, callInsert.insertId]
    );
    await query(
      `UPDATE pbx_call_requests SET status = 'acknowledged', acknowledged_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    await query(
      `UPDATE calls SET status = 'success', uuid = COALESCE(?, uuid), message = ? WHERE id = ?`,
      [callId, "Dial accepted by Neron (broker)", legacy.insertId]
    );

    await audit("click_to_call", {
      deviceId: device.id,
      userId: req.user.id,
      detail: { requestId, extension, phone: phone.dial },
    });

    const row = (
      await query("SELECT * FROM pbx_calls WHERE id = ?", [callInsert.insertId])
    )[0];
    liveBus.broadcast("pbx_call", { type: "created", data: row });
    res.status(201).json({
      status: "success",
      data: row,
      message:
        "Call command accepted by Neron. Live status will update from MQTT events.",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/calls/:id/hangup", requireAuth, async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM pbx_calls WHERE id = ?", [
      req.params.id,
    ]);
    const call = rows[0];
    if (!call) {
      return res.status(404).json({ status: "error", message: "Call not found" });
    }
    if (!call.call_id) {
      return res.status(400).json({
        status: "error",
        message: "No Neron call_id yet — cannot hang up",
      });
    }
    const device = await getDevice(call.pbx_device_id);
    device._crmUserId = req.user.id;
    const requestId = adapter.newRequestId();
    const built = adapter.hangupCall({ requestId, callId: call.call_id });
    await publishCommand(device, built.topicSuffix, built.payload, { wait: true });
    await query(
      `UPDATE pbx_calls SET call_status = 'hungup', ended_at = COALESCE(ended_at, NOW()) WHERE id = ?`,
      [call.id]
    );
    if (call.extension_number) {
      await setExtensionStatus(device.id, call.extension_number, "idle");
    }
    await audit("hangup", {
      deviceId: device.id,
      userId: req.user.id,
      detail: { callId: call.call_id },
    });
    const updated = (
      await query("SELECT * FROM pbx_calls WHERE id = ?", [call.id])
    )[0];
    liveBus.broadcast("pbx_call", { type: "hangup", data: updated });
    res.json({ status: "success", data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
