const express = require("express");
const { query } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { resolveAppId } = require("../appsHelper");
const { normalizePhoneNumber } = require("../utils/phone");
const { phoneMatchKey } = require("../inbound/engine");
const {
  renderTemplate,
  parseVars,
  refreshCampaignCounters,
  kickCampaign,
} = require("../bulk/runner");

const router = express.Router();

function requireOwnerOrAdmin(req, res, next) {
  const role = String(req.user?.role || "");
  if (role === "admin" || role === "owner" || role === "supervisor") {
    return next();
  }
  return requireAdmin(req, res, next);
}

function mapGroup(row, contactCount = 0) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description || "",
    contactCount: Number(contactCount) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContact(row) {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    name: row.name || "",
    phone: row.phone,
    phoneKey: row.phone_key,
    variables: parseVars(row.variables_json),
    notes: row.notes || "",
    createdAt: row.created_at,
  };
}

function mapPrompt(row) {
  return {
    id: String(row.id),
    name: row.name,
    kind: row.kind,
    fileRef: row.file_ref || "",
    scriptTemplate: row.script_template || "",
    notes: row.notes || "",
    createdAt: row.created_at,
  };
}

function mapCampaign(row) {
  return {
    id: String(row.id),
    groupId: row.group_id != null ? String(row.group_id) : null,
    promptId: row.prompt_id != null ? String(row.prompt_id) : null,
    name: row.name,
    mode: row.mode,
    extension: row.extension,
    autoAnswer: Number(row.auto_answer) === 1,
    delaySec: Number(row.delay_sec) || 45,
    status: row.status,
    total: Number(row.total) || 0,
    queued: Number(row.queued) || 0,
    dialed: Number(row.dialed) || 0,
    answered: Number(row.answered) || 0,
    failed: Number(row.failed) || 0,
    skipped: Number(row.skipped) || 0,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function mapItem(row) {
  return {
    id: String(row.id),
    contactId: row.contact_id != null ? String(row.contact_id) : null,
    phone: row.phone,
    displayName: row.display_name || "",
    variables: parseVars(row.variables_json),
    renderedScript: row.rendered_script || "",
    status: row.status,
    pbxCallId: row.pbx_call_id,
    errorMessage: row.error_message || "",
    dialedAt: row.dialed_at,
    endedAt: row.ended_at,
  };
}

async function assertGroup(appId, groupId) {
  const rows = await query(
    "SELECT * FROM bulk_groups WHERE id = ? AND app_id = ?",
    [groupId, appId]
  );
  return rows[0] || null;
}

/* ── Groups ─────────────────────────────────────────────── */

router.get("/groups", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT g.*,
         (SELECT COUNT(*) FROM bulk_contacts c WHERE c.group_id = g.id) AS contact_count
       FROM bulk_groups g
       WHERE g.app_id = ?
       ORDER BY g.id DESC`,
      [appId]
    );
    res.json({
      status: "success",
      data: rows.map((r) => mapGroup(r, r.contact_count)),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/groups", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ status: "error", message: "Group name is required" });
    }
    const result = await query(
      `INSERT INTO bulk_groups (app_id, name, description, created_by)
       VALUES (?, ?, ?, ?)`,
      [appId, name, req.body?.description || null, req.user?.id || null]
    );
    const rows = await query("SELECT * FROM bulk_groups WHERE id = ?", [
      result.insertId,
    ]);
    res.json({ status: "success", data: mapGroup(rows[0], 0) });
  } catch (err) {
    next(err);
  }
});

router.patch("/groups/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const group = await assertGroup(appId, req.params.id);
    if (!group) {
      return res.status(404).json({ status: "error", message: "Group not found" });
    }
    const name = req.body?.name != null ? String(req.body.name).trim() : group.name;
    if (!name) {
      return res.status(400).json({ status: "error", message: "Group name is required" });
    }
    await query(
      `UPDATE bulk_groups SET name = ?, description = ? WHERE id = ?`,
      [
        name,
        req.body?.description != null ? req.body.description : group.description,
        group.id,
      ]
    );
    const rows = await query("SELECT * FROM bulk_groups WHERE id = ?", [group.id]);
    const count = await query(
      "SELECT COUNT(*) AS c FROM bulk_contacts WHERE group_id = ?",
      [group.id]
    );
    res.json({ status: "success", data: mapGroup(rows[0], count[0]?.c) });
  } catch (err) {
    next(err);
  }
});

router.delete("/groups/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const group = await assertGroup(appId, req.params.id);
    if (!group) {
      return res.status(404).json({ status: "error", message: "Group not found" });
    }
    await query("DELETE FROM bulk_groups WHERE id = ?", [group.id]);
    res.json({ status: "success", data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

/* ── Contacts ───────────────────────────────────────────── */

router.get("/groups/:id/contacts", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const group = await assertGroup(appId, req.params.id);
    if (!group) {
      return res.status(404).json({ status: "error", message: "Group not found" });
    }
    const rows = await query(
      `SELECT * FROM bulk_contacts WHERE group_id = ? ORDER BY id DESC`,
      [group.id]
    );
    res.json({ status: "success", data: rows.map(mapContact) });
  } catch (err) {
    next(err);
  }
});

router.post("/groups/:id/contacts", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const group = await assertGroup(appId, req.params.id);
    if (!group) {
      return res.status(404).json({ status: "error", message: "Group not found" });
    }

    const body = req.body || {};
    const list = Array.isArray(body.contacts) ? body.contacts : [body];
    const added = [];
    const errors = [];

    for (const raw of list) {
      const phoneIn = raw.phone || raw.number || raw.mobile || "";
      const phone = normalizePhoneNumber(phoneIn);
      if (!phone.ok) {
        errors.push({ phone: phoneIn, error: phone.error });
        continue;
      }
      const key = phoneMatchKey(phone.digits || phone.dial);
      const name = String(raw.name || "").trim();
      const variables =
        raw.variables && typeof raw.variables === "object" ? raw.variables : {};
      if (name && !variables.name) variables.name = name;
      try {
        const result = await query(
          `INSERT INTO bulk_contacts
            (group_id, name, phone, phone_key, variables_json, notes)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             phone = VALUES(phone),
             variables_json = VALUES(variables_json),
             notes = VALUES(notes)`,
          [
            group.id,
            name || null,
            phone.dial,
            key,
            JSON.stringify(variables),
            raw.notes || null,
          ]
        );
        const id = result.insertId || (
          await query(
            "SELECT id FROM bulk_contacts WHERE group_id = ? AND phone_key = ?",
            [group.id, key]
          )
        )[0]?.id;
        if (id) {
          const rows = await query("SELECT * FROM bulk_contacts WHERE id = ?", [id]);
          if (rows[0]) added.push(mapContact(rows[0]));
        }
      } catch (e) {
        errors.push({ phone: phoneIn, error: e.message });
      }
    }

    res.json({
      status: "success",
      data: { added, errors, addedCount: added.length, errorCount: errors.length },
    });
  } catch (err) {
    next(err);
  }
});

router.delete(
  "/groups/:groupId/contacts/:contactId",
  requireAuth,
  requireOwnerOrAdmin,
  async (req, res, next) => {
    try {
      const appId = await resolveAppId(req);
      const group = await assertGroup(appId, req.params.groupId);
      if (!group) {
        return res.status(404).json({ status: "error", message: "Group not found" });
      }
      await query("DELETE FROM bulk_contacts WHERE id = ? AND group_id = ?", [
        req.params.contactId,
        group.id,
      ]);
      res.json({ status: "success", data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

/* ── Prompts ─────────────────────────────────────────────── */

router.get("/prompts", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT * FROM bulk_prompts WHERE app_id = ? ORDER BY id DESC`,
      [appId]
    );
    res.json({ status: "success", data: rows.map(mapPrompt) });
  } catch (err) {
    next(err);
  }
});

