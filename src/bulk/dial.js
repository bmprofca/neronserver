const config = require("../config");
const { query } = require("../db");
const { normalizePhoneNumber } = require("../utils/phone");
const {
  adapter,
  publishCommand,
  health: mqttHealth,
  releaseExtension,
  setExtensionStatus,
} = require("../mqtt/brokerService");

const DIAL_ACK_TIMEOUT_MS =
  config.bulkDialAckTimeoutMs ||
  Number(process.env.DIAL_ACK_TIMEOUT_MS) ||
  12000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyExtensionError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("not idle") ||
    msg.includes("in use") ||
    msg.includes("inuse") ||
    msg.includes("busy")
  );
}

function isMqttTimeoutError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout");
}

function deviceReadyForDial(device) {
  const token =
    device.mqtt_token_enc || device.mqtt_token || device.deviceToken || "";
  return Boolean(token) && Number(device.api_enabled) !== 0;
}

async function getPrimaryBrokerDevice(appId) {
  if (appId) {
    const rows = await query(
      `SELECT * FROM devices
       WHERE app_id = ? AND api_enabled = 1
         AND (integration_mode = 'broker' OR api_type = 'broker')
       ORDER BY id ASC LIMIT 1`,
      [appId]
    );
    if (rows[0]) return rows[0];
    const any = await query(
      "SELECT * FROM devices WHERE app_id = ? ORDER BY id ASC LIMIT 1",
      [appId]
    );
    if (any[0]) return any[0];
  }
  const rows = await query(
    `SELECT * FROM devices
     WHERE api_enabled = 1 AND (integration_mode = 'broker' OR api_type = 'broker')
     ORDER BY id ASC LIMIT 1`
  );
  return rows[0] || null;
}

/**
 * Clear any live PBX channel on the extension (livecall + hangup).
 * fast:true skips livecall and leaves Neron "not idle".
 */
async function clearExtensionLine(device, extension, excludeCallIds = []) {
  try {
    await releaseExtension(device, extension, {
      quick: true,
      excludeCallIds,
      liveTimeoutMs: 2000,
    });
  } catch {
    /* still attempt dial */
  }
  await sleep(250);
}

/**
 * Place one outbound auto-answer click-to-call (optionally with playfile/playtext).
 * Always clears the desk line first — bulk campaigns leave FXO/SIP channels Up.
 */
