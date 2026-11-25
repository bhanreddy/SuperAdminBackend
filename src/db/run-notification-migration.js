const fs = require("node:fs");
const path = require("node:path");
async function migrate(sql, name = "34_notification_center.sql") {
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(74131034)`;
    await connection`CREATE TABLE IF NOT EXISTS notification_schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
    const [done] =
      await connection`SELECT name FROM notification_schema_migrations WHERE name=${name}`;
    if (done) return;
    const source = fs
      .readFileSync(path.join(__dirname, "migrations", name), "utf8")
      .replace(/^BEGIN;\s*$/m, "")
      .replace(/^COMMIT;\s*$/m, "");
    await connection.unsafe("BEGIN");
    try {
      await connection.unsafe(source);
      await connection`INSERT INTO notification_schema_migrations(name) VALUES(${name})`;
      await connection.unsafe("COMMIT");
    } catch (e) {
      await connection.unsafe("ROLLBACK");
      throw e;
    }
  } finally {
    await connection`SELECT pg_advisory_unlock(74131034)`;
    connection.release();
  }
}
if (require.main === module) {
  if (!process.argv.includes("--apply"))
    console.log(
      "Run npm run migrate:notifications -- --apply against the control-plane SCHOOL_DATABASE_URL after reviewing migration 34.",
    );
  else {
    const sql = require("../config/db");
    const target = process.argv.includes("--crm")
      ? require("../config/crmDb")
      : sql;
    migrate(
      target,
      process.argv.includes("--crm")
        ? "35_notification_crm_outbox.sql"
        : "34_notification_center.sql",
    )
      .catch((e) => {
        console.error("Notification migration failed:", e.message);
        process.exitCode = 1;
      })
      .finally(async () => {
        await target.end();
        if (target !== sql) await sql.end();
      });
  }
}
module.exports = { migrate };
