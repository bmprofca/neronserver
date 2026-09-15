require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT) || 5000,
  apiKey: process.env.API_KEY || "",
  jwtSecret: process.env.JWT_SECRET || "neron-cloud-jwt-change-me",
  otpDevMode: process.env.OTP_DEV_MODE !== "false",
  defaultMobile: process.env.DEFAULT_MOBILE || "7002695990",
  defaultOtp: process.env.DEFAULT_OTP || "123456",
  tokenEncryptKey:
    process.env.DEVICE_TOKEN_ENCRYPT_KEY ||
    process.env.JWT_SECRET ||
    "neron-device-token-key",
  dialPrefix: process.env.DIAL_PREFIX || "0",
  dialCountryCode: process.env.DIAL_COUNTRY_CODE || "91",
  callCommandTimeoutMs: Number(process.env.CALL_COMMAND_TIMEOUT_MS) || 15000,
  deviceOnlineTimeoutSec: Number(process.env.DEVICE_ONLINE_TIMEOUT_SEC) || 90,
  clickToCallRateLimitPerMin:
    Number(process.env.CLICK_TO_CALL_RATE_LIMIT_PER_MIN) || 20,
  mqtt: {
    enabled: process.env.MQTT_BROKER_URL
      ? process.env.MQTT_ENABLED !== "false"
      : process.env.MQTT_ENABLED === "true",
    brokerUrl: process.env.MQTT_BROKER_URL || "",
    username: process.env.MQTT_USERNAME || "",
    password: process.env.MQTT_PASSWORD || "",
    clientId: process.env.MQTT_CLIENT_ID || `crm-backend-${process.pid}`,
    rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== "false",
    connectTimeout: Number(process.env.MQTT_CONNECT_TIMEOUT) || 10000,
    keepalive: Number(process.env.MQTT_KEEPALIVE) || 60,
  },
  // Configurable Neron click-to-call fields (firmware may vary)
  neronDial: {
    cmd: process.env.NERON_DIAL_CMD || "dial",
    callerField: process.env.NERON_DIAL_CALLER_FIELD || "caller",
    calleeField: process.env.NERON_DIAL_CALLEE_FIELD || "callee",
    dialPermissionField:
      process.env.NERON_DIAL_PERMISSION_FIELD || "dialpermission",
    autoAnswerField: process.env.NERON_DIAL_AUTOANSWER_FIELD || "autoanswer",
    autoAnswerValue: process.env.NERON_DIAL_AUTOANSWER_VALUE || "yes",
  },
  db: {
    host: process.env.DB_HOST || "auth-db1754.hstgr.io",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "u278432002_ibpx",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "u278432002_ibpx",
    ssl: process.env.DB_SSL === "true",
  },
};
