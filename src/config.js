require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT) || 5000,
  apiKey: process.env.API_KEY || "",
  jwtSecret: process.env.JWT_SECRET || "neron-cloud-jwt-change-me",
  otpDevMode: process.env.OTP_DEV_MODE !== "false",
  defaultMobile: process.env.DEFAULT_MOBILE || "7002695990",
  defaultOtp: process.env.DEFAULT_OTP || "123456",
  db: {
    host: process.env.DB_HOST || "auth-db1754.hstgr.io",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "u278432002_ibpx",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "u278432002_ibpx",
    ssl: process.env.DB_SSL === "true",
  },
};
