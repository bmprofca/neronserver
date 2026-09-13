require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { query, ping } = require("../src/db");
const { canUseMqtt } = require("../src/neronClient");

(async () => {
  await ping();
  await query(
    `UPDATE devices
     SET mqtt_host = ?, base_url = ?, api_type = 'mqtt',
         integration_mode = 'local', api_enabled = 1
     WHERE id = 1`,
    ["192.168.0.180", "http://192.168.0.180"]
  );
  const rows = await query("SELECT * FROM devices WHERE id = 1");
  const device = rows[0];
  console.log({
    mqtt_host: device.mqtt_host,
    base_url: device.base_url,
    has_token: Boolean(device.mqtt_token),
    client_id: device.mqtt_client_id,
    canUseMqtt: canUseMqtt(device),
  });
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
