const crypto = require("crypto");
const net = require("net");
const mqtt = require("mqtt");
const express = require("express");
const { query, ping } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth, requireAdmin);

async function getPrimaryDevice() {
  const rows = await query("SELECT * FROM devices ORDER BY id ASC LIMIT 1");
  return rows[0] || null;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeHost(value) {
  let host = clean(value) || "192.168.0.180";
  host = host
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (
    !host ||
    host === "127.0.0.1" ||
    host.toLowerCase() === "localhost"
  ) {
    host = "192.168.0.180";
  }
  return host;
}

function toPublicDevice(device) {
  if (!device) return null;
  return {
    ...device,
    mqtt_password: device.mqtt_password ? "********" : "",
    has_password: Boolean(device.mqtt_password),
  };
}

router.get("/neron", async (req, res, next) => {
  try {
    const device = await getPrimaryDevice();
    res.json({ status: "success", data: toPublicDevice(device) });
  } catch (err) {
    next(err);
  }
});

router.put("/neron", async (req, res, next) => {
  try {
    const existing = await getPrimaryDevice();
    const body = req.body || {};
    const mode = body.integration_mode === "cloud" ? "cloud" : "local";
    const host = normalizeHost(body.mqtt_host || body.host || existing?.mqtt_host);
    const port = Number(body.mqtt_port || body.port || 1883) || 1883;
    const token = clean(body.mqtt_token) || clean(body.token);
    const keepPassword =
      body.mqtt_password === "********" || body.mqtt_password === undefined;
    const password = keepPassword
      ? existing?.mqtt_password || null
      : clean(body.mqtt_password);

    const values = {
      name: clean(body.name) || "Office Neron 20",
      model: "Neron 20",
      api_enabled: body.api_enabled === false || body.api_enabled === 0 ? 0 : 1,
      integration_mode: mode,
      api_type: mode === "cloud" ? "agent" : "mqtt",
      mqtt_host: host,
      mqtt_port: port,
      mqtt_username: clean(body.mqtt_username) || clean(body.username),
      mqtt_password: password,
      mqtt_client_id:
        clean(body.mqtt_client_id) || clean(body.client_id) || "neron-nxg-01",
      mqtt_token: token,
      base_url: `http://${host}`,
      luci_api_url: clean(body.luci_api_url),
      default_gateway: clean(body.default_gateway),
      notes: clean(body.notes),
      status: existing?.status || "unknown",
    };

    if (!existing) {
      const result = await query(
        `INSERT INTO devices
          (name, model, api_enabled, integration_mode, api_type, mqtt_host,
           mqtt_port, mqtt_username, mqtt_password, mqtt_client_id, mqtt_token,
           base_url, luci_api_url, default_gateway, notes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          values.name,
          values.model,
          values.api_enabled,
          values.integration_mode,
          values.api_type,
          values.mqtt_host,
          values.mqtt_port,
          values.mqtt_username,
          values.mqtt_password,
          values.mqtt_client_id,
          values.mqtt_token,
          values.base_url,
          values.luci_api_url,
          values.default_gateway,
          values.notes,
          values.status,
        ]
      );
      const rows = await query("SELECT * FROM devices WHERE id = ?", [
        result.insertId,
      ]);
      return res.json({ status: "success", data: toPublicDevice(rows[0]) });
    }

    await query(
      `UPDATE devices
       SET name = ?, api_enabled = ?, integration_mode = ?, api_type = ?,
           mqtt_host = ?, mqtt_port = ?, mqtt_username = ?, mqtt_password = ?,
           mqtt_client_id = ?, mqtt_token = ?, base_url = ?, luci_api_url = ?,
           default_gateway = ?, notes = ?
       WHERE id = ?`,
      [
        values.name,
        values.api_enabled,
        values.integration_mode,
        values.api_type,
        values.mqtt_host,
        values.mqtt_port,
        values.mqtt_username,
        values.mqtt_password,
        values.mqtt_client_id,
        values.mqtt_token,
        values.base_url,
        values.luci_api_url,
        values.default_gateway,
        values.notes,
        existing.id,
      ]
    );
    const rows = await query("SELECT * FROM devices WHERE id = ?", [existing.id]);
    res.json({ status: "success", data: toPublicDevice(rows[0]) });
  } catch (err) {
    next(err);
  }
});

function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "Timed out"));
    socket.once("error", (err) => finish(false, err.message));
    socket.connect(port, host);
  });
}

function mqttProbe(config, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const url = `mqtt://${config.host}:${config.port}`;
    const client = mqtt.connect(url, {
      clientId: config.clientId || `neron-test-${Date.now()}`,
      username: config.username || undefined,
      password: config.password || undefined,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      clean: true,
    });

    const timer = setTimeout(() => {
      client.end(true);
      resolve({ ok: false, error: "MQTT connect timed out" });
    }, timeoutMs);

    client.on("connect", () => {
      clearTimeout(timer);
      client.end(true);
      resolve({ ok: true });
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      client.end(true);
      resolve({ ok: false, error: err.message });
    });
  });
}

router.post("/test-cloud", async (req, res) => {
  const started = Date.now();
  try {
    await ping();
    res.json({
      status: "success",
      target: "cloud",
      message: "Cloud / server app OK. API and MySQL are connected.",
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      target: "cloud",
      message: `Server app is up, but MySQL failed: ${err.message}`,
      latency_ms: Date.now() - started,
    });
  }
});

router.post("/test-neron", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const saved = await getPrimaryDevice();
    const host = normalizeHost(
      body.mqtt_host || body.host || saved?.mqtt_host || "192.168.0.180"
    );
    const port = Number(body.mqtt_port || body.port || saved?.mqtt_port || 1883);
    const username =
      clean(body.mqtt_username) ||
      clean(body.username) ||
      saved?.mqtt_username;
    const password =
      body.mqtt_password && body.mqtt_password !== "********"
        ? clean(body.mqtt_password)
        : saved?.mqtt_password;
    const clientId =
      clean(body.mqtt_client_id) ||
      clean(body.client_id) ||
      saved?.mqtt_client_id ||
      "neron-nxg-01";
    const token = clean(body.mqtt_token) || clean(body.token) || saved?.mqtt_token;

    const tcp = await tcpProbe(host, port);
    if (!tcp.ok) {
      if (saved?.id) {
        await query("UPDATE devices SET status = 'offline' WHERE id = ?", [
          saved.id,
        ]);
      }
      return res.status(502).json({
        status: "error",
        target: "neron",
        message: `Cannot reach Neron 20 at ${host}:${port}. ${tcp.error || "Host unreachable from this server."}`,
        latency_ms: Date.now() - started,
        host,
        port,
      });
    }

    const mqttResult = await mqttProbe({
      host,
      port,
      username,
      password,
      clientId,
    });

    if (saved?.id) {
      await query(
        `UPDATE devices
         SET status = ?, last_seen_at = NOW(), mqtt_host = ?, mqtt_port = ?
         WHERE id = ?`,
        [mqttResult.ok ? "online" : "offline", host, port, saved.id]
      );
    }

    if (!mqttResult.ok) {
      return res.status(502).json({
        status: "error",
        target: "neron",
        message: `Port ${port} is open, but MQTT login failed: ${mqttResult.error}. Check Username / Password / Client ID / Token in Neron API Manager.`,
        latency_ms: Date.now() - started,
        host,
        port,
        token_present: Boolean(token),
      });
    }

    res.json({
      status: "success",
      target: "neron",
      message: `Connected to Neron 20 API Manager MQTT at ${host}:${port}.`,
      latency_ms: Date.now() - started,
      host,
      port,
      client_id: clientId,
      token_present: Boolean(token),
      connection_status: "Connected",
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      target: "neron",
      message: err.message,
      latency_ms: Date.now() - started,
    });
  }
});

router.get("/api-keys", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, name,
              CONCAT(LEFT(api_key, 8), '••••••••', RIGHT(api_key, 4)) AS api_key_masked,
              active, created_at
       FROM api_keys
       ORDER BY id DESC`
    );
    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/api-keys", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({
        status: "error",
        message: "Give this key a name, e.g. CRM or LAN Agent",
      });
    }
    const apiKey = `nrn_${crypto.randomBytes(24).toString("hex")}`;
    const result = await query(
      "INSERT INTO api_keys (name, api_key, active) VALUES (?, ?, 1)",
      [name, apiKey]
    );
    res.status(201).json({
      status: "success",
      data: { id: result.insertId, name, api_key: apiKey, active: 1 },
      message: "Copy this key now. It will not be shown in full again.",
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/api-keys/:id", async (req, res, next) => {
  try {
    const result = await query("DELETE FROM api_keys WHERE id = ?", [
      req.params.id,
    ]);
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Key not found" });
    }
    res.json({ status: "success", message: "API key revoked" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
