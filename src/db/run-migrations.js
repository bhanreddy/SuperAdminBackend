const fs = require('fs');
const path = require('path');
const sql = require('../config/db');

async function runMigrations() {
  try {
    const migrationSql = fs.readFileSync(
      path.join(__dirname, 'migrations', '001_create_rbac_tables.sql'),
      'utf8',
    );
    await sql.unsafe(migrationSql);
    console.log('RBAC schema migration completed successfully.');
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('RBAC migration failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { runMigrations };
