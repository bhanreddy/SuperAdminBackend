const sql = require('./src/config/db');
const { schoolSupabaseAdmin } = require('./src/config/supabase');

async function migrate() {
  try {
    console.log('Creating festival_posters table...');
    await sql`
      CREATE TABLE IF NOT EXISTS festival_posters (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title       VARCHAR(120) NOT NULL,
        image_path  TEXT NOT NULL,
        target_apps TEXT[] NOT NULL DEFAULT '{schoolims,medipos,paperforge}',
        starts_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        ends_at     TIMESTAMPTZ NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_by  UUID NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_festival_posters_active
        ON festival_posters (is_active, starts_at, ends_at)
    `;
    console.log('Table ready.');

    console.log('Creating festival-posters storage bucket (public)...');
    const { error: bucketError } = await schoolSupabaseAdmin.storage.createBucket('festival-posters', {
      public: true,
      fileSizeLimit: 2 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    });
    if (bucketError) {
      if (String(bucketError.message || '').toLowerCase().includes('already exists')) {
        console.log('Bucket already exists, skipping.');
      } else {
        throw bucketError;
      }
    } else {
      console.log('Bucket created.');
    }

    console.log("Triggering schema cache reload via NOTIFY pgrst...");
    try {
      await sql`NOTIFY pgrst, 'reload schema'`;
      console.log('Schema reload triggered.');
    } catch (e) {
      console.error('Failed to notify pgrst:', e);
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
