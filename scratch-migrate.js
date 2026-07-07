require('dotenv').config();
const sql = require('./src/config/db');
const config = require('./src/config/env');

async function migrate() {
  try {
    console.log("Creating clusters table...");
    await sql`
      CREATE TABLE IF NOT EXISTS clusters (
        cluster_id        TEXT PRIMARY KEY,
        label             TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        school_backend_url  TEXT NOT NULL,
        medical_backend_url TEXT NOT NULL,
        school_supabase_url TEXT,
        medical_supabase_url TEXT,
        school_anon_key   TEXT,
        medical_anon_key  TEXT,
        max_schools       INT DEFAULT 40,
        school_count      INT DEFAULT 0,
        medical_count     INT DEFAULT 0,
        school_service_role_key TEXT,
        medical_service_role_key TEXT,
        created_at        TIMESTAMPTZ DEFAULT now(),
        updated_at        TIMESTAMPTZ DEFAULT now()
      );
    `;

    console.log("Checking if cluster_a exists...");
    const existing = await sql`SELECT cluster_id FROM clusters WHERE cluster_id = 'cluster_a'`;
    
    if (existing.length === 0) {
      console.log("Seeding cluster_a...");
      await sql`
        INSERT INTO clusters (
          cluster_id, label, status,
          school_backend_url, medical_backend_url,
          school_supabase_url, medical_supabase_url,
          school_anon_key, medical_anon_key,
          school_service_role_key, medical_service_role_key,
          max_schools, school_count, medical_count
        ) VALUES (
          'cluster_a', 'Primary Cluster', 'active',
          ${process.env.SCHOOL_BACKEND_URL || 'http://localhost:4000'},
          ${process.env.MEDICAL_BACKEND_URL || 'http://localhost:4000'},
          ${config.schoolSupabase.url},
          ${config.medicalSupabase.url || null},
          ${config.schoolSupabase.anonKey},
          ${config.medicalSupabase.anonKey || null},
          ${config.schoolSupabase.serviceRoleKey},
          ${config.medicalSupabase.serviceRoleKey || null},
          40, 0, 0
        );
      `;
    } else {
      console.log("Updating cluster_a service role keys...");
      await sql`
        UPDATE clusters
        SET
          school_service_role_key = ${config.schoolSupabase.serviceRoleKey},
          medical_service_role_key = ${config.medicalSupabase.serviceRoleKey || null}
        WHERE cluster_id = 'cluster_a'
      `;
    }
    
    // Attempt schema reload using HTTP fetch since RPC failed
    console.log("Triggering schema cache reload via HTTP...");
    try {
      const { schoolSupabaseAdmin } = require('./src/config/supabase');
      // A quick hack to force reload is to insert a dummy and delete it, or just use the management API if we had it.
      // But the backend will just query it. Supabase REST API schema cache expires in 15 seconds by default usually?
      // No, postgrest schema cache requires `NOTIFY pgrst, 'reload schema'` via SQL!
      console.log("Executing NOTIFY pgrst...");
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
