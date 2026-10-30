const fs = require('node:fs');
const path = require('node:path');
const {initializeCompanyBooks}=require('../src/services/books/companySetup');
const sql = require('../src/config/db');
async function migrateBooks() {
  try {
    const connection = await sql.reserve();
    try {
      for (const file of ['26_books.sql', '27_books_workflows.sql', '28_books_ca_access.sql', '29_books_companies.sql', '30_books_finance_connections.sql', '32_books_statements.sql']) {
        await connection.unsafe(
          fs.readFileSync(
            path.join(__dirname, '../src/db/migrations', file),
            'utf8',
          ),
        );
      }
    } finally {
      connection.release();
    }
    const companies=await sql`SELECT name,schema_name FROM public.books_companies WHERE active`;
    for(const company of companies) await initializeCompanyBooks(sql,company.schema_name,company.name);
    console.log('Books migration completed on the central database.');
  } finally {
    await sql.end();
  }
}
if (require.main === module)
  migrateBooks().catch((e) => {
    console.error('Books migration failed:', e.message);
    process.exitCode = 1;
  });
module.exports = { migrateBooks };
