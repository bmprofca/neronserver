require("dotenv").config();
const key = process.env.FAST2SMS_API_KEY;
const otp = "582917"; // 6 digits → expect chars 39 if this is the working template

async function tryMessage(message) {
  const body = {
    route: "dlt",
    sender_id: "ONESAA",
    message: String(message),
    variables_values: otp,
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
  return data;
}

(async () => {
  // Probe likely Fast2SMS message IDs for ONESAA
  const ids = [];
  for (let i = 220200; i <= 220350; i++) ids.push(i);
  for (let i = 1; i <= 50; i++) ids.push(i);
  for (let i = 100; i <= 300; i += 1) ids.push(i);
  // unique
  const unique = [...new Set(ids)];
  console.log("probing", unique.length, "message ids");

  for (const id of unique) {
    const data = await tryMessage(id);
    if (!data.return) {
      // silence invalid
      if (String(data.message || "").includes("Invalid Message")) continue;
      console.log("id", id, "err", data.message || data.status_code);
      continue;
    }
    const chars = data.sms_details?.character_count;
    console.log(
      "VALID id=",
      id,
      "chars=",
      chars,
      "request=",
      data.request_id
    );
    if (Number(chars) === 39) {
      console.log("FOUND_WORKING_MESSAGE_ID=", id);
      // verify DLR
      await new Promise((r) => setTimeout(r, 3000));
      const dlr = await (
        await fetch("https://www.fast2sms.com/dev/dlr/" + data.request_id, {
          headers: { authorization: key },
        })
      ).json();
      console.log("dlr", JSON.stringify(dlr?.data?.[0]?.delivery_status?.[0]));
      process.exit(0);
    }
  }
  console.log("DONE_NO_39");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
