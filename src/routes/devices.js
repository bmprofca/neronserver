const express = require("express");
const { query } = require("../db");
const {
  fetchLiveCalls,
  fetchCdr,
  fetchCallStatus,
} = require("../neronClient");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM devices ORDER BY id DESC");
    res.json({ status: "success", data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM devices WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows[0]) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    res.json({ status: "success", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const {
      name,
      model = "Neron 20",
      serial = null,
      mqtt_token = null,
      base_url = "http://127.0.0.1",
      api_type = "agent",
      default_gateway = null,
      notes = null,
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ status: "error", message: "name is required" });
    }

    const result = await query(
      `INSERT INTO devices
        (name, model, serial, mqtt_token, base_url, api_type, default_gateway, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, model, serial, mqtt_token, base_url, api_type, default_gateway, notes]
    );

    const rows = await query("SELECT * FROM devices WHERE id = ?", [
      result.insertId,
    ]);
    res.status(201).json({ status: "success", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const current = await query("SELECT * FROM devices WHERE id = ?", [
      req.params.id,
    ]);
    if (!current[0]) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }

    const nextDevice = {
      ...current[0],
      ...req.body,
    };

    await query(
      `UPDATE devices
       SET name = ?, model = ?, serial = ?, mqtt_token = ?, base_url = ?,
           api_type = ?, default_gateway = ?, notes = ?
       WHERE id = ?`,
      [
        nextDevice.name,
        nextDevice.model,
        nextDevice.serial,
        nextDevice.mqtt_token,
        nextDevice.base_url,
        nextDevice.api_type,
        nextDevice.default_gateway,
        nextDevice.notes,
        req.params.id,
      ]
    );

    const rows = await query("SELECT * FROM devices WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ status: "success", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const result = await query("DELETE FROM devices WHERE id = ?", [
      req.params.id,
    ]);
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    res.json({ status: "success", message: "Device deleted" });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/heartbeat", async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE devices
       SET status = 'online', last_seen_at = NOW()
       WHERE id = ?`,
      [req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    res.json({ status: "success", message: "Heartbeat recorded" });
  } catch (err) {
    next(err);
  }
});

async function proxyNeron(req, res, next, fetcher) {
  try {
    const rows = await query("SELECT * FROM devices WHERE id = ?", [
      req.params.id,
    ]);
    const device = rows[0];
    if (!device) {
      return res.status(404).json({ status: "error", message: "Device not found" });
    }
    if (device.api_type !== "http" || !device.base_url) {
      return res.status(409).json({
        status: "error",
        message:
          "Device is LAN-only. Use the local agent or set api_type=http with a reachable base_url.",
      });
    }

    const result = await fetcher(device, req.query);
    res.status(result.statusCode || 200).json(result.json || { message: result.text });
  } catch (err) {
    next(err);
  }
}

router.get("/:id/live-calls", (req, res, next) => {
  proxyNeron(req, res, next, fetchLiveCalls);
});

router.get("/:id/cdr", (req, res, next) => {
  proxyNeron(req, res, next, (device) =>
    fetchCdr(device, {
      start_date: req.query.start_date,
      end_date: req.query.end_date,
    })
  );
});

router.get("/:id/call-status", (req, res, next) => {
  proxyNeron(req, res, next, fetchCallStatus);
});

module.exports = router;
