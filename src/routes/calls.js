const express = require("express");
const { query } = require("../db");
const {
  executeCall,
  normalizeDialNumber,
  fetchLiveCalls,
  canUseMqtt,
  canUseHttp,
  shortError,
} = require("../neronClient");

const router = express.Router();

async function getDevice(id) {
  const rows = await query("SELECT * FROM devices WHERE id = ?", [id]);
  return rows[0] || null;
}

async function getPrimaryDevice() {
  const rows = await query("SELECT * FROM devices ORDER BY id ASC LIMIT 1");
  return rows[0] || null;
}

function validateCallBody(body) {
  const type = body.type || "extnCall";
  const allowed = ["extnCall", "numCall", "ivrCall"];
  if (!allowed.includes(type)) {
    return "type must be extnCall, numCall, or ivrCall";
  }
  if (type === "extnCall" && (!body.extension || !body.caller_id_number)) {
    return "extension and caller_id_number are required for extnCall";
  }
  if (type === "numCall" && (!body.caller_id_number || !body.callee_id_number)) {
    return "caller_id_number and callee_id_number are required for numCall";
  }
  if (type === "ivrCall" && (!body.extension || !body.caller_id_number || !body.ivr)) {
    return "extension, caller_id_number, and ivr are required for ivrCall";
  }
  return null;
}

function isCloudAgentMode(device) {
  return (
    device &&
    (device.integration_mode === "cloud" || device.api_type === "agent")
  );
}

function shouldDispatchNow(device) {
  if (!device || device.api_enabled === 0) return false;
  // Hostinger/cloud cannot reach office LAN MQTT — LAN agent polls /api/jobs
  if (isCloudAgentMode(device)) return false;
  return canUseMqtt(device) || canUseHttp(device);
}

async function dispatchIfReachable(device, callRow) {
  if (!shouldDispatchNow(device)) {
    return callRow;
  }

  await query("UPDATE calls SET status = 'dispatching' WHERE id = ?", [
    callRow.id,
  ]);

  try {
    const result = await executeCall(device, {
      ...callRow,
      gateway: callRow.gateway || device.default_gateway,
      dialer_mode: callRow.dialer_mode || "auto_answer",
      caller_id_number: normalizeDialNumber(callRow.caller_id_number),
      callee_id_number: callRow.callee_id_number
        ? normalizeDialNumber(callRow.callee_id_number)
        : null,
    });
    const status = result.success ? "success" : "failed";
    await query(
      `UPDATE calls
       SET status = ?, uuid = ?, message = ?, raw_response = ?,
           caller_id_number = COALESCE(?, caller_id_number)
       WHERE id = ?`,
      [
        status,
        result.uuid,
        result.message,
        JSON.stringify(result.raw),
        result.dialed_number || normalizeDialNumber(callRow.caller_id_number),
        callRow.id,
      ]
    );
  } catch (err) {
    await query(
      `UPDATE calls
       SET status = 'failed', message = ?
       WHERE id = ?`,
      [shortError(err.message), callRow.id]
    );
  }

  const rows = await query("SELECT * FROM calls WHERE id = ?", [callRow.id]);
  return rows[0];
}

