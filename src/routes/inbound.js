const express = require("express");
const { query } = require("../db");
const {
  requireAuth,
  requireAuthOrKey,
  requireAdmin,
} = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");
const {
  phoneMatchKey,
  normalizeCaller,
  parseFailoverJson,
  mapRoute,
  mapMapping,
  listRoutes,
  listMappings,
  listDecisions,
  loadRouteSteps,
  resolveInbound,
  recordDecision,
} = require("../inbound/engine");
const {
  adapter,
  publishCommand,
} = require("../mqtt/brokerService");

const router = express.Router();

function requireOwnerOrAdmin(req, res, next) {
  const role = String(req.user?.role || "");
  if (role === "admin" || role === "owner") return next();
  return requireAdmin(req, res, next);
}

async function getDevice(appId) {
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

router.get("/routes", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    res.json({ status: "success", data: await listRoutes(appId) });
  } catch (err) {
    next(err);
  }
});

router.post("/routes", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const name = String(body.name || "Inbound rule").trim();
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const result = await query(
      `INSERT INTO inbound_routes
        (app_id, name, enabled, priority, match_type, match_value,
         sticky_last_agent, sticky_days, ring_timeout_sec, queue_number, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appId,
        name,
        body.enabled === false ? 0 : 1,
        Number(body.priority) || 10,
        body.matchType || "all",
        body.matchValue || null,
        body.stickyLastAgent === false ? 0 : 1,
        Number(body.stickyDays) || 7,
        Number(body.ringTimeoutSec) || 20,
        body.queueNumber || null,
        body.notes || null,
      ]
    );
    let order = 0;
    for (const step of steps) {
      const extension = String(step.extension || "").trim();
      if (!extension) continue;
      await query(
        `INSERT INTO inbound_route_steps (route_id, extension, timeout_sec, sort_order)
         VALUES (?, ?, ?, ?)`,
        [
          result.insertId,
          extension,
          Number(step.timeoutSec) || Number(body.ringTimeoutSec) || 20,
          order++,
        ]
      );
    }
    const rows = await query(`SELECT * FROM inbound_routes WHERE id = ?`, [
      result.insertId,
    ]);
    res.status(201).json({
      status: "success",
      data: mapRoute(rows[0], await loadRouteSteps(result.insertId)),
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/routes/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const id = Number(req.params.id);
    const existing = await query(
      `SELECT * FROM inbound_routes WHERE id = ? AND app_id = ? LIMIT 1`,
      [id, appId]
    );
    if (!existing[0]) {
      return res.status(404).json({ status: "error", message: "Rule not found" });
    }
    const body = req.body || {};
    const row = existing[0];
    await query(
      `UPDATE inbound_routes SET
        name = ?, enabled = ?, priority = ?, match_type = ?, match_value = ?,
        sticky_last_agent = ?, sticky_days = ?, ring_timeout_sec = ?,
        queue_number = ?, notes = ?
       WHERE id = ?`,
      [
        body.name != null ? String(body.name).trim() : row.name,
        body.enabled != null ? (body.enabled ? 1 : 0) : row.enabled,
        body.priority != null ? Number(body.priority) : row.priority,
        body.matchType || row.match_type,
        body.matchValue != null ? body.matchValue : row.match_value,
        body.stickyLastAgent != null
          ? body.stickyLastAgent
            ? 1
            : 0
          : row.sticky_last_agent,
        body.stickyDays != null ? Number(body.stickyDays) : row.sticky_days,
        body.ringTimeoutSec != null
          ? Number(body.ringTimeoutSec)
          : row.ring_timeout_sec,
        body.queueNumber != null ? body.queueNumber : row.queue_number,
        body.notes != null ? body.notes : row.notes,
        id,
      ]
    );
    if (Array.isArray(body.steps)) {
      await query(`DELETE FROM inbound_route_steps WHERE route_id = ?`, [id]);
      let order = 0;
      for (const step of body.steps) {
        const extension = String(step.extension || "").trim();
        if (!extension) continue;
        await query(
          `INSERT INTO inbound_route_steps (route_id, extension, timeout_sec, sort_order)
           VALUES (?, ?, ?, ?)`,
          [
            id,
            extension,
            Number(step.timeoutSec) || Number(body.ringTimeoutSec) || 20,
            order++,
          ]
        );
      }
    }
    const rows = await query(`SELECT * FROM inbound_routes WHERE id = ?`, [id]);
    res.json({
      status: "success",
      data: mapRoute(rows[0], await loadRouteSteps(id)),
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/routes/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const id = Number(req.params.id);
    const result = await query(
      `DELETE FROM inbound_routes WHERE id = ? AND app_id = ?`,
      [id, appId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Rule not found" });
    }
    res.json({ status: "success", data: { id: String(id) } });
  } catch (err) {
    next(err);
  }
});

router.get("/mappings", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    res.json({ status: "success", data: await listMappings(appId) });
  } catch (err) {
    next(err);
  }
});

router.post("/mappings", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const caller = normalizeCaller(body.phone || body.matchKey);
    if (!caller.ok) {
      return res.status(400).json({ status: "error", message: caller.error });
    }
    const extension = String(body.extension || "").trim();
    if (!extension) {
      return res.status(400).json({ status: "error", message: "Extension required" });
    }
    const failover = Array.isArray(body.failoverExtensions)
      ? body.failoverExtensions
      : parseFailoverJson(body.failoverExtensions || body.failover || "");
    const result = await query(
      `INSERT INTO inbound_mappings
        (app_id, phone, match_key, extension, failover_extensions_json, name, notes, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         phone = VALUES(phone),
         extension = VALUES(extension),
         failover_extensions_json = VALUES(failover_extensions_json),
         name = VALUES(name),
         notes = VALUES(notes),
         enabled = 1`,
      [
        appId,
        caller.dial,
        caller.matchKey,
        extension,
        JSON.stringify(failover),
        body.name || null,
        body.notes || null,
      ]
    );
    const id = result.insertId || result.insertid;
    const rows = await query(
      `SELECT * FROM inbound_mappings WHERE app_id = ? AND match_key = ? LIMIT 1`,
      [appId, caller.matchKey]
    );
    res.status(201).json({ status: "success", data: mapMapping(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.patch("/mappings/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const id = Number(req.params.id);
    const existing = await query(
      `SELECT * FROM inbound_mappings WHERE id = ? AND app_id = ? LIMIT 1`,
      [id, appId]
    );
    if (!existing[0]) {
      return res.status(404).json({ status: "error", message: "Map not found" });
    }
    const body = req.body || {};
    const row = existing[0];
    let phone = row.phone;
    let matchKey = row.match_key;
    if (body.phone != null || body.matchKey != null) {
      const caller = normalizeCaller(body.phone || body.matchKey);
      if (!caller.ok) {
        return res.status(400).json({ status: "error", message: caller.error });
      }
      phone = caller.dial;
      matchKey = caller.matchKey;
    }
    let failoverJson = row.failover_extensions_json;
    if (body.failoverExtensions != null || body.failover != null) {
      const failover = Array.isArray(body.failoverExtensions)
        ? body.failoverExtensions
        : parseFailoverJson(body.failoverExtensions || body.failover || "");
      failoverJson = JSON.stringify(failover);
    }
    await query(
      `UPDATE inbound_mappings SET
        phone = ?, match_key = ?, extension = ?, failover_extensions_json = ?,
        name = ?, notes = ?, enabled = ?
       WHERE id = ?`,
      [
        phone,
        matchKey,
        body.extension != null ? String(body.extension).trim() : row.extension,
        failoverJson,
        body.name != null ? body.name : row.name,
        body.notes != null ? body.notes : row.notes,
        body.enabled != null ? (body.enabled ? 1 : 0) : row.enabled,
        id,
      ]
    );
    const rows = await query(`SELECT * FROM inbound_mappings WHERE id = ?`, [id]);
    res.json({ status: "success", data: mapMapping(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.delete("/mappings/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const id = Number(req.params.id);
    const result = await query(
      `DELETE FROM inbound_mappings WHERE id = ? AND app_id = ?`,
      [id, appId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Map not found" });
    }
    res.json({ status: "success", data: { id: String(id) } });
  } catch (err) {
    next(err);
  }
});

router.get("/decisions", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    res.json({ status: "success", data: await listDecisions(appId) });
  } catch (err) {
    next(err);
  }
});

router.post("/resolve", requireAuthOrKey, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const preview = await resolveInbound(appId, {
      from: body.from || body.caller || body.phone,
      to: body.to || body.did,
    });
    if (!preview.ok) {
      return res.status(400).json({ status: "error", message: preview.error });
    }
    res.json({ status: "success", data: preview });
  } catch (err) {
    next(err);
  }
});

/** Preview + optional live dial to the first hunt extension (test path). */
router.post("/simulate", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const preview = await resolveInbound(appId, {
      from: body.from || body.caller,
      to: body.to || body.did,
    });
    if (!preview.ok) {
      return res.status(400).json({ status: "error", message: preview.error });
    }
    if (!preview.firstExtension) {
      await recordDecision(appId, preview, { status: "missed" });
      return res.status(400).json({
        status: "error",
        message: "No extension to ring. Add a caller map or last-agent / backup rule.",
        data: preview,
      });
    }

    const device = await getDevice(appId);
    if (!device) {
      await recordDecision(appId, preview, { status: "missed" });
      return res.status(404).json({ status: "error", message: "No PBX device" });
    }

    const requestId = adapter.newRequestId();
    const built = adapter.initiateExtensionCall({
      requestId,
      extension: preview.firstExtension,
      phoneNumber: preview.callerDial,
      autoAnswer: true,
    });
    device._crmUserId = req.user?.id || null;
    try {
      await publishCommand(device, built.topicSuffix, built.payload, {
        wait: false,
      });
    } catch (err) {
      await recordDecision(appId, preview, { status: "missed" });
      return res.status(502).json({
        status: "error",
        message: err.message || "Could not publish dial",
        data: preview,
      });
    }

    const decisionId = await recordDecision(appId, preview, {
      status: "simulated",
    });
    res.json({
      status: "success",
      data: { ...preview, decisionId: String(decisionId) },
      message: `Ringing ${preview.firstExtension} first`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.phoneMatchKey = phoneMatchKey;
