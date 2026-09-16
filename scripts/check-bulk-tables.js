require("dotenv").config();
const { query, ping } = require("../src/db");

async function main() {
  await ping();
  const tables = await query("SHOW TABLES LIKE 'bulk_%'");
  console.log("tables", tables);
  try {
    const g = await query("SELECT COUNT(*) AS c FROM bulk_groups");
    console.log("bulk_groups", g[0]);
  } catch (e) {
    console.error("bulk_groups error", e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
