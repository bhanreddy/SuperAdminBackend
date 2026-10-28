// Provision an accountant without granting access or sending credentials by email.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const sql = require('../src/config/db');
const { createBooksAccessService } = require('../src/services/books/access');
async function main() {
  const [email, fullName] = process.argv.slice(2);
  if (!email || !fullName) throw new Error('Usage: node scripts/create-books-ca.js <email> <full-name>');
  const directory = path.join(os.homedir(), '.codex', 'credentials');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `books-ca-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  const password = randomBytes(24).toString('base64url');
  // Reserve a private file first so a successful account always has recoverable credentials.
  fs.writeFileSync(file, JSON.stringify({ email, temporary_password: password }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    const account = await createBooksAccessService(sql).create({ email, full_name: fullName, password, permissions: [] });
    fs.writeFileSync(file, JSON.stringify({ email: account.email, full_name: account.full_name, employee_id: account.employee_id, id: account.id, temporary_password: password, must_change_password: true, permissions: [] }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ email: account.email, id: account.id, permissions: [], credentials_file: file, must_change_password: true }));
  } catch (e) { fs.unlinkSync(file); throw e; }
}
if (require.main === module) main().catch(e => { console.error('CA provisioning failed:', e.message); process.exitCode = 1; }).finally(() => sql.end());
