const sql = require('./src/config/db');

async function syncCounts() {
  try {
    console.log("Syncing school_count in clusters table...");
    await sql`
      UPDATE clusters
      SET school_count = (
        SELECT COUNT(*) FROM schools
        WHERE schools.cluster_id = clusters.cluster_id
      )
    `;
    
    console.log("Triggering schema cache reload via NOTIFY pgrst...");
    try {
      await sql`NOTIFY pgrst, 'reload schema'`;
    } catch (e) {
      console.error(e);
    }
    
    console.log("Count sync complete!");
    process.exit(0);
  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  }
}

syncCounts();
