/**
 * Resume paused campaign OR dial via placeBulkDial in-process after connecting
 * is wrong — use HTTP resume on campaign 4 / create from existing group.
 */
require("dotenv").config();
const http = require("http");
const { query, ping } = require("../src/db");
const { signUser } = require("../src/middleware/auth");

function request2(method, path, token, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 5000,
        path,
        method,
        headers: {
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
          Authorization: `Bearer ${token}`,
        },
        timeout: 60000,
      },
      (res) => {
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  await ping();
  const users = await query(
    `SELECT * FROM users WHERE status='active' ORDER BY id ASC LIMIT 1`
  );
  const token = signUser(users[0]);
  const ext = process.argv[2] || "1001";
  const phone = process.argv[3] || "07002695990";

  console.log(
    "release",
    await request2("POST", `/api/pbx/extensions/${ext}/release`, token, {})
  );
  await new Promise((r) => setTimeout(r, 1200));

  const groups = await query(
    `SELECT g.id, g.name, COUNT(c.id) AS n
     FROM bulk_groups g
     LEFT JOIN bulk_contacts c ON c.group_id = g.id
     GROUP BY g.id
     ORDER BY g.id DESC LIMIT 5`
  );
  console.log("groups", groups);
  const groupId = groups[0]?.id;
  if (!groupId) throw new Error("No bulk group");

  const contacts = await query(
    `SELECT id, name, phone FROM bulk_contacts WHERE group_id = ? AND phone LIKE ? LIMIT 1`,
    [groupId, `%${phone.replace(/^0/, "").slice(-8)}%`]
  );
  const contactIds = contacts[0]
    ? [contacts[0].id]
    : (
        await query(
          `SELECT id FROM bulk_contacts WHERE group_id = ? ORDER BY id ASC LIMIT 1`,
          [groupId]
        )
      ).map((r) => r.id);

  const create = await request2("POST", "/api/bulk/campaigns", token, {
    name: `bulk-fix-${Date.now()}`,
    mode: "live",
    extension: ext,
    groupId,
    contactIds,
    selection: "selected",
    autoAnswer: true,
    delaySec: 45,
    start: true,
  });
  console.log("create", create.status, create.body.slice(0, 700));
  const created = JSON.parse(create.body);
  const campId = created?.data?.id;
  if (!campId) throw new Error("no campaign id: " + create.body);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const items = await query(
      `SELECT id, status, phone, pbx_call_id, error_message FROM bulk_campaign_items WHERE campaign_id = ?`,
      [campId]
    );
    const camp = (
      await query(
        `SELECT id, status, dialed, failed, queued FROM bulk_campaigns WHERE id = ?`,
        [campId]
      )
    )[0];
    console.log("poll", i, camp, items);
    const st = items[0]?.status;
    if (st && !["queued", "dialing"].includes(st)) break;
  }

  const item = (
    await query(
      `SELECT * FROM bulk_campaign_items WHERE campaign_id = ? LIMIT 1`,
      [campId]
    )
  )[0];
  if (item?.pbx_call_id) {
    const calls = await query(
      `SELECT id, call_status, call_id, customer_number, started_at FROM pbx_calls WHERE id = ?`,
      [item.pbx_call_id]
    );
    console.log("pbx_call", calls[0]);
  }

  await request2("POST", `/api/bulk/campaigns/${campId}/cancel`, token, {});
  await request2("POST", `/api/pbx/extensions/${ext}/release`, token, {});
  process.exit(item?.pbx_call_id ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