async function placeBulkDial({
  appId,
  extension,
  phoneNumber,
  actorId = null,
  gateway = null,
  autoAnswer = true,
  playFile = null,
  playText = null,
  forceRelease = true,
}) {
  const device = await getPrimaryBrokerDevice(appId);
  if (!device) throw new Error("No PBX device");
  if (device.integration_mode !== "broker" && device.api_type !== "broker") {
    throw new Error("Device is not in broker mode");
  }
  if (!mqttHealth().connected) {
    throw new Error("MQTT broker not connected");
  }
  if (!deviceReadyForDial(device)) {
    throw new Error("Device token missing or API disabled");
  }

  const ext = String(extension || "").trim();
  if (!ext) throw new Error("Extension is required");

  const phone = normalizePhoneNumber(phoneNumber);
  if (!phone.ok) throw new Error(phone.error);

  let crmUserId = actorId;
  if (!crmUserId) {
    const mapped = await query(
      `SELECT id FROM users
       WHERE extension = ? AND status = 'active' AND (app_id = ? OR app_id IS NULL)
       ORDER BY id ASC LIMIT 1`,
      [ext, appId]
    );
    if (mapped[0]) crmUserId = mapped[0].id;
  }
  device._crmUserId = crmUserId;

  // Bulk must always clear the live channel — CRM "idle" is not enough.
  if (forceRelease !== false) {
    await clearExtensionLine(device, ext);
  } else {
    const extStatusRows = await query(
      `SELECT current_status FROM pbx_extensions
       WHERE pbx_device_id = ? AND extension_number = ? LIMIT 1`,
      [device.id, ext]
    );
    const extSt = String(extStatusRows[0]?.current_status || "").toLowerCase();
    if (["inuse", "in use", "busy", "ringing"].includes(extSt)) {
      await clearExtensionLine(device, ext);
    }
  }

  const requestId = adapter.newRequestId();
  const gw = gateway || device.default_gateway || null;

  await query(
    `INSERT INTO pbx_call_requests
      (pbx_device_id, crm_user_id, contact_id, request_id, extension_number,
       customer_number, gateway, direction, command_type, status)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'outbound', 'extnCall', 'requested')`,
    [device.id, crmUserId, requestId, ext, phone.dial, gw]
  );

  const legacy = await query(
    `INSERT INTO calls
      (device_id, user_id, type, extension, caller_id_number, gateway, dialer_mode, status, message)
     VALUES (?, ?, 'extnCall', ?, ?, ?, 'auto_answer', 'dispatching', ?)`,
    [
      device.id,
      crmUserId,
      ext,
      phone.dial,
      gw,
      `Bulk dial: ext ${ext} → ${phone.dial}`,
    ]
  );

  const callInsert = await query(
    `INSERT INTO pbx_calls
      (pbx_device_id, crm_user_id, contact_id, legacy_call_id, request_id,
       extension_number, customer_number, direction, call_status, started_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'outbound', 'requested', NOW())`,
    [device.id, crmUserId, legacy.insertId, requestId, ext, phone.dial]
  );

  const built = adapter.initiateExtensionCall({
    requestId,
    extension: ext,
    phoneNumber: phone.dial,
    gateway: gw,
    autoAnswer: autoAnswer !== false,
    playFile,
    playText,
  });

  await query(`UPDATE pbx_calls SET call_status = 'published' WHERE id = ?`, [
    callInsert.insertId,
  ]);

  async function markAck(result, usedRequestId) {
    const neronCallId =
      result?.response?.callid || result?.response?.uuid || null;
    await query(
      `UPDATE pbx_calls
       SET call_status = 'acknowledged', call_id = COALESCE(?, call_id)
       WHERE id = ?`,
      [neronCallId, callInsert.insertId]
    );
    await query(
      `UPDATE pbx_call_requests
       SET status = 'acknowledged', acknowledged_at = NOW()
       WHERE request_id = ?`,
      [usedRequestId]
    );
    await query(
      `UPDATE calls SET status = 'success', uuid = COALESCE(?, uuid), message = ? WHERE id = ?`,
      [
        neronCallId,
        result?.response
          ? "Bulk dial accepted by Neron"
          : "Bulk dial published (awaiting events)",
        legacy.insertId,
      ]
    );
    await setExtensionStatus(device.id, ext, "ringing");
    return neronCallId;
  }

  let publishResult;
  try {
    publishResult = await publishCommand(device, built.topicSuffix, built.payload, {
      wait: true,
      timeoutMs: DIAL_ACK_TIMEOUT_MS,
    });
    await markAck(publishResult, publishResult.requestId || requestId);
  } catch (err) {
    if (isBusyExtensionError(err)) {
      try {
        await setExtensionStatus(device.id, ext, "inuse");
        await clearExtensionLine(device, ext, [callInsert.insertId]);
        const retryRequestId = adapter.newRequestId();
        await query(
          `UPDATE pbx_calls SET request_id = ?, call_status = 'published', ended_at = NULL WHERE id = ?`,
          [retryRequestId, callInsert.insertId]
        );
        await query(
          `UPDATE pbx_call_requests SET request_id = ?, status = 'requested', error_message = NULL WHERE request_id = ?`,
          [retryRequestId, requestId]
        );
        publishResult = await publishCommand(
          device,
          built.topicSuffix,
          { ...built.payload, request_id: retryRequestId },
          { wait: true, timeoutMs: DIAL_ACK_TIMEOUT_MS }
        );
        await markAck(publishResult, publishResult.requestId || retryRequestId);
      } catch (retryErr) {
        if (!(isMqttTimeoutError(retryErr) && retryErr.published)) {
          await query(
            `UPDATE pbx_calls SET call_status = 'timed_out', ended_at = NOW() WHERE id = ?`,
            [callInsert.insertId]
          );
          throw retryErr;
        }
        // Soft-publish only — do not claim success without call_id.
        await query(
          `UPDATE pbx_calls SET call_status = 'published' WHERE id = ?`,
          [callInsert.insertId]
        );
      }
    } else if (!(isMqttTimeoutError(err) && err.published)) {
      await query(
        `UPDATE pbx_calls SET call_status = 'timed_out', ended_at = NOW() WHERE id = ?`,
        [callInsert.insertId]
      );
      throw err;
    } else {
      // MQTT ACK timed out but dial was published — keep row active.
      await query(
        `UPDATE pbx_calls SET call_status = 'published' WHERE id = ? AND call_status = 'published'`,
        [callInsert.insertId]
      );
    }
  }

  // Confirm Neron accepted the dial (call_id) before returning success to runner.
  let rows = await query(`SELECT call_id, call_status FROM pbx_calls WHERE id = ?`, [
    callInsert.insertId,
  ]);
  if (!rows[0]?.call_id) {
    for (let i = 0; i < 6 && !rows[0]?.call_id; i++) {
      await sleep(500);
      rows = await query(`SELECT call_id, call_status FROM pbx_calls WHERE id = ?`, [
        callInsert.insertId,
      ]);
    }
  }
  if (!rows[0]?.call_id) {
    await query(
      `UPDATE pbx_calls SET call_status = 'timed_out', ended_at = NOW() WHERE id = ?`,
      [callInsert.insertId]
    );
    throw new Error(
      `Bulk dial did not get PBX callid for ${phone.dial} (extension ${ext} may be busy)`
    );
  }

  return {
    callId: callInsert.insertId,
    neronCallId: rows[0].call_id,
    requestId: publishResult?.requestId || requestId,
    phone: phone.dial,
    extension: ext,
    device,
  };
}

