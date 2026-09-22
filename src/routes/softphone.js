const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAuthOrKey, requireAdmin } = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");
const { encryptSecret, decryptSecret } = require("../security/secrets");
const config = require("../config");
const {
  adapter,
  sendDeviceCommand,
} = require("../mqtt/brokerService");

const router = express.Router();

function normalizePhoneMode(value, fallback = "desk") {
  const m = String(value || fallback).toLowerCase();
  return m === "sip" ? "sip" : "desk";
}

async function getSoftphoneMqttDevice(appId) {
  const rows = await query(
    `SELECT * FROM devices
     WHERE app_id = ? AND api_enabled = 1
     ORDER BY (integration_mode = 'broker' OR api_type = 'broker') DESC, id ASC
     LIMIT 1`,
    [appId]
  );
  const device = rows[0] || (await query("SELECT * FROM devices ORDER BY id ASC LIMIT 1"))[0];
  if (!device) return null;
  return {
    ...device,
    deviceToken:
      decryptSecret(device.mqtt_token_enc) ||
      decryptSecret(device.mqtt_token) ||
      device.mqtt_token,
  };
}

function parseSoftphoneExtList(response) {
  const json = response || {};
  let list =
    json.extlist ||
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
  return list
    .map((row) => ({
      number: String(row.number || row.extension || row.ext || "").trim(),
      username: String(row.username || row.name || row.fullname || "").trim(),
      status: String(row.status || row.state || "").trim(),
      type: String(row.type || "SIP").trim(),
    }))
    .filter((r) => r.number);
}

/** Fix truncated / broken SIP WS URLs (e.g. …/w → …/ws). */
function normalizeSipWsUrl(raw, host) {
  let u = String(raw || "").trim();
  const h = String(host || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

  if (/\/w$/i.test(u) && !/\/ws$/i.test(u)) u = `${u}s`;

  if (!u && h) return `ws://${h}:8088/ws`;
  if (!u) return "";

  if (!/^wss?:\/\//i.test(u)) {
    u = `ws://${u.replace(/^\/\//, "")}`;
  }

  try {
    const parsed = new URL(u);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/ws";
      u = parsed.toString().replace(/\/$/, "");
      if (!/\/ws$/i.test(u)) u = `${u.replace(/\/?$/, "")}/ws`;
    }
  } catch {
    /* keep */
  }
  return u;
}

async function loadSipSession(appId, userRow) {
  const apps = await query(
    `SELECT id, name, sip_host, sip_ws_url FROM apps WHERE id = ? LIMIT 1`,
    [appId]
  );
  const app = apps[0] || {};
  const extension = String(userRow?.extension || "").trim();
  const sipHost =
    String(app.sip_host || process.env.SIP_HOST || "").trim() ||
    String(process.env.SIP_HOST || "").trim();
  let sipWsUrl = String(app.sip_ws_url || process.env.SIP_WS_URL || "").trim();
  sipWsUrl = normalizeSipWsUrl(sipWsUrl, sipHost);
  const password = decryptSecret(userRow?.sip_password_enc) || "";

  return {
    agent: {
      id: userRow.id,
      name: userRow.name,
      mobile: userRow.mobile,
      extension: extension || null,
      phoneMode: normalizePhoneMode(userRow.phone_mode),
      sipPasswordSet: Boolean(password),
    },
    sip: {
      host: sipHost,
      wsUri: sipWsUrl,
      uri: extension && sipHost ? `sip:${extension}@${sipHost}` : "",
      authorizationUser: extension,
      displayName: String(userRow.name || extension || "Agent"),
      password: password || null,
      registerExpires: 120,
    },
    hints: {
      needsExtension: !extension,
      needsPassword: !password,
      needsSipHost: !sipHost,
      needsSipWs: !sipWsUrl,
      httpsNeedsWss:
        Boolean(sipWsUrl) &&
        sipWsUrl.toLowerCase().startsWith("ws://") &&
        !sipWsUrl.toLowerCase().startsWith("wss://"),
    },
  };
}

/**
 * GET /api/softphone  or  /api/v1/softphone
 * Returns SIP REGISTER credentials for the logged-in user (or ?extension= with API key).
 */
