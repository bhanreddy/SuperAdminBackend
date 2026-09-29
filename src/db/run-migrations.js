const fs = require('fs');
const path = require('path');
const sql = require('../config/db');

async function runMigrations() {
  try {
    const migrations = ['001_create_rbac_tables.sql', '23_operational_delegation.sql'];
    for (const file of migrations) {
      const filePath = path.join(__dirname, 'migrations', file);
      if (fs.existsSync(filePath)) {
        const migrationSql = fs.readFileSync(filePath, 'utf8');
        await sql.unsafe(migrationSql);
        console.log(`Migration ${file} completed successfully.`);
      }
    }
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
