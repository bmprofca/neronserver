require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { executeCall, fetchLiveCalls } = require("../src/neronClient");

const CLOUD_URL = (process.env.CLOUD_URL || "https://call.bmtaxopc.com").replace(
  /\/$/,
  ""
);
const DEVICE_ID = process.env.DEVICE_ID || "1";
const API_KEY = process.env.API_KEY || "";
const POLL_MS = Number(process.env.POLL_MS) || 3000;

/** Optional local overrides — normally MQTT settings come from cloud API Manager */
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
  if (API_KEY) {
    out["x-api-key"] = API_KEY;
  }
  return out;
}

async function cloudFetch(path, options = {}) {
  const res = await fetch(`${CLOUD_URL}${path}`, {
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
    base_url: `http://${LOCAL_OVERRIDE.mqtt_host || remote.mqtt_host || "192.168.0.180"}`,
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
        `Job ${job.id} ${job.type} -> ${result.success ? "ok" : "fail"}: ${result.message || ""}`
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

  // Keep cloud UI informed that agent can reach Neron MQTT (best-effort)
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

if (!API_KEY) {
  console.warn(
    "WARNING: API_KEY is empty. Generate a key in cloud API Manager and set it in agent/.env"
  );
}

console.log(
  `Neron 20 LAN agent started.\n  Cloud=${CLOUD_URL}\n  device=${DEVICE_ID}\n  poll=${POLL_MS}ms`
);
loop();
setInterval(loop, POLL_MS);
