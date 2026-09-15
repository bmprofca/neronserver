/**
 * Mock Neron MQTT device for local development.
 * Usage: MQTT_BROKER_URL=mqtt://127.0.0.1:1883 DEVICE_TOKEN=testtoken npm run mqtt:simulate-neron
 */
require("dotenv").config();
const mqtt = require("mqtt");
const crypto = require("crypto");

const url = process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
const token = process.env.DEVICE_TOKEN || "test-device-token";
const username = process.env.MQTT_USERNAME || undefined;
const password = process.env.MQTT_PASSWORD || undefined;
const rejectUnauthorized = process.env.MQTT_REJECT_UNAUTHORIZED !== "false";

const base = `device/${token}/api/v1.0`;
const client = mqtt.connect(url, {
  clientId: `neron-sim-${Date.now()}`,
  username,
  password,
  rejectUnauthorized,
  reconnectPeriod: 2000,
});

function pub(topic, obj) {
  client.publish(topic, JSON.stringify(obj), { qos: 1 });
  console.log("→", topic, JSON.stringify(obj).slice(0, 160));
}

client.on("connect", () => {
  console.log("Simulator connected", url);
  client.subscribe(`${base}/command/#`, { qos: 1 });
  pub(`${base}/status`, { status: "online" });
});

client.on("message", (topic, buf) => {
  let msg;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (msg.cmd && !msg.status && topic.includes("/command/")) {
    // echo ignored by CRM; send real response
    const requestId = msg.request_id || crypto.randomUUID();
    if (msg.cmd === "deviceInfo") {
      pub(`${base}/response`, {
        request_id: requestId,
        status: "Success",
        message: "success",
        model: "Neron 20",
        firmware: "sim-1.0",
      });
      return;
    }
    if (msg.cmd === "extension_list") {
      pub(`${base}/response`, {
        request_id: requestId,
        status: "Success",
        message: "success",
        extensions: [
          { extension: "1001", status: "Idle" },
          { extension: "1002", status: "Idle" },
        ],
      });
      return;
    }
    if (msg.cmd === "trunk_list") {
      pub(`${base}/response`, {
        request_id: requestId,
        status: "Success",
        message: "success",
        trunks: [{ name: "FXO/1", status: "Idle" }],
      });
      return;
    }
    if (msg.cmd === "dial") {
      const callid = `${Date.now()}.sim`;
      const scenario = process.env.SIM_SCENARIO || "answered";
      pub(`${base}/response`, {
        request_id: requestId,
        status: "Success",
        message: "success",
        callid,
      });
      setTimeout(() => {
        pub(`${base}/event`, {
          event: "extension_status",
          extension: msg.caller,
          status: "Ringing",
          callid,
        });
      }, 300);
      setTimeout(() => {
        pub(`${base}/event`, {
          event: "invite",
          from: msg.callee,
          to: msg.caller,
          callid,
        });
      }, 600);
      if (scenario === "busy") {
        setTimeout(() => {
          pub(`${base}/event`, {
            event: "hangup",
            callid,
            status: "busy",
          });
          pub(`${base}/cdr`, {
            callid,
            caller: msg.caller,
            called: msg.callee,
            disposition: "BUSY",
            duration: 0,
          });
        }, 1200);
        return;
      }
      if (scenario === "no_answer") {
        setTimeout(() => {
          pub(`${base}/cdr`, {
            callid,
            caller: msg.caller,
            called: msg.callee,
            disposition: "NO ANSWER",
            duration: 0,
          });
        }, 1500);
        return;
      }
      setTimeout(() => {
        pub(`${base}/event`, {
          event: "extension_status",
          extension: msg.caller,
          status: "InUse",
          callid,
        });
        pub(`${base}/event`, {
          event: "callstatus",
          calllist: [
            {
              caller: msg.caller,
              called: msg.callee,
              state: "Up",
              callid,
              calltype: "Outbound",
            },
          ],
        });
      }, 1000);
      setTimeout(() => {
        pub(`${base}/cdr`, {
          callid,
          caller: msg.caller,
          called: msg.callee,
          disposition: "ANSWERED",
          duration: 12,
          billsec: 10,
        });
      }, 2500);
      return;
    }
    if (msg.cmd === "hangup") {
      pub(`${base}/response`, {
        request_id: requestId,
        status: "Success",
        message: "hungup",
        callid: msg.callid,
      });
      pub(`${base}/event`, { event: "hangup", callid: msg.callid });
    }
  }
});

client.on("error", (err) => console.error("sim error", err.message));
