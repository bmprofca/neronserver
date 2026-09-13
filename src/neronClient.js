const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL, URLSearchParams } = require("url");
const mqtt = require("mqtt");

function parseUuid(message) {
  if (!message || typeof message !== "string") return null;
  const match = message.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  return match ? match[0] : null;
}

function normalizeDialNumber(input) {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("0") && digits.length === 11) {
    return digits;
  }
  if (digits.length === 10) {
    return `0${digits}`;
  }
  return digits;
}

function shortError(text, max = 180) {
  const clean = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function deviceHost(baseUrlOrHost) {
  const raw = String(baseUrlOrHost || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, "");
  return `http://${raw.replace(/\/$/, "")}`;
}

function isLocalDummyHost(host) {
  const h = String(host || "").toLowerCase();
  return (
    !h ||
    h.includes("127.0.0.1") ||
    h.includes("localhost") ||
    h === "http://" ||
    h === "https://"
  );
}

function buildNeronUrl(baseUrl, path, params) {
  const base = deviceHost(baseUrl);
  if (!base) throw new Error("HTTP base URL missing");
  const url = new URL(`${base}${path}`);
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });
  url.search = search.toString();
  return url.toString();
}

function callParams(call) {
  const number = normalizeDialNumber(
    call.caller_id_number || call.callee_id_number
  );
  switch (call.type) {
    case "extnCall":
      return {
        path: "/onyxcxm/api/extnCall",
        params: {
          extension: call.extension,
          caller_id_number: number,
          gateway: call.gateway,
          auto_answer: "yes",
          autoanswer: "1",
        },
      };
    case "numCall":
      return {
        path: "/onyxcxm/api/numCall",
        params: {
          caller_id_number: normalizeDialNumber(call.caller_id_number),
          callee_id_number: normalizeDialNumber(call.callee_id_number),
          gateway: call.gateway,
        },
      };
    case "ivrCall":
      return {
        path: "/onyxcxm/api/ivrCall",
        params: {
          extension: call.extension,
          caller_id_number: number,
          ivr: call.ivr,
        },
      };
    case "hangup":
      return {
        path: "/onyxcxm/api/hangup",
        params: { uuid: call.uuid },
      };
    default:
      throw new Error(`Unsupported Neron call type: ${call.type}`);
  }
}

function neronGet(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: "GET",
          timeout: timeoutMs,
          rejectUnauthorized: false,
          headers: { Accept: "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = {
                status: res.statusCode < 400 ? "success" : "failed",
                message: shortError(text),
              };
            }
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 400,
              statusCode: res.statusCode,
              json,
              text: shortError(text),
              url,
            });
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({
          ok: false,
          statusCode: 0,
          json: null,
          text: "timeout",
          url,
          error: "timeout",
        });
      });
      req.on("error", (err) => {
        resolve({
          ok: false,
          statusCode: 0,
          json: null,
          text: err.message,
          url,
          error: err.message,
        });
      });
      req.end();
    } catch (err) {
      resolve({
        ok: false,
        statusCode: 0,
        json: null,
        text: err.message,
        url,
        error: err.message,
      });
    }
  });
}

