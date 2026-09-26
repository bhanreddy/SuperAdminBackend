const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const postgres = require('postgres');
const { orderedCrmMigrations } = require('./crmMigrationManifest');

const MIGRATION_LOCK = 84215045;

function postgresOptions(connectionString) {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
  const pooler = /pooler\.supabase\.com|:6543\b/.test(connectionString);
  return {
    ssl: local ? false : { rejectUnauthorized: false },
    max: 1,
    onnotice: () => {},
    prepare: pooler ? false : undefined,
  };
}

async function applyOne(sql, body) {
  const run = async (tx, text) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '120s'`);
    await tx.unsafe(text);
  };
  try {
    await sql.begin(async (tx) => {
      await tx.savepoint(async (sp) => run(sp, body));
    });
  } catch (err) {
    if (!/pgcrypto/.test(err.message || '')) throw err;
    await sql.begin((tx) => run(tx, body.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g, '-- pgcrypto skipped')));
  }
}

async function applyCrmMigrations(connectionString, { through } = {}) {
  if (!connectionString) throw new Error('CRM_DATABASE_URL is required. Refusing to use the school database.');
  const sql = postgres(connectionString, postgresOptions(connectionString));
  const applied = [];
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS crm_schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await sql.unsafe(`ALTER TABLE crm_schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);
    for (const migration of orderedCrmMigrations()) {
      const filePath = path.join(__dirname, 'migrations', migration.file);
      const body = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(body).digest('hex');
      const [row] = await sql`SELECT id, checksum FROM crm_schema_migrations WHERE id = ${migration.id}`;
      if (row?.checksum && row.checksum !== checksum) {
        throw new Error(`CRM migration ${migration.id} checksum mismatch. Refusing to continue.`);
      }
      if (!row) {
        await applyOne(sql, body);
        await sql`INSERT INTO crm_schema_migrations (id, checksum) VALUES (${migration.id}, ${checksum})`;
        applied.push(migration.id);
      } else if (!row.checksum) {
        await sql`UPDATE crm_schema_migrations SET checksum = ${checksum} WHERE id = ${migration.id} AND checksum IS NULL`;
      }
      if (through && migration.id === through) break;
    }
    return applied;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  require('../config/env');
  const config = require('../config/env');
  if (!config.crmDatabaseUrl) {
    console.error('CRM_DATABASE_URL is required. The school database is not a fallback.');
    process.exit(1);
  }
  const applied = await applyCrmMigrations(config.crmDatabaseUrl);
  console.log(applied.length ? `Applied CRM migrations: ${applied.join(', ')}` : 'CRM migrations already applied');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { applyCrmMigrations };