router.post("/prompts", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) {
      return res.status(400).json({ status: "error", message: "Prompt name is required" });
    }
    const kind = ["file", "url", "script"].includes(body.kind) ? body.kind : "file";
    const result = await query(
      `INSERT INTO bulk_prompts
        (app_id, name, kind, file_ref, script_template, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        appId,
        name,
        kind,
        body.fileRef || body.file_ref || null,
        body.scriptTemplate || body.script_template || null,
        body.notes || null,
      ]
    );
    const rows = await query("SELECT * FROM bulk_prompts WHERE id = ?", [
      result.insertId,
    ]);
    res.json({ status: "success", data: mapPrompt(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.delete("/prompts/:id", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    await query("DELETE FROM bulk_prompts WHERE id = ? AND app_id = ?", [
      req.params.id,
      appId,
    ]);
    res.json({ status: "success", data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

router.post("/prompts/preview", requireAuth, async (req, res, next) => {
  try {
    const template = String(req.body?.scriptTemplate || req.body?.template || "");
    const variables = parseVars(req.body?.variables || {});
    res.json({
      status: "success",
      data: { rendered: renderTemplate(template, variables) },
    });
  } catch (err) {
    next(err);
  }
});

/* ── Campaigns ───────────────────────────────────────────── */

router.get("/campaigns", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      `SELECT * FROM bulk_campaigns WHERE app_id = ? ORDER BY id DESC LIMIT 50`,
      [appId]
    );
    res.json({ status: "success", data: rows.map(mapCampaign) });
  } catch (err) {
    next(err);
  }
});

router.get("/campaigns/:id", requireAuth, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const rows = await query(
      "SELECT * FROM bulk_campaigns WHERE id = ? AND app_id = ?",
      [req.params.id, appId]
    );
    if (!rows[0]) {
      return res.status(404).json({ status: "error", message: "Campaign not found" });
    }
    const items = await query(
      `SELECT * FROM bulk_campaign_items WHERE campaign_id = ? ORDER BY id ASC`,
      [rows[0].id]
    );
    res.json({
      status: "success",
      data: { ...mapCampaign(rows[0]), items: items.map(mapItem) },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/campaigns", requireAuth, requireOwnerOrAdmin, async (req, res, next) => {
  try {
    const appId = await resolveAppId(req);
    const body = req.body || {};
    const groupId = body.groupId;
    const extension = String(body.extension || "").trim();
    const mode = body.mode === "prerecorded" ? "prerecorded" : "live";
    const name = String(body.name || "").trim() || `Bulk ${new Date().toLocaleString()}`;

    if (!groupId) {
      return res.status(400).json({ status: "error", message: "groupId is required" });
    }
    if (!extension) {
      return res.status(400).json({ status: "error", message: "extension is required" });
    }

    const group = await assertGroup(appId, groupId);
    if (!group) {
      return res.status(404).json({ status: "error", message: "Group not found" });
    }

    let promptId = body.promptId || null;
    if (mode === "prerecorded") {
      if (!promptId) {
        return res.status(400).json({
          status: "error",
          message: "Select a pre-recorded / script prompt for prerecorded mode",
        });
      }
      const prompts = await query(
        "SELECT id FROM bulk_prompts WHERE id = ? AND app_id = ?",
        [promptId, appId]
      );
      if (!prompts[0]) {
        return res.status(404).json({ status: "error", message: "Prompt not found" });
      }
    } else {
      promptId = promptId || null;
    }

    let contacts;
    const selectedIds = Array.isArray(body.contactIds)
      ? body.contactIds.map(String)
      : null;
    if (selectedIds && selectedIds.length) {
      const placeholders = selectedIds.map(() => "?").join(",");
      contacts = await query(
        `SELECT * FROM bulk_contacts
         WHERE group_id = ? AND id IN (${placeholders})
         ORDER BY id ASC`,
        [group.id, ...selectedIds]
      );
    } else if (body.selection === "selected" && (!selectedIds || !selectedIds.length)) {
      return res.status(400).json({
        status: "error",
        message: "Select at least one number, or choose all numbers in the group",
      });
    } else {
      contacts = await query(
        `SELECT * FROM bulk_contacts WHERE group_id = ? ORDER BY id ASC`,
        [group.id]
      );
    }

    if (!contacts.length) {
      return res.status(400).json({
        status: "error",
        message: "No contacts to dial in this group/selection",
      });
    }

    const delaySec = Math.max(30, Number(body.delaySec) || 45);
    const autoAnswer = body.autoAnswer === false ? 0 : 1;
    const startNow = body.start !== false;

    const camp = await query(
      `INSERT INTO bulk_campaigns
        (app_id, group_id, prompt_id, name, mode, extension, auto_answer,
         delay_sec, status, total, queued, created_by, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appId,
        group.id,
        promptId,
        name,
        mode,
        extension,
        autoAnswer,
        delaySec,
        startNow ? "running" : "draft",
        contacts.length,
        contacts.length,
        req.user?.id || null,
        startNow ? new Date() : null,
      ]
    );

    for (const c of contacts) {
      await query(
        `INSERT INTO bulk_campaign_items
          (campaign_id, contact_id, phone, display_name, variables_json, status)
         VALUES (?, ?, ?, ?, ?, 'queued')`,
        [
          camp.insertId,
          c.id,
          c.phone,
          c.name || "",
          c.variables_json || null,
        ]
      );
    }

    await refreshCampaignCounters(camp.insertId);

    if (startNow) kickCampaign(camp.insertId);

    const rows = await query("SELECT * FROM bulk_campaigns WHERE id = ?", [
      camp.insertId,
    ]);
    res.json({ status: "success", data: mapCampaign(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/campaigns/:id/pause",
  requireAuth,
  requireOwnerOrAdmin,
  async (req, res, next) => {
    try {
      const appId = await resolveAppId(req);
      await query(
        `UPDATE bulk_campaigns SET status = 'paused' WHERE id = ? AND app_id = ? AND status = 'running'`,
        [req.params.id, appId]
      );
      const rows = await query(
        "SELECT * FROM bulk_campaigns WHERE id = ? AND app_id = ?",
        [req.params.id, appId]
      );
      if (!rows[0]) {
        return res.status(404).json({ status: "error", message: "Campaign not found" });
      }
      res.json({ status: "success", data: mapCampaign(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/campaigns/:id/resume",
  requireAuth,
  requireOwnerOrAdmin,
  async (req, res, next) => {
    try {
      const appId = await resolveAppId(req);
      const rows = await query(
        "SELECT * FROM bulk_campaigns WHERE id = ? AND app_id = ?",
        [req.params.id, appId]
      );
      if (!rows[0]) {
        return res.status(404).json({ status: "error", message: "Campaign not found" });
      }
      if (!["paused", "draft"].includes(rows[0].status)) {
        return res.status(400).json({
          status: "error",
          message: `Cannot resume campaign in status ${rows[0].status}`,
        });
      }
      await query(
        `UPDATE bulk_campaigns
         SET status = 'running', started_at = COALESCE(started_at, NOW()), finished_at = NULL
         WHERE id = ?`,
        [rows[0].id]
      );
      kickCampaign(rows[0].id);
      const updated = await query("SELECT * FROM bulk_campaigns WHERE id = ?", [
        rows[0].id,
      ]);
      res.json({ status: "success", data: mapCampaign(updated[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/campaigns/:id/cancel",
  requireAuth,
  requireOwnerOrAdmin,
  async (req, res, next) => {
    try {
      const appId = await resolveAppId(req);
      await query(
        `UPDATE bulk_campaigns
         SET status = 'cancelled', finished_at = NOW()
         WHERE id = ? AND app_id = ? AND status IN ('running','paused','draft')`,
        [req.params.id, appId]
      );
      await query(
        `UPDATE bulk_campaign_items
         SET status = 'cancelled', ended_at = NOW()
         WHERE campaign_id = ? AND status = 'queued'`,
        [req.params.id]
      );
      await refreshCampaignCounters(req.params.id);
      const rows = await query(
        "SELECT * FROM bulk_campaigns WHERE id = ? AND app_id = ?",
        [req.params.id, appId]
      );
      if (!rows[0]) {
        return res.status(404).json({ status: "error", message: "Campaign not found" });
      }
      res.json({ status: "success", data: mapCampaign(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
