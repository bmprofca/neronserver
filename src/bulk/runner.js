const { query } = require("../db");
const {
  placeBulkDial,
  waitForCallSettle,
  getPrimaryBrokerDevice,
  clearExtensionLine,
  isCallStillLive,
} = require("./dial");

const running = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseVars(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function renderTemplate(template, vars = {}) {
  const src = String(template || "");
  if (!src) return "";
  return src.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = vars[key];
    return val == null ? "" : String(val);
  });
}

async function refreshCampaignCounters(campaignId) {
  const rows = await query(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'queued') AS queued,
       SUM(status IN ('dialing','dialed','answered')) AS dialed,
       SUM(status = 'answered') AS answered,
       SUM(status = 'failed') AS failed,
       SUM(status IN ('skipped','cancelled')) AS skipped
     FROM bulk_campaign_items WHERE campaign_id = ?`,
    [campaignId]
  );
  const c = rows[0] || {};
  await query(
    `UPDATE bulk_campaigns
     SET total = ?, queued = ?, dialed = ?, answered = ?, failed = ?, skipped = ?
     WHERE id = ?`,
    [
      Number(c.total) || 0,
      Number(c.queued) || 0,
      Number(c.dialed) || 0,
      Number(c.answered) || 0,
      Number(c.failed) || 0,
      Number(c.skipped) || 0,
      campaignId,
    ]
  );
}

async function loadCampaign(campaignId) {
  const rows = await query("SELECT * FROM bulk_campaigns WHERE id = ?", [
    campaignId,
  ]);
  return rows[0] || null;
}

async function loadPrompt(promptId) {
  if (!promptId) return null;
  const rows = await query("SELECT * FROM bulk_prompts WHERE id = ?", [promptId]);
  return rows[0] || null;
}

function outcomeFromCall(callRow) {
  if (!callRow) return { status: "dialed", error: null };
  const st = String(callRow.call_status || "").toLowerCase();
  if (callRow.answered_at || st === "answered" || st === "completed") {
    return { status: "answered", error: null };
  }
  if (st === "failed" || st === "timed_out" || st === "busy") {
    return {
      status: "failed",
      error: callRow.hangup_cause || st,
    };
  }
  // hungup / no_answer without answer = dialed but not picked
  return { status: "dialed", error: callRow.hangup_cause || null };
}

async function campaignStillRunning(campaignId) {
  const rows = await query("SELECT status FROM bulk_campaigns WHERE id = ?", [
    campaignId,
  ]);
  return rows[0]?.status === "running";
}

async function processNextItem(campaign) {
  const items = await query(
    `SELECT * FROM bulk_campaign_items
     WHERE campaign_id = ? AND status = 'queued'
     ORDER BY id ASC LIMIT 1`,
    [campaign.id]
  );
  const item = items[0];
  if (!item) {
    await query(
      `UPDATE bulk_campaigns
       SET status = 'completed', finished_at = NOW()
       WHERE id = ? AND status = 'running'`,
      [campaign.id]
    );
    await refreshCampaignCounters(campaign.id);
    return false;
  }

  await query(
    `UPDATE bulk_campaign_items SET status = 'dialing', dialed_at = NOW() WHERE id = ?`,
    [item.id]
  );

  const prompt = await loadPrompt(campaign.prompt_id);
  const vars = {
    name: item.display_name || "",
    phone: item.phone || "",
    ...parseVars(item.variables_json),
  };

  let playFile = null;
  let playText = null;
  if (campaign.mode === "prerecorded" && prompt) {
    if (prompt.kind === "file" || prompt.kind === "url") {
      playFile = prompt.file_ref || null;
    }
    if (prompt.kind === "script" || prompt.script_template) {
      playText = renderTemplate(prompt.script_template, vars);
    }
    if (!playFile && prompt.file_ref) playFile = prompt.file_ref;
  }

  const rendered = playText || renderTemplate(prompt?.script_template || "", vars);
  if (rendered) {
    await query(
      `UPDATE bulk_campaign_items SET rendered_script = ? WHERE id = ?`,
      [rendered, item.id]
    );
  }

  const isLive = String(campaign.mode || "live") === "live";
  let callId = null;
  let device = null;
  try {
    const result = await placeBulkDial({
      appId: campaign.app_id,
      extension: campaign.extension,
      phoneNumber: item.phone,
      actorId: campaign.created_by,
      autoAnswer: Number(campaign.auto_answer) !== 0,
      playFile: campaign.mode === "prerecorded" ? playFile : null,
      playText: campaign.mode === "prerecorded" ? playText || rendered || null : null,
      forceRelease: true,
    });
    callId = result.callId;
    device = result.device;
    await query(
      `UPDATE bulk_campaign_items
       SET status = 'dialed', pbx_call_id = ?, error_message = NULL
       WHERE id = ?`,
      [callId, item.id]
    );

    // Live: wait for natural hangup after pickup — never auto-cut an answered call.
    // Prerecorded: ring window + talk window, then clear for the next number.
    const ringTimeoutSec = Math.max(30, Number(campaign.delay_sec) || 45);
    const settled = await waitForCallSettle(callId, {
      ringTimeoutSec,
      // Live mode: after pickup, wait until someone hangs up — never time out the talk.
      talkTimeoutSec: isLive ? null : Math.max(30, Number(campaign.delay_sec) || 60),
      maxTotalSec: isLive ? 7200 : Math.max(120, ringTimeoutSec + 120),
      shouldContinue: () => campaignStillRunning(campaign.id),
    });

    const outcome = outcomeFromCall(settled);
    await query(
      `UPDATE bulk_campaign_items
       SET status = ?, error_message = ?, ended_at = NOW()
       WHERE id = ?`,
      [outcome.status, outcome.error, item.id]
    );

    // Only clear the line when the call already ended (or never connected).
    if (!isCallStillLive(settled)) {
      try {
        const dev = device || (await getPrimaryBrokerDevice(campaign.app_id));
        if (dev) {
          await clearExtensionLine(dev, campaign.extension);
          await sleep(400);
        }
      } catch {
        /* continue */
      }
    }
  } catch (err) {
    await query(
      `UPDATE bulk_campaign_items
       SET status = 'failed', error_message = ?, ended_at = NOW()
       WHERE id = ?`,
      [String(err.message || err).slice(0, 480), item.id]
    );
    try {
      const dev = device || (await getPrimaryBrokerDevice(campaign.app_id));
      if (dev) await clearExtensionLine(dev, campaign.extension);
    } catch {
      /* ignore */
    }
  }

  await refreshCampaignCounters(campaign.id);
  return true;
}

async function runCampaign(campaignId) {
  if (running.has(campaignId)) return;
  running.add(campaignId);
  try {
    while (true) {
      const campaign = await loadCampaign(campaignId);
      if (!campaign) break;
      if (campaign.status === "paused" || campaign.status === "cancelled") break;
      if (campaign.status !== "running") break;

      const more = await processNextItem(campaign);
      if (!more) break;

      await sleep(2000);

      const again = await loadCampaign(campaignId);
      if (!again || again.status !== "running") break;
    }
  } finally {
    running.delete(campaignId);
  }
}

function kickCampaign(campaignId) {
  setImmediate(() => {
    runCampaign(campaignId).catch((err) => {
      console.error("[bulk] campaign failed", campaignId, err.message);
      query(
        `UPDATE bulk_campaigns SET status = 'failed', finished_at = NOW() WHERE id = ? AND status = 'running'`,
        [campaignId]
      ).catch(() => {});
    });
  });
}

module.exports = {
  renderTemplate,
  parseVars,
  refreshCampaignCounters,
  kickCampaign,
  running,
};
