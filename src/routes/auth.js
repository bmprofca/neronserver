const express = require("express");
const { query } = require("../db");
const { signUser, requireAuth } = require("../middleware/auth");
const config = require("../config");
const {
  ensureDefaultApp,
  getAppById,
  publicApp,
  createAppWithBrokerDevice,
} = require("../appsHelper");

const router = express.Router();

function normalizeMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits;
}

function publicUser(user, app = null) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    extension: user.extension,
    role: user.role,
    status: user.status,
    app_id: user.app_id || null,
    app: app ? publicApp(app) : null,
  };
}

function sendAuthError(res, err, next) {
  if (err && err.payload && err.status) {
    return res.status(err.status).json(err.payload);
  }
  return next(err);
}

router.post("/request-otp", async (req, res, next) => {
  try {
    const mobile = normalizeMobile(req.body?.mobile);
    const isRegister =
      req.body?.register === true ||
      req.body?.purpose === "register" ||
      req.body?.mode === "register";

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

    if (isRegister) {
      if (users[0]) {
        return res.status(409).json({
          status: "error",
          message:
            "This mobile is already registered. Sign in instead, or use a different mobile.",
        });
      }
    } else if (!isFirstUser && !users[0]) {
      return res.status(404).json({
        status: "error",
        message:
          "Mobile number is not registered. Use Create an account on the login page.",
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
      register: Boolean(isRegister),
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

/** Sign in existing user (no new app). */
router.post("/verify-otp", async (req, res, next) => {
  try {
    const mobile = normalizeMobile(req.body?.mobile);
    const code = String(req.body?.otp || "").trim();

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

    // Bootstrap only the very first install admin onto Bmtax (legacy)
    const userCountRows = await query("SELECT COUNT(*) AS total FROM users");
    const isFirstUser = Number(userCountRows[0].total) === 0;
    if (!users[0] && (isFirstUser || mobile === config.defaultMobile)) {
      const defApp = await ensureDefaultApp();
      const name = String(req.body?.name || "").trim() || "Admin";
      const result = await query(
        `INSERT INTO users (name, mobile, role, status, app_id)
         VALUES (?, ?, 'admin', 'active', ?)`,
        [name, mobile, defApp.id]
      );
      users = await query("SELECT * FROM users WHERE id = ?", [result.insertId]);
    }

    if (!users[0]) {
      return res.status(404).json({
        status: "error",
        message:
          "Mobile number is not registered. Use Create an account to start a new business app.",
      });
    }

    if (users[0].status === "disabled") {
      return res.status(403).json({
        status: "error",
        message: "This user is disabled",
      });
    }

    if (!users[0].app_id) {
      const defApp = await ensureDefaultApp();
      await query("UPDATE users SET app_id = ? WHERE id = ?", [
        defApp.id,
        users[0].id,
      ]);
      users[0].app_id = defApp.id;
    }

    const app = await getAppById(users[0].app_id);
    const token = signUser(users[0]);
    res.json({
      status: "success",
      token,
      data: publicUser(users[0], app),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Create account: new app (unique MQTT Token + Client ID) + admin user.
 */
router.post("/register", async (req, res, next) => {
  try {
    const mobile = normalizeMobile(req.body?.mobile);
    const code = String(req.body?.otp || "").trim();
    const name = String(req.body?.name || "").trim();
    const orgName = String(
      req.body?.orgName || req.body?.company || req.body?.app_name || ""
    ).trim();

    if (!orgName) {
      return res.status(400).json({
        status: "error",
        message: "Company / app name is required",
      });
    }
    if (!name) {
      return res.status(400).json({
        status: "error",
        message: "Your name is required",
      });
    }
    if (mobile.length < 10 || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        status: "error",
        message: "Enter the mobile number and 6-digit OTP",
      });
    }

    const existing = await query("SELECT id FROM users WHERE mobile = ? LIMIT 1", [
      mobile,
    ]);
    if (existing[0]) {
      return res.status(409).json({
        status: "error",
        message:
          "This mobile is already registered. Sign in instead of creating a new account.",
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

    const { app } = await createAppWithBrokerDevice(orgName, {
      notes: `Created via Create account for ${name} (${mobile})`,
    });

    const result = await query(
      `INSERT INTO users (name, mobile, role, status, app_id)
       VALUES (?, ?, 'admin', 'active', ?)`,
      [name, mobile, app.id]
    );
    const users = await query("SELECT * FROM users WHERE id = ?", [
      result.insertId,
    ]);

    const token = signUser(users[0]);
    res.status(201).json({
      status: "success",
      token,
      data: publicUser(users[0], app),
      message:
        "Account created. Your app has a unique MQTT Token and Client ID — open Apps to configure your Neron PBX.",
    });
  } catch (err) {
    return sendAuthError(res, err, next);
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
    if (!rows[0].app_id) {
      const defApp = await ensureDefaultApp();
      await query("UPDATE users SET app_id = ? WHERE id = ?", [
        defApp.id,
        rows[0].id,
      ]);
      rows[0].app_id = defApp.id;
    }
    const app = await getAppById(rows[0].app_id);
    res.json({ status: "success", data: publicUser(rows[0], app) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
