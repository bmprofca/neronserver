const { query } = require("./db");
const config = require("./config");
const { decryptSecret } = require("./security/secrets");

function slugify(name) {
  return String(name || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "app";
}

function parseBrokerPublic() {
  const overrideIp = String(
    process.env.MQTT_PUBLIC_IP || process.env.VPS_PUBLIC_IP || ""
  ).trim();
  const overrideHost = String(process.env.MQTT_PUBLIC_HOST || "").trim();
  const overridePort = Number(process.env.MQTT_PUBLIC_PORT || 0);
  let hostname = overrideHost;
  let port = overridePort || 0;
  let tls = false;
  const url = String(config.mqtt.brokerUrl || "").trim();
  if (url) {
    try {
      const u = new URL(url);
      if (!hostname) hostname = u.hostname;
      if (!port) port = Number(u.port) || (u.protocol === "mqtt:" ? 1883 : 8883);
      tls = u.protocol === "mqtts:" || u.protocol === "wss:" || port === 8883;
    } catch {
      /* ignore */
    }
  }
  if (!hostname) hostname = "ipbx.bmtaxopc.com";
  if (!port) port = 1883;

  const isIpv4 = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v || ""));
  // Always expose a numeric VPS IP for DNS-fail cases
  let ip = isIpv4(overrideIp)
    ? overrideIp
    : isIpv4(hostname)
      ? hostname
      : "201.18.192.212";

  return {
    ip,
    hostname: isIpv4(hostname) ? "ipbx.bmtaxopc.com" : hostname,
    host: ip,
    port,
    tls,
    cloudApiUrl:
      String(process.env.PUBLIC_API_URL || "").trim() ||
      "https://ipbx.bmtaxopc.com",
  };
}

async function ensureDefaultApp() {
  const existing = await query(
    `SELECT * FROM apps WHERE slug = 'bmtax' OR name = 'Bmtax' ORDER BY id ASC LIMIT 1`
  );
  if (existing[0]) return existing[0];

  const result = await query(
    `INSERT INTO apps (name, slug, status, is_default, notes)
     VALUES ('Bmtax', 'bmtax', 'active', 1, 'Default app — migrated from current live PBX / MQTT setup')`
  );
  const rows = await query("SELECT * FROM apps WHERE id = ?", [result.insertId]);
  return rows[0];
}