router.get("/", async (req, res, next) => {
  try {
    const params = [];
    let sql = `
      SELECT c.*, d.name AS device_name, d.model
      FROM calls c
      JOIN devices d ON d.id = c.device_id
    `;
    if (req.query.device_id) {
      sql += " WHERE c.device_id = ?";
      params.push(req.query.device_id);
    }
    sql += " ORDER BY c.id DESC LIMIT 200";
    const rows = await query(sql, params);
    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/live", async (req, res, next) => {
  try {
    const device = await getPrimaryDevice();
    if (!device) {
      return res.status(404).json({
        status: "error",
        message: "No Neron device configured",
      });
    }

    const recent = await query(
      `SELECT * FROM calls
       WHERE type != 'hangup'
       ORDER BY id DESC
       LIMIT 10`
    );

    let live = [];
    let liveError = null;
    try {
      const result = await fetchLiveCalls(device);
      const raw = result.json?.livecall || result.json?.message || result.json;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      live = list.filter((item) => {
        if (!item || typeof item !== "object") return false;
        if (item.event && !item.caller && !item.called && !item.callid) {
          return false;
        }
        const state = String(
          item.state || item.callstate || item.status || ""
        ).toLowerCase();
        // Only hide clearly ended channels
        if (
          state.includes("idle") ||
          state.includes("hangup") ||
          state.includes("down") ||
          state.includes("destroy") ||
          state === "offline"
        ) {
          return false;
        }
        return Boolean(
          item.callid ||
            item.uuid ||
            item.caller ||
            item.called ||
            item.cid_num ||
            item.dest
        );
      });
      if (!result.ok && result.error) {
        liveError = result.error;
      }
    } catch (err) {
      liveError = err.message;
    }

    res.json({
      status: "success",
      data: {
        live,
        recent,
        live_error: liveError,
        device: {
          id: device.id,
          host: device.mqtt_host || device.base_url,
          status: device.status,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM calls WHERE id = ?", [req.params.id]);
    if (!rows[0]) {
      return res.status(404).json({ status: "error", message: "Call not found" });
    }
    res.json({ status: "success", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const error = validateCallBody(body);
    if (error) {
      return res.status(400).json({ status: "error", message: error });
    }

    let deviceId = body.device_id;
    if (!deviceId) {
      const devices = await query("SELECT id FROM devices ORDER BY id ASC LIMIT 1");
      deviceId = devices[0]?.id;
    }
    const device = await getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    if (device.api_enabled === 0) {
      return res.status(400).json({
        status: "error",
        message: "Neron API is disabled in API Manager settings",
      });
    }

    const dialerMode = "auto_answer";
    const extension = body.extension || req.user?.extension || null;
    const dialNumber = normalizeDialNumber(body.caller_id_number);
    if (!dialNumber || dialNumber.replace(/\D/g, "").length < 10) {
      return res.status(400).json({
        status: "error",
        message: "Enter a valid 10-digit mobile number",
      });
    }

    if (!canUseMqtt(device) && !canUseHttp(device)) {
      return res.status(400).json({
        status: "error",
        message:
          "Neron MQTT not ready. In API integration set Host (192.168.0.180), Port 1883, Username, Password, Client ID, Token, then Save and Test Neron 20.",
      });
    }

    const modeLabel = "Auto-answer extension, then ring mobile";

    const result = await query(
      `INSERT INTO calls
        (device_id, user_id, type, extension, caller_id_number, callee_id_number,
         gateway, ivr, dialer_mode, status, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [
        device.id,
        req.user?.id || null,
        body.type || "extnCall",
        extension,
        dialNumber,
        body.callee_id_number
          ? normalizeDialNumber(body.callee_id_number)
          : null,
        body.gateway || device.default_gateway || null,
        body.ivr || null,
        dialerMode,
        `Placing call: ext ${extension} → ${dialNumber} (${modeLabel})`,
      ]
    );

    const created = await query("SELECT * FROM calls WHERE id = ?", [
      result.insertId,
    ]);
    const dispatched = await dispatchIfReachable(device, created[0]);
    if (isCloudAgentMode(device) && dispatched.status === "queued") {
      dispatched.message = `${dispatched.message} — waiting for office LAN agent`;
    }
    res.status(201).json({ status: "success", data: dispatched });
  } catch (err) {
    next(err);
  }
});

router.post("/hangup-live", async (req, res, next) => {
  try {
    const callid = String(req.body?.callid || req.body?.uuid || "").trim();
    if (!callid) {
      return res.status(400).json({
        status: "error",
        message: "callid is required",
      });
    }
    const device = await getPrimaryDevice();
    if (!device) {
      return res.status(404).json({
        status: "error",
        message: "No Neron device configured",
      });
    }

    if (isCloudAgentMode(device)) {
      const job = await query(
        `INSERT INTO calls
          (device_id, user_id, type, uuid, dialer_mode, status, message)
         VALUES (?, ?, 'hangup', ?, 'auto_answer', 'queued', ?)`,
        [
          device.id,
          req.user?.id || null,
          callid,
          `Hangup queued for LAN agent (callid ${callid})`,
        ]
      );
      const rows = await query("SELECT * FROM calls WHERE id = ?", [
        job.insertId,
      ]);
      return res.json({
        status: "success",
        data: {
          status: "queued",
          message: rows[0].message,
          uuid: callid,
          job_id: rows[0].id,
        },
      });
    }

    const result = await executeCall(device, {
      type: "hangup",
      uuid: callid,
    });

    // Mark matching DB calls as hung up
    await query(
      `UPDATE calls
       SET status = 'hungup', message = 'Call disconnected', uuid = COALESCE(uuid, ?)
       WHERE uuid = ? OR (status IN ('success', 'dispatching', 'queued') AND type != 'hangup')`,
      [callid, callid]
    );

    res.json({
      status: "success",
      data: {
        status: "hungup",
        message: result.message || "Call disconnected",
        uuid: callid,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/hangup", async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM calls WHERE id = ?", [req.params.id]);
    const original = rows[0];
    if (!original) {
      return res.status(404).json({ status: "error", message: "Call not found" });
    }

    let uuid = req.body?.uuid || req.body?.callid || original.uuid;
    const device = await getDevice(original.device_id);
    let liveList = [];

    try {
      const live = await fetchLiveCalls(device);
      liveList = Array.isArray(live.json?.livecall)
        ? live.json.livecall
        : Array.isArray(live.json?.message)
          ? live.json.message
          : [];
    } catch {
      liveList = [];
    }

    if (!uuid) {
      const match = liveList.find((item) => {
        const dest = String(item.called || item.dest || item.callee || "");
        const caller = String(item.caller || item.cid_num || "");
        const num = String(original.caller_id_number || "");
        return (
          caller === String(original.extension) ||
          dest.includes(num) ||
          dest.includes(num.replace(/^0/, "")) ||
          num.includes(dest.replace(/\D/g, ""))
        );
      });
      uuid = match?.callid || match?.uuid || liveList[0]?.callid || liveList[0]?.uuid || null;
      if (uuid) {
        await query("UPDATE calls SET uuid = ? WHERE id = ?", [
          String(uuid),
          original.id,
        ]);
      }
    }

    // Hang up every matching live channel for this extension/number
    const targets = new Set();
    if (uuid) targets.add(String(uuid));
    liveList.forEach((item) => {
      const dest = String(item.called || item.dest || "");
      const caller = String(item.caller || item.cid_num || "");
      const num = String(original.caller_id_number || "");
      if (
        caller === String(original.extension) ||
        dest.includes(num) ||
        dest.includes(num.replace(/^0/, ""))
      ) {
        if (item.callid || item.uuid) {
          targets.add(String(item.callid || item.uuid));
        }
      }
    });

    if (targets.size === 0) {
      await query(
        `UPDATE calls SET status = 'hungup', message = 'Call already ended / no live channel' WHERE id = ?`,
        [original.id]
      );
      return res.json({
        status: "success",
        data: {
          status: "hungup",
          message: "No live channel found. Marked disconnected.",
          original_call: (
            await query("SELECT * FROM calls WHERE id = ?", [original.id])
          )[0],
        },
      });
    }

    let lastResult = null;
    for (const callid of targets) {
      const insert = await query(
        `INSERT INTO calls (device_id, type, uuid, status, message)
         VALUES (?, 'hangup', ?, 'queued', ?)`,
        [original.device_id, callid, "Hangup requested"]
      );
      const hangup = await query("SELECT * FROM calls WHERE id = ?", [
        insert.insertId,
      ]);
      lastResult = await dispatchIfReachable(device, hangup[0]);
    }

    await query(
      `UPDATE calls
       SET status = 'hungup',
           message = 'Call disconnected',
           uuid = COALESCE(uuid, ?)
       WHERE id = ?`,
      [String([...targets][0]), original.id]
    );

    const updated = await query("SELECT * FROM calls WHERE id = ?", [
      original.id,
    ]);

    res.status(201).json({
      status: "success",
      data: {
        ...(lastResult || {}),
        status: "hungup",
        message: "Call disconnected",
        hung_up_ids: [...targets],
        original_call: updated[0],
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
