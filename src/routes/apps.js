const crypto = require("crypto");
const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { encryptSecret } = require("../security/secrets");
const { subscribeAll, health: mqttHealth, probeDevice } = require("../mqtt/brokerService");
const {
  slugify,
  ensureDefaultApp,
  getAppById,
  resolveAppId,
  getAppDevice,
  publicApp,
  mqttConnectionGuide,
  deviceTokenPlain,
  parseBrokerPublic,
  assertMqttFieldsUnique,
  allocateUniqueMqttCredentials,
  createAppWithBrokerDevice,
} = require("../appsHelper");

const router = express.Router();

router.use(requireAuth);

function sendRouteError(res, err, next) {
  if (err && err.payload && err.status) {
    return res.status(err.status).json(err.payload);
  }
  return next(err);
}

router.get("/", async (req, res, next) => {
  try {
    await ensureDefaultApp();
    // Each account only sees its own app (created at signup)
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT a.*,
         (SELECT COUNT(*) FROM users u WHERE u.app_id = a.id) AS user_count,
         (SELECT COUNT(*) FROM devices d WHERE d.app_id = a.id) AS device_count
       FROM apps a WHERE a.id = ?`,
      [appId]
    );
    res.json({
      status: "success",
      data: rows.map((r) =>
        publicApp(r, {
          user_count: Number(r.user_count || 0),
          device_count: Number(r.device_count || 0),
        })
      ),
    });
  } catch (err) {
    next(err);
  }
});

/** Internal/admin helper — prefer Create account (register) for new businesses. */
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const notes = String(req.body?.notes || "").trim() || null;
    const { app, mqtt } = await createAppWithBrokerDevice(name, { notes });
    res.status(201).json({
      status: "success",
      data: publicApp(app),
      mqtt,
      message:
        "App created with unique Token and Client ID. Prefer Create an account on the login page for new businesses.",
    });
  } catch (err) {
    return sendRouteError(res, err, next);
  }
});

router.get("/current", async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const app = await getAppById(appId);
    const device = await getAppDevice(appId);
    res.json({
      status: "success",
      data: {
        app: publicApp(app),
        device: device
          ? {
              id: device.id,
              name: device.name,
              status: device.status,
              connection_status: device.connection_status || device.status,
              last_seen_at: device.last_seen_at,
              integration_mode: device.integration_mode,
              mqtt_client_id: device.mqtt_client_id,
            }
          : null,
        mqtt_health: mqttHealth(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/mqtt", async (req, res, next) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app) {
      return res.status(404).json({ status: "error", message: "App not found" });
    }
    if (req.user.role !== "admin") {
      const mine = await resolveAppId(req);
      if (mine !== app.id) {
        return res.status(403).json({ status: "error", message: "Not your app" });
      }
    }
    const device = await getAppDevice(app.id);
    res.json({
      status: "success",
      data: mqttConnectionGuide(device, app),
      mqtt_health: mqttHealth(),
    });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/mqtt", requireAdmin, async (req, res, next) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app) {
      return res.status(404).json({ status: "error", message: "App not found" });
    }
    let device = await getAppDevice(app.id);
    const body = req.body || {};
    const rotateToken = Boolean(body.rotate_token);
    const isDefault = Boolean(app.is_default);

    if (rotateToken && isDefault && !body.force_rotate) {
      return res.status(400).json({
        status: "error",
        message:
          "Refusing to rotate Bmtax token — that would drop the live office PBX. Reconfigure the PBX first, then retry with force_rotate=true.",
      });
    }

    const pub = parseBrokerPublic();
    let token = deviceTokenPlain(device);
    let clientId =
      String(body.mqtt_client_id || "").trim() ||
      device?.mqtt_client_id ||
      null;
    let mqttUsername =
      String(body.mqtt_username || "").trim() || device?.mqtt_username || null;
    let mqttPassword =
      body.mqtt_password && body.mqtt_password !== "********"
        ? String(body.mqtt_password).trim()
        : device?.mqtt_password || null;

    if (rotateToken) {
      const allocated = await allocateUniqueMqttCredentials(app.slug, {
        excludeDeviceId: device?.id || null,
      });
      token = body.mqtt_token ? String(body.mqtt_token).trim() : allocated.token;
      if (!String(body.mqtt_client_id || "").trim()) clientId = allocated.clientId;
      if (!String(body.mqtt_username || "").trim()) mqttUsername = allocated.username;
      if (!body.mqtt_password || body.mqtt_password === "********") {
        mqttPassword = allocated.password;
      }
    } else if (body.mqtt_token) {
      token = String(body.mqtt_token).trim();
    }
    if (!token || !clientId || !mqttUsername || !mqttPassword) {
      const allocated = await allocateUniqueMqttCredentials(app.slug, {
        excludeDeviceId: device?.id || null,
      });
      if (!token) token = allocated.token;
      if (!clientId) clientId = allocated.clientId;
      if (!mqttUsername) mqttUsername = allocated.username;
      if (!mqttPassword) mqttPassword = allocated.password;
    }

    await assertMqttFieldsUnique({
      token,
      clientId,
      username: mqttUsername,
      excludeDeviceId: device?.id || null,
    });

    const name =
      String(body.device_name || "").trim() ||
      device?.name ||
      `${app.name} PBX`;
    const gateway = String(body.default_gateway || "").trim() || device?.default_gateway || null;

    if (!device) {
      const result = await query(
        `INSERT INTO devices
          (name, model, api_enabled, integration_mode, api_type,
           mqtt_host, mqtt_port, mqtt_client_id, mqtt_token, mqtt_token_enc,
           mqtt_username, mqtt_password, default_gateway, status, connection_status, notes,
           app_id, organization_id)
         VALUES (?, 'Neron 20', 1, 'broker', 'broker', ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'unknown', ?, ?, ?)`,
        [
          name,
          pub.host,
          pub.port,
          clientId,
          token,
          encryptSecret(token),
          mqttUsername,
          mqttPassword,
          gateway,
          `MQTT broker integration for ${app.name}`,
          app.id,
          app.id,
        ]
      );
      device = (await query("SELECT * FROM devices WHERE id = ?", [result.insertId]))[0];
      try {
        const { provisionBrokerUser } = require("../mqtt/brokerUsers");
        await provisionBrokerUser(mqttUsername, mqttPassword);
      } catch (err) {
        console.warn("[apps] broker user provision:", err.message);
      }
    } else {
      const keepToken = !rotateToken && !body.mqtt_token;
      const nextToken = keepToken ? deviceTokenPlain(device) || token : token;
      await assertMqttFieldsUnique({
        token: nextToken,
        clientId,
        username: mqttUsername,
        excludeDeviceId: device.id,
      });
      await query(
        `UPDATE devices SET
           name = ?, api_enabled = 1, integration_mode = 'broker', api_type = 'broker',
           mqtt_host = ?, mqtt_port = ?, mqtt_client_id = ?,
           mqtt_token = ?, mqtt_token_enc = ?,
           mqtt_username = ?, mqtt_password = ?,
           default_gateway = COALESCE(?, default_gateway),
           app_id = ?, organization_id = ?
         WHERE id = ?`,
        [
          name,
          pub.host,
          pub.port,
          clientId,
          nextToken,
          encryptSecret(nextToken),
          mqttUsername,
          mqttPassword,
          gateway,
          app.id,
          app.id,
          device.id,
        ]
      );
      device = (await query("SELECT * FROM devices WHERE id = ?", [device.id]))[0];
      if (rotateToken || body.mqtt_username || body.mqtt_password) {
        try {
          const { provisionBrokerUser } = require("../mqtt/brokerUsers");
          await provisionBrokerUser(mqttUsername, mqttPassword);
        } catch (err) {
          console.warn("[apps] broker user provision:", err.message);
        }
      }
    }

    try {
      await subscribeAll();
    } catch {
      /* ignore */
    }

    res.json({
      status: "success",
      data: mqttConnectionGuide(device, app),
      mqtt_health: mqttHealth(),
      message: "MQTT integration saved. Enter the same fields on your in-house PBX.",
    });
  } catch (err) {
    return sendRouteError(res, err, next);
  }
});

router.post("/:id/mqtt/test", requireAdmin, async (req, res, next) => {
  const started = Date.now();
  try {
    const app = await getAppById(req.params.id);
    if (!app) {
      return res.status(404).json({ status: "error", message: "App not found" });
    }
    const device = await getAppDevice(app.id);
    const mh = mqttHealth();
    if (!mh.brokerConfigured || !mh.connected) {
      return res.status(503).json({
        status: "error",
        message: "VPS CRM is not connected to the MQTT broker. Check server MQTT_BROKER_URL.",
        mqtt: mh,
        latency_ms: Date.now() - started,
      });
    }
    if (!device || !deviceTokenPlain(device)) {
      return res.status(400).json({
        status: "error",
        message: "Save MQTT integration (device token) for this app first.",
        latency_ms: Date.now() - started,
      });
    }
    try {
      await probeDevice(device, 10000);
    } catch (err) {
      return res.status(502).json({
        status: "error",
        message: `Broker up, but PBX did not answer MQTT probe (${err.message}). Match Host/Port/User/Pass/Token/Client ID on the PBX.`,
        connection_status: "Disconnected",
        mqtt: mh,
        latency_ms: Date.now() - started,
      });
    }
    res.json({
      status: "success",
      message: `${app.name} PBX answered MQTT probe — connection alive.`,
      connection_status: "Connected",
      mqtt: mh,
      latency_ms: Date.now() - started,
      data: mqttConnectionGuide(device, app),
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app) {
      return res.status(404).json({ status: "error", message: "App not found" });
    }
    const name = String(req.body?.name || app.name).trim();
    const notes =
      req.body?.notes !== undefined ? String(req.body.notes || "").trim() : app.notes;
    const status =
      req.body?.status === "disabled" && !app.is_default ? "disabled" : "active";
    await query("UPDATE apps SET name = ?, notes = ?, status = ? WHERE id = ?", [
      name,
      notes || null,
      status,
      app.id,
    ]);
    const rows = await query("SELECT * FROM apps WHERE id = ?", [app.id]);
    res.json({ status: "success", data: publicApp(rows[0]) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