function mqttConfig(device) {
  let host = (
    device.mqtt_host ||
    String(device.base_url || "")
      .replace(/^https?:\/\//i, "")
      .split("/")[0] ||
    ""
  ).trim();
  host = host.replace(/:\d+$/, "");
  if (!host || isLocalDummyHost(host)) {
    host = "192.168.0.180";
  }
  return {
    host,
    port: Number(device.mqtt_port || 1883),
    username: device.mqtt_username || undefined,
    password: device.mqtt_password || undefined,
    clientId: `${device.mqtt_client_id || "neron-app"}-${Date.now()}`,
    token: device.mqtt_token,
  };
}

function canUseMqtt(device) {
  if (!device || device.api_enabled === 0) return false;
  const cfg = mqttConfig(device);
  // Ready when token exists; host defaults to Neron LAN IP if missing/localhost
  return Boolean(cfg.token && cfg.host);
}

function canUseHttp(device) {
  if (!device || device.api_enabled === 0) return false;
  // Neron 20 API Manager is MQTT. Only use legacy onyxcxm if explicitly http
  // and not pointed at local IIS dummy.
  if (device.api_type === "mqtt") return false;
  if (device.mqtt_token && device.api_type !== "http") return false;
  const host = deviceHost(device.base_url || device.mqtt_host);
  return Boolean(host && !isLocalDummyHost(host));
}

function mqttRequest(device, topicSuffix, payload, timeoutMs = 12000) {
  const cfg = mqttConfig(device);
  if (!cfg.host || !cfg.token) {
    return Promise.reject(
      new Error(
        "Set Host + Token in API Manager (System → API on Neron 20), then Save and Test Neron 20"
      )
    );
  }
  if (isLocalDummyHost(cfg.host)) {
    return Promise.reject(
      new Error("MQTT Host cannot be 127.0.0.1. Use the Neron LAN IP, e.g. 192.168.0.180")
    );
  }

  return new Promise((resolve, reject) => {
    const requestId =
      payload.request_id || crypto.randomBytes(8).toString("hex");
    const body = { ...payload, request_id: requestId };
    const url = `mqtt://${cfg.host}:${cfg.port}`;
    const client = mqtt.connect(url, {
      clientId: cfg.clientId,
      username: cfg.username,
      password: cfg.password,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      clean: true,
    });

    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(data);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `MQTT timeout to ${cfg.host}:${cfg.port}. Check Enable, Username, Password, Client ID, Token on Neron API Manager`
        )
      );
    }, timeoutMs);

    client.on("error", (err) => finish(err));

    client.on("connect", () => {
      const commandTopic = `device/${cfg.token}/api/v1.0/${topicSuffix}`;
      const responseTopic = `device/${cfg.token}/api/v1.0/#`;
      client.subscribe(responseTopic, { qos: 1 }, (err) => {
        if (err) {
          finish(err);
          return;
        }
        client.publish(commandTopic, JSON.stringify(body), { qos: 1 }, (pubErr) => {
          if (pubErr) finish(pubErr);
        });
      });
    });

    client.on("message", (_topic, message) => {
      try {
        const json = JSON.parse(message.toString());
        if (json.request_id) {
          if (
            String(json.request_id).trim() !== String(requestId).trim()
          ) {
            return;
          }
          finish(null, json);
          return;
        }
        // Ignore live events (invite, extension_status, cdr) while waiting
        // for the dial command reply.
        if (json.event) return;
        if (json.status || json.callid || json.message || json.livecall) {
          finish(null, json);
        }
      } catch {
        // ignore non-json events
      }
    });
  });
}

function isMqttSuccess(json) {
  if (!json || typeof json !== "object") return false;
  const status = String(json.status || "").toLowerCase();
  const message = String(json.message || "").toLowerCase();
  if (status === "failed" || status === "error" || status === "fail") {
    return false;
  }
  if (status === "success" || status === "ok") return true;
  if (message === "success" || message.includes("+ok")) return true;
  if (json.callid || json.uuid) return true;
  return false;
}

async function executeHttpCall(device, call) {
  const { path, params } = callParams(call);
  const base = deviceHost(device.base_url || device.mqtt_host);
  if (isLocalDummyHost(base)) {
    throw new Error(
      "HTTP IPBX URL is localhost. Configure Neron MQTT Host 192.168.0.180 instead"
    );
  }
  const url = buildNeronUrl(base, path, params);
  const result = await neronGet(url);
  const message =
    result.json && result.json.message != null
      ? shortError(String(result.json.message))
      : shortError(result.text);
  const uuid =
    call.uuid ||
    parseUuid(message) ||
    result.json?.uuid ||
    result.json?.callid ||
    null;
  const success =
    result.ok &&
    (!result.json ||
      !result.json.status ||
      String(result.json.status).toLowerCase() === "success");

  if (!success) {
    throw new Error(
      `HTTP ${result.statusCode || ""} ${message || "call failed"}`.trim()
    );
  }

  return {
    success: true,
    uuid: uuid ? String(uuid) : null,
    message,
    raw: result.json || result.text,
    url,
    transport: "http",
  };
}

