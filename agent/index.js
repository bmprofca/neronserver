/**
 * Neron 20 LAN Agent
 * Double-click NeronLanAgent.exe (or run-agent.cmd).
 * Keep this window open while making cloud calls.
 */
const fs = require("fs");
const path = require("path");

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

function loadEnvFile(filePath, override = true) {
  if (!fs.existsSync(filePath)) return;
  require("dotenv").config({ path: filePath, override });
}

// Parent server/.env first (DB etc.) — do not let empty API_KEY wipe agent key
loadEnvFile(path.join(baseDir, "..", ".env"), false);
loadEnvFile(path.join(baseDir, "NeronLanAgent.env"), true);
loadEnvFile(path.join(baseDir, ".env"), true);

const { executeCall, fetchLiveCalls } = require("../src/neronClient");

const CLOUD_URL = (process.env.CLOUD_URL || "https://call.bmtaxopc.com").replace(
  /\/$/,
  ""
);
const DEVICE_ID = process.env.DEVICE_ID || "1";
const API_KEY = process.env.API_KEY || "";
const POLL_MS = Number(process.env.POLL_MS) || 3000;

const LOCAL_OVERRIDE = {
  mqtt_host: process.env.NERON_HOST || process.env.MQTT_HOST || null,
  mqtt_port: process.env.NERON_PORT || process.env.MQTT_PORT || null,
  mqtt_username: process.env.MQTT_USERNAME || null,
  mqtt_password: process.env.MQTT_PASSWORD || null,
  mqtt_client_id: process.env.MQTT_CLIENT_ID || null,
  mqtt_token: process.env.MQTT_TOKEN || null,
};

function headers() {
  const out = { "Content-Type": "application/json" };
  if (API_KEY) out["x-api-key"] = API_KEY;
  return out;
}

async function cloudFetch(pathName, options = {}) {
  const res = await fetch(`${CLOUD_URL}${pathName}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || `Cloud API ${res.status}`);
  }
  return json;
}

let cachedDevice = null;
let cachedAt = 0;

async function loadDevice(force = false) {
  if (!force && cachedDevice && Date.now() - cachedAt < 15000) {
    return cachedDevice;
  }
  const json = await cloudFetch(`/api/devices/${DEVICE_ID}/agent-config`);
  const remote = json.data || {};
  cachedDevice = {
    ...remote,
    mqtt_host: LOCAL_OVERRIDE.mqtt_host || remote.mqtt_host || "192.168.0.180",
    mqtt_port: Number(LOCAL_OVERRIDE.mqtt_port || remote.mqtt_port || 1883),
    mqtt_username: LOCAL_OVERRIDE.mqtt_username || remote.mqtt_username,
    mqtt_password: LOCAL_OVERRIDE.mqtt_password || remote.mqtt_password,
    mqtt_client_id: LOCAL_OVERRIDE.mqtt_client_id || remote.mqtt_client_id,
    mqtt_token: LOCAL_OVERRIDE.mqtt_token || remote.mqtt_token,
    api_enabled: 1,
    api_type: "mqtt",
    base_url: `http://${
      LOCAL_OVERRIDE.mqtt_host || remote.mqtt_host || "192.168.0.180"
    }`,
  };
  cachedAt = Date.now();
  return cachedDevice;
}

async function heartbeat() {
  await cloudFetch(`/api/devices/${DEVICE_ID}/heartbeat`, { method: "POST" });
}

async function poll() {
  const device = await loadDevice();
  if (!device.mqtt_token) {
    throw new Error(
      "No MQTT token on cloud device. Set Token in API Manager on call.bmtaxopc.com and Save."
    );
  }

  const pending = await cloudFetch(`/api/jobs/pending?device_id=${DEVICE_ID}`);
  const jobs = pending.data || [];

  for (const job of jobs) {
    try {
      const payload =
        job.type === "hangup"
          ? { type: "hangup", uuid: job.uuid }
          : {
              ...job,
              gateway: job.gateway || device.default_gateway,
            };
      const result = await executeCall(device, payload);
      await cloudFetch(`/api/jobs/${job.id}/result`, {
        method: "POST",
        body: JSON.stringify({
          status:
            job.type === "hangup" && result.success
              ? "hungup"
              : result.success
                ? "success"
                : "failed",
          uuid: result.uuid || job.uuid,
          message: result.message,
          raw: result.raw,
        }),
      });
      console.log(
        `Job ${job.id} ${job.type} -> ${result.success ? "ok" : "fail"}: ${
          result.message || ""
        }`
      );
    } catch (err) {
      await cloudFetch(`/api/jobs/${job.id}/result`, {
        method: "POST",
        body: JSON.stringify({
          status: "failed",
          message: err.message,
        }),
      });
      console.error(`Job ${job.id} failed:`, err.message);
    }
  }

  try {
    await fetchLiveCalls(device);
  } catch {
    /* ignore */
  }
}

async function loop() {
  try {
    await heartbeat();
    await poll();
  } catch (err) {
    console.error("Agent cycle failed:", err.message);
    cachedDevice = null;
  }
}

function banner() {
  console.log("========================================");
  console.log("  Neron 20 LAN Agent");
  console.log("========================================");
  console.log(`  Cloud : ${CLOUD_URL}`);
  console.log(`  Device: ${DEVICE_ID}`);
  console.log(`  Poll  : ${POLL_MS}ms`);
  console.log(`  Config: ${path.join(baseDir, "NeronLanAgent.env")} or .env`);
  console.log("  Keep this window OPEN while dialing.");
  console.log("  Press Ctrl+C to stop.");
  console.log("========================================");
  if (!API_KEY) {
    console.warn(
      "WARNING: API_KEY is empty. Edit NeronLanAgent.env next to this program."
    );
  }
}

banner();
loop();
setInterval(loop, POLL_MS);
