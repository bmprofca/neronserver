const { query } = require("../db");
const { normalizePhoneNumber } = require("../utils/phone");

function phoneMatchKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function normalizeCaller(input) {
  const raw = String(input || "").trim();
  const phone = normalizePhoneNumber(raw);
  if (phone.ok) {
    return {
      ok: true,
      dial: phone.dial,
      digits: phone.digits,
      matchKey: phoneMatchKey(phone.digits || phone.dial),
      display: phone.display || phone.digits,
    };
  }
  const key = phoneMatchKey(raw);
  if (key.length >= 8) {
    return {
      ok: true,
      dial: key.length === 10 ? `0${key}` : key,
      digits: key,
      matchKey: key.length >= 10 ? key.slice(-10) : key,
      display: key,
    };
  }
  return { ok: false, error: phone.error || "Invalid caller number", matchKey: "" };
}

function parseFailoverJson(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || "").trim()).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v || "").trim()).filter(Boolean);
    }
  } catch {
    /* comma-separated fallback */
  }
  return String(raw)
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function mapRoute(row, steps = []) {
  return {
    id: String(row.id),
    name: row.name,
    enabled: Boolean(row.enabled),
    priority: Number(row.priority) || 10,
    matchType: row.match_type || "all",
    matchValue: row.match_value || "",
    stickyLastAgent: Boolean(row.sticky_last_agent),
    stickyDays: Number(row.sticky_days) || 7,
    ringTimeoutSec: Number(row.ring_timeout_sec) || 20,
    queueNumber: row.queue_number || "",
    notes: row.notes || "",
    steps: steps.map((s) => ({
      id: String(s.id),
      extension: s.extension,
      timeoutSec: Number(s.timeout_sec) || 20,
      sortOrder: Number(s.sort_order) || 0,
    })),
  };
}

function mapMapping(row) {
  return {
    id: String(row.id),
    phone: row.phone,
    matchKey: row.match_key,
    extension: row.extension,
    failoverExtensions: parseFailoverJson(row.failover_extensions_json),
    name: row.name || "",
    notes: row.notes || "",
    enabled: Boolean(row.enabled),
  };
}

function mapDecision(row) {
  let hunt = [];
  try {
    hunt = row.hunt_json ? JSON.parse(row.hunt_json) : [];
  } catch {
    hunt = [];
  }
  return {
    id: String(row.id),
    caller: row.caller || "",
    did: row.did || "",
    mappedExtension: row.mapped_extension || "",
    stickyExtension: row.sticky_extension || "",
    firstExtension: row.first_extension || "",
    huntJson: row.hunt_json || "[]",
    hunt,
    reason: row.reason || "",
    status: row.status || "routed",
    createdAt: row.created_at,
    route: row.route_name ? { name: row.route_name } : null,
  };
}

async function loadRouteSteps(routeId) {
  return query(
    `SELECT * FROM inbound_route_steps WHERE route_id = ? ORDER BY sort_order ASC, id ASC`,
    [routeId]
  );
}

async function listRoutes(appId) {
  const rows = await query(
    `SELECT * FROM inbound_routes WHERE app_id = ? ORDER BY priority ASC, id ASC`,
    [appId]
  );
  const out = [];
  for (const row of rows) {
    out.push(mapRoute(row, await loadRouteSteps(row.id)));
  }
  return out;
}

async function listMappings(appId) {
  const rows = await query(
    `SELECT * FROM inbound_mappings WHERE app_id = ? ORDER BY id DESC`,
    [appId]
  );
  return rows.map(mapMapping);
}

async function listDecisions(appId, limit = 40) {
  const rows = await query(
    `SELECT d.*, r.name AS route_name
     FROM inbound_decisions d
     LEFT JOIN inbound_routes r ON r.id = d.route_id
     WHERE d.app_id = ?
     ORDER BY d.id DESC
     LIMIT ?`,
    [appId, Math.min(Number(limit) || 40, 100)]
  );
  return rows.map(mapDecision);
}

async function findStickyExtension(appId, matchKey, stickyDays) {
  const days = Math.max(1, Number(stickyDays) || 7);
  const like = `%${matchKey}`;
  const rows = await query(
    `SELECT c.extension_number
     FROM pbx_calls c
     INNER JOIN devices d ON d.id = c.pbx_device_id
     WHERE d.app_id = ?
       AND c.extension_number IS NOT NULL
       AND c.extension_number != ''
       AND c.customer_number IS NOT NULL
       AND (
         c.customer_number = ?
         OR c.customer_number LIKE ?
         OR RIGHT(REPLACE(REPLACE(c.customer_number, '+', ''), ' ', ''), 10) = ?
       )
       AND c.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND (
         c.direction = 'outbound'
         OR c.call_status IN ('answered', 'completed', 'acknowledged', 'extension_ringing', 'customer_ringing')
       )
     ORDER BY COALESCE(c.answered_at, c.started_at, c.created_at) DESC, c.id DESC
     LIMIT 1`,
    [appId, matchKey, like, matchKey, days]
  );
  return rows[0]?.extension_number || "";
}

