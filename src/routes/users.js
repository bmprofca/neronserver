const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAdmin, requireAuthOrKey } = require("../middleware/auth");
const { resolveAppId, ensureDefaultApp } = require("../appsHelper");

const router = express.Router();

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    extension: user.extension,
    role: user.role,
    status: user.status,
    app_id: user.app_id || null,
    created_at: user.created_at,
  };
}

/**
 * One PBX extension ↔ one CRM user within an app.
 * Clears the desk from anyone else before assigning.
 */
async function claimExclusiveExtension(appId, userId, extension) {
  const ext = String(extension || "").trim() || null;
  if (!ext) return { extension: null, previousHolders: [] };

  const holders = await query(
    `SELECT id, name, extension FROM users
     WHERE app_id = ? AND extension = ? AND id != ?`,
    [appId, ext, userId]
  );
  if (holders.length) {
    await query(
      `UPDATE users SET extension = NULL
       WHERE app_id = ? AND extension = ? AND id != ?`,
      [appId, ext, userId]
    );
  }
  return { extension: ext, previousHolders: holders };
}

router.get("/", requireAuthOrKey, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const isAdmin =
      req.user?.role === "admin" ||
      req.user?.role === "owner" ||
      (req.apiClient && req.apiClient.key_type === "app");
    if (!isAdmin) {
      if (!req.user?.id) {
        return res.status(401).json({
          status: "error",
          message: "User token or login required",
        });
      }
      const rows = await query("SELECT * FROM users WHERE id = ? LIMIT 1", [
        req.user.id,
      ]);
      return res.json({ status: "success", data: rows.map(publicUser) });
    }
    const rows = await query(
      "SELECT * FROM users WHERE app_id = ? ORDER BY role ASC, name ASC",
      [appId]
    );
    res.json({ status: "success", data: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const appId = (await resolveAppId(req)) || (await ensureDefaultApp()).id;
    const name = String(req.body?.name || "").trim();
    const mobile = normalizeMobile(req.body?.mobile);
    const extension = String(req.body?.extension || "").trim() || null;
    const role = req.body?.role === "admin" ? "admin" : "agent";

    if (!name || mobile.length < 10) {
      return res.status(400).json({
        status: "error",
        message: "Name and a valid mobile number are required",
      });
    }

    const claimed = await claimExclusiveExtension(appId, 0, extension);

    const result = await query(
      `INSERT INTO users (name, mobile, extension, role, status, app_id)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [name, mobile, claimed.extension, role, appId]
    );
    const rows = await query("SELECT * FROM users WHERE id = ?", [
      result.insertId,
    ]);
    res.status(201).json({
      status: "success",
      data: publicUser(rows[0]),
      message: claimed.previousHolders.length
        ? `Extension ${claimed.extension} was remapped from ${claimed.previousHolders
            .map((h) => h.name)
            .join(", ")}`
        : undefined,
    });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        status: "error",
        message: "This mobile number is already registered",
      });
    }
    next(err);
  }
});

router.put("/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const current = await query(
      "SELECT * FROM users WHERE id = ? AND app_id = ?",
      [req.params.id, appId]
    );
    if (!current[0]) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }

    const name = String(req.body?.name || current[0].name).trim();
    const mobile = normalizeMobile(req.body?.mobile || current[0].mobile);
    const extension =
      req.body?.extension !== undefined
        ? String(req.body.extension || "").trim() || null
        : current[0].extension;
    const role = req.body?.role || current[0].role;
    const status = req.body?.status || current[0].status;

    const claimed = await claimExclusiveExtension(
      appId,
      Number(req.params.id),
      extension
    );

    await query(
      `UPDATE users
       SET name = ?, mobile = ?, extension = ?, role = ?, status = ?
       WHERE id = ? AND app_id = ?`,
      [name, mobile, claimed.extension, role, status, req.params.id, appId]
    );
    const rows = await query("SELECT * FROM users WHERE id = ?", [req.params.id]);
    res.json({
      status: "success",
      data: publicUser(rows[0]),
      message: claimed.previousHolders.length
        ? `Extension ${claimed.extension} is exclusive — unmapped ${claimed.previousHolders
            .map((h) => h.name)
            .join(", ")}`
        : undefined,
    });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        status: "error",
        message: "This mobile number is already registered",
      });
    }
    next(err);
  }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (Number(req.params.id) === Number(req.user.id)) {
      return res.status(400).json({
        status: "error",
        message: "You cannot delete your own account",
      });
    }
    const appId = await resolveAppId(req);
    const result = await query(
      "DELETE FROM users WHERE id = ? AND app_id = ?",
      [req.params.id, appId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }
    res.json({ status: "success", message: "User deleted" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