router.get("/", requireAuthOrKey, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    let userRow = null;

    if (req.user?.id) {
      const rows = await query(
        `SELECT * FROM users WHERE id = ? AND (app_id = ? OR app_id IS NULL) LIMIT 1`,
        [req.user.id, appId]
      );
      userRow = rows[0] || null;
    }

    const extQ = String(req.query.extension || "").trim();
    if (!userRow && extQ) {
      const rows = await query(
        `SELECT * FROM users
         WHERE app_id = ? AND extension = ? AND status = 'active'
         ORDER BY id ASC LIMIT 1`,
        [appId, extQ]
      );
      userRow = rows[0] || null;
      if (!userRow) {
        // Allow API-key session for a bare extension (password must still be set on a user)
        userRow = {
          id: null,
          name: `Ext ${extQ}`,
          mobile: "",
          extension: extQ,
          phone_mode: "sip",
          sip_password_enc: null,
        };
      }
    }

    if (!userRow) {
      return res.status(401).json({
        status: "error",
        message: "Login or pass ?extension= with API key",
      });
    }

    const session = await loadSipSession(appId, userRow);
    // Never omit password when present — browser needs it for REGISTER
    res.json({ status: "success", data: session });
  } catch (err) {
    next(err);
  }
});

/** Admin: save org SIP WebSocket settings used by browser softphone. */
router.put("/settings", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const sipHost = String(body.sipHost || body.sip_host || "").trim() || null;
    let sipWsUrl = String(body.sipWsUrl || body.sip_ws_url || "").trim() || null;
    if (sipWsUrl || sipHost) {
      sipWsUrl = normalizeSipWsUrl(sipWsUrl || "", sipHost || "") || null;
    }
    await query(
      `UPDATE apps SET sip_host = ?, sip_ws_url = ? WHERE id = ?`,
      [sipHost, sipWsUrl, appId]
    );
    res.json({
      status: "success",
      data: { sipHost: sipHost || "", sipWsUrl: sipWsUrl || "" },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/settings", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT sip_host, sip_ws_url FROM apps WHERE id = ? LIMIT 1`,
      [appId]
    );
    const app = rows[0] || {};
    const sipHost = app.sip_host || process.env.SIP_HOST || "";
    const sipWsUrl = normalizeSipWsUrl(
      app.sip_ws_url || process.env.SIP_WS_URL || "",
      sipHost
    );
    res.json({
      status: "success",
      data: {
        sipHost,
        sipWsUrl,
        defaultOtpMode: Boolean(config.otpDevMode),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/softphone/me — current user sets SIP password + phone mode.
 */
router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const rows = await query(
      `SELECT * FROM users WHERE id = ? AND (app_id = ? OR app_id IS NULL) LIMIT 1`,
      [req.user.id, appId]
    );
    if (!rows[0]) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }

    const phoneMode =
      body.phoneMode != null || body.phone_mode != null
        ? normalizePhoneMode(body.phoneMode || body.phone_mode)
        : normalizePhoneMode(rows[0].phone_mode);

    let sipEnc = rows[0].sip_password_enc;
    if (body.sipPassword != null || body.sip_password != null) {
      const plain = String(body.sipPassword || body.sip_password || "");
      sipEnc = plain ? encryptSecret(plain) : null;
    }

    let extension = rows[0].extension;
    if (body.extension != null) {
      extension = String(body.extension || "").trim() || null;
    }

    await query(
      `UPDATE users SET phone_mode = ?, sip_password_enc = ?, extension = COALESCE(?, extension)
       WHERE id = ?`,
      [phoneMode, sipEnc, extension, req.user.id]
    );

    const updated = await query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [
      req.user.id,
    ]);
    const session = await loadSipSession(appId, updated[0]);
    res.json({
      status: "success",
      data: {
        phoneMode,
        extension: updated[0].extension || "",
        sipPasswordSet: Boolean(decryptSecret(updated[0].sip_password_enc)),
        session,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/softphone/pbx-ready
 * After SIP REGISTER: mark extension logged-in on Neron (MQTT extension_set)
 * and return live status from extension_list (LuCI SIP page source).
 *
 * Neron API PDF §2.4:
 *   topic …/command/cfg  cmd=extension_set  params.logout_status="0"
 * §2.3 extension_list status: "Unavailable" until SIP peer is registered → "Idle".
 */
router.post("/pbx-ready", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT * FROM users WHERE id = ? AND (app_id = ? OR app_id IS NULL) LIMIT 1`,
      [req.user.id, appId]
    );
    const userRow = rows[0];
    const extension = String(
      req.body?.extension || userRow?.extension || ""
    ).trim();
    if (!extension) {
      return res.status(400).json({
        status: "error",
        message: "No extension mapped to this user",
      });
    }

    const shouldPoll = req.body?.poll !== false && req.body?.poll !== "false";

    const device = await getSoftphoneMqttDevice(appId);
    if (!device?.deviceToken) {
      return res.json({
        status: "success",
        data: {
          extension,
          mqttOk: false,
          message:
            "SIP REGISTER is separate from MQTT. Configure MQTT/PBX in settings to sync LuCI status via API.",
          pbxStatus: null,
        },
      });
    }
    device._crmUserId = req.user?.id || null;

    let setResult = null;
    try {
      setResult = await sendDeviceCommand(
        device,
        (requestId) =>
          adapter.prepareExtension({
            requestId,
            extension,
            fullname: userRow?.name || extension,
            permission: "3",
          }),
        { wait: true, timeoutMs: 10000 }
      );
    } catch (err) {
      setResult = { error: err.message };
    }

    const setOk =
      setResult &&
      !setResult.error &&
      String(setResult.response?.status || "").toLowerCase() === "success";

    let pbxStatus = null;
    let extlist = [];
    const readList = async () => {
      const listResult = await sendDeviceCommand(
        device,
        (requestId) => adapter.getExtensions(requestId),
        { wait: true, timeoutMs: 10000 }
      );
      extlist = parseSoftphoneExtList(listResult.response);
      const row = extlist.find((e) => String(e.number) === extension);
      pbxStatus = row?.status || null;
      return row;
    };

    try {
      await readList();
      // After SIP REGISTER + logout_status=0, status moves Unavailable → Idle
      if (shouldPoll && pbxStatus && /unavail/i.test(String(pbxStatus))) {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          await readList();
          if (pbxStatus && !/unavail|offline|logout/i.test(String(pbxStatus))) {
            break;
          }
        }
      }
    } catch {
      /* ignore list errors — set may still have succeeded */
    }

    const available = pbxStatus
      ? !/unavail|offline|logout/i.test(String(pbxStatus))
      : null;

    res.json({
      status: "success",
      data: {
        extension,
        mqttOk: Boolean(setOk),
        message: setOk
          ? available
            ? `Extension ${extension} online on Neron (${pbxStatus})`
            : `Extension ${extension} login enabled (logout_status=0) — waiting for SIP REGISTER to clear Unavailable`
          : setResult?.error ||
            setResult?.response?.message ||
            "extension_set not confirmed — keep SIP WebSocket registered",
        pbxStatus,
        available,
        extlist: extlist.filter((e) => String(e.number) === extension),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/softphone/extension-status — live status from Neron extension_list */
router.get("/extension-status", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT extension, name FROM users WHERE id = ? LIMIT 1`,
      [req.user.id]
    );
    const extension = String(
      req.query.extension || rows[0]?.extension || ""
    ).trim();
    if (!extension) {
      return res.status(400).json({
        status: "error",
        message: "No extension",
      });
    }
    const device = await getSoftphoneMqttDevice(appId);
    if (!device?.deviceToken) {
      return res.json({
        status: "success",
        data: { extension, pbxStatus: null, mqttOk: false },
      });
    }
    device._crmUserId = req.user?.id || null;
    const listResult = await sendDeviceCommand(
      device,
      (requestId) => adapter.getExtensions(requestId),
      { wait: true, timeoutMs: 10000 }
    );
    const extlist = parseSoftphoneExtList(listResult.response);
    const row = extlist.find((e) => String(e.number) === extension);
    const pbxStatus = row?.status || null;
    res.json({
      status: "success",
      data: {
        extension,
        pbxStatus,
        available: pbxStatus
          ? !/unavail|offline|logout/i.test(String(pbxStatus))
          : null,
        mqttOk: true,
        row: row || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.loadSipSession = loadSipSession;
module.exports.normalizePhoneMode = normalizePhoneMode;
