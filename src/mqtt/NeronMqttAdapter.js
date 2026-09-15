const crypto = require("crypto");
const config = require("../config");

/**
 * Isolates raw Neron MQTT command shapes.
 * Confirmed from live Neron 20 tests: dial uses cmd=dial, caller/callee.
 * Other cmds (deviceInfo, extension_list, trunk_list) per Neron docs — may vary by firmware.
 */
class NeronMqttAdapter {
  constructor(options = {}) {
    this.dial = { ...config.neronDial, ...(options.dial || {}) };
    this.apiVersion = options.apiVersion || "v1.0";
  }

  topic(deviceToken, kind, sub = "") {
    const base = `device/${deviceToken}/api/${this.apiVersion}`;
    if (kind === "command") return `${base}/command/${sub}`;
    if (kind === "response") return `${base}/response`;
    if (kind === "event") return `${base}/event`;
    if (kind === "cdr") return `${base}/cdr`;
    if (kind === "status") return `${base}/status`;
    return `${base}/${kind}${sub ? `/${sub}` : ""}`;
  }

  newRequestId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
  }

  wrap(cmd, extra = {}) {
    return {
      cmd,
      request_id: extra.request_id || this.newRequestId(),
      ...extra,
    };
  }

  getDeviceInfo(requestId) {
    return {
      topicSuffix: "system",
      payload: this.wrap("deviceInfo", { request_id: requestId }),
    };
  }

  getExtensions(requestId) {
    return {
      topicSuffix: "system",
      payload: this.wrap("extension_list", { request_id: requestId }),
    };
  }

  getTrunks(requestId) {
    return {
      topicSuffix: "system",
      payload: this.wrap("trunk_list", { request_id: requestId }),
    };
  }

  /** Click-to-call: ring extension (auto-answer), then dial customer */
  initiateExtensionCall({
    requestId,
    extension,
    phoneNumber,
    gateway,
    autoAnswer = true,
  }) {
    const payload = this.wrap(this.dial.cmd, {
      request_id: requestId,
      [this.dial.callerField]: String(extension),
      [this.dial.calleeField]: String(phoneNumber),
      [this.dial.dialPermissionField]: String(extension),
    });
    if (autoAnswer) {
      payload[this.dial.autoAnswerField] = this.dial.autoAnswerValue;
      payload.auto_answer = "1";
    }
    if (gateway) payload.gateway = gateway;
    return { topicSuffix: "call", payload };
  }

  initiateNumberToNumberCall({
    requestId,
    callerNumber,
    calleeNumber,
    gateway,
  }) {
    // Firmware-dependent; exposed as configurable numCall-style dial
    const payload = this.wrap(this.dial.cmd, {
      request_id: requestId,
      [this.dial.callerField]: String(callerNumber),
      [this.dial.calleeField]: String(calleeNumber),
    });
    if (gateway) payload.gateway = gateway;
    return { topicSuffix: "call", payload };
  }

  hangupCall({ requestId, callId }) {
    return {
      topicSuffix: "call",
      payload: this.wrap("hangup", {
        request_id: requestId,
        callid: callId,
      }),
    };
  }

  liveCall(requestId) {
    return {
      topicSuffix: "system",
      payload: this.wrap("livecall", { request_id: requestId }),
    };
  }

  parseIncoming(topic, raw) {
    let json;
    try {
      json = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return { ok: false, error: "invalid_json", topic };
    }
    if (!json || typeof json !== "object") {
      return { ok: false, error: "invalid_payload", topic };
    }
    const parts = String(topic || "").split("/");
    const deviceToken = parts[1] || null;
    let channel = "unknown";
    if (topic.includes("/response")) channel = "response";
    else if (topic.includes("/event")) channel = "event";
    else if (topic.includes("/cdr")) channel = "cdr";
    else if (topic.includes("/status")) channel = "status";
    else if (topic.includes("/command/")) channel = "command_echo";

    return {
      ok: true,
      deviceToken,
      channel,
      requestId: json.request_id || null,
      callId: json.callid || json.call_id || json.uuid || null,
      event: json.event || null,
      status: json.status || null,
      message: json.message || null,
      json,
      topic,
    };
  }

  isSuccessResponse(json) {
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
}

module.exports = { NeronMqttAdapter };
