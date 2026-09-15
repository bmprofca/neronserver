const crypto = require("crypto");
const config = require("../config");

const ALGO = "aes-256-gcm";

function keyBytes() {
  return crypto.createHash("sha256").update(String(config.tokenEncryptKey)).digest();
}

function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptSecret(blob) {
  if (!blob) return null;
  if (!String(blob).startsWith("v1:")) return String(blob);
  try {
    const [, ivHex, tagHex, dataHex] = String(blob).split(":");
    const decipher = crypto.createDecipheriv(
      ALGO,
      keyBytes(),
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return out.toString("utf8");
  } catch {
    // Wrong DEVICE_TOKEN_ENCRYPT_KEY vs when blob was written — caller may fall back
    return null;
  }
}

function maskToken(token) {
  const t = String(token || "");
  if (t.length <= 8) return "••••";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

module.exports = { encryptSecret, decryptSecret, maskToken };
