const sql = require('./src/config/db');

async function migrate() {
  try {
    console.log("Applying columns from 03_schools_app_update_payment_banner.sql...");
    await sql`
      ALTER TABLE schools
        ADD COLUMN IF NOT EXISTS minimum_app_version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
        ADD COLUMN IF NOT EXISTS force_update_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS payment_banner_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS payment_banner_reason VARCHAR(280) NULL;
    `;
    console.log("Columns added successfully!");

    console.log("Triggering schema cache reload via NOTIFY pgrst...");
    try {
      await sql`NOTIFY pgrst, 'reload schema'`;
      console.log("Schema reload triggered.");
    } catch (e) {
      console.error("Failed to notify pgrst:", e);
    }

    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrate();
