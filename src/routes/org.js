const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");
const {
  adapter,
  sendDeviceCommand,
  setExtensionStatus,
} = require("../mqtt/brokerService");
const { decryptSecret } = require("../security/secrets");

const router = express.Router();

async function getAppDevice(appId) {
  const rows = await query(
    `SELECT * FROM devices
     WHERE app_id = ? AND api_enabled = 1
     ORDER BY (integration_mode = 'broker' OR api_type = 'broker') DESC, id ASC
     LIMIT 1`,
    [appId]
  );
  if (rows[0]) return rows[0];
  const any = await query("SELECT * FROM devices ORDER BY id ASC LIMIT 1");
  return any[0] || null;
}

function deviceForMqtt(device) {
  if (!device) return null;
  return {
    ...device,
    deviceToken:
      decryptSecret(device.mqtt_token_enc) ||
      decryptSecret(device.mqtt_token) ||
      device.mqtt_token,
  };
}

function parseExtensionList(response) {
  const json = response || {};
  let list =
    json.extensions ||
    json.extension_list ||
    json.extensionlist ||
    json.message ||
    json.data ||
    json.list ||
    [];
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = Object.values(list);
  }
  if (!Array.isArray(list)) list = [];

  const out = [];
  for (const item of list) {
    if (item == null) continue;
    if (typeof item === "string" || typeof item === "number") {
      const number = String(item).trim();
      if (number) out.push({ number, type: "sip", status: "unknown", username: number });
      continue;
    }
    if (typeof item !== "object") continue;
    const number = String(
      item.extension ||
        item.exten ||
        item.number ||
        item.ext ||
        item.id ||
        item.username ||
        ""
    ).trim();
    if (!number) continue;
    out.push({
      number,
      type: String(item.type || item.ext_type || item.protocol || "sip").toLowerCase(),
      status: String(item.status || item.state || item.presence || "unknown"),
      username: String(item.username || item.name || number),
      port: item.port != null ? String(item.port) : "",
    });
  }
  return out;
}

function parseTrunkList(response) {
  const json = response || {};
  let list = json.trunks || json.trunk_list || json.message || json.data || [];
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = Object.values(list);
  }
  if (!Array.isArray(list)) list = [];
  return list
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      return {
        name: String(t.name || t.trunk || t.id || "Trunk"),
        type: String(t.type || t.protocol || ""),
        status: String(t.status || t.state || "unknown"),
        port: t.port != null ? String(t.port) : "",
        vbat: t.vbat != null ? String(t.vbat) : "",
      };
    })
    .filter(Boolean);
}

async function loadMappedUsers(appId) {
  const users = await query(
    `SELECT id, name, mobile, extension, role, status
     FROM users
     WHERE (app_id = ? OR app_id IS NULL)
       AND extension IS NOT NULL AND extension != ''
     ORDER BY name ASC`,
    [appId]
  );
  const byExt = new Map();
  for (const u of users) {
    const n = String(u.extension).trim();
    if (!byExt.has(n)) byExt.set(n, []);
    byExt.get(n).push({
      id: String(u.id),
      name: u.name,
      email: u.mobile || "",
      mobile: u.mobile || "",
      role: u.role,
      isActive: u.status === "active",
      status: u.status,
    });
  }
  return byExt;
}

