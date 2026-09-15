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
  const [pbx] = await c.query(
    `SELECT id, call_id, call_status, extension_number, customer_number,
            duration_seconds, hangup_cause, LEFT(COALESCE(raw_cdr_json,''), 400) cdr,
            started_at, ended_at
     FROM pbx_calls ORDER BY id DESC LIMIT 6`
  );
  const [resp] = await c.query(
    `SELECT request_id, status, LEFT(COALESCE(response_json,''), 400) resp
     FROM pbx_mqtt_requests ORDER BY id DESC LIMIT 4`
  );
  console.log(JSON.stringify({ pbx, resp }, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
