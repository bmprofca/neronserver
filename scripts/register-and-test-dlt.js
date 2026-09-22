require("dotenv").config();
const fs = require("fs");
const key = process.env.FAST2SMS_API_KEY;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
fs.writeFileSync("tmp-dlt.png", png);

const PH = "{#OTP#}";
const prefixes = [
  "Your OTP is ",
  "Your OTP: ",
  "Dear Customer, your OTP is ",
  "Your ONESAAS OTP is ",
  "ONESAAS OTP: ",
  "ONESAA OTP: ",
  "Use OTP ",
  "Your login OTP is ",
  "Your verification OTP is ",
];
const suffixes = [
  ". Valid for 10 minutes.",
  ". Do not share.",
  ". Do not share it.",
  ". Do not share with anyone.",
  " ONESAAS",
  " - ONESAAS",
  ". Thanks.",
];

function candidates() {
  const out = new Set();
  for (const a of prefixes) {
    for (const b of suffixes) {
      const t = a + PH + b;
      if (t.length === 42) out.add(t);
    }
  }
  out.add("Your OTP is {#OTP#}. Valid for 10 minutes.");
  return [...out];
}

async function addTemplate(messageText) {
  const fd = new FormData();
  fd.append("entity_id", "1401687770000073525");
  fd.append("sender_id[]", "ONESAA");
  fd.append("template_id", "220273");
  fd.append("message_text", messageText);
  fd.append("template_type", "n");
  fd.append("screenshot", new Blob([png], { type: "image/png" }), "dlt.png");
  const r = await fetch(
    "https://www.fast2sms.com/dev/dlt_manager/add_template",
    { method: "POST", headers: { authorization: key }, body: fd }
  );
  return r.json();
}

async function testManual(filled) {
  const body = {
    route: "dlt_manual",
    sender_id: "ONESAA",
    message: filled,
    entity_id: "1401687770000073525",
    numbers: "7002695990",
    sms_details: "1",
  };
  const r = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.request_id) return { data, dlr: null };
  await new Promise((r) => setTimeout(r, 5000));
  const dlr = await (
    await fetch("https://www.fast2sms.com/dev/dlr/" + data.request_id, {
      headers: { authorization: key },
    })
  ).json();
  return { data, dlr: dlr?.data?.[0]?.delivery_status?.[0] };
}

(async () => {
  const otp = "664291";
  const list = candidates();
  console.log("registering", list.length, "templates");
  for (const tmpl of list) {
    const withVar = tmpl.replace(/\{#OTP#\}/gi, "{#var#}");
    const add = await addTemplate(withVar);
    console.log("add", JSON.stringify(withVar), add.return, add.message || add.errors);
  }

  console.log("\ntesting delivery...");
  for (const tmpl of list) {
    const filled = tmpl.replace(/\{#OTP#\}/gi, otp);
    const { data, dlr } = await testManual(filled);
    console.log(
      "test",
      JSON.stringify(filled),
      "api",
      data.return,
      "dlr",
      dlr?.status,
      dlr?.status_description,
      "sender",
      dlr?.sender_id
    );
    if (String(dlr?.status).toLowerCase() === "delivered") {
      console.log("SUCCESS_TEMPLATE=", JSON.stringify(tmpl));
      process.exit(0);
    }
  }
  console.log("NO_DELIVERED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