async function listExtensionsPayload(appId) {
  const device = await getAppDevice(appId);
  const byExt = await loadMappedUsers(appId);
  let rows = [];
  if (device?.id) {
    rows = await query(
      `SELECT extension_number, extension_name, extension_type, current_status, last_status_at
       FROM pbx_extensions WHERE pbx_device_id = ?
       ORDER BY extension_number ASC`,
      [device.id]
    );
  }

  const numbers = new Set([
    ...rows.map((r) => String(r.extension_number)),
    ...byExt.keys(),
  ]);

  const data = [...numbers]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((number) => {
      const row = rows.find((r) => String(r.extension_number) === number);
      return {
        number,
        username: row?.extension_name || number,
        type: row?.extension_type || "sip",
        status: row?.current_status || "unknown",
        lastStatusAt: row?.last_status_at || null,
        mapped: byExt.get(number) || [],
      };
    });

  return { deviceId: device?.id || null, data };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const keys = await query(
      `SELECT api_key FROM api_keys
       WHERE active = 1 AND (app_id = ? OR app_id IS NULL)
       ORDER BY id DESC LIMIT 1`,
      [appId]
    );
    const apps = await query(
      `SELECT crm_webhook_url, crm_webhook_secret, crm_lookup_url, crm_lookup_auth_header
       FROM apps WHERE id = ? LIMIT 1`,
      [appId]
    );
    const app = apps[0] || {};
    res.json({
      status: "success",
      data: {
        appId,
        crmApiKey: keys[0]?.api_key || "",
        crmWebhookUrl: app.crm_webhook_url || "",
        crmWebhookSecret: app.crm_webhook_secret || "",
        crmLookupUrl: app.crm_lookup_url || "",
        crmLookupAuthHeader: app.crm_lookup_auth_header || "",
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Alias used by CRM hub UI */
router.put("/crm", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    await query(
      `UPDATE apps SET
        crm_webhook_url = ?,
        crm_webhook_secret = ?,
        crm_lookup_url = ?,
        crm_lookup_auth_header = ?
       WHERE id = ?`,
      [
        String(body.crmWebhookUrl || "").trim() || null,
        String(body.crmWebhookSecret || "").trim() || null,
        String(body.crmLookupUrl || "").trim() || null,
        String(body.crmLookupAuthHeader || "").trim() || null,
        appId,
      ]
    );
    const apps = await query(
      `SELECT crm_webhook_url, crm_webhook_secret, crm_lookup_url, crm_lookup_auth_header
       FROM apps WHERE id = ? LIMIT 1`,
      [appId]
    );
    const app = apps[0] || {};
    res.json({
      status: "success",
      data: {
        crmWebhookUrl: app.crm_webhook_url || "",
        crmWebhookSecret: app.crm_webhook_secret || "",
        crmLookupUrl: app.crm_lookup_url || "",
        crmLookupAuthHeader: app.crm_lookup_auth_header || "",
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/extensions", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const { data } = await listExtensionsPayload(appId);
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
});

/** Pull live extension_list from Neron over MQTT and store in pbx_extensions. */
router.post("/extensions/sync", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const device = deviceForMqtt(await getAppDevice(appId));
    if (!device?.deviceToken) {
      return res.status(400).json({
        status: "error",
        message: "No broker PBX device / token. Configure MQTT / PBX first.",
      });
    }
    device._crmUserId = req.user?.id || null;

    const result = await sendDeviceCommand(
      device,
      (requestId) => adapter.getExtensions(requestId),
      { wait: true, timeoutMs: 12000 }
    );
    const parsed = parseExtensionList(result.response);
    for (const ext of parsed) {
      await query(
        `INSERT INTO pbx_extensions
          (pbx_device_id, extension_number, extension_name, extension_type, current_status, last_status_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           extension_name = VALUES(extension_name),
           extension_type = VALUES(extension_type),
           current_status = VALUES(current_status),
           last_status_at = NOW()`,
        [
          device.id,
          ext.number,
          ext.username || ext.number,
          ext.type || "sip",
          ext.status || "unknown",
        ]
      );
      if (ext.status) {
        await setExtensionStatus(device.id, ext.number, ext.status).catch(() => {});
      }
    }

    const { data } = await listExtensionsPayload(appId);
    res.json({
      status: "success",
      message: parsed.length
        ? `Synced ${parsed.length} extension${parsed.length === 1 ? "" : "s"} from PBX`
        : "PBX replied but no extensions were parsed — check Neron API Manager",
      data,
      synced: parsed.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/trunks", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const device = deviceForMqtt(await getAppDevice(appId));
    if (!device?.deviceToken) {
      return res.json({ status: "success", data: [] });
    }
    device._crmUserId = req.user?.id || null;
    try {
      const result = await sendDeviceCommand(
        device,
        (requestId) => adapter.getTrunks(requestId),
        { wait: true, timeoutMs: 8000 }
      );
      return res.json({
        status: "success",
        data: parseTrunkList(result.response),
      });
    } catch {
      return res.json({ status: "success", data: [] });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