async function executeMqttCall(device, call) {
  const number = normalizeDialNumber(
    call.caller_id_number || call.callee_id_number
  );

  if (call.type === "hangup") {
    const json = await mqttRequest(device, "command/call", {
      cmd: "hangup",
      callid: call.uuid,
    });
    const success =
      isMqttSuccess(json) ||
      String(json.message || "")
        .toLowerCase()
        .includes("hungup") ||
      String(json.message || "")
        .toLowerCase()
        .includes("hangup");
    return {
      success: true, // treat hangup request as done; PBX may already be idle
      uuid: call.uuid,
      message:
        json.message ||
        (success ? "Call disconnected" : "Hangup sent to Neron"),
      raw: json,
      transport: "mqtt",
    };
  }

  // Click-to-call: extension (caller) auto-answers, then mobile (callee) rings
  const json = await mqttRequest(device, "command/call", {
    cmd: "dial",
    caller: String(call.extension),
    callee: number,
    dialpermission: String(call.extension),
    autoanswer: "yes",
    auto_answer: "1",
  });

  const success = isMqttSuccess(json);
  let uuid = json.callid || json.uuid || null;
  if (!success) {
    throw new Error(
      shortError(json.message || json.status || "Neron dial rejected the call")
    );
  }

  // Dial reply sometimes has no callid yet — pull it from livecall
  if (!uuid) {
    try {
      await new Promise((r) => setTimeout(r, 700));
      const live = await fetchLiveCalls(device);
      const list = Array.isArray(live.json?.livecall)
        ? live.json.livecall
        : Array.isArray(live.json?.message)
          ? live.json.message
          : [];
      const match =
        list.find((item) => {
          const caller = String(item.caller || item.cid_num || "");
          const called = String(item.called || item.dest || "");
          return (
            caller === String(call.extension) ||
            called.includes(String(number).replace(/^0/, "")) ||
            called.includes(String(number))
          );
        }) || list[0];
      uuid = match?.callid || match?.uuid || null;
    } catch {
      // ignore
    }
  }

  return {
    success: true,
    uuid: uuid ? String(uuid) : null,
    message:
      (json.message && String(json.message).toLowerCase() !== "success"
        ? String(json.message)
        : null) ||
      `Ext ${call.extension} auto-answered → ringing ${number}`,
    raw: json,
    transport: "mqtt",
    dialed_number: number,
  };
}

async function executeCall(device, call) {
  if (canUseMqtt(device)) {
    return executeMqttCall(device, call);
  }

  if (canUseHttp(device)) {
    return executeHttpCall(device, call);
  }

  throw new Error(
    "Neron MQTT is not configured. Open API integration → set Host 192.168.0.180, Port 1883, Username, Password, Client ID, Token → Save → Test Neron 20"
  );
}

async function fetchLiveCalls(device) {
  if (canUseMqtt(device)) {
    const json = await mqttRequest(device, "command/system", {
      cmd: "livecall",
    });
    return {
      ok: String(json.status || "").toLowerCase() === "success",
      statusCode: 200,
      json,
      text: JSON.stringify(json),
      transport: "mqtt",
    };
  }

  if (!canUseHttp(device)) {
    return {
      ok: false,
      statusCode: 0,
      json: null,
      text: "MQTT not configured",
      error: "Configure MQTT Host + Token to load live calls",
    };
  }

  const base = deviceHost(device.base_url || device.mqtt_host);
  const url = buildNeronUrl(base, "/onyxcxm/api/liveCalls");
  return neronGet(url);
}

async function fetchCdr(device, query = {}) {
  if (canUseMqtt(device)) {
    try {
      const json = await mqttRequest(device, "cdr", { cmd: "cdr" });
      return { ok: true, statusCode: 200, json, text: JSON.stringify(json) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const base = deviceHost(device.base_url || device.mqtt_host);
  const url = buildNeronUrl(base, "/onyxcxm/api/cdr", query);
  return neronGet(url);
}

async function fetchCallStatus(device) {
  return fetchLiveCalls(device);
}

module.exports = {
  parseUuid,
  normalizeDialNumber,
  shortError,
  buildNeronUrl,
  callParams,
  executeCall,
  fetchLiveCalls,
  fetchCdr,
  fetchCallStatus,
  canUseMqtt,
  canUseHttp,
};
