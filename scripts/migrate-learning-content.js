const fs = require('node:fs');
const path = require('node:path');
const sql = require('../src/config/db');
(async () => {
  try {
    const connection = await sql.reserve();
    try { await connection.unsafe(fs.readFileSync(path.join(__dirname, '../src/db/migrations/25_learning_content_library.sql'), 'utf8')); }
    finally { connection.release(); }
    const {schoolSupabaseAdmin} = require('../src/config/supabase');
    const {BUCKET,MAX_BYTES} = require('../src/services/learningContentImages');
    const existing = await schoolSupabaseAdmin.storage.getBucket(BUCKET);
    if (existing.error) {
      const created = await schoolSupabaseAdmin.storage.createBucket(BUCKET,{public:false,fileSizeLimit:MAX_BYTES,allowedMimeTypes:['image/jpeg','image/png','image/webp']});
      if (created.error) throw new Error('Schema installed but the private image bucket could not be provisioned: '+created.error.message);
    } else if (existing.data.public) throw new Error('Content image bucket must be private; configure it before uploading.');
    console.log('Learning content library migration complete.');
  } finally { await sql.end(); }
})().catch(err => { console.error('Learning content migration failed:', err.message); process.exitCode = 1; });
