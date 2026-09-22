const config = require("../config");

function last10Digits(mobile) {
  const digits = String(mobile || "").replace(/\D/g, "");
  return digits.slice(-10);
}

function generateOtp(length = 6) {
  const n = Math.max(4, Math.min(8, Number(length) || 6));
  const max = 10 ** n;
  const min = 10 ** (n - 1);
  return String(Math.floor(min + Math.random() * (max - min)));
}

function isSmsConfigured() {
  return Boolean(config.fast2sms?.apiKey);
}

function buildVariablesValues(otp, mobile, pattern) {
  const code = String(otp).trim();
  const number = last10Digits(mobile);
  const raw = String(pattern == null ? "" : pattern).trim();
  if (!raw) return code;

  const filled = raw
    .replace(/\{#\s*OTP\s*#\}/gi, code)
    .replace(/\{#\s*otp\s*#\}/gi, code)
    .replace(/\{#\s*var\s*#\}/gi, code)
    .replace(/\{otp\}/gi, code)
    .replace(/\{var\}/gi, code)
    .replace(/\{mobile\}/gi, number);

  if (!filled || /\{#.*#\}/.test(filled) || /\{(otp|var)\}/i.test(filled)) {
    return code;
  }
  return filled;
}

async function postBulkV2(apiKey, body) {
  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const ok =
    res.ok &&
    data &&
    (data.return === true ||
      data.return === "true" ||
      String(data.message || "")
        .toLowerCase()
        .includes("success"));
  return { data, ok };
}

async function fetchDlrStatus(apiKey, requestId) {
  if (!requestId) return null;
  try {
    const res = await fetch(`https://www.fast2sms.com/dev/dlr/${requestId}`, {
      headers: { authorization: apiKey },
    });
    const dlr = await res.json();
    return dlr?.data?.[0]?.delivery_status?.[0] || null;
  } catch {
    return null;
  }
}

async function waitForDlr(apiKey, requestId, attempts = 6, delayMs = 2000) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await fetchDlrStatus(apiKey, requestId);
    const status = String(last?.status || "");
    if (/delivered/i.test(status) || /fail/i.test(status)) return last;
  }
  return last;
}

/**
 * Send OTP via DLT sender ONESAA.
 * Message ID 220278 fills {#var#} with the real OTP (220273 left {#OTP#} literal).
 */
async function sendOtpSms(mobile, otp) {
  const cfg = config.fast2sms || {};
  if (!cfg.apiKey) {
    const err = new Error("Fast2SMS API key is not configured");
    err.status = 503;
    err.payload = {
      status: "error",
      message: "SMS gateway is not configured. Set FAST2SMS_API_KEY in server .env.",
    };
    throw err;
  }

  const number = last10Digits(mobile);
  if (number.length !== 10) {
    const err = new Error("Invalid mobile for SMS");
    err.status = 400;
    err.payload = {
      status: "error",
      message: "Enter a valid 10-digit Indian mobile number",
    };
    throw err;
  }

  const code = String(otp).trim();
  if (!/^\d{4,8}$/.test(code)) {
    const err = new Error("Invalid OTP value for SMS");
    err.status = 500;
    err.payload = {
      status: "error",
      message: "Could not send OTP SMS. Try again in a moment.",
    };
    throw err;
  }

  const variables = buildVariablesValues(code, number, cfg.variablesValues);
  const body = {
    route: "dlt",
    sender_id: cfg.senderId || "ONESAA",
    message: String(cfg.templateId || "220278"),
    variables_values: variables,
    numbers: number,
    sms_details: "1",
  };

  const { data, ok } = await postBulkV2(cfg.apiKey, body);
  if (!ok) {
    const detail =
      (Array.isArray(data?.message) && data.message.join(", ")) ||
      data?.message ||
      data?.description ||
      "unknown error";
    console.error("Fast2SMS OTP failed:", detail, data);
    const err = new Error(`OTP SMS failed: ${detail}`);
    err.status = 502;
    err.payload = {
      status: "error",
      message: "Could not send OTP SMS from DLT sender ONESAA.",
    };
    throw err;
  }

  const requestId = data.request_id || null;
  const chars = data.sms_details?.character_count;
  const dlr = await waitForDlr(cfg.apiKey, requestId);
  const status = dlr?.status || "pending";
  const sender = dlr?.sender_id || cfg.senderId || "ONESAA";

  console.log(
    `Fast2SMS OK request_id=${requestId} route=dlt sender=${sender} message=${body.message} to=${number} chars=${chars || "n/a"} delivery=${status} var_len=${variables.length}`
  );

  if (dlr && /fail/i.test(String(status))) {
    const err = new Error(
      `OTP SMS delivery failed: ${dlr.status_description || status}`
    );
    err.status = 502;
    err.payload = {
      status: "error",
      message: "OTP SMS from ONESAA failed delivery.",
    };
    throw err;
  }

  // 42 chars with a 6-digit OTP usually means {#OTP#} was left literal
  if (Number(chars) === 42 && code.length === 6) {
    console.warn(
      "Fast2SMS: character_count=42 suggests placeholder not replaced. Check FAST2SMS_TEMPLATE_ID (use 220278, not 220273)."
    );
  }

  return {
    requestId,
    number,
    route: "dlt",
    senderId: sender,
    characterCount: chars || null,
    delivery: status,
  };
}

module.exports = {
  generateOtp,
  isSmsConfigured,
  sendOtpSms,
  last10Digits,
  buildVariablesValues,
};
