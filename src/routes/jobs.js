const express = require("express");
const { query } = require("../db");

const router = express.Router();

router.get("/pending", async (req, res, next) => {
  try {
    const deviceId = req.query.device_id;
    if (!deviceId) {
      return res.status(400).json({
        status: "error",
        message: "device_id is required",
      });
    }

    await query(
      `UPDATE devices SET status = 'online', last_seen_at = NOW() WHERE id = ?`,
      [deviceId]
    );

    const rows = await query(
      `SELECT * FROM calls
       WHERE device_id = ? AND status IN ('queued', 'dispatching')
       ORDER BY id ASC
       LIMIT 20`,
      [deviceId]
    );

    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/result", async (req, res, next) => {
  try {
    const { status, uuid = null, message = null, raw = null } = req.body || {};
    const allowed = ["success", "failed", "hungup"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        status: "error",
        message: "status must be success, failed, or hungup",
      });
    }

    const result = await query(
      `UPDATE calls
       SET status = ?, uuid = COALESCE(?, uuid), message = ?, raw_response = ?
       WHERE id = ?`,
      [status, uuid, message, raw ? JSON.stringify(raw) : null, req.params.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Job not found" });
    }

    const rows = await query("SELECT * FROM calls WHERE id = ?", [req.params.id]);
    res.json({ status: "success", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
