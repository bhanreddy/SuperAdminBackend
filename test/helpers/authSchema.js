const fs = require('node:fs');
const path = require('node:path');

// Exercise legacy-directory authentication alongside the current auth schema.
// Missing-table errors in the PGlite socket adapter discard the next result;
// production authentication must be tested with the migrated schema instead.
async function createAuthSchema(sql) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_create_rbac_tables.sql'), 'utf8');
  await sql.unsafe(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS internal_users'), source.indexOf('-- 5. School Requirements')));
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action text,
    entity text, entity_id text, details jsonb, ip_address text, user_agent text,
    school_id int, created_at timestamptz DEFAULT now()
  )`);
  // PGlite has one PostgreSQL session. A multi-connection postgres.js pool can
  // overwrite another socket's unnamed prepared statement during Promise.all.
  // Use real SQL clients with one socket per database for this fixture only.
  const postgres = require('postgres');
  for (const [modulePath, url] of [
    ['../../src/config/db', process.env.SCHOOL_DATABASE_URL],
    ['../../src/config/crmDb', process.env.CRM_DATABASE_URL],
  ]) {
    const filename = require.resolve(modulePath);
    if (require.cache[filename]) throw new Error('Install fixture clients before loading application database modules');
    const client = postgres(url, { ssl: false, max: 1, onnotice: () => {} });
    require.cache[filename] = { id: filename, filename, loaded: true, exports: client };
  }
}
module.exports = { createAuthSchema };
