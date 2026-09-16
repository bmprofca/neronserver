const mqtt = require("mqtt");
const config = require("../config");
const { query } = require("../db");
const { decryptSecret, maskToken } = require("../security/secrets");
const { NeronMqttAdapter } = require("./NeronMqttAdapter");
const { PendingRequestManager } = require("./PendingRequestManager");
const {
  canTransition,
  mapNeronEventToState,
} = require("./callStateMachine");
const { liveBus } = require("../realtime/liveBus");
const {
  resolveInbound,
  recordDecision,
  phoneMatchKey,
} = require("../inbound/engine");

const adapter = new NeronMqttAdapter();
const pending = new PendingRequestManager();

const ACTIVE_CALL_STATUSES = [
  "requested",
  "published",
  "acknowledged",
  "extension_ringing",
  "customer_dialling",
  "customer_ringing",
  "answered",
];

let client = null;
let connected = false;
let reconnectAttempts = 0;
let invalidMessageCount = 0;
let commandTimeoutCount = 0;
let starting = false;
const processedEventKeys = new Set();
/** Active inbound hunt timers: callId → { timer, index, hunt, decisionId, device } */
const inboundHunts = new Map();

function logInfo(msg, extra = {}) {
  console.log(`[mqtt-broker] ${msg}`, sanitizeLog(extra));
}

function logWarn(msg, extra = {}) {
  console.warn(`[mqtt-broker] ${msg}`, sanitizeLog(extra));
}

function sanitizeLog(obj) {
  const out = { ...obj };
  if (out.token) out.token = maskToken(out.token);
  if (out.deviceToken) out.deviceToken = maskToken(out.deviceToken);
  if (out.password) out.password = "***";
  return out;
}

async function loadDevices() {
  const rows = await query(
    `SELECT * FROM devices
     WHERE api_enabled = 1
       AND mqtt_token IS NOT NULL
       AND mqtt_token != ''
       AND (integration_mode = 'broker' OR api_type = 'broker')`
  );
  return rows.map((row) => ({
    ...row,
    deviceToken:
      decryptSecret(row.mqtt_token_enc) ||
      decryptSecret(row.mqtt_token) ||
      row.mqtt_token,
  }));
}

function health() {
  return {
    enabled: Boolean(config.mqtt.enabled && config.mqtt.brokerUrl),
    connected,
    brokerConfigured: Boolean(config.mqtt.brokerUrl),
    reconnectAttempts,
    invalidMessageCount,
    commandTimeoutCount,
    pendingRequests: pending.size(),
    sseClients: liveBus.count(),
  };
}

async function touchDevice(deviceId, status = "online") {
  await query(
    `UPDATE devices SET status = ?, last_seen_at = NOW(), connection_status = ?
     WHERE id = ?`,
    [status === "online" ? "online" : status, status, deviceId]
  );
}

async function findDeviceByToken(token) {
  if (!token) return null;
  const rows = await query(
    `SELECT * FROM devices WHERE mqtt_token IS NOT NULL AND mqtt_token != ''`
  );
  for (const row of rows) {
    const plain =
      decryptSecret(row.mqtt_token_enc) ||
      decryptSecret(row.mqtt_token) ||
      row.mqtt_token;
    if (plain && plain === token) return { ...row, deviceToken: plain };
  }
  return null;
}

function rememberEventKey(key) {
  if (processedEventKeys.has(key)) return false;
  processedEventKeys.add(key);
  if (processedEventKeys.size > 5000) {
    const first = processedEventKeys.values().next().value;
    processedEventKeys.delete(first);
  }
  return true;
}

async function setExtensionStatus(deviceId, extension, status) {
  if (!deviceId || !extension) return;
  const st = String(status || "unknown").toLowerCase();
  await query(
    `INSERT INTO pbx_extensions (pbx_device_id, extension_number, extension_type, current_status, last_status_at)
     VALUES (?, ?, 'SIP', ?, NOW())
     ON DUPLICATE KEY UPDATE current_status = VALUES(current_status), last_status_at = NOW()`,
    [deviceId, String(extension), st]
  );
  liveBus.broadcast("pbx_extension", {
    deviceId,
    extension: String(extension),
    status: st,
  });
}

/**
 * Close ACTIVE CRM call rows for an extension (missed hangup/CDR / soft-publish orphans).
 * Returns the closed row ids.
 */
