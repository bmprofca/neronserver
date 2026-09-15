const TERMINAL = new Set([
  "completed",
  "busy",
  "no_answer",
  "rejected",
  "failed",
  "cancelled",
  "timed_out",
  "hungup",
]);

const ORDER = [
  "requested",
  "published",
  "acknowledged",
  "extension_ringing",
  "customer_dialling",
  "customer_ringing",
  "answered",
  "completed",
];

function rank(state) {
  const i = ORDER.indexOf(state);
  return i >= 0 ? i : -1;
}

/**
 * Controlled call state transitions.
 * Allows terminal jumps from most states; rejects backward moves unless force.
 */
function canTransition(from, to, { force = false } = {}) {
  if (!to) return false;
  if (from === to) return false;
  if (TERMINAL.has(from) && !force) return false;
  if (TERMINAL.has(to)) return true;
  if (force) return true;
  const a = rank(from);
  const b = rank(to);
  if (a < 0 || b < 0) return true;
  return b > a;
}

function mapNeronEventToState(event, json = {}) {
  const ev = String(event || "").toLowerCase();
  const status = String(json.status || json.state || "").toLowerCase();

  if (ev === "extension_status") {
    if (status === "ringing") return "extension_ringing";
    if (status === "inuse" || status === "busy") return "answered";
    if (status === "idle") return null;
  }
  if (ev === "invite") {
    if (json.to && String(json.to).length <= 5) return "extension_ringing";
    return "customer_ringing";
  }
  if (status === "ringing" && !ev) {
    return "customer_ringing";
  }
  if (ev === "callstatus" || ev === "call_status") {
    const list = json.calllist || json.livecall || [];
    const first = Array.isArray(list) ? list[0] : list;
    const st = String(first?.state || first?.status || status).toLowerCase();
    if (st.includes("ring")) return "customer_ringing";
    if (st === "up" || st.includes("answer")) return "answered";
    if (st.includes("busy")) return "busy";
    if (st.includes("hang") || st === "down") return "completed";
  }
  if (ev === "hangup" || ev === "cdr" || status.includes("hangup")) {
    return "completed";
  }
  if (status.includes("busy")) return "busy";
  if (status.includes("noanswer") || status.includes("no_answer")) {
    return "no_answer";
  }
  if (status.includes("fail") || status.includes("reject")) return "failed";
  return null;
}

module.exports = {
  TERMINAL,
  ORDER,
  canTransition,
  mapNeronEventToState,
};
