const fs = require('node:fs');
const path = require('node:path');

// Deliberately opt-in. Never imported from server startup or run against CRM_DATABASE_URL.
async function migrate(sql) {
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(74131031)`;
    await connection`CREATE TABLE IF NOT EXISTS collaboration_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of [
      '31_nexsyrus_connect.sql',
      '32_connect_extensions.sql',
      '33_connect_all_roles.sql',
    ]) {
      const [done] =
        await connection`SELECT name FROM collaboration_schema_migrations WHERE name=${name}`;
      if (done) continue;
      const body = fs
        .readFileSync(path.join(__dirname, 'migrations', name), 'utf8')
        .replace(/^BEGIN;\s*$/m, '')
        .replace(/^COMMIT;\s*$/m, '');
      await connection.unsafe('BEGIN');
      try {
        await connection.unsafe(body);
        await connection`INSERT INTO collaboration_schema_migrations(name) VALUES(${name})`;
        await connection.unsafe('COMMIT');
      } catch (error) {
        await connection.unsafe('ROLLBACK');
        throw error;
      }
      console.log(`Connect migration applied: ${name}`);
    }
  } finally {
    await connection`SELECT pg_advisory_unlock(74131031)`;
    connection.release();
  }
}
if (require.main === module) {
  if (!process.argv.includes('--apply')) {
    console.log(
      'Review the Connect migrations in src/db/migrations, then explicitly run node src/db/run-connect-migration.js --apply against the control-plane SCHOOL_DATABASE_URL.',
    );
  } else {
    const sql = require('../config/db');
    migrate(sql)
      .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
      })
      .finally(() => sql.end());
  }
}
module.exports = { migrate };
