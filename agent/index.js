require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { executeCall } = require("../src/neronClient");

const CLOUD_URL = (process.env.CLOUD_URL || "http://localhost:5000").replace(
  /\/$/,
  ""
);
const DEVICE_ID = process.env.DEVICE_ID || "1";
const API_KEY = process.env.API_KEY || "";
const NERON_BASE_URL = process.env.NERON_BASE_URL || "http://127.0.0.1";
const POLL_MS = Number(process.env.POLL_MS) || 3000;

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
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.message || `Cloud API ${res.status}`);
  }
  return json;
}

async function heartbeat() {
  await cloudFetch(`/api/devices/${DEVICE_ID}/heartbeat`, { method: "POST" });
}

async function poll() {
  const pending = await cloudFetch(`/api/jobs/pending?device_id=${DEVICE_ID}`);
  const jobs = pending.data || [];

  for (const job of jobs) {
    try {
      const result = await executeCall(
        { base_url: NERON_BASE_URL },
        job
      );
      await cloudFetch(`/api/jobs/${job.id}/result`, {
        method: "POST",
        body: JSON.stringify({
          status: job.type === "hangup" && result.success ? "hungup" : result.success ? "success" : "failed",
          uuid: result.uuid,
          message: result.message,
          raw: result.raw,
        }),
      });
      console.log(`Job ${job.id} ${job.type} -> ${result.success ? "ok" : "fail"}`);
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
}

async function loop() {
  try {
    await heartbeat();
    await poll();
  } catch (err) {
    console.error("Agent cycle failed:", err.message);
  }
}

console.log(
  `Neron 20 LAN agent started. Cloud=${CLOUD_URL} device=${DEVICE_ID} neron=${NERON_BASE_URL}`
);
loop();
setInterval(loop, POLL_MS);
