const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAuthSharedDb } = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");
const { normalizePhoneNumber } = require("../utils/phone");
const { phoneMatchKey } = require("../inbound/engine");

const router = express.Router();

function mapContact(row) {
  return {
    id: String(row.id),
    name: row.name || "",
    phone: row.phone || "",
    phoneKey: row.phone_key || "",
    company: row.company || "",
    email: row.email || "",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pickContactFields(body = {}) {
  const name = String(body.name || "").trim();
  const phoneIn = body.phone || body.number || body.mobile || "";
  const phone = normalizePhoneNumber(phoneIn);
  const company = String(body.company || "").trim();
  const email = String(body.email || "").trim();
  const notes = String(body.notes || "").trim();
  return { name, phone, company, email, notes };
}

router.get("/", requireAuthSharedDb, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const q = String(req.query.q || req.query.query || "").trim();
    const params = [appId];
    let sql = `SELECT * FROM app_contacts WHERE app_id = ?`;
    if (q) {
      sql += ` AND (
        name LIKE ? OR phone LIKE ? OR company LIKE ? OR email LIKE ?
        OR phone_key LIKE ?
      )`;
      const like = `%${q}%`;
      const key = phoneMatchKey(q);
      params.push(like, like, like, like, key ? `%${key}%` : like);
    }
    sql += ` ORDER BY name ASC, id DESC LIMIT 2000`;
    const rows = await query(sql, params);
    res.json({ status: "success", data: rows.map(mapContact) });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuthSharedDb, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const fields = pickContactFields(req.body);
    if (!fields.name) {
      return res.status(400).json({ status: "error", message: "Name is required" });
    }
    if (!fields.phone.ok) {
      return res.status(400).json({ status: "error", message: fields.phone.error });
    }
    const key = phoneMatchKey(fields.phone.digits || fields.phone.dial);
    const result = await query(
      `INSERT INTO app_contacts
        (app_id, name, phone, phone_key, company, email, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         phone = VALUES(phone),
         company = VALUES(company),
         email = VALUES(email),
         notes = VALUES(notes)`,
      [
        appId,
        fields.name,
        fields.phone.dial,
        key,
        fields.company || null,
        fields.email || null,
        fields.notes || null,
        req.user?.id || null,
      ]
    );
    let id = result.insertId;
    if (!id) {
      const existing = await query(
        `SELECT id FROM app_contacts WHERE app_id = ? AND phone_key = ? LIMIT 1`,
        [appId, key]
      );
      id = existing[0]?.id;
    }
    const rows = await query(`SELECT * FROM app_contacts WHERE id = ? LIMIT 1`, [id]);
    res.json({ status: "success", data: mapContact(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAuthSharedDb, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const id = Number(req.params.id);
    const existing = await query(
      `SELECT * FROM app_contacts WHERE id = ? AND app_id = ? LIMIT 1`,
      [id, appId]
    );
    if (!existing[0]) {
      return res.status(404).json({ status: "error", message: "Contact not found" });
    }
    const fields = pickContactFields({
      name: req.body?.name ?? existing[0].name,
      phone: req.body?.phone ?? existing[0].phone,
      company: req.body?.company ?? existing[0].company,
      email: req.body?.email ?? existing[0].email,
      notes: req.body?.notes ?? existing[0].notes,
    });
    if (!fields.name) {
      return res.status(400).json({ status: "error", message: "Name is required" });
    }
    if (!fields.phone.ok) {
      return res.status(400).json({ status: "error", message: fields.phone.error });
    }
    const key = phoneMatchKey(fields.phone.digits || fields.phone.dial);
    await query(
      `UPDATE app_contacts
       SET name = ?, phone = ?, phone_key = ?, company = ?, email = ?, notes = ?
       WHERE id = ? AND app_id = ?`,
      [
        fields.name,
        fields.phone.dial,
        key,
        fields.company || null,
        fields.email || null,
        fields.notes || null,
        id,
        appId,
      ]
    );
    const rows = await query(`SELECT * FROM app_contacts WHERE id = ? LIMIT 1`, [id]);
    res.json({ status: "success", data: mapContact(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAuthSharedDb, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const id = Number(req.params.id);
    const result = await query(
      `DELETE FROM app_contacts WHERE id = ? AND app_id = ?`,
      [id, appId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ status: "error", message: "Contact not found" });
    }
    res.json({ status: "success", data: { id: String(id) } });
  } catch (err) {
    next(err);
  }
});

router.post("/import", requireAuthSharedDb, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const list = Array.isArray(req.body?.contacts)
      ? req.body.contacts
      : Array.isArray(req.body?.rows)
        ? req.body.rows
        : [];
    if (!list.length) {
      return res.status(400).json({
        status: "error",
        message: "No contacts to import. Send { contacts: [...] }",
      });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const raw of list.slice(0, 2000)) {
      const fields = pickContactFields(raw);
      if (!fields.phone.ok) {
        skipped += 1;
        errors.push({
          phone: raw?.phone || raw?.number || "",
          error: fields.phone.error,
        });
        continue;
      }
      const name =
        fields.name ||
        String(raw.name || raw.Name || raw.full_name || "").trim() ||
        fields.phone.display;
      if (!name) {
        skipped += 1;
        continue;
      }
      const key = phoneMatchKey(fields.phone.digits || fields.phone.dial);
      const before = await query(
        `SELECT id FROM app_contacts WHERE app_id = ? AND phone_key = ? LIMIT 1`,
        [appId, key]
      );
      await query(
        `INSERT INTO app_contacts
          (app_id, name, phone, phone_key, company, email, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           phone = VALUES(phone),
           company = COALESCE(VALUES(company), company),
           email = COALESCE(VALUES(email), email),
           notes = COALESCE(VALUES(notes), notes)`,
        [
          appId,
          name,
          fields.phone.dial,
          key,
          fields.company || null,
          fields.email || null,
          fields.notes || null,
          req.user?.id || null,
        ]
      );
      if (before[0]) updated += 1;
      else imported += 1;
    }

    res.json({
      status: "success",
      data: { imported, updated, skipped, errors: errors.slice(0, 20) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
