require("dotenv").config();
const { query, ping } = require("../src/db");

async function main() {
  await ping();
  const mqtt = await query(
    `SELECT id, request_id, command, topic, status, payload_json, created_at, completed_at
     FROM pbx_mqtt_requests
     WHERE request_id IN ('7d6adcce-8747-4ff7-82d8-c51393c731a2','386f4148-7474-4e99-be06-98938b82ead2')
        OR created_at >= '2026-09-16 13:15:00'
     ORDER BY id DESC LIMIT 20`
  );
  console.log("mqtt recent", JSON.stringify(mqtt, null, 2));

  const recentCalls = await query(
    `SELECT id, request_id, extension_number, customer_number, call_status, direction, started_at, answered_at, ended_at
     FROM pbx_calls
     ORDER BY id DESC LIMIT 15`
  );
  console.log("recent pbx_calls", JSON.stringify(recentCalls, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
