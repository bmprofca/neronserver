const assert = require("assert");
const { NeronMqttAdapter } = require("../src/mqtt/NeronMqttAdapter");
const {
  canTransition,
  mapNeronEventToState,
} = require("../src/mqtt/callStateMachine");
const { PendingRequestManager } = require("../src/mqtt/PendingRequestManager");
const { normalizePhoneNumber } = require("../src/utils/phone");
const { encryptSecret, decryptSecret, maskToken } = require("../src/security/secrets");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test("phone normalize India 10-digit", () => {
  const r = normalizePhoneNumber("7002695990");
  assert.equal(r.ok, true);
  assert.equal(r.dial, "07002695990");
});

test("phone reject short", () => {
  const r = normalizePhoneNumber("12345");
  assert.equal(r.ok, false);
});

test("adapter dial payload", () => {
  const a = new NeronMqttAdapter();
  const { topicSuffix, payload } = a.initiateExtensionCall({
    requestId: "r1",
    extension: "1001",
    phoneNumber: "07002695990",
  });
  assert.equal(topicSuffix, "call");
  assert.equal(payload.cmd, "dial");
  assert.equal(payload.caller, "1001");
  assert.equal(payload.callee, "07002695990");
  assert.equal(payload.request_id, "r1");
});

test("adapter parse ignores command echo shape", () => {
  const a = new NeronMqttAdapter();
  const p = a.parseIncoming(
    "device/tok/api/v1.0/command/call",
    JSON.stringify({ cmd: "dial", request_id: "x" })
  );
  assert.equal(p.channel, "command_echo");
});

test("state machine forward only", () => {
  assert.equal(canTransition("requested", "published"), true);
  assert.equal(canTransition("answered", "requested"), false);
  assert.equal(canTransition("answered", "completed"), true);
});

test("map neron events", () => {
  assert.equal(
    mapNeronEventToState("extension_status", { status: "Ringing" }),
    "extension_ringing"
  );
  assert.equal(
    mapNeronEventToState("callstatus", {
      calllist: [{ state: "Up" }],
    }),
    "answered"
  );
});

test("pending request timeout", async () => {
  const p = new PendingRequestManager();
  const promise = p.add("t1", {}, 50);
  await assert.rejects(promise, /timed out/);
});

test("secret encrypt roundtrip", () => {
  const enc = encryptSecret("super-secret-token");
  assert.ok(enc.startsWith("v1:"));
  assert.equal(decryptSecret(enc), "super-secret-token");
  assert.ok(maskToken("super-secret-token").includes("…"));
});

test("isSuccessResponse", () => {
  const a = new NeronMqttAdapter();
  assert.equal(a.isSuccessResponse({ status: "Success", message: "success" }), true);
  assert.equal(a.isSuccessResponse({ status: "failed" }), false);
});

console.log("unit tests finished");