async function closeActiveCallsForExtension(
  extension,
  {
    deviceId = null,
    reason = "hungup",
    olderThanSec = 0,
    onlyWithoutCallId = false,
    excludeCallIds = [],
  } = {}
) {
  const ext = String(extension || "").trim();
  if (!ext) return [];

  const excludeIds = new Set(
    (excludeCallIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );

  const params = [ext, ...ACTIVE_CALL_STATUSES];
  let extra = "";
  if (olderThanSec > 0) {
    extra += " AND started_at < DATE_SUB(NOW(), INTERVAL ? SECOND)";
    params.push(Number(olderThanSec));
  }
  if (onlyWithoutCallId) {
    extra += " AND (call_id IS NULL OR call_id = '')";
  }
  if (excludeIds.size) {
    extra += ` AND id NOT IN (${[...excludeIds].map(() => "?").join(",")})`;
    params.push(...excludeIds);
  }

  const rows = await query(
    `SELECT id, call_status, call_id, customer_number, extension_number
     FROM pbx_calls
     WHERE extension_number = ?
       AND call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})${extra}
     ORDER BY id DESC`,
    params
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  await query(
    `UPDATE pbx_calls
     SET call_status = ?, ended_at = COALESCE(ended_at, NOW()), hangup_cause = COALESCE(hangup_cause, ?)
     WHERE id IN (${ids.map(() => "?").join(",")})`,
    [reason, reason === "hungup" ? "crm_reconcile" : reason, ...ids]
  );

  for (const row of rows) {
    liveBus.broadcast("pbx_call", {
      type: "call_status",
      data: { ...row, call_status: reason, ended_at: new Date().toISOString() },
    });
  }

  if (deviceId) {
    await setExtensionStatus(deviceId, ext, "idle");
  }

  return ids;
}

/**
 * Heal sticky "ringing / on a call" when PBX is idle or dial never got a callid.
 * - no call_id after 25s → orphan soft-publish
 * - any active row older than 4 minutes → force close
 */
async function reconcileExtensionPresence(deviceId, extension) {
  const ext = String(extension || "").trim();
  if (!ext) return { closedIds: [], status: "idle", active: null };

  const closedNoId = await closeActiveCallsForExtension(ext, {
    deviceId: null,
    reason: "timed_out",
    olderThanSec: 25,
    onlyWithoutCallId: true,
  });
  const closedOld = await closeActiveCallsForExtension(ext, {
    deviceId: null,
    reason: "hungup",
    olderThanSec: 240,
  });
  const closedIds = [...closedNoId, ...closedOld];

  const active = (
    await query(
      `SELECT id, call_id, call_status, customer_number, started_at, answered_at
       FROM pbx_calls
       WHERE extension_number = ?
         AND call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})
       ORDER BY id DESC LIMIT 1`,
      [ext, ...ACTIVE_CALL_STATUSES]
    )
  )[0] || null;

  const extRows = await query(
    `SELECT current_status, last_status_at FROM pbx_extensions
     WHERE pbx_device_id = ? AND extension_number = ? LIMIT 1`,
    [deviceId, ext]
  );
  let status = String(extRows[0]?.current_status || "idle").toLowerCase();

  // Never keep CRM busy when there is no live call row.
  if (!active && (status === "ringing" || status === "inuse" || status === "busy")) {
    await setExtensionStatus(deviceId, ext, "idle");
    status = "idle";
  } else if (active && (status === "idle" || status === "unknown" || !status)) {
    // Prefer real call only briefly — avoid resurrecting forever after missed hangups.
    const startedMs = active.started_at ? new Date(active.started_at).getTime() : 0;
    const ageSec = startedMs ? (Date.now() - startedMs) / 1000 : 9999;
    if (active.call_id && ageSec < 90) {
      status = active.call_status === "answered" ? "inuse" : "ringing";
    } else if (!active.call_id || ageSec >= 90) {
      await closeActiveCallsForExtension(ext, {
        deviceId,
        reason: active.call_id ? "hungup" : "timed_out",
      });
      status = "idle";
      return { closedIds: [...closedIds, active.id], status: "idle", active: null };
    }
  }

  return { closedIds, status, active };
}

async function applyCallState(callRow, nextState, extra = {}) {
  if (!callRow || !nextState) return callRow;
  const current = callRow.call_status || callRow.status;
  if (!canTransition(current, nextState) && current !== nextState) {
    return callRow;
  }
  const sets = ["call_status = ?", "updated_at = NOW()"];
  const params = [nextState];
  if (nextState === "extension_ringing" || nextState === "customer_ringing") {
    sets.push("ringing_at = COALESCE(ringing_at, NOW())");
  }
  if (nextState === "answered") {
    sets.push("answered_at = COALESCE(answered_at, NOW())");
  }
  if (
    ["completed", "busy", "no_answer", "failed", "cancelled", "timed_out", "hungup"].includes(
      nextState
    )
  ) {
    sets.push("ended_at = COALESCE(ended_at, NOW())");
    if (extra.hangup_cause) {
      sets.push("hangup_cause = ?");
      params.push(extra.hangup_cause);
    }
    if (extra.duration_seconds != null) {
      sets.push("duration_seconds = ?");
      params.push(extra.duration_seconds);
    }
  }
  if (extra.call_id) {
    sets.push("call_id = COALESCE(call_id, ?)");
    params.push(extra.call_id);
  }
  if (extra.raw) {
    sets.push("raw_cdr_json = ?");
    params.push(JSON.stringify(extra.raw));
  }
  params.push(callRow.id);
  await query(`UPDATE pbx_calls SET ${sets.join(", ")} WHERE id = ?`, params);

  // Keep legacy calls table in sync when linked
  if (callRow.legacy_call_id) {
    const legacyStatus =
      nextState === "answered" ||
      nextState === "customer_ringing" ||
      nextState === "acknowledged" ||
      nextState === "extension_ringing"
        ? "success"
        : ["failed", "busy", "no_answer", "timed_out"].includes(nextState)
          ? "failed"
          : nextState === "completed" || nextState === "hungup"
            ? "hungup"
            : "dispatching";
    const legacyMsg =
      nextState === "answered"
        ? "On call (auto-answer)"
        : nextState === "customer_ringing" || nextState === "customer_dialling"
          ? "Customer ringing"
          : nextState === "acknowledged"
            ? "Ext auto-answered · dialing customer"
            : nextState === "completed" || nextState === "hungup"
              ? extra.duration_seconds != null
                ? `Call completed (${extra.duration_seconds}s)`
                : "Call completed"
              : `Call ${nextState}`;
    await query(
      `UPDATE calls SET status = ?, uuid = COALESCE(?, uuid), message = ? WHERE id = ?`,
      [
        legacyStatus,
        extra.call_id || null,
        legacyMsg,
        callRow.legacy_call_id,
      ]
    );
  }

  const updated = (
    await query("SELECT * FROM pbx_calls WHERE id = ?", [callRow.id])
  )[0];
  liveBus.broadcast("pbx_call", { type: "call_status", data: updated });

  const ext = updated?.extension_number || callRow.extension_number;
  const deviceId = updated?.pbx_device_id || callRow.pbx_device_id;
  if (ext && deviceId) {
    const busy = [
      "published",
      "acknowledged",
      "extension_ringing",
      "customer_dialling",
      "customer_ringing",
      "answered",
    ];
    const idle = [
      "completed",
      "busy",
      "no_answer",
      "failed",
      "cancelled",
      "timed_out",
      "hungup",
    ];
    if (busy.includes(nextState)) {
      await setExtensionStatus(
        deviceId,
        ext,
        nextState === "answered" ? "inuse" : "ringing"
      );
    } else if (idle.includes(nextState)) {
      await setExtensionStatus(deviceId, ext, "idle");
    }
  }

  return updated;
}

async function handleResponse(device, parsed) {
  await touchDevice(device.id, "online");
  const { requestId, json } = parsed;
  if (requestId) {
    const ok = adapter.isSuccessResponse(json);
    pending.settle(
      requestId,
      json,
      ok ? null : new Error(json.message || json.status || "Command failed")
    );
    await query(
      `UPDATE pbx_mqtt_requests
       SET status = ?, response_json = ?, completed_at = NOW()
       WHERE request_id = ?`,
      [ok ? "acknowledged" : "failed", JSON.stringify(json), requestId]
    );
    const calls = await query(
      `SELECT * FROM pbx_calls WHERE request_id = ? ORDER BY id DESC LIMIT 1`,
      [requestId]
    );
    if (calls[0]) {
      const next = ok
        ? json.callid
          ? "acknowledged"
          : "acknowledged"
        : "failed";
      await applyCallState(calls[0], next, {
        call_id: json.callid || json.uuid,
        raw: json,
      });
      const msg = String(json.message || "").toLowerCase();
      if (
        !ok &&
        calls[0].extension_number &&
        (msg.includes("not idle") ||
          msg.includes("in use") ||
          msg.includes("inuse") ||
          msg.includes("busy"))
      ) {
        await setExtensionStatus(
          device.id,
          calls[0].extension_number,
          "inuse"
        );
      }
    }
  }
  liveBus.broadcast("pbx_device", {
    type: "response",
    deviceId: device.id,
    data: { requestId, status: json.status, message: json.message },
  });
}

async function handleEvent(device, parsed) {
  const key = `${parsed.topic}:${parsed.callId || ""}:${parsed.event || ""}:${JSON.stringify(parsed.json).slice(0, 80)}`;
  if (!rememberEventKey(key)) return;

  await touchDevice(device.id, "online");
  const next = mapNeronEventToState(parsed.event, parsed.json);
  let callRow = null;
  if (parsed.callId) {
    const rows = await query(
      `SELECT * FROM pbx_calls WHERE call_id = ? OR uuid = ? ORDER BY id DESC LIMIT 1`,
      [parsed.callId, parsed.callId]
    );
    callRow = rows[0];
  }
  if (!callRow && parsed.requestId) {
    const rows = await query(
      `SELECT * FROM pbx_calls WHERE request_id = ? ORDER BY id DESC LIMIT 1`,
      [parsed.requestId]
    );
    callRow = rows[0];
  }
  if (callRow && next) {
    await applyCallState(callRow, next, { call_id: parsed.callId, raw: parsed.json });
  }

  // Extension status table — when PBX reports idle, close orphan CRM "live" rows.
  if (parsed.event === "extension_status" && parsed.json.extension) {
    const extNum = parsed.json.extension;
    const st = String(parsed.json.status || "unknown").toLowerCase();
    if (st === "idle") {
      await closeActiveCallsForExtension(extNum, {
        deviceId: device.id,
        reason: "hungup",
      });
    } else {
      await setExtensionStatus(device.id, extNum, st);
    }
  }

  if (String(parsed.event || "").toLowerCase() === "invite") {
    await maybeRouteInbound(device, parsed).catch((err) =>
      logWarn("inbound route failed", { err: err.message })
    );
  }

  if (
    parsed.callId &&
    ["answered", "hangup", "cdr"].includes(String(parsed.event || "").toLowerCase())
  ) {
    clearInboundHunt(parsed.callId, parsed.event);
  }

  liveBus.broadcast("pbx_event", {
    deviceId: device.id,
    event: parsed.event,
    callId: parsed.callId,
    data: parsed.json,
  });
}

function extractInboundCaller(json = {}) {
  const keys = [
    "from",
    "caller",
    "src",
    "cid_num",
    "callerid",
    "caller_id_number",
    "ani",
    "number",
  ];
  for (const key of keys) {
    const raw = json[key];
    if (raw == null) continue;
    const digits = String(raw).replace(/\D/g, "");
    if (digits.length >= 8) return String(raw);
  }
  return "";
}

function extractInboundDid(json = {}) {
  const keys = ["to", "called", "callee", "dst", "did", "destination"];
  for (const key of keys) {
    if (json[key] != null && String(json[key]).trim()) return String(json[key]);
  }
  return "";
}

function looksLikeExternalCaller(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length >= 8) return true;
  return false;
}

function clearInboundHunt(callId, reason = "") {
  const entry = inboundHunts.get(String(callId));
  if (!entry) return;
  clearTimeout(entry.timer);
  inboundHunts.delete(String(callId));
  if (entry.decisionId && /answer/i.test(String(reason))) {
    query(
      `UPDATE inbound_decisions SET status = 'answered' WHERE id = ?`,
      [entry.decisionId]
    ).catch(() => {});
  }
}

async function transferToExtension(device, callId, extension) {
  const requestId = adapter.newRequestId();
  const built = adapter.transferCall({
    requestId,
    callId,
    destination: extension,
  });
  await publishCommand(device, built.topicSuffix, built.payload, {
    wait: false,
  });
}

function scheduleInboundFailover(device, callId, hunt, index, decisionId) {
  const step = hunt[index];
  if (!step) return;
  const waitMs = Math.max(5, Number(step.timeoutSec) || 20) * 1000;
  const timer = setTimeout(() => {
    void (async () => {
      const current = inboundHunts.get(String(callId));
      if (!current) return;
      const nextIndex = index + 1;
      const next = hunt[nextIndex];
      if (!next) {
        inboundHunts.delete(String(callId));
        await query(
          `UPDATE inbound_decisions SET status = 'missed' WHERE id = ?`,
          [decisionId]
        ).catch(() => {});
        return;
      }
      try {
        await transferToExtension(device, callId, next.extension);
        await query(
          `UPDATE inbound_decisions SET status = 'overflow', first_extension = ? WHERE id = ?`,
          [next.extension, decisionId]
        ).catch(() => {});
        scheduleInboundFailover(device, callId, hunt, nextIndex, decisionId);
      } catch (err) {
        logWarn("inbound failover transfer failed", {
          callId,
          ext: next.extension,
          err: err.message,
        });
        inboundHunts.delete(String(callId));
      }
    })();
  }, waitMs);
  inboundHunts.set(String(callId), {
    timer,
    index,
    hunt,
    decisionId,
    deviceId: device.id,
  });
}

async function maybeRouteInbound(device, parsed) {
  const json = parsed.json || {};
  const callerRaw = extractInboundCaller(json);
  if (!looksLikeExternalCaller(callerRaw)) return;
  const did = extractInboundDid(json);
  // Skip internal extension-to-extension invites (short "to" already handled elsewhere)
  const toDigits = String(did || "").replace(/\D/g, "");
  const fromDigits = String(callerRaw || "").replace(/\D/g, "");
  if (fromDigits.length <= 5 && toDigits.length <= 5) return;

  const appId = device.app_id;
  if (!appId) return;

  const callId = parsed.callId || json.callid || json.uuid || null;
  if (callId && inboundHunts.has(String(callId))) return;

  const preview = await resolveInbound(appId, { from: callerRaw, to: did });
  if (!preview.ok || !preview.firstExtension) {
    if (preview.ok) {
      await recordDecision(appId, preview, { status: "missed", callId });
    }
    return;
  }

  const decisionId = await recordDecision(appId, preview, {
    status: "routed",
    callId,
  });

  // Persist inbound call row for UI / sticky later
  if (callId) {
    const existing = await query(
      `SELECT id FROM pbx_calls WHERE call_id = ? LIMIT 1`,
      [callId]
    );
    if (!existing[0]) {
      await query(
        `INSERT INTO pbx_calls
          (pbx_device_id, request_id, call_id, extension_number, customer_number,
           direction, call_status, started_at, ringing_at)
         VALUES (?, ?, ?, ?, ?, 'inbound', 'extension_ringing', NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           extension_number = VALUES(extension_number),
           customer_number = VALUES(customer_number),
           direction = 'inbound',
           call_status = 'extension_ringing'`,
        [
          device.id,
          parsed.requestId || `inbound-${callId}`,
          callId,
          preview.firstExtension,
          preview.callerDial || phoneMatchKey(callerRaw),
        ]
      );
    }
  }

  try {
    if (callId) {
      await transferToExtension(device, callId, preview.firstExtension);
      if (preview.hunt.length > 1) {
        scheduleInboundFailover(
          device,
          callId,
          preview.hunt,
          0,
          decisionId
        );
      }
    }
  } catch (err) {
    logWarn("inbound transfer publish failed", { err: err.message });
  }

  liveBus.broadcast("pbx_inbound", {
    deviceId: device.id,
    callId,
    preview,
  });
}

async function handleCdr(device, parsed) {
  const key = `cdr:${parsed.callId || parsed.requestId}:${JSON.stringify(parsed.json).slice(0, 120)}`;
  if (!rememberEventKey(key)) return;
  await touchDevice(device.id, "online");

  let callRow = null;
  if (parsed.callId) {
    callRow = (
      await query(`SELECT * FROM pbx_calls WHERE call_id = ? LIMIT 1`, [
        parsed.callId,
      ])
    )[0];
  }
  const duration =
    Number(parsed.json.duration || parsed.json.billsec || 0) || null;
  if (callRow) {
    await applyCallState(callRow, "completed", {
      call_id: parsed.callId,
      duration_seconds: duration,
      hangup_cause: parsed.json.disposition || parsed.json.hangup_cause || null,
      raw: parsed.json,
    });
  } else {
    await query(
      `INSERT INTO pbx_calls
        (pbx_device_id, request_id, call_id, direction, call_status, ended_at, duration_seconds, raw_cdr_json, customer_number, extension_number)
       VALUES (?, ?, ?, 'unknown', 'completed', NOW(), ?, ?, ?, ?)`,
      [
        device.id,
        parsed.requestId || `cdr-${Date.now()}`,
        parsed.callId,
        duration,
        JSON.stringify(parsed.json),
        parsed.json.called || parsed.json.callee || null,
        parsed.json.caller || parsed.json.extension || null,
      ]
    );
  }

  // After CDR, mark extension idle and close any leftover ACTIVE rows for that desk.
  const ext =
    (callRow && callRow.extension_number) ||
    parsed.json.caller ||
    parsed.json.src ||
    parsed.json.extension ||
    null;
  if (ext) {
    await closeActiveCallsForExtension(ext, {
      deviceId: device.id,
      reason: "hungup",
      excludeCallIds: callRow?.id ? [callRow.id] : [],
    });
    await setExtensionStatus(device.id, ext, "idle");
  }

  liveBus.broadcast("pbx_cdr", { deviceId: device.id, data: parsed.json });
}

async function onMessage(topic, messageBuf) {
  const text = messageBuf.toString();
  if (text.length > 200000) {
    invalidMessageCount += 1;
    logWarn("payload too large", { topic, len: text.length });
    return;
  }
  const parsed = adapter.parseIncoming(topic, text);
  if (!parsed.ok) {
    invalidMessageCount += 1;
    return;
  }
  if (parsed.channel === "command_echo") return;

  const device = await findDeviceByToken(parsed.deviceToken);
  if (!device) {
    logWarn("ignored event from unregistered token", {
      token: parsed.deviceToken,
    });
    return;
  }

  await touchDevice(device.id, "online");

  if (parsed.channel === "status") {
    const st = String(parsed.status || "").toLowerCase();
    await touchDevice(
      device.id,
      st === "offline" ? "offline" : "online"
    );
    liveBus.broadcast("pbx_device", {
      type: "presence",
      deviceId: device.id,
      status: st || "online",
    });
    return;
  }
  if (parsed.channel === "response") return handleResponse(device, parsed);
  if (parsed.channel === "event") return handleEvent(device, parsed);
  if (parsed.channel === "cdr") return handleCdr(device, parsed);
}

async function subscribeAll() {
  if (!client || !connected) return;
  const devices = await loadDevices();
  for (const d of devices) {
    if (!d.deviceToken) continue;
    const topics = [
      adapter.topic(d.deviceToken, "response"),
      adapter.topic(d.deviceToken, "event"),
      adapter.topic(d.deviceToken, "cdr"),
      adapter.topic(d.deviceToken, "status"),
    ];
    for (const t of topics) {
      client.subscribe(t, { qos: 1 }, (err) => {
        if (err) logWarn("subscribe failed", { topic: t, err: err.message });
      });
    }
  }
  logInfo("subscriptions restored", { devices: devices.length });
}

function connectBroker() {
  if (!config.mqtt.enabled || !config.mqtt.brokerUrl) {
    logInfo("broker MQTT disabled (set MQTT_BROKER_URL to enable)");
    return;
  }
  if (starting || client) return;
  starting = true;

  const opts = {
    clientId: config.mqtt.clientId,
    username: config.mqtt.username || undefined,
    password: config.mqtt.password || undefined,
    reconnectPeriod: Math.min(30000, 1000 * Math.pow(2, reconnectAttempts)),
    connectTimeout: config.mqtt.connectTimeout,
    keepalive: config.mqtt.keepalive,
    clean: true,
    rejectUnauthorized: config.mqtt.rejectUnauthorized,
  };

  logInfo("connecting", { url: config.mqtt.brokerUrl, clientId: opts.clientId });
  client = mqtt.connect(config.mqtt.brokerUrl, opts);

  client.on("connect", async () => {
    connected = true;
    reconnectAttempts = 0;
    starting = false;
    logInfo("connected");
    try {
      await subscribeAll();
    } catch (err) {
      logWarn("subscribeAll failed", { err: err.message });
    }
    liveBus.broadcast("pbx_mqtt", { connected: true });
  });

  client.on("reconnect", () => {
    reconnectAttempts += 1;
    connected = false;
    logInfo("reconnecting", { attempt: reconnectAttempts });
  });

  client.on("close", () => {
    connected = false;
    liveBus.broadcast("pbx_mqtt", { connected: false });
  });

  client.on("error", (err) => {
    logWarn("error", { err: err.message });
  });

  client.on("message", (topic, buf) => {
    onMessage(topic, buf).catch((err) =>
      logWarn("message handler failed", { err: err.message })
    );
  });
}

async function publishCommand(
  device,
  topicSuffix,
  payload,
  { wait = true, timeoutMs } = {}
) {
  if (!client || !connected) {
    throw new Error("MQTT broker not connected");
  }
  const token = device.deviceToken || decryptSecret(device.mqtt_token_enc) || decryptSecret(device.mqtt_token) || device.mqtt_token;
  if (!token) throw new Error("Device token missing");

  const requestId = payload.request_id || adapter.newRequestId();
  payload.request_id = requestId;
  const topic = adapter.topic(token, "command", topicSuffix);
  const waitMs =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : config.callCommandTimeoutMs;

  await query(
    `INSERT INTO pbx_mqtt_requests
      (pbx_device_id, request_id, command, topic, payload_json, status, crm_user_id)
     VALUES (?, ?, ?, ?, ?, 'published', ?)
     ON DUPLICATE KEY UPDATE status = 'published', payload_json = VALUES(payload_json)`,
    [
      device.id,
      requestId,
      payload.cmd || topicSuffix,
      topic,
      JSON.stringify(payload),
      device._crmUserId || null,
    ]
  );

  let waiter = null;
  if (wait) {
    waiter = pending.add(
      requestId,
      { deviceId: device.id, cmd: payload.cmd },
      waitMs
    );
  }

  await new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  logInfo("command published", {
    requestId,
    cmd: payload.cmd,
    deviceId: device.id,
  });

  if (!wait) return { requestId, published: true };
  try {
    const response = await waiter;
    return { requestId, published: true, response };
  } catch (err) {
    // Late ACK race: response may land just after the waiter times out.
    // Prefer the DB response over a blind timeout so "not idle" / Success
    // are not treated as soft-publish successes.
    await new Promise((r) => setTimeout(r, 150));
    const rows = await query(
      `SELECT status, response_json FROM pbx_mqtt_requests WHERE request_id = ? LIMIT 1`,
      [requestId]
    );
    const row = rows[0];
    let late = null;
    if (row?.response_json) {
      try {
        late =
          typeof row.response_json === "string"
            ? JSON.parse(row.response_json)
            : row.response_json;
      } catch {
        late = null;
      }
    }
    if (late && typeof late === "object") {
      if (adapter.isSuccessResponse(late)) {
        return { requestId, published: true, response: late, lateAck: true };
      }
      const fail = new Error(
        late.message || late.status || err.message || "Command failed"
      );
      fail.published = true;
      fail.requestId = requestId;
      fail.response = late;
      throw fail;
    }

    const msg = String(err?.message || err || "");
    const isTimeout =
      msg.toLowerCase().includes("timed out") ||
      msg.toLowerCase().includes("timeout");
    if (isTimeout) {
      commandTimeoutCount += 1;
      await query(
        `UPDATE pbx_mqtt_requests
         SET status = 'timed_out', completed_at = COALESCE(completed_at, NOW())
         WHERE request_id = ? AND status = 'published'`,
        [requestId]
      );
    }
    const e = err instanceof Error ? err : new Error(String(err));
    e.published = true;
    e.requestId = requestId;
    throw e;
  }
}

async function sendDeviceCommand(deviceRow, builderFn, opts) {
  const device = {
    ...deviceRow,
    deviceToken:
      decryptSecret(deviceRow.mqtt_token_enc) ||
      decryptSecret(deviceRow.mqtt_token) ||
      deviceRow.mqtt_token,
  };
  const requestId = adapter.newRequestId();
  const { topicSuffix, payload } = builderFn(requestId);
  return publishCommand(device, topicSuffix, payload, opts);
}

async function hangupCall(deviceRow, callId, opts = {}) {
  return sendDeviceCommand(
    deviceRow,
    (requestId) => adapter.hangupCall({ requestId, callId }),
    opts
  );
}


async function fetchLiveCalls(deviceRow, opts = {}) {
  const result = await sendDeviceCommand(
    deviceRow,
    (requestId) => adapter.liveCall(requestId),
    { wait: true, timeoutMs: opts.timeoutMs, ...opts }
  );
  const json = result.response || {};
  if (Array.isArray(json.livecall)) return json.livecall;
  if (Array.isArray(json.message)) return json.message;
  if (Array.isArray(json.calllist)) return json.calllist;
  return [];
}

/**
 * Hang up live channels for an extension and mark it idle.
 * opts.fast: skip livecall; hangup only known CRM call_ids (no MQTT wait).
 * opts.quick: short livecall (default 2s) + fire-and-forget hangups — for click-to-call.
 * opts.excludeCallIds: pbx_calls.id values to keep (current dial row).
 */
async function releaseExtension(deviceProp, extension, opts = {}) {
  const ext = String(extension || "").trim();
  if (!ext) throw new Error("Extension required");
  const quick = Boolean(opts.quick);
  const fast = Boolean(opts.fast) && !quick;
  const hangupWait =
    opts.hangupWait != null ? Boolean(opts.hangupWait) : !(fast || quick);
  const liveTimeoutMs =
    typeof opts.liveTimeoutMs === "number"
      ? opts.liveTimeoutMs
      : quick
        ? 2000
        : fast
          ? 1500
          : config.callCommandTimeoutMs;
  const excludeIds = new Set(
    (opts.excludeCallIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );

  const callIds = new Set();
  const dbCalls = await query(
    `SELECT id, call_id FROM pbx_calls
     WHERE extension_number = ?
       AND call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})
     ORDER BY id DESC
     LIMIT 20`,
    [ext, ...ACTIVE_CALL_STATUSES]
  );
  for (const row of dbCalls) {
    if (excludeIds.has(Number(row.id))) continue;
    if (row.call_id) callIds.add(String(row.call_id));
  }

  // Clear CRM state first so a stuck "busy" does not block the next dial.
  const clearParams = [ext, ...ACTIVE_CALL_STATUSES];
  let excludeSql = "";
  if (excludeIds.size) {
    excludeSql = ` AND id NOT IN (${[...excludeIds].map(() => "?").join(",")})`;
    clearParams.push(...excludeIds);
  }
  await query(
    `UPDATE pbx_calls
     SET call_status = 'hungup', ended_at = COALESCE(ended_at, NOW())
     WHERE extension_number = ?
       AND call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})${excludeSql}`,
    clearParams
  );

  for (const row of dbCalls) {
    if (excludeIds.has(Number(row.id))) continue;
    liveBus.broadcast("pbx_call", {
      type: "call_status",
      data: {
        id: row.id,
        call_id: row.call_id,
        extension_number: ext,
        call_status: "hungup",
        ended_at: new Date().toISOString(),
      },
    });
  }

  const deviceId = deviceProp.id || deviceProp.pbx_device_id;
  if (deviceId) {
    await setExtensionStatus(deviceId, ext, "idle");
  }

  if (!fast) {
    try {
      const live = await fetchLiveCalls(deviceProp, { timeoutMs: liveTimeoutMs });
      for (const item of live || []) {
        if (!item || typeof item !== "object") continue;
        const caller = String(
          item.caller || item.cid_num || item.extension || item.src || ""
        );
        if (
          caller === ext ||
          caller.endsWith(`/${ext}`) ||
          caller.endsWith(ext)
        ) {
          const id = item.callid || item.uuid || item.call_id;
          if (id) callIds.add(String(id));
        }
      }
    } catch (err) {
      logWarn("livecall during release failed", { ext, err: err.message });
    }
  }

  const results = [];
  for (const callId of callIds) {
    try {
      await hangupCall(deviceProp, callId, {
        wait: hangupWait,
        timeoutMs: hangupWait ? liveTimeoutMs : 1500,
      });
      results.push({ callId, ok: true });
    } catch (err) {
      results.push({ callId, ok: false, error: err.message });
    }
  }

  return {
    extension: ext,
    hungupCallIds: [...callIds],
    results,
  };
}

/** Lightweight reachability check — updates last_seen_at on success. */
async function probeDevice(deviceRow, timeoutMs = 8000) {
  const result = await sendDeviceCommand(
    deviceRow,
    (requestId) => adapter.getDeviceInfo(requestId),
    { wait: true }
  );
  return result;
}

function shutdown() {
  pending.clear();
  if (client) {
    try {
      client.end(true);
    } catch {
      /* ignore */
    }
    client = null;
  }
  connected = false;
  starting = false;
}

module.exports = {
  adapter,
  pending,
  connectBroker,
  subscribeAll,
  publishCommand,
  sendDeviceCommand,
  hangupCall,
  fetchLiveCalls,
  releaseExtension,
  setExtensionStatus,
  closeActiveCallsForExtension,
  reconcileExtensionPresence,
  probeDevice,
  health,
  shutdown,
  loadDevices,
  ACTIVE_CALL_STATUSES,
};
