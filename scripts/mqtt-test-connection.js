require("dotenv").config();
const mqtt = require("mqtt");
const config = require("../src/config");

const url = config.mqtt.brokerUrl || process.env.MQTT_BROKER_URL;
if (!url) {
  console.error("Set MQTT_BROKER_URL");
  process.exit(1);
}

const client = mqtt.connect(url, {
  clientId: `crm-test-${Date.now()}`,
  username: config.mqtt.username || undefined,
  password: config.mqtt.password || undefined,
  rejectUnauthorized: config.mqtt.rejectUnauthorized,
  connectTimeout: config.mqtt.connectTimeout,
});

const timer = setTimeout(() => {
  console.error("FAIL: connect timeout");
  process.exit(2);
}, 12000);

client.on("connect", () => {
  clearTimeout(timer);
  console.log("OK: connected to", url);
  client.end(true);
  process.exit(0);
});

client.on("error", (err) => {
  clearTimeout(timer);
  console.error("FAIL:", err.message);
  process.exit(3);
});
