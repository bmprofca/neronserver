const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

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
    created_at: user.created_at,
  };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      const rows = await query("SELECT * FROM users WHERE id = ? LIMIT 1", [
        req.user.id,
      ]);
      return res.json({ status: "success", data: rows.map(publicUser) });
    }
    const rows = await query(
      "SELECT * FROM users ORDER BY role ASC, name ASC"
    );
    res.json({ status: "success", data: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
  try {
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

    const result = await query(
      `INSERT INTO users (name, mobile, extension, role, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [name, mobile, extension, role]
    );
    const rows = await query("SELECT * FROM users WHERE id = ?", [
      result.insertId,
    ]);
    res.status(201).json({ status: "success", data: publicUser(rows[0]) });
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
    const current = await query("SELECT * FROM users WHERE id = ?", [
      req.params.id,
    ]);
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

    await query(
      `UPDATE users
       SET name = ?, mobile = ?, extension = ?, role = ?, status = ?
       WHERE id = ?`,
      [name, mobile, extension, role, status, req.params.id]
    );
    const rows = await query("SELECT * FROM users WHERE id = ?", [req.params.id]);
    res.json({ status: "success", data: publicUser(rows[0]) });
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
    const result = await query("DELETE FROM users WHERE id = ?", [req.params.id]);
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }
    res.json({ status: "success", message: "User deleted" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
