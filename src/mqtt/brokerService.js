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

const adapter = new NeronMqttAdapter();
const pending = new PendingRequestManager();

let client = null;
let connected = false;
let reconnectAttempts = 0;
let invalidMessageCount = 0;
let commandTimeoutCount = 0;
let starting = false;
const processedEventKeys = new Set();

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

  // Extension status table
  if (parsed.event === "extension_status" && parsed.json.extension) {
    await setExtensionStatus(
      device.id,
      parsed.json.extension,
      parsed.json.status || "unknown"
    );
  }

  liveBus.broadcast("pbx_event", {
    deviceId: device.id,
    event: parsed.event,
    callId: parsed.callId,
    data: parsed.json,
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

  // After CDR, mark extension idle so next click-to-call is not blocked
  const ext =
    (callRow && callRow.extension_number) ||
    parsed.json.caller ||
    parsed.json.src ||
    parsed.json.extension ||
    null;
  if (ext) {
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

async function publishCommand(device, topicSuffix, payload, { wait = true } = {}) {
  if (!client || !connected) {
    throw new Error("MQTT broker not connected");
  }
  const token = device.deviceToken || decryptSecret(device.mqtt_token_enc) || decryptSecret(device.mqtt_token) || device.mqtt_token;
  if (!token) throw new Error("Device token missing");

  const requestId = payload.request_id || adapter.newRequestId();
  payload.request_id = requestId;
  const topic = adapter.topic(token, "command", topicSuffix);

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
    waiter = pending.add(requestId, { deviceId: device.id, cmd: payload.cmd }, config.callCommandTimeoutMs);
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
    commandTimeoutCount += 1;
    await query(
      `UPDATE pbx_mqtt_requests SET status = 'timed_out', completed_at = NOW() WHERE request_id = ?`,
      [requestId]
    );
    throw err;
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

async function hangupCall(deviceRow, callId) {
  return sendDeviceCommand(deviceRow, (requestId) =>
    adapter.hangupCall({ requestId, callId })
  );
}


async function fetchLiveCalls(deviceProp) {
  const result = await sendDeviceCommand(
    deviceRow,
    (requestId) => adapter.liveCall(requestId),
    { wait: true }
  );
  const json = result.response || {};
  if (Array.isArray(json.livecall)) return json.livecall;
  if (Array.isArray(json.message)) return json.message;
  if (Array.isArray(json.calllist)) return json.calllist;
  return [];
}

const ACTIVE_CALL_STATUSES = [
  "requested",
  "published",
  "acknowledged",
  "extension_ringing",
  "customer_dialling",
  "customer_ringing",
  "answered",
];

/** Hang up live channels for an extension and mark it idle (fixes stuck "not idle"). */
async function releaseExtension(deviceProp, extension) {
  const ext = String(extension || "").trim();
  if (!ext) throw new Error("Extension required");

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
    if (row.call_id) callIds.add(String(row.call_id));
  }

  try {
    const live = await fetchLiveCalls(deviceProp);
    for (const item of live || []) {
      if (!item || typeof item !== "object") continue;
      const caller = String(
        item.caller || item.cid_num || item.extension || item.src || ""
      );
      if (caller === ext || caller.endsWith(`/${ext}`) || caller.endsWith(ext)) {
        const id = item.callid || item.uuid || item.call_id;
        if (id) callIds.add(String(id));
      }
    }
  } catch (err) {
    logWarn("livecall during release failed", { ext, err: err.message });
  }

  const results = [];
  for (const callId of callIds) {
    try {
      await hangupCall(deviceProp, callId);
      results.push({ callId, ok: true });
    } catch (err) {
      results.push({ callId, ok: false, error: err.message });
    }
  }

  await query(
    `UPDATE pbx_calls
     SET call_status = 'hungup', ended_at = COALESCE(ended_at, NOW())
     WHERE extension_number = ?
       AND call_status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})`,
    [ext, ...ACTIVE_CALL_STATUSES]
  );

  const deviceId = deviceProp.id || deviceProp.pbx_device_id;
  if (deviceId) {
    await setExtensionStatus(deviceId, ext, "idle");
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
  probeDevice,
  health,
  shutdown,
  loadDevices,
};
