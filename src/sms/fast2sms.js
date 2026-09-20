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

/**
 * Send DLT OTP via Fast2SMS bulkV2 (route=dlt).
 * Template message id = FAST2SMS_TEMPLATE_ID (220273).
 * variables_values = OTP (pipe-separated if template has more vars).
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

  const variables = String(cfg.variablesValues || "{otp}")
    .replace(/\{otp\}/gi, String(otp))
    .replace(/\{mobile\}/gi, number);

  const body = {
    route: "dlt",
    sender_id: cfg.senderId || "ONESAA",
    message: String(cfg.templateId || "220273"),
    variables_values: variables,
    numbers: number,
    flash: 0,
  };
  if (cfg.entityId) {
    body.entity_id = String(cfg.entityId);
  }

  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: cfg.apiKey,
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

  if (!ok) {
    const detail =
      (Array.isArray(data?.message) && data.message.join(", ")) ||
      data?.message ||
      data?.description ||
      `HTTP ${res.status}`;
    console.error("Fast2SMS OTP failed:", detail, data);
    const err = new Error(`OTP SMS failed: ${detail}`);
    err.status = 502;
    err.payload = {
      status: "error",
      message: "Could not send OTP SMS. Try again in a moment.",
    };
    throw err;
  }

  return {
    requestId: data.request_id || null,
    number,
  };
}

module.exports = {
  generateOtp,
  isSmsConfigured,
  sendOtpSms,
  last10Digits,
};
