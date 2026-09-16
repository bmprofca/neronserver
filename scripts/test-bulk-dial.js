/**
 * One-shot PBX dial test from inside the API container / local server tree.
 * Usage: node scripts/test-bulk-dial.js [extension] [phone]
 */
require("dotenv").config();
const { query, ping } = require("../src/db");
const {
  connectBroker,
  health,
  adapter,
  publishCommand,
  shutdown,
} = require("../src/mqtt/brokerService");
const { decryptSecret } = require("../src/security/secrets");

const extension = process.argv[2] || "1001";
const phone = process.argv[3] || "07002695990";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await ping();
  connectBroker();
  for (let i = 0; i < 20; i++) {
    if (health().connected) break;
    await sleep(250);
  }
  if (!health().connected) {
    throw new Error("MQTT not connected");
  }

  const devices = await query(
    `SELECT * FROM devices
     WHERE api_enabled = 1 AND (integration_mode = 'broker' OR api_type = 'broker')
     ORDER BY id ASC LIMIT 1`
  );
  const device = devices[0];
  if (!device) throw new Error("No broker device");
  device.deviceToken =
    decryptSecret(device.mqtt_token_enc) ||
    decryptSecret(device.mqtt_token) ||
    device.mqtt_token;
  if (!device.deviceToken) throw new Error("No device token");

  console.log("device", {
    id: device.id,
    name: device.name,
    host: device.mqtt_host,
    last_seen_at: device.last_seen_at,
  });
  console.log("mqtt", health());

  const infoId = adapter.newRequestId();
  const info = adapter.getDeviceInfo(infoId);
  try {
    const infoRes = await publishCommand(device, info.topicSuffix, info.payload, {
      wait: true,
      timeoutMs: 10000,
    });
    console.log("deviceInfo OK", JSON.stringify(infoRes.response || infoRes).slice(0, 300));
  } catch (err) {
    console.log("deviceInfo FAIL", err.message, "published=", err.published);
  }

  const requestId = adapter.newRequestId();
  const built = adapter.initiateExtensionCall({
    requestId,
    extension,
    phoneNumber: phone,
    gateway: device.default_gateway || null,
    autoAnswer: true,
  });
  console.log("dial payload", JSON.stringify(built.payload));

  try {
    const dialRes = await publishCommand(device, built.topicSuffix, built.payload, {
      wait: true,
      timeoutMs: 12000,
    });
    console.log("dial OK", JSON.stringify(dialRes.response || dialRes).slice(0, 400));
  } catch (err) {
    console.log("dial FAIL", err.message, "published=", err.published);
  }

  await sleep(500);
  shutdown();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    try {
      shutdown();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