const TERMINAL_CALL_STATUSES = new Set([
  "hungup",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "busy",
  "no_answer",
]);

const ACTIVE_TALK_STATUSES = new Set([
  "answered",
  "customer_ringing",
  "customer_dialling",
  "extension_ringing",
  "acknowledged",
  "published",
]);

/**
 * Wait until the PBX call ends (or ring/talk limits hit).
 *
 * @param {number} callId
 * @param {number|object} opts Or legacy maxWaitSec number.
 *   ringTimeoutSec — give up ringing if never answered (default 45)
 *   talkTimeoutSec — after answer, null = wait for natural hangup (live mode)
 *   maxTotalSec — hard safety cap
 *   shouldContinue — async () => boolean; stop waiting early if false (pause/cancel)
 */
async function waitForCallSettle(callId, opts = 60) {
  const conf =
    typeof opts === "number"
      ? {
          ringTimeoutSec: Math.max(15, opts),
          talkTimeoutSec: Math.max(15, opts),
          maxTotalSec: Math.max(30, opts),
        }
      : opts || {};

  const ringTimeoutSec = Math.max(15, Number(conf.ringTimeoutSec) || 45);
  const talkTimeoutSec =
    conf.talkTimeoutSec == null ? null : Math.max(15, Number(conf.talkTimeoutSec) || 60);
  const maxTotalSec = Math.max(
    ringTimeoutSec,
    Number(conf.maxTotalSec) || (talkTimeoutSec == null ? 7200 : talkTimeoutSec + ringTimeoutSec)
  );
  const shouldContinue =
    typeof conf.shouldContinue === "function" ? conf.shouldContinue : null;

  const started = Date.now();
  const ringDeadline = started + ringTimeoutSec * 1000;
  const totalDeadline = started + maxTotalSec * 1000;
  let answeredAtMs = null;
  let last = null;

  while (Date.now() < totalDeadline) {
    if (shouldContinue) {
      const ok = await shouldContinue();
      if (!ok) return last;
    }

    const rows = await query(
      `SELECT id, call_status, answered_at, ended_at, hangup_cause, call_id
       FROM pbx_calls WHERE id = ? LIMIT 1`,
      [callId]
    );
    last = rows[0] || null;
    const st = String(last?.call_status || "").toLowerCase();

    if (last && TERMINAL_CALL_STATUSES.has(st)) {
      return last;
    }

    if (last?.answered_at || st === "answered") {
      if (!answeredAtMs) {
        answeredAtMs = last.answered_at
          ? new Date(last.answered_at).getTime()
          : Date.now();
      }
      // Live / open talk: wait for natural hangup unless talkTimeoutSec set.
      if (talkTimeoutSec != null && Date.now() >= answeredAtMs + talkTimeoutSec * 1000) {
        return last;
      }
    } else if (Date.now() >= ringDeadline) {
      // Never answered within ring window — stop waiting (do not kill an answered call).
      return last;
    }

    await sleep(1500);
  }
  return last;
}

function isCallStillLive(callRow) {
  if (!callRow) return false;
  if (callRow.ended_at) return false;
  const st = String(callRow.call_status || "").toLowerCase();
  if (TERMINAL_CALL_STATUSES.has(st)) return false;
  return (
    ACTIVE_TALK_STATUSES.has(st) ||
    Boolean(callRow.answered_at) ||
    st === "answered"
  );
}

module.exports = {
  placeBulkDial,
  getPrimaryBrokerDevice,
  waitForCallSettle,
  clearExtensionLine,
  isCallStillLive,
  TERMINAL_CALL_STATUSES,
};
