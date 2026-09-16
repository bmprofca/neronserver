const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");

const router = express.Router();

const MISSED = new Set([
  "no_answer",
  "busy",
  "cancelled",
  "timed_out",
  "failed",
  "rejected",
]);

function parseDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(90, Math.floor(n));
}

function isAnswered(row) {
  if (row.answered_at) return true;
  const st = String(row.call_status || "").toLowerCase();
  if (MISSED.has(st)) return false;
  if (st === "answered") return true;
  const cause = String(row.hangup_cause || "").toLowerCase();
  if (/no.?answer|busy|cancel|fail|reject|abandon/.test(cause)) return false;
  const dur = Number(row.duration_seconds || row.billable_seconds || 0);
  if (dur > 0 && (st === "completed" || st === "hungup" || /normal|answer|success/.test(cause))) {
    return true;
  }
  return false;
}

function isMissed(row) {
  if (isAnswered(row)) return false;
  const st = String(row.call_status || "").toLowerCase();
  if (MISSED.has(st)) return true;
  const cause = String(row.hangup_cause || "").toLowerCase();
  if (/no.?answer|busy|cancel|abandon|miss/.test(cause)) return true;
  if (row.ended_at && !row.answered_at) return true;
  return false;
}

function talkSec(row) {
  if (!isAnswered(row)) return 0;
  const bill = Number(row.billable_seconds);
  if (Number.isFinite(bill) && bill > 0) return bill;
  const dur = Number(row.duration_seconds);
  return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

function callSpanSec(row) {
  if (row.started_at && row.ended_at) {
    const a = new Date(row.started_at).getTime();
    const b = new Date(row.ended_at).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
      return Math.round((b - a) / 1000);
    }
  }
  const dur = Number(row.duration_seconds);
  return Number.isFinite(dur) && dur > 0 ? dur : talkSec(row);
}

function mapRow(row) {
  const answered = isAnswered(row);
  const missed = isMissed(row);
  return {
    id: String(row.id),
    callId: row.call_id || row.uuid || null,
    direction: row.direction || "outbound",
    status: row.call_status || "",
    extension: row.extension_number || "",
    customer: row.customer_number || "",
    agentName: row.agent_name || "",
    agentMobile: row.agent_mobile || "",
    startedAt: row.started_at || row.created_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    talkSec: talkSec(row),
    callSec: callSpanSec(row),
    hangupCause: row.hangup_cause || "",
    outcome: answered ? "answered" : missed ? "missed" : row.call_status || "other",
  };
}

async function loadCalls(appId, days) {
  return query(
    `SELECT c.*,
            u.name AS agent_name,
            u.mobile AS agent_mobile
     FROM pbx_calls c
     INNER JOIN devices d ON d.id = c.pbx_device_id
     LEFT JOIN users u
       ON u.app_id = d.app_id
      AND u.extension = c.extension_number
     WHERE d.app_id = ?
       AND c.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY c.created_at DESC
     LIMIT 2000`,
    [appId, days]
  );
}

function buildSummary(rows) {
  let answered = 0;
  let missed = 0;
  let talk = 0;
  let callTime = 0;
  const byUser = new Map();

  for (const row of rows) {
    const mapped = mapRow(row);
    const key = mapped.extension || "unassigned";
    if (!byUser.has(key)) {
      byUser.set(key, {
        extension: mapped.extension || "—",
        agentName: mapped.agentName || (mapped.extension ? `Ext ${mapped.extension}` : "Unassigned"),
        total: 0,
        answered: 0,
        missed: 0,
        talkSec: 0,
        callSec: 0,
      });
    }
    const bucket = byUser.get(key);
    if (mapped.agentName) bucket.agentName = mapped.agentName;
    bucket.total += 1;
    bucket.callSec += mapped.callSec;
    callTime += mapped.callSec;

    if (mapped.outcome === "answered") {
      answered += 1;
      bucket.answered += 1;
      bucket.talkSec += mapped.talkSec;
      talk += mapped.talkSec;
    } else if (mapped.outcome === "missed") {
      missed += 1;
      bucket.missed += 1;
    }
  }

  const byUserList = [...byUser.values()].sort((a, b) => b.total - a.total);
  return {
    total: rows.length,
    answered,
    missed,
    other: Math.max(0, rows.length - answered - missed),
    talkSec: talk,
    callSec: callTime,
    avgTalkSec: answered ? Math.round(talk / answered) : 0,
    answerRate: rows.length ? Math.round((answered / rows.length) * 1000) / 10 : 0,
    byUser: byUserList,
  };
}

router.get("/report", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const days = parseDays(req.query.days);
    const rows = await loadCalls(appId, days);
    const summary = buildSummary(rows);
    const calls = rows.slice(0, 500).map(mapRow);
    res.json({
      status: "success",
      data: {
        days,
        summary,
        calls,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const days = parseDays(req.query.days || 7);
    const rows = await loadCalls(appId, days);
    res.json({
      status: "success",
      data: rows.slice(0, 500).map(mapRow),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._test = { isAnswered, isMissed, talkSec, mapRow, buildSummary };
