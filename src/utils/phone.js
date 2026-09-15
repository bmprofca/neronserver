const config = require("../config");

/**
 * Organization-level dial rules (single-tenant defaults from env).
 */
function normalizePhoneNumber(input, rules = {}) {
  const dialPrefix = rules.dialPrefix ?? config.dialPrefix;
  const countryCode = String(rules.countryCode ?? config.dialCountryCode).replace(
    /\D/g,
    ""
  );
  const raw = String(input || "").trim();
  if (!raw) {
    return { ok: false, error: "Phone number is required", digits: "", dial: "" };
  }

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  }
  digits = digits.replace(/\D/g, "");

  // India-oriented rules when country is 91; still configurable
  if (countryCode === "91") {
    if (digits.startsWith("91") && digits.length === 12) {
      digits = digits.slice(2);
    }
    if (digits.startsWith("0") && digits.length === 11) {
      digits = digits.slice(1);
    }
    if (digits.length !== 10) {
      return {
        ok: false,
        error: "Enter a valid 10-digit mobile number",
        digits,
        dial: "",
      };
    }
    const dial = dialPrefix ? `${dialPrefix}${digits}` : digits;
    return {
      ok: true,
      digits,
      dial,
      e164: `+${countryCode}${digits}`,
      display: digits,
    };
  }

  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      error: "Invalid telephone number length",
      digits,
      dial: "",
    };
  }
  return {
    ok: true,
    digits,
    dial: digits,
    e164: `+${digits}`,
    display: digits,
  };
}

module.exports = { normalizePhoneNumber };
