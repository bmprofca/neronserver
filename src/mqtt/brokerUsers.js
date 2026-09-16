const { execFile } = require("child_process");
const fs = require("fs");
const util = require("util");

const execFileAsync = util.promisify(execFile);

function passwdFile() {
  return (
    String(process.env.MQTT_PASSWD_FILE || "").trim() ||
    "/mqtt-config/passwd"
  );
}

function brokerContainer() {
  return (
    String(process.env.MQTT_BROKER_CONTAINER || "").trim() ||
    "neron-mqtt-broker"
  );
}

/**
 * Add/update a Mosquitto user in the broker password file, then SIGHUP the broker.
 * Requires MQTT_PASSWD_FILE mounted RW into the API container and mosquitto_passwd installed.
 */
async function provisionBrokerUser(username, password) {
  const user = String(username || "").trim();
  const pass = String(password || "");
  if (!user || !pass) {
    return { ok: false, skipped: true, reason: "username/password empty" };
  }

  const file = passwdFile();
  if (!fs.existsSync(file)) {
    console.warn(
      `[mqtt-users] passwd file missing at ${file} — store credentials in DB only; mount broker config to enable live provisioning`
    );
    return {
      ok: false,
      skipped: true,
      reason: `passwd file not found: ${file}`,
    };
  }

  try {
    // -b: batch mode; do not use -c (that wipes the file)
    await execFileAsync("mosquitto_passwd", ["-b", file, user, pass], {
      timeout: 15000,
    });
  } catch (err) {
    console.error("[mqtt-users] mosquitto_passwd failed:", err.message);
    return { ok: false, reason: err.message };
  }

  let reloaded = false;
  try {
    await execFileAsync(
      "docker",
      ["kill", "--signal=HUP", brokerContainer()],
      { timeout: 10000 }
    );
    reloaded = true;
  } catch (err) {
    console.warn(
      `[mqtt-users] could not HUP broker (${err.message}). Restart neron-mqtt-broker so new users apply.`
    );
  }

  console.log(
    `[mqtt-users] provisioned broker user "${user}" (reload=${reloaded})`
  );
  return { ok: true, reloaded, username: user };
}

module.exports = { provisionBrokerUser, passwdFile };
