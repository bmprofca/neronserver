const express = require("express");
const { query } = require("../db");
const {
  requireAuth,
  requireAuthOrKey,
  requireAdmin,
} = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");
const { liveBus } = require("../realtime/liveBus");
const {
  screenPopIncoming,
  resolveCallerName,
  getAppCrmSettings,
  buildScreenPopVars,
} = require("../crm/screenPop");
const { phoneMatchKey } = require("../inbound/engine");

const router = express.Router();

function requireOwnerOrAdmin(req, res, next) {
  const role = String(req.user?.role || "");
  if (role === "admin" || role === "owner") return next();
  return requireAdmin(req, res, next);
}

/**
 * GET /api/v1/crm/caller?phone=98xxxxxxxx
 * Resolve {name} for a mobile from local + CRM DB lookup.
 */
router.get("/caller", requireAuthOrKey, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const phone = phoneMatchKey(req.query.phone || req.query.number || "");
    const resolved = await resolveCallerName(appId, phone, req.query.name);
    res.json({
      status: "success",
      data: {
        phone,
        name: resolved.name,
        company: resolved.company,
        crm_id: resolved.crmId,
        source: resolved.source,
        variables: {
          name: resolved.name,
          phone,
          company: resolved.company,
          crm_id: resolved.crmId,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/crm/screen-pop
 * Show an incoming call on the CRM user screen.
 *
 * Body:
 * {
 *   "phone": "9876543210",          // required
 *   "name": "optional — else fetched from CRM DB / contacts",
 *   "extension": "1001",
 *   "call_id": "optional",
 *   "did": "optional",
 *   "crm_id": "optional",
 *   "notify": true                  // default true — POST to CRM webhook
 * }
 *
 * Response includes variables.name filled from CRM/local DB for screen UI.
 */
router.post("/screen-pop", requireAuthOrKey, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const phone = phoneMatchKey(body.phone || body.from || body.caller || "");
    if (!phone || phone.length < 8) {
      return res.status(400).json({
        status: "error",
        message: "phone (caller mobile) is required",
      });
    }

    const result = await screenPopIncoming(appId, {
      phone,
      name: body.name,
      extension: body.extension || body.to || body.agent_extension,
      callId: body.call_id || body.callId,
      did: body.did || body.to,
      company: body.company,
      crmId: body.crm_id || body.crmId,
      agent: body.agent || req.user?.name,
      notify: body.notify !== false,
    });

    // Push to connected IPBS agent UIs (same app users)
    liveBus.broadcast("crm_screen_pop", {
      appId,
      ...result.payload,
    });
    liveBus.broadcast("pbx_inbound", {
      callId: result.vars.call_id || null,
      extension: result.vars.extension,
      callerPhone: result.vars.phone,
      callerName: result.vars.name,
      source: "crm_api",
    });

    res.json({
      status: "success",
      message: result.vars.name
        ? `Screen-pop ready for ${result.vars.name}`
        : `Screen-pop ready for ${result.vars.phone}`,
      data: {
        ...result.payload,
        variables: result.vars,
        name_source: result.resolved.source,
        webhook: result.delivery,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/call  with action=receive — partner alias for inbound screen-pop + hunt preview
 * Also supports action=dial/hangup delegated elsewhere; here we handle receive.
 */
router.post("/call", requireAuthOrKey, async (req, res, next) => {
  try {
    const body = req.body || {};
    const action = String(body.action || "receive").toLowerCase();
    if (action !== "receive" && action !== "screenpop" && action !== "screen_pop") {
      return res.status(400).json({
        status: "error",
        message:
          'Use action=receive for inbound screen-pop. For dial/hangup use /api/pbx/calls.',
      });
    }

    const appId = await resolveAppId(req);
    const phone = phoneMatchKey(body.from || body.phone || body.caller || "");
    if (!phone || phone.length < 8) {
      return res.status(400).json({
        status: "error",
        message: "from / phone is required for action=receive",
      });
    }

    const result = await screenPopIncoming(appId, {
      phone,
      name: body.name,
      extension: body.to || body.extension,
      callId: body.call_id || body.callId || body.uuid,
      did: body.to || body.did,
      company: body.company,
      crmId: body.crm_id || body.crmId,
      agent: body.agent || req.user?.name,
    });

    liveBus.broadcast("crm_screen_pop", {
      appId,
      ...result.payload,
    });
    liveBus.broadcast("pbx_inbound", {
      callId: result.vars.call_id || null,
      extension: result.vars.extension,
      callerPhone: result.vars.phone,
      callerName: result.vars.name,
      source: "crm_receive",
    });

    res.json({
      status: "success",
      message: "Incoming call screen-pop sent",
      data: {
        action: "receive",
        variables: result.vars,
        screen_pop: result.payload.screen_pop,
        title: result.payload.title,
        message: result.payload.message_resolved,
        name_source: result.resolved.source,
        webhook: result.delivery,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Recent webhook delivery log (admin UI). */
router.get("/deliveries", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT id, event, url, status_code, error_message, created_at, payload_json
       FROM crm_deliveries
       WHERE app_id = ?
       ORDER BY id DESC
       LIMIT 50`,
      [appId]
    );
    res.json({
      status: "success",
      data: rows.map((r) => ({
        id: String(r.id),
        event: r.event,
        url: r.url,
        status: r.status_code,
        error: r.error_message || "",
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Save CRM webhook + lookup URL (name from CRM DB). */
router.put("/settings", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
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
        String(body.crmWebhookUrl || body.crm_webhook_url || "").trim() || null,
        String(body.crmWebhookSecret || body.crm_webhook_secret || "").trim() ||
          null,
        String(body.crmLookupUrl || body.crm_lookup_url || "").trim() || null,
        String(
          body.crmLookupAuthHeader || body.crm_lookup_auth_header || ""
        ).trim() || null,
        appId,
      ]
    );
    const app = await getAppCrmSettings(appId);
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

router.get("/settings", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const app = await getAppCrmSettings(appId);
    res.json({
      status: "success",
      data: {
        crmWebhookUrl: app?.crm_webhook_url || "",
        crmWebhookSecret: app?.crm_webhook_secret || "",
        crmLookupUrl: app?.crm_lookup_url || "",
        crmLookupAuthHeader: app?.crm_lookup_auth_header || "",
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
