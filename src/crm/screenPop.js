const crypto = require("crypto");
const { query } = require("../db");
const { phoneMatchKey } = require("../inbound/engine");

/**
 * Replace template variables in a string.
 * Supported: {name} {phone} {extension} {call_id} {did} {company} {crm_id} {agent}
 */
function applyVars(template, vars) {
  return String(template || "").replace(/\{([a-z0-9_]+)\}/gi, (_, key) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

function buildScreenPopVars(input = {}) {
  const phone = phoneMatchKey(input.phone || input.from || input.caller || "");
  return {
    name: String(input.name || "").trim(),
    phone,
    extension: String(input.extension || input.to || "").trim(),
    call_id: String(input.callId || input.call_id || "").trim(),
    did: String(input.did || input.to || "").trim(),
    company: String(input.company || "").trim(),
    crm_id: String(input.crmId || input.crm_id || "").trim(),
    agent: String(input.agent || input.agentName || "").trim(),
  };
}

async function getAppCrmSettings(appId) {
  const rows = await query(
    `SELECT id, name, crm_webhook_url, crm_webhook_secret, crm_lookup_url, crm_lookup_auth_header
     FROM apps WHERE id = ? LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

/**
 * Resolve caller display name:
 * 1) explicit name from request
 * 2) local app_contacts / users / inbound_mappings
 * 3) optional CRM DB lookup URL (crm_lookup_url with {phone})
 */
async function resolveCallerName(appId, phone, explicitName = "") {
  const given = String(explicitName || "").trim();
  if (given && given !== "{name}") {
    return { name: given, company: "", source: "request", crmId: "" };
  }

  const key = phoneMatchKey(phone);
  if (!key || key.length < 8) {
    return { name: "", company: "", source: null, crmId: "" };
  }

  const mapped = await query(
    `SELECT name, phone FROM inbound_mappings
     WHERE app_id = ? AND enabled = 1 AND match_key = ?
     ORDER BY id DESC LIMIT 1`,
    [appId, key]
  );
  if (mapped[0]?.name) {
    return {
      name: String(mapped[0].name).trim(),
      company: "",
      source: "inbound_map",
      crmId: "",
    };
  }

  const people = await query(
    `SELECT name, mobile FROM users
     WHERE status = 'active'
       AND (
         mobile = ? OR mobile = ?
         OR RIGHT(REPLACE(REPLACE(mobile, '+', ''), ' ', ''), 10) = ?
       )
     ORDER BY id ASC LIMIT 1`,
    [key, `0${key}`, key]
  );
  if (people[0]?.name) {
    return {
      name: String(people[0].name).trim(),
      company: "",
      source: "user",
      crmId: "",
    };
  }

  const book = await query(
    `SELECT name, phone, company FROM app_contacts
     WHERE app_id = ?
       AND (
         phone_key = ? OR phone = ?
         OR RIGHT(REPLACE(REPLACE(phone, '+', ''), ' ', ''), 10) = ?
       )
     ORDER BY id DESC LIMIT 1`,
    [appId, key, key, key]
  );
  if (book[0]?.name) {
    return {
      name: String(book[0].name).trim(),
      company: String(book[0].company || "").trim(),
      source: "contacts",
      crmId: "",
    };
  }

  // CRM DB lookup — URL may include {phone}; expects JSON with name / Name / contact_name
  const app = await getAppCrmSettings(appId);
  const lookupUrl = String(app?.crm_lookup_url || process.env.CRM_LOOKUP_URL || "").trim();
  if (lookupUrl) {
    try {
      const url = applyVars(lookupUrl, { phone: key, name: "", extension: "", call_id: "", did: "", company: "", crm_id: "", agent: "" });
      const headers = { Accept: "application/json" };
      const auth = String(
        app?.crm_lookup_auth_header || process.env.CRM_LOOKUP_AUTH_HEADER || ""
      ).trim();
      if (auth) {
        if (auth.includes(":")) {
          const idx = auth.indexOf(":");
          headers[auth.slice(0, idx).trim()] = auth.slice(idx + 1).trim();
        } else {
          headers.Authorization = auth;
        }
      }
      const res = await fetch(url, { method: "GET", headers });
      const data = await res.json().catch(() => null);
      const obj = data?.data || data?.contact || data || {};
      const name = String(
        obj.name || obj.Name || obj.contact_name || obj.full_name || obj.customer_name || ""
      ).trim();
      const company = String(obj.company || obj.Company || obj.account || "").trim();
      const crmId = String(obj.id || obj.crm_id || obj.contact_id || "").trim();
      if (name) {
        return { name, company, source: "crm_db", crmId };
      }
    } catch (err) {
      console.error("CRM lookup failed:", err.message);
    }
  }

  return { name: "", company: "", source: null, crmId: "" };
}

function buildScreenPopPayload(vars, extra = {}) {
  const title = vars.name
    ? `Incoming call — ${vars.name}`
    : `Incoming call — ${vars.phone || "Unknown"}`;
  return {
    event: "incoming_call",
    title,
    message: vars.name
      ? `{name} is calling ({phone})`
      : `Incoming call from {phone}`,
    message_resolved: vars.name
      ? `${vars.name} is calling (${vars.phone})`
      : `Incoming call from ${vars.phone}`,
    variables: {
      name: vars.name,
      phone: vars.phone,
      extension: vars.extension,
      call_id: vars.call_id,
      did: vars.did,
      company: vars.company,
      crm_id: vars.crm_id,
      agent: vars.agent,
    },
    screen_pop: {
      phone: vars.phone,
      name: vars.name,
      company: vars.company,
      extension: vars.extension,
      callId: vars.call_id,
      crmId: vars.crm_id,
      openContact: Boolean(vars.crm_id || vars.phone),
    },
    ...extra,
  };
}

function signPayload(secret, bodyText) {
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(bodyText).digest("hex");
}

/**
 * POST screen-pop JSON to the CRM webhook so the CRM user's screen can show the call + name.
 */
async function deliverCrmScreenPop(appId, payload) {
  const app = await getAppCrmSettings(appId);
  const url = String(app?.crm_webhook_url || process.env.CRM_WEBHOOK_URL || "").trim();
  if (!url) {
    return { delivered: false, skipped: true, reason: "No CRM webhook URL configured" };
  }

  const bodyText = JSON.stringify(payload);
  const secret = String(app?.crm_webhook_secret || process.env.CRM_WEBHOOK_SECRET || "").trim();
  const signature = signPayload(secret, bodyText);
  const headers = {
    "Content-Type": "application/json",
    "X-IPBS-Event": payload.event || "incoming_call",
    "User-Agent": "IPBS-Neron-CRM/1.0",
  };
  if (signature) {
    headers["X-IPBS-Signature"] = signature;
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  let statusCode = null;
  let responseBody = "";
  let errorMessage = null;
  try {
    const res = await fetch(url, { method: "POST", headers, body: bodyText });
    statusCode = res.status;
    responseBody = (await res.text()).slice(0, 2000);
    if (!res.ok) {
      errorMessage = `HTTP ${res.status}`;
    }
  } catch (err) {
    errorMessage = err.message || "Webhook failed";
  }

  await query(
    `INSERT INTO crm_deliveries
      (app_id, event, url, payload_json, status_code, response_body, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      payload.event || "incoming_call",
      url,
      bodyText.slice(0, 8000),
      statusCode,
      responseBody || null,
      errorMessage,
    ]
  );

  return {
    delivered: !errorMessage && statusCode >= 200 && statusCode < 300,
    statusCode,
    errorMessage,
    url,
  };
}

/**
 * Full inbound screen-pop: resolve {name} from CRM/local DB, notify CRM webhook, return payload.
 */
async function screenPopIncoming(appId, input = {}) {
  const baseVars = buildScreenPopVars(input);
  const resolved = await resolveCallerName(appId, baseVars.phone, baseVars.name);
  const vars = {
    ...baseVars,
    name: resolved.name || baseVars.name,
    company: resolved.company || baseVars.company,
    crm_id: resolved.crmId || baseVars.crm_id,
  };

  const payload = buildScreenPopPayload(vars, {
    name_source: resolved.source,
    received_at: new Date().toISOString(),
  });

  // Resolve message templates with variables for CRM UI
  payload.title = applyVars(
    vars.name ? "Incoming call — {name}" : "Incoming call — {phone}",
    vars
  );
  payload.message_resolved = applyVars(payload.message, vars);

  const skipDelivery = input.notify === false || input.skipDelivery === true;
  const delivery = skipDelivery
    ? { delivered: false, skipped: true, reason: "notify=false" }
    : await deliverCrmScreenPop(appId, payload);
  return { vars, payload, delivery, resolved };
}

module.exports = {
  applyVars,
  buildScreenPopVars,
  buildScreenPopPayload,
  resolveCallerName,
  getAppCrmSettings,
  deliverCrmScreenPop,
  screenPopIncoming,
  signPayload,
};
