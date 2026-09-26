const config = require("../config");

/**
 * Normalize a customer phone for India (default) dial-out.
 *
 * Important:
 * - A *10-digit* number starting with "91" is a valid Indian mobile (e.g. 9123456780).
 *   Never strip "91" from those — that would leave 8 digits and reject the call.
 * - Only strip a leading country code when the string is clearly 91 + 10 national digits
 *   (length 12), or 0 + 10 digits (length 11).
 * - Dial prefix "0" + national "91…" produces "091…" which many PBXs treat as ISD and
 *   reject as "invalid number". For those mobiles, omit the leading 0.
 */
function normalizePhoneNumber(input, rules = {}) {
  const dialPrefix = String(rules.dialPrefix ?? config.dialPrefix ?? "");
  const countryCode = String(rules.countryCode ?? config.dialCountryCode).replace(
    /\D/g,
    ""
  );
  const raw = String(input || "").trim();
  if (!raw) {
    return { ok: false, error: "Phone number is required", digits: "", dial: "" };
  }

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  digits = digits.replace(/\D/g, "");

  if (countryCode === "91") {
    // 91XXXXXXXXXX (country + 10-digit national) — not a 10-digit mobile that starts with 91
    if (digits.length === 12 && digits.startsWith("91")) {
      digits = digits.slice(2);
    }
    // 0XXXXXXXXXX (trunk + 10 digits)
    if (digits.length === 11 && digits.startsWith("0")) {
      digits = digits.slice(1);
    }
    // Longer pasted values: keep last 10 if they look like an Indian mobile
    if (digits.length > 10) {
      const last10 = digits.slice(-10);
      if (/^[6-9]\d{9}$/.test(last10)) digits = last10;
    }

    if (digits.length !== 10 || !/^[6-9]\d{9}$/.test(digits)) {
      return {
        ok: false,
        error: "Enter a valid 10-digit mobile number",
        digits,
        dial: "",
      };
    }

    // Avoid PBX "invalid number" on 0+91… (looks like ISD India)
    let dial;
    if (dialPrefix === "0" && digits.startsWith("91")) {
      dial = digits;
    } else {
      dial = dialPrefix ? `${dialPrefix}${digits}` : digits;
    }

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
