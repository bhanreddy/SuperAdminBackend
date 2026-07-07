const sql = require('./src/config/db');

async function migrate() {
  try {
    console.log("Adding columns to schools table...");
    await sql`
      ALTER TABLE schools
        ADD COLUMN IF NOT EXISTS cluster_id TEXT DEFAULT 'cluster_a',
        ADD COLUMN IF NOT EXISTS backend_url TEXT,
        ADD COLUMN IF NOT EXISTS android_package TEXT,
        ADD COLUMN IF NOT EXISTS ios_bundle_id TEXT,
        ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#1A73E8',
        ADD COLUMN IF NOT EXISTS logo_url TEXT,
        ADD COLUMN IF NOT EXISTS onboarding_status TEXT 
          DEFAULT 'pending_build'
          CHECK (onboarding_status IN (
            'pending_build',
            'apk_delivered', 
            'live',
            'suspended'
          )),
        ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    `;
    
    console.log("Updating existing schools to have cluster_a...");
    await sql`UPDATE schools SET cluster_id = 'cluster_a' WHERE cluster_id IS NULL`;

    console.log("Triggering schema cache reload via NOTIFY pgrst...");
    try {
      await sql`NOTIFY pgrst, 'reload schema'`;
    } catch (e) {
      console.error(e);
    }
    
    console.log("Migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrate();
