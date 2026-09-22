require("dotenv").config();
const key = process.env.FAST2SMS_API_KEY;
const otp = "946182";
const PH = "{#OTP#}";

function candidates() {
  const prefixes = [
    "Your OTP is ",
    "Your OTP: ",
    "OTP is ",
    "OTP: ",
    "Dear user your OTP is ",
    "Dear user, your OTP is ",
    "Dear User, your OTP is ",
    "Dear Customer, your OTP is ",
    "Dear Customer your OTP is ",
    "Your login OTP is ",
    "Your ONESAAS OTP is ",
    "Your OneSaaS OTP is ",
    "ONESAAS OTP is ",
    "ONESAAS OTP: ",
    "ONESAA OTP is ",
    "ONESAA OTP: ",
    "Use OTP ",
    "Your verification OTP is ",
    "Verification OTP is ",
    "Login OTP is ",
    "Your ONESAAS login OTP is ",
    "Hi, your OTP is ",
    "Hello, your OTP is ",
    "{#OTP#}",
  ];
  const suffixes = [
    "",
    ".",
    "!",
    ". Do not share.",
    ". Do not share it.",
    ". Do not share with anyone.",
    ". Do not share with anyone",
    ". Valid for 10 minutes.",
    ". Valid for 5 minutes.",
    ". Valid for 10 mins.",
    " for login.",
    " for ONESAAS.",
    " for OneSaaS.",
    " - ONESAAS",
    " -ONESAAS",
    " ONESAAS",
    " - ONESAA",
    ". - ONESAAS",
    ". Thanks.",
    ". Team ONESAAS",
    " - Team ONESAAS",
    " to login.",
    " to continue.",
  ];
  const out = new Set();
  for (const a of prefixes) {
    for (const b of suffixes) {
      const t = `${a}${PH}${b}`;
      // delivered SMS was 42 chars with placeholder still present
      if (t.length === 42 || t.length === 41 || t.length === 43) out.add(t);
    }
  }
  return [...out];
}

async function sendManual(message) {
  const body = {
    route: "dlt_manual",
    sender_id: "ONESAA",
    message,
    template_id: "220273",
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
  return r.json();
}

async function dlr(id) {
  const r = await fetch("https://www.fast2sms.com/dev/dlr/" + id, {
    headers: { authorization: key },
  });
  return r.json();
}

(async () => {
  const list = candidates();
  console.log("candidates", list.length);

  for (const tmpl of list) {
    const message = tmpl.replace(/\{#\s*OTP\s*#\}/gi, otp);
    const data = await sendManual(message);
    const id = data.request_id;
    const apiMsg = Array.isArray(data.message)
      ? data.message.join(",")
      : data.message;
    if (!data.return && !id) {
      console.log("skip", JSON.stringify(message), apiMsg);
      continue;
    }
    console.log("sent", JSON.stringify(message), "id=", id, apiMsg);
    if (!id) continue;
    await new Promise((r) => setTimeout(r, 2200));
    const report = await dlr(id);
    const st = report?.data?.[0]?.delivery_status?.[0];
    console.log(
      "  dlr",
      st?.status,
      st?.status_description,
      "chars",
      st?.character_count
    );
    if (String(st?.status).toLowerCase() === "delivered") {
      console.log("SUCCESS_TEMPLATE=", JSON.stringify(tmpl));
      console.log("SUCCESS_FILLED=", JSON.stringify(message));
      process.exit(0);
    }
  }
  console.log("NO_MATCH");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
