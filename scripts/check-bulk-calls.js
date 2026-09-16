require("dotenv").config();
const { query, ping } = require("../src/db");

async function main() {
  await ping();
  const camps = await query(
    `SELECT id, name, mode, extension, auto_answer, delay_sec, status, total, dialed, failed, app_id, created_at
     FROM bulk_campaigns ORDER BY id DESC LIMIT 5`
  );
  console.log("campaigns", JSON.stringify(camps, null, 2));

  if (camps[0]) {
    const items = await query(
      `SELECT id, phone, display_name, status, pbx_call_id, error_message, dialed_at
       FROM bulk_campaign_items WHERE campaign_id = ? ORDER BY id`,
      [camps[0].id]
    );
    console.log("items", JSON.stringify(items, null, 2));

    const callIds = items.map((i) => i.pbx_call_id).filter(Boolean);
    if (callIds.length) {
      const calls = await query(
        `SELECT id, request_id, extension_number, customer_number, call_status, started_at, ended_at, hangup_cause
         FROM pbx_calls WHERE id IN (${callIds.map(() => "?").join(",")})`,
        callIds
      );
      console.log("pbx_calls", JSON.stringify(calls, null, 2));

      const reqs = await query(
        `SELECT request_id, command, status, error_message, payload_json, created_at
         FROM pbx_mqtt_requests
         WHERE request_id IN (SELECT request_id FROM pbx_calls WHERE id IN (${callIds.map(() => "?").join(",")}))
         ORDER BY id DESC LIMIT 10`,
        callIds
      );
      console.log("mqtt", JSON.stringify(reqs, null, 2));
    }
  }

  const devices = await query(
    `SELECT id, name, app_id, api_enabled, integration_mode, api_type, default_gateway,
            CASE WHEN mqtt_token_enc IS NOT NULL AND mqtt_token_enc != '' THEN 1
                 WHEN mqtt_token IS NOT NULL AND mqtt_token != '' THEN 1 ELSE 0 END AS has_token
     FROM devices ORDER BY id`
  );
  console.log("devices", JSON.stringify(devices, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
