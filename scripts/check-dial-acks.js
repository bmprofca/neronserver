require("dotenv").config();
const { query, ping } = require("../src/db");

async function main() {
  await ping();
  const dials = await query(
    `SELECT id, command, status, created_at, completed_at,
            TIMESTAMPDIFF(SECOND, created_at, COALESCE(completed_at, created_at)) AS secs,
            LEFT(payload_json, 180) AS payload
     FROM pbx_mqtt_requests
     WHERE command = 'dial'
     ORDER BY id DESC
     LIMIT 12`
  );
  console.log("dials", JSON.stringify(dials, null, 2));

  const ext = await query(
    `SELECT extension_number, current_status, last_status_at
     FROM pbx_extensions ORDER BY extension_number`
  );
  console.log("extensions", JSON.stringify(ext, null, 2));

  const devices = await query(
    `SELECT id, name, status, connection_status, last_seen_at, integration_mode, api_enabled,
            mqtt_client_id, mqtt_host
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
