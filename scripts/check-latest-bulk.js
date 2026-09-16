require("dotenv").config();
const { query, ping } = require("../src/db");

async function main() {
  await ping();
  const camps = await query(
    `SELECT id, name, mode, extension, delay_sec, status, total, dialed, failed, created_at
     FROM bulk_campaigns ORDER BY id DESC LIMIT 3`
  );
  console.log(JSON.stringify(camps, null, 2));
  if (camps[0]) {
    const items = await query(
      `SELECT id, phone, display_name, status, pbx_call_id, error_message, dialed_at, ended_at
       FROM bulk_campaign_items WHERE campaign_id = ? ORDER BY id`,
      [camps[0].id]
    );
    console.log("items", JSON.stringify(items, null, 2));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
