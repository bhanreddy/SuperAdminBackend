const fs = require('node:fs');
const path = require('node:path');
async function initializeCompanyBooks(db, schema, name) {
  if (!/^(public|books_[a-z0-9_]+)$/.test(schema)) throw new Error('Invalid Books schema');
  await db.begin(async tx => {
    const [existing] = await tx`SELECT to_regclass(${schema + '.books_settings'}) AS table_name`;
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await tx`SELECT set_config('search_path',${`"${schema}", pg_catalog`},true)`;
    for (const file of ['26_books.sql','27_books_workflows.sql','32_books_statements.sql']) {
      const migration = fs.readFileSync(path.join(__dirname,'../../db/migrations',file),'utf8').replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'');
      await tx.unsafe(migration);
    }
    // Bind deferred trigger lookups to their owning company's books even outside an API request.
    for (const fn of ['books_immutable_journal','books_check_journal_balance','books_guard_document','books_guard_new_line']) await tx.unsafe(`ALTER FUNCTION "${schema}"."${fn}"() SET search_path TO "${schema}", pg_catalog`);
    if (!existing.table_name) await tx`UPDATE books_settings SET organization_name=${name} WHERE id=1`;
  });
}
module.exports = { initializeCompanyBooks };