async function getAppById(id) {
  if (!id) return null;
  const rows = await query("SELECT * FROM apps WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

/**
 * Resolve which app the request operates on.
 * Agents: always their users.app_id.
 * Admins: X-App-Id / ?app_id / body.app_id, else their users.app_id, else default Bmtax.
 */
async function resolveAppId(req) {
  const header =
    Number(req.get?.("x-app-id") || req.query?.app_id || req.body?.app_id || 0) ||
    0;

  let userAppId = null;
  if (req.user?.id) {
    const rows = await query("SELECT app_id, role FROM users WHERE id = ? LIMIT 1", [
      req.user.id,
    ]);
    if (rows[0]) {
      userAppId = rows[0].app_id || null;
      const isAdmin = rows[0].role === "admin" || req.user.role === "admin";
      if (!isAdmin) return userAppId;
      if (header) {
        const app = await getAppById(header);
        if (app) return app.id;
      }
      if (userAppId) return userAppId;
    }
  }

  if (req.apiClient?.app_id) return req.apiClient.app_id;

  if (header) {
    const app = await getAppById(header);
    if (app) return app.id;
  }

  const def = await ensureDefaultApp();
  return def.id;
}

async function getAppDevice(appId) {
  if (!appId) return null;
  const rows = await query(
    `SELECT * FROM devices
     WHERE app_id = ? AND api_enabled = 1
     ORDER BY
       CASE WHEN integration_mode = 'broker' OR api_type = 'broker' THEN 0 ELSE 1 END,
       id ASC
     LIMIT 1`,
    [appId]
  );
  if (rows[0]) return rows[0];
  const any = await query(
    "SELECT * FROM devices WHERE app_id = ? ORDER BY id ASC LIMIT 1",
    [appId]
  );
  return any[0] || null;
}

function deviceTokenPlain(device) {
  if (!device) return null;
  return (
    decryptSecret(device.mqtt_token_enc) ||
    decryptSecret(device.mqtt_token) ||
    device.mqtt_token ||
    null
  );
}

function maskMiddle(value, keep = 6) {
  const s = String(value || "");
  if (s.length <= keep * 2) return s ? `${s.slice(0, 2)}…${s.slice(-2)}` : "";
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/**
 * Ensure Token / Client ID are not reused by another app's PBX device.
 * Returns [] if OK, or conflict objects for a 409 response.
 */
async function findMqttUniqueConflicts({
  token,
  clientId,
  username,
  excludeDeviceId = null,
} = {}) {
  const rows = await query(
    `SELECT d.id, d.name, d.app_id, d.mqtt_client_id, d.mqtt_token, d.mqtt_token_enc,
            d.mqtt_username,
            a.name AS app_name, a.slug AS app_slug, a.is_default
     FROM devices d
     LEFT JOIN apps a ON a.id = d.app_id
     WHERE (d.mqtt_token IS NOT NULL AND d.mqtt_token != '')
        OR (d.mqtt_client_id IS NOT NULL AND d.mqtt_client_id != '')
        OR (d.mqtt_username IS NOT NULL AND d.mqtt_username != '')`
  );

  const conflicts = [];
  const wantToken = token ? String(token).trim() : "";
  const wantClient = clientId ? String(clientId).trim() : "";
  const wantUser = username ? String(username).trim() : "";

  for (const row of rows) {
    if (excludeDeviceId && Number(row.id) === Number(excludeDeviceId)) continue;
    const plain = deviceTokenPlain(row);
    if (wantToken && plain && plain === wantToken) {
      conflicts.push({
        field: "token",
        field_label: "Token / Device token",
        value: maskMiddle(wantToken),
        value_full_hint: "matches another app's MQTT device token",
        used_by_app_id: row.app_id,
        used_by_app_name: row.app_name || `App #${row.app_id || "?"}`,
        used_by_app_slug: row.app_slug || null,
        used_by_device_id: row.id,
        used_by_device_name: row.name || `Device #${row.id}`,
        is_default_app: Boolean(row.is_default),
      });
    }
    if (wantClient && row.mqtt_client_id && String(row.mqtt_client_id) === wantClient) {
      conflicts.push({
        field: "client_id",
        field_label: "Client ID",
        value: wantClient,
        value_full_hint: "exact Client ID already assigned",
        used_by_app_id: row.app_id,
        used_by_app_name: row.app_name || `App #${row.app_id || "?"}`,
        used_by_app_slug: row.app_slug || null,
        used_by_device_id: row.id,
        used_by_device_name: row.name || `Device #${row.id}`,
        is_default_app: Boolean(row.is_default),
      });
    }
    if (wantUser && row.mqtt_username && String(row.mqtt_username) === wantUser) {
      conflicts.push({
        field: "username",
        field_label: "MQTT Username",
        value: wantUser,
        value_full_hint: "exact broker username already assigned to another app",
        used_by_app_id: row.app_id,
        used_by_app_name: row.app_name || `App #${row.app_id || "?"}`,
        used_by_app_slug: row.app_slug || null,
        used_by_device_id: row.id,
        used_by_device_name: row.name || `Device #${row.id}`,
        is_default_app: Boolean(row.is_default),
      });
    }
  }
  return conflicts;
}

function conflictErrorPayload(conflicts) {
  const lines = conflicts.map((c) => {
    const appBit = c.used_by_app_slug
      ? `"${c.used_by_app_name}" (slug: ${c.used_by_app_slug}, app id: ${c.used_by_app_id})`
      : `"${c.used_by_app_name}" (app id: ${c.used_by_app_id})`;
    const defaultNote = c.is_default_app ? " [DEFAULT / live Bmtax — do not reuse]" : "";
    return (
      `${c.field_label} value "${c.value}" is already used by another app: ${appBit}, ` +
      `device "${c.used_by_device_name}" (device id: ${c.used_by_device_id})${defaultNote}. ` +
      `Detail: ${c.value_full_hint}. Each app must have its own unique ${c.field_label}.`
    );
  });
  return {
    status: "error",
    message: lines.join(" | "),
    code: "UNIQUE_FIELD_CONFLICT",
    conflicts,
    hint:
      "On Create account, Token, Client ID, Username and Password are generated uniquely. Do not paste another app’s MQTT credentials. Host/Port may be shared on this VPS broker.",
  };
}

async function assertMqttFieldsUnique(opts) {
  const conflicts = await findMqttUniqueConflicts(opts);
  if (conflicts.length) {
    const err = new Error(conflictErrorPayload(conflicts).message);
    err.status = 409;
    err.payload = conflictErrorPayload(conflicts);
    throw err;
  }
}

async function allocateUniqueMqttCredentials(slug, { excludeDeviceId = null } = {}) {
  const crypto = require("crypto");
  for (let i = 0; i < 8; i += 1) {
    const token = `nxg-${crypto.randomBytes(16).toString("hex")}`;
    const clientId = `neron-${String(slug || "app").slice(0, 16)}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    const userSlug = String(slug || "app")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 10)
      .toLowerCase() || "app";
    const username = `nrn_${userSlug}_${crypto.randomBytes(3).toString("hex")}`;
    const password = crypto.randomBytes(12).toString("hex");
    const conflicts = await findMqttUniqueConflicts({
      token,
      clientId,
      username,
      excludeDeviceId,
    });
    if (!conflicts.length) return { token, clientId, username, password };
  }
  throw new Error("Could not allocate unique MQTT credentials");
}

/**
 * Create a new app + broker device with unique Token / Client ID.
 * Used by Create account (register) so each business gets its own PBX MQTT identity.
 */
async function createAppWithBrokerDevice(appName, { notes = null } = {}) {
  const crypto = require("crypto");
  const { encryptSecret } = require("./security/secrets");
  const name = String(appName || "").trim();
  if (!name) {
    const err = new Error("Company / app name is required");
    err.status = 400;
    err.payload = { status: "error", message: err.message };
    throw err;
  }

  let slug = slugify(name);
  const nameClash = await query(
    `SELECT id, name, slug FROM apps WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    [name]
  );
  if (nameClash[0]) {
    const err = new Error(
      `Company / app name "${name}" is already used by app id ${nameClash[0].id} (slug: ${nameClash[0].slug}). Choose a different name.`
    );
    err.status = 409;
    err.payload = {
      status: "error",
      code: "UNIQUE_FIELD_CONFLICT",
      message: err.message,
      conflicts: [
        {
          field: "name",
          field_label: "Company / app name",
          value: name,
          used_by_app_id: nameClash[0].id,
          used_by_app_name: nameClash[0].name,
          used_by_app_slug: nameClash[0].slug,
        },
      ],
      hint: "Each business account needs a unique company name. MQTT Token and Client ID are generated uniquely for you.",
    };
    throw err;
  }

  const slugClash = await query("SELECT id FROM apps WHERE slug = ? LIMIT 1", [slug]);
  if (slugClash[0]) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;

  const result = await query(
    `INSERT INTO apps (name, slug, status, is_default, notes)
     VALUES (?, ?, 'active', 0, ?)`,
    [name, slug, notes]
  );
  const appId = result.insertId;

  const { token, clientId, username, password } =
    await allocateUniqueMqttCredentials(slug);
  await assertMqttFieldsUnique({ token, clientId, username });

  const pub = parseBrokerPublic();
  await query(
    `INSERT INTO devices
      (name, model, api_enabled, integration_mode, api_type,
       mqtt_host, mqtt_port, mqtt_client_id, mqtt_token, mqtt_token_enc,
       mqtt_username, mqtt_password, status, connection_status, notes, app_id, organization_id)
     VALUES (?, 'Neron 20', 1, 'broker', 'broker', ?, ?, ?, ?, ?, ?, ?, 'unknown', 'unknown', ?, ?, ?)`,
    [
      `${name} PBX`,
      pub.host,
      pub.port,
      clientId,
      token,
      encryptSecret(token),
      username,
      password,
      notes ||
        `Broker mode for ${name}. Unique MQTT Username/Password/Token/Client ID — configure in-house Neron System → API.`,
      appId,
      appId,
    ]
  );

  try {
    const { provisionBrokerUser } = require("./mqtt/brokerUsers");
    await provisionBrokerUser(username, password);
  } catch (err) {
    console.warn("[apps] broker user provision:", err.message);
  }

  try {
    const { subscribeAll } = require("./mqtt/brokerService");
    await subscribeAll();
  } catch {
    /* broker may be offline */
  }

  const rows = await query("SELECT * FROM apps WHERE id = ?", [appId]);
  const device = await getAppDevice(appId);
  return { app: rows[0], device, mqtt: mqttConnectionGuide(device, rows[0]) };
}

function publicApp(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    is_default: Boolean(row.is_default),
    notes: row.notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

function mqttConnectionGuide(device, app) {
  const pub = parseBrokerPublic();
  const token = deviceTokenPlain(device);
  const clientId =
    device?.mqtt_client_id ||
    `neron-${(app?.slug || "app").slice(0, 20)}-${device?.id || "1"}`;

  return {
    mode: "broker",
    app: publicApp(app),
    device_id: device?.id || null,
    device_name: device?.name || null,
    connection_status:
      device?.connection_status || device?.status || "unknown",
    last_seen_at: device?.last_seen_at || null,
    server: {
      vps_ip: pub.ip,
      mqtt_host: pub.ip,
      mqtt_hostname: pub.hostname,
      mqtt_port: pub.port,
      mqtt_tls: pub.tls,
      cloud_api: pub.cloudApiUrl,
    },
    /** Values to enter on in-house PBX: System → API / MQTT */
    pbx_fields: {
      mqtt_api_enable: "On",
      host: pub.ip,
      host_hostname: pub.hostname,
      port: String(pub.port),
      enable_tls: pub.tls ? "On" : "Off",
      username:
        device?.mqtt_username ||
        config.mqtt.username ||
        "(leave blank if broker allows anonymous)",
      password:
        device?.mqtt_password ||
        (config.mqtt.password ? config.mqtt.password : "(leave blank if unused)"),
      client_id: clientId,
      token: token || "(save a device token in this app first)",
      keepalive: String(config.mqtt.keepalive || 60),
      reconnect: "Enabled",
    },
    topics: token
      ? {
          command: `device/${token}/api/v1.0/command/#`,
          response: `device/${token}/api/v1.0/response`,
          event: `device/${token}/api/v1.0/event`,
          cdr: `device/${token}/api/v1.0/cdr`,
          status: `device/${token}/api/v1.0/status`,
        }
      : null,
    notes: [
      `Use Host = ${pub.ip} when DNS fails; ${pub.hostname} when DNS works.`,
      "Username, Password, Token, and Client ID are unique per app — enter them exactly on that site’s PBX.",
      "Do not reuse another business’s MQTT login or Token.",
      "Do not change the Bmtax credentials unless you also update the office PBX.",
    ],
  };
}

module.exports = {
  slugify,
  parseBrokerPublic,
  ensureDefaultApp,
  getAppById,
  resolveAppId,
  getAppDevice,
  deviceTokenPlain,
  publicApp,
  mqttConnectionGuide,
  findMqttUniqueConflicts,
  conflictErrorPayload,
  assertMqttFieldsUnique,
  allocateUniqueMqttCredentials,
  createAppWithBrokerDevice,
};
