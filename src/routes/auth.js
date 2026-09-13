const express = require("express");
const { query } = require("../db");
const { signUser, requireAuth } = require("../middleware/auth");
const config = require("../config");

const router = express.Router();

function normalizeMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    extension: user.extension,
    role: user.role,
    status: user.status,
  };
}

router.post("/request-otp", async (req, res, next) => {
  try {
    const mobile = normalizeMobile(req.body?.mobile);
    if (mobile.length < 10) {
      return res.status(400).json({
        status: "error",
        message: "Enter a valid mobile number",
      });
    }

    const users = await query("SELECT * FROM users WHERE mobile = ? LIMIT 1", [
      mobile,
    ]);
    const userCountRows = await query("SELECT COUNT(*) AS total FROM users");
    const isFirstUser = Number(userCountRows[0].total) === 0;

    if (!isFirstUser && !users[0]) {
      return res.status(404).json({
        status: "error",
        message: "Mobile number is not registered. Ask an admin to add you.",
      });
    }

    if (users[0] && users[0].status === "disabled") {
      return res.status(403).json({
        status: "error",
        message: "This user is disabled",
      });
    }

    const code = config.defaultOtp;
    await query("UPDATE otp_codes SET used = 1 WHERE mobile = ? AND used = 0", [
      mobile,
    ]);
    await query(
      "INSERT INTO otp_codes (mobile, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))",
      [mobile, code]
    );

    console.log(`OTP for ${mobile}: ${code}`);

    const payload = {
      status: "success",
      message: "OTP sent. Use the default OTP to continue.",
      first_user: isFirstUser && !users[0],
      default_mobile: config.defaultMobile,
    };
    if (config.otpDevMode) {
      payload.dev_otp = code;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post("/verify-otp", async (req, res, next) => {
  try {
    const mobile = normalizeMobile(req.body?.mobile);
    const code = String(req.body?.otp || "").trim();
    const name = String(req.body?.name || "").trim();

    if (mobile.length < 10 || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        status: "error",
        message: "Enter the mobile number and 6-digit OTP",
      });
    }

    const isDefaultOtp = code === config.defaultOtp;
    const otps = await query(
      `SELECT * FROM otp_codes
       WHERE mobile = ? AND code = ? AND used = 0 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [mobile, code]
    );

    if (!otps[0] && !isDefaultOtp) {
      return res.status(400).json({
        status: "error",
        message: "Invalid or expired OTP",
      });
    }

    if (otps[0]) {
      await query("UPDATE otp_codes SET used = 1 WHERE id = ?", [otps[0].id]);
    }

    let users = await query("SELECT * FROM users WHERE mobile = ? LIMIT 1", [
      mobile,
    ]);
    const userCountRows = await query("SELECT COUNT(*) AS total FROM users");
    const isFirstUser = Number(userCountRows[0].total) === 0;

    if (!users[0] && (isFirstUser || mobile === config.defaultMobile)) {
      const result = await query(
        `INSERT INTO users (name, mobile, role, status)
         VALUES (?, ?, 'admin', 'active')`,
        [name || "Admin", mobile]
      );
      users = await query("SELECT * FROM users WHERE id = ?", [result.insertId]);
    }

    if (!users[0]) {
      return res.status(404).json({
        status: "error",
        message: "Mobile number is not registered",
      });
    }

    if (users[0].status === "disabled") {
      return res.status(403).json({
        status: "error",
        message: "This user is disabled",
      });
    }

    const token = signUser(users[0]);
    res.json({
      status: "success",
      token,
      data: publicUser(users[0]),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM users WHERE id = ? LIMIT 1", [
      req.user.id,
    ]);
    if (!rows[0] || rows[0].status === "disabled") {
      return res.status(401).json({ status: "error", message: "User not found" });
    }
    res.json({ status: "success", data: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
