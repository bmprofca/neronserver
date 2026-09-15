#!/usr/bin/env node
require("dotenv").config();
const mysql = require("mysql2/promise");

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [reqs] = await c.query(
    `SELECT id, request_id, command, topic, status, LEFT(payload_json, 280) AS payload, created_at
     FROM pbx_mqtt_requests ORDER BY id DESC LIMIT 8`
  );
  const [calls] = await c.query(
    `SELECT id, status, message, extension, caller_id_number, uuid, dialer_mode, created_at
     FROM calls ORDER BY id DESC LIMIT 8`
  );
  const [devs] = await c.query(
    `SELECT id, integration_mode, api_type, mqtt_client_id, mqtt_token, mqtt_host, mqtt_port, status, last_seen_at
     FROM devices ORDER BY id ASC LIMIT 3`
  );
  console.log(JSON.stringify({ reqs, calls, devs }, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