function routeMatches(route, { matchKey, did }) {
  if (!route.enabled) return false;
  if (route.matchType === "all") return true;
  if (route.matchType === "did") {
    const want = phoneMatchKey(route.matchValue);
    const got = phoneMatchKey(did);
    return Boolean(want && got && (want === got || String(did || "").includes(route.matchValue)));
  }
  if (route.matchType === "caller_prefix") {
    const prefix = String(route.matchValue || "").replace(/\D/g, "");
    return Boolean(prefix && matchKey.startsWith(prefix));
  }
  return false;
}

/**
 * Resolve inbound hunt for a caller.
 * Priority: caller map (+ failover) → sticky last agent → route backup desks.
 */
async function resolveInbound(appId, { from, to } = {}) {
  const caller = normalizeCaller(from);
  if (!caller.ok) {
    return { ok: false, error: caller.error };
  }
  const did = String(to || "").trim();
  const hunt = [];
  let mappedExtension = "";
  let stickyExtension = "";
  let route = null;
  const reasons = [];

  const mappings = await query(
    `SELECT * FROM inbound_mappings
     WHERE app_id = ? AND enabled = 1 AND match_key = ?
     ORDER BY id DESC LIMIT 1`,
    [appId, caller.matchKey]
  );
  const mapping = mappings[0] ? mapMapping(mappings[0]) : null;

  if (mapping) {
    mappedExtension = mapping.extension;
    hunt.push({
      extension: mapping.extension,
      timeoutSec: 25,
      role: "mapped",
    });
    for (const ext of mapping.failoverExtensions) {
      if (ext === mapping.extension) continue;
      if (hunt.some((h) => h.extension === ext)) continue;
      hunt.push({ extension: ext, timeoutSec: 20, role: "overflow" });
    }
    reasons.push(`Caller map ${mapping.matchKey} → ${mapping.extension}`);
  }

  const routes = await listRoutes(appId);
  route =
    routes.find((r) => routeMatches(r, { matchKey: caller.matchKey, did })) ||
    null;

  if (!mapping && route?.stickyLastAgent) {
    stickyExtension = await findStickyExtension(
      appId,
      caller.matchKey,
      route.stickyDays
    );
    if (stickyExtension) {
      hunt.push({
        extension: stickyExtension,
        timeoutSec: route.ringTimeoutSec || 20,
        role: "sticky",
      });
      reasons.push(
        `Last agent ${stickyExtension} (within ${route.stickyDays}d)`
      );
    } else {
      reasons.push("No recent outbound agent for this caller");
    }
  } else if (!mapping && route && !route.stickyLastAgent) {
    reasons.push("Sticky last-agent off for this rule");
  }

  if (route) {
    for (const step of route.steps) {
      if (!step.extension) continue;
      if (hunt.some((h) => h.extension === step.extension)) continue;
      hunt.push({
        extension: step.extension,
        timeoutSec: step.timeoutSec || route.ringTimeoutSec || 20,
        role: "overflow",
      });
    }
    if (route.steps.length) {
      reasons.push(`Backup desks: ${route.steps.map((s) => s.extension).join(" → ")}`);
    }
  } else if (!mapping) {
    reasons.push("No matching inbound rule");
  }

  const firstExtension = hunt[0]?.extension || "";
  const reason = reasons.filter(Boolean).join(" · ") || "No destination";

  return {
    ok: true,
    caller: caller.display || caller.dial,
    callerDial: caller.dial,
    matchKey: caller.matchKey,
    callerName: mapping?.name || "",
    did,
    mappedExtension,
    stickyExtension,
    firstExtension,
    reason,
    hunt,
    route: route
      ? { id: route.id, name: route.name, queueNumber: route.queueNumber }
      : null,
    routeId: route ? Number(route.id) : null,
  };
}

async function recordDecision(appId, preview, { status = "routed", callId = null } = {}) {
  const result = await query(
    `INSERT INTO inbound_decisions
      (app_id, route_id, caller, did, mapped_extension, sticky_extension,
       first_extension, hunt_json, reason, status, call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      preview.routeId || null,
      preview.caller || "",
      preview.did || "",
      preview.mappedExtension || null,
      preview.stickyExtension || null,
      preview.firstExtension || null,
      JSON.stringify(preview.hunt || []),
      preview.reason || "",
      status,
      callId,
    ]
  );
  return result.insertId;
}

module.exports = {
  phoneMatchKey,
  normalizeCaller,
  parseFailoverJson,
  mapRoute,
  mapMapping,
  mapDecision,
  listRoutes,
  listMappings,
  listDecisions,
  loadRouteSteps,
  findStickyExtension,
  resolveInbound,
  recordDecision,
};
