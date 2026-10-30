const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { hashPassword, verifyPassword } = require('../../src/utils/passwords');
const { createBooksService } = require('../../src/services/books/service');
const { createBooksAccessService } = require('../../src/services/books/access');
const { getEffectivePermissions } = require('../../src/config/rbac');
let db, socket, sql, http, origin, root, ca, rootToken, caToken, invoice, bill, file, access;
let remoteAuthCalls = 0;
const secret = 'disposable-ca-auth-tests-only-secret';
const password = 'Initial-private-pass-2026';
const ownPassword = 'Changed-private-pass-2026';
function mock(relative, exports) { const filename = require.resolve(relative); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
async function request(url, { token = caToken, method = 'GET', body } = {}) {
 const response = await fetch(origin + '/api/super-admin' + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
 const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: response.status, data };
}
async function grants(permissions) { await access.update(ca.id, { full_name: 'CA Test', status: 'ACTIVE', permissions }, root.id); }
async function login(email, pwd = password, entry = '/auth/ca/login') { return request(entry, { token: null, method: 'POST', body: { identifier: email, password: pwd } }); }
test.before(async () => {
 db = new PGlite(); socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 }); await socket.start();
 sql = postgres(`postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`, { ssl: false, max: 3, onnotice: () => {} });
 const schema = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_create_rbac_tables.sql'), 'utf8');
 // Actual auth schema, excluding unrelated school/support enum migrations.
 await sql.unsafe(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS internal_users'), schema.indexOf('-- 5. School Requirements')));
 await sql`ALTER TABLE internal_users ADD COLUMN job_title text`;
 await sql`CREATE TABLE audit_logs (user_id uuid,action text,entity text,entity_id text,details jsonb,ip_address text,user_agent text,school_id int,created_at timestamptz)`;
 for (const migration of ['26_books.sql', '27_books_workflows.sql', '28_books_ca_access.sql','29_books_companies.sql','32_books_statements.sql']) { const connection = await sql.reserve(); try { await connection.unsafe(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', migration), 'utf8')); } finally { connection.release(); } }
 process.env.SUPERADMIN_JWT_SECRET = secret;
 mock('../../src/config/db', sql);
 mock('../../src/config/env', { schoolSupabase: { jwtSecret: secret } });
 const remote = async () => { remoteAuthCalls++; return { data: null, error: new Error('not available') }; };
 mock('../../src/config/supabase', { schoolSupabase: { auth: { signInWithPassword: remote } }, schoolSupabaseAdmin: { auth: { getUser: remote, admin: { updateUserById: remote } } } });
 [root] = await sql`INSERT INTO internal_users (full_name,email,employee_id,password_hash,role) VALUES ('Founder','founder@example.test','FOUNDER-001',${hashPassword(password)},'FOUNDER') RETURNING *`;
 access = createBooksAccessService(sql); ca = await access.create({ full_name: 'CA Test', email: 'ca@example.test', password }, root.id);
 const books = createBooksService(sql);
 const customer = await books.saveContact({ kind: 'customer', name: 'Private customer' }, root.id);
 const vendor = await books.saveContact({ kind: 'vendor', name: 'Private vendor' }, root.id);
 const input = (kind, contact_id) => ({ kind, contact_id, date: '2026-10-26', lines: [{ description: 'Work', quantity: 1, rate: 100, tax_rate: 0 }] });
 invoice = await books.createDocument(input('invoice', customer.id), root.id);
 bill = await books.createDocument(input('bill', vendor.id), root.id);
 file = await books.addAttachment({ originalname: 'receipt.txt', mimetype: 'text/plain', buffer: Buffer.from('secret receipt') }, bill.id, root.id);
 const { authenticateUser, requirePermission } = require('../../src/middleware/rbac');
 const app = express(); app.use(express.json());
 app.use('/api/super-admin/auth', require('../../src/routes/superadmin/founderAuth'));
 app.use('/api/super-admin/books', require('../../src/routes/superadmin/books').createBooksRouter({ db: sql }));
 app.use('/api/super-admin/users', require('../../src/routes/superadmin/users'));
 app.get('/api/super-admin/schools', authenticateUser, requirePermission('schools.read.all'), (_req,res) => res.json(['never for CA']));
 http = app.listen(0, '127.0.0.1'); await new Promise(r => http.once('listening', r)); origin = `http://127.0.0.1:${http.address().port}`;
 const founderLogin = await login(root.email, password, '/auth/login'); assert.equal(founderLogin.status, 200); rootToken = founderLogin.data.session.access_token;
});
test.after(async () => { if (http) await new Promise(r => http.close(r)); if(sql) await sql.end(); if(socket) await socket.stop(); if(db) await db.close(); });
test('separate CA entry rejects founder and unknown accounts without creating sessions', async () => {
 const before = await sql`SELECT count(*) AS n FROM internal_user_sessions`;
 assert.equal((await login(root.email)).status, 401); assert.equal((await login('missing@example.test')).status, 401);
 assert.equal((await sql`SELECT count(*) AS n FROM internal_user_sessions`)[0].n, before[0].n);
});
test('temporary password allows only profile, logout and password change, then invalidates the old session', async () => {
 const r = await login(ca.email); assert.equal(r.status, 200); assert.equal(r.data.user.mustChangePassword, true); assert.deepEqual(r.data.permissions, []); caToken = r.data.session.access_token;
 assert.equal((await request('/auth/me')).status, 200);
 assert.equal((await request('/books/bootstrap')).data.error, 'PASSWORD_CHANGE_REQUIRED');
 assert.equal((await request('/auth/change-password', { method: 'POST', body: { newPassword: 'short' } })).status, 400);
 assert.equal((await request('/auth/change-password', { method: 'POST', body: { newPassword: ownPassword } })).status, 200);
 assert.equal((await request('/auth/me')).status, 401);
 const next = await login(ca.email, ownPassword); assert.equal(next.status, 200); caToken = next.data.session.access_token; assert.equal(next.data.user.mustChangePassword, false);
});
test('zero-grant CA receives no records and cannot read or manage any module or other SuperAdmin area', async () => {
 const b = await request('/books/bootstrap'); assert.equal(b.status, 200); assert.deepEqual(b.data.modules, []); assert.deepEqual(b.data.stats, { contacts: 0, items: 0, documents: 0 }); assert.equal(b.data.settings.gstin, undefined);
 const lookups = await request('/books/lookups'); assert.deepEqual(lookups.data, { contacts: [], items: [], accounts: [], projects: [], payments: [] });
 for (const url of ['/books/contacts', '/books/documents?kind=invoice', '/books/reports', '/books/payments', '/books/access/users', '/books/access/catalog', '/schools', '/users']) assert.equal((await request(url)).status, 403, url);
 assert.equal((await request('/books/access/users', { method: 'POST', body: { email: 'attacker@example.test', full_name: 'Attacker', permissions: [] } })).status, 403);
});
test('grants and revocations apply immediately to the same access token; directory kinds remain scoped', async () => {
 await grants(['books.customers.view']); const r = await request('/books/contacts'); assert.equal(r.status, 200); assert.deepEqual(r.data.map(c => c.name), ['Private customer']);
 const l = await request('/books/lookups'); assert.equal(l.data.contacts.length, 1); assert.deepEqual(l.data.accounts, []);
 assert.equal((await request('/books/contacts', { method: 'POST', body: { kind: 'customer', name: 'Denied' } })).status, 403);
 await grants([]); assert.equal((await request('/books/contacts')).status, 403);
});
test('view-only invoices cannot edit, post, void, pay, print, convert or read bills by ID', async () => {
 await grants(['books.invoice.view']); assert.equal((await request(`/books/documents/${invoice.id}`)).status, 200); assert.equal((await request('/books/documents?kind=invoice')).data.total, 1);
 assert.equal((await request(`/books/documents/${bill.id}`)).status, 403);
 for (const action of ['post','void','convert']) assert.equal((await request(`/books/documents/${invoice.id}/${action}`, { method:'POST' })).status, 403);
 assert.equal((await request(`/books/documents/${invoice.id}`, { method:'PUT', body:{} })).status,403);
 assert.equal((await request('/books/documents', { method:'POST', body:{kind:'invoice'} })).status,403);
 assert.equal((await request(`/books/documents/${invoice.id}/print`)).status,403);
 assert.equal((await request('/books/payments', { method:'POST', body:{document_id:invoice.id} })).status,403);
});
test('reports and dashboard grants are separate; dashboard excludes detailed ledger and tax records', async () => {
 await grants(['books.reports.view']); const r = await request('/books/reports'); assert.equal(r.status,200); assert.ok(Array.isArray(r.data.trial)); assert.equal((await request('/books/dashboard')).status,403); assert.equal((await request('/books/documents?kind=invoice')).status,403);
 await grants(['books.home.view']); const d = await request('/books/dashboard'); assert.equal(d.status,200); for (const key of ['trial','taxes','aging','assets','liabilities']) assert.equal(d.data[key],undefined); assert.equal((await request('/books/reports')).status,403);
});
test('supporting-file library and downloads cannot bypass a linked document permission', async () => {
 await grants(['books.documents.view','books.data.export','books.invoice.view']); assert.deepEqual((await request('/books/attachments')).data, []);
 assert.equal((await request(`/books/attachments/${file.id}/download`)).status,403);
 await grants(['books.documents.view','books.data.export','books.bill.view']); const r = await request(`/books/attachments/${file.id}/download`); assert.equal(r.status,200); assert.equal(r.data,'secret receipt');
 await grants(['books.documents.view','books.bill.view']); assert.equal((await request(`/books/attachments/${file.id}/download`)).status,403);
});
test('CA ignores non-Books privilege overrides and non-internal tokens; cannot grant itself access', async () => {
 await sql`INSERT INTO internal_user_permission_overrides(user_id,permission,effect) VALUES(${ca.id},'users.manage','GRANT')`;
 assert.equal(getEffectivePermissions('CA',[{permission:'users.manage',effect:'GRANT'}]).includes('users.manage'),false);
 assert.equal((await request(`/users/${ca.id}/permissions`,{method:'PUT',body:{overrides:[]}})).status,403);
 const legacy = jwt.sign({sub:ca.id,email:ca.email},secret,{expiresIn:60}); assert.equal((await request('/auth/me',{token:legacy})).status,401);
 await grants([]);
});
test('owner-only account operations validate grants, store salted hashes and audit without passwords', async () => {
 assert.equal((await request('/books/access/users',{token:rootToken})).status,200);
 const invalid = await request(`/books/access/users/${ca.id}`,{token:rootToken,method:'PUT',body:{full_name:'CA Test',status:'ACTIVE',permissions:['books.invoice.post']}}); assert.equal(invalid.status,400);
 const duplicate = await request('/books/access/users',{token:rootToken,method:'POST',body:{full_name:'Duplicate',email:ca.email}}); assert.equal(duplicate.status,409);
 const [row] = await sql`SELECT password_hash FROM internal_users WHERE id=${ca.id}`; assert.notEqual(row.password_hash,ownPassword); assert.equal(verifyPassword(ownPassword,row.password_hash),true);
 const audit=JSON.stringify(await sql`SELECT * FROM books_access_events`); assert.equal(audit.includes(password),false); assert.equal(audit.includes(ownPassword),false);
});
test('ledger details, reporting classifications and report validation enforce separate grants', async () => {
 await grants(['books.reports.view']);
 assert.equal((await request('/books/accounts/1010/ledger')).status,403);
 assert.equal((await request('/books/reports?from=2026-02-30')).status,400);
 await grants(['books.accounts.view']);
 const ledger=await request('/books/accounts/1010/ledger?from=2026-01-01&to=2026-12-31&page_size=1');
 assert.equal(ledger.status,200);assert.ok(Array.isArray(ledger.data.data));assert.equal(ledger.data.page_size,1);
 assert.equal((await request('/books/accounts/1010/ledger?page_size=10000')).status,400);
 assert.equal((await request('/books/accounts/missing/ledger')).status,404);
 assert.equal((await request('/books/accounts/1010/reporting',{method:'PUT',body:{cash_flow_activity:'investing'}})).status,403);
 await grants(['books.accounts.view','books.accounts.manage']);
 assert.equal((await request('/books/accounts/1100/reporting',{method:'PUT',body:{cash_flow_activity:'operating'}})).status,200);
 assert.equal((await request('/books/accounts/1100/reporting',{method:'PUT',body:{cash_flow_activity:'bad'}})).status,400);
 assert.equal((await request('/books/reports')).status,403);
});

test('suspension, reactivation and reset revoke sessions; CA credentials never fall back to Supabase', async () => {
 await access.update(ca.id,{full_name:'CA Test',status:'SUSPENDED',permissions:[]},root.id); assert.equal((await request('/auth/me')).status,401); assert.equal((await login(ca.email,ownPassword)).status,403);
 await access.update(ca.id,{full_name:'CA Test',status:'ACTIVE',permissions:[]},root.id); assert.equal((await request('/auth/me')).status,401);
 const next=await login(ca.email,ownPassword); caToken=next.data.session.access_token;
 const reset=await request(`/books/access/users/${ca.id}/reset-password`,{token:rootToken,method:'POST'}); assert.equal(reset.status,200); assert.ok(reset.data.temporary_password.length>=24); assert.equal((await request('/auth/me')).status,401);
 assert.equal((await login(ca.email,ownPassword)).status,401); assert.equal((await login(ca.email,reset.data.temporary_password)).data.user.mustChangePassword,true); assert.equal(remoteAuthCalls,0);
});

test('lead CA has full accounting across separate companies and manages only their own ordinary CA team', async () => {
 const { initializeCompanyBooks } = require('../../src/services/books/companySetup');
 await initializeCompanyBooks(sql,'books_nexmaxx','Nexmaxx');
 const lead = await access.create({full_name:'Lead CA',email:'lead@example.test',role:'CA_LEAD',password:ownPassword},root.id);
 await sql`UPDATE internal_users SET must_change_password=false WHERE id=${lead.id}`;
 const logged=await login(lead.email,ownPassword); assert.equal(logged.status,200); assert.equal(logged.data.role,'CA_LEAD');
 const token=logged.data.session.access_token;
 const organizations=await request('/books/organizations',{token}); assert.equal(organizations.status,200); assert.equal(organizations.data.length,2);
 const nexsyrus=organizations.data.find(c=>c.code==='nexsyrus'),nexmaxx=organizations.data.find(c=>c.code==='nexmaxx');
 const call=async(path,company,method='GET',body)=>{const r=await fetch(origin+'/api/super-admin/books'+path,{method,headers:{Authorization:`Bearer ${token}`,'X-Books-Company-Id':company.id,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 assert.equal((await call('/contacts',nexsyrus)).data.length,2); assert.deepEqual((await call('/contacts',nexmaxx)).data,[]);
 const contact=await call('/contacts',nexmaxx,'POST',{kind:'customer',name:'Nexmaxx customer'}); assert.equal(contact.status,200);
 const doc=await call('/documents',nexmaxx,'POST',{kind:'invoice',contact_id:contact.data.id,date:'2026-10-27',lines:[{description:'Private Nexmaxx work',quantity:1,rate:200}]}); assert.equal(doc.status,200);
 assert.equal((await call(`/documents/${doc.data.id}/post`,nexmaxx,'POST',{})).status,200);
 assert.equal((await call(`/documents/${doc.data.id}`,nexsyrus)).status,404);
 assert.equal((await call(`/documents/${invoice.id}`,nexmaxx)).status,404);
 // PGlite multiplexes one physical connection; report transactions run sequentially here.
 const reports=[await call('/reports',nexsyrus),await call('/reports',nexmaxx)];assert.equal(reports[0].data.income,0);assert.equal(reports[1].data.income,20000);
 // Deferred journal constraints must read Nexmaxx tables at commit, not public tables.
 const balances=await sql`SELECT sum(l.debit-l.credit) AS balance FROM books_nexmaxx.books_journal_lines l`; assert.equal(Number(balances[0].balance),0);
 const created=await request('/books/access/users',{token,method:'POST',body:{full_name:'Team CA',email:'team@example.test',company_access:[{company_id:nexmaxx.id,permissions:['books.invoice.view']}]}});assert.equal(created.status,200);assert.equal(created.data.manager_id,lead.id);
 assert.equal((await request('/books/access/users',{token,method:'POST',body:{full_name:'Bad lead',email:'bad-lead@example.test',role:'CA_LEAD'}})).status,403);
 assert.equal((await request(`/books/access/users/${lead.id}`,{token,method:'PUT',body:{full_name:'Changed',status:'ACTIVE',role:'CA_LEAD'}})).status,403);
 assert.equal((await request(`/books/access/users/${ca.id}/reset-password`,{token,method:'POST'})).status,403);
 assert.deepEqual((await request('/books/access/users',{token})).data.map(u=>u.id),[created.data.id]);
 assert.equal((await request('/schools',{token})).status,403); assert.equal((await request('/users',{token})).status,403);
 await sql`UPDATE internal_users SET must_change_password=false WHERE id=${created.data.id}`;
 const teamLogin=await login(created.data.email,created.data.temporary_password);const teamToken=teamLogin.data.session.access_token;
 const assigned=await request('/books/organizations',{token:teamToken});assert.deepEqual(assigned.data.map(c=>c.id),[nexmaxx.id]);
 const cross=await fetch(origin+'/api/super-admin/books/contacts',{headers:{Authorization:`Bearer ${teamToken}`,'X-Books-Company-Id':nexsyrus.id}});assert.equal(cross.status,403);
 assert.equal((await request('/books/documents?kind=invoice',{token:teamToken})).data.total,1);
 assert.equal((await request(`/books/documents/${doc.data.id}/void`,{token:teamToken,method:'POST'})).status,403);
 assert.equal((await request('/books/access/users',{token:teamToken})).status,403);
 const revoked=await request(`/books/access/users/${created.data.id}`,{token,method:'PUT',body:{full_name:'Team CA',status:'ACTIVE',company_access:[]}});assert.equal(revoked.status,200);
 assert.deepEqual((await request('/books/organizations',{token:teamToken})).data,[]);
 assert.equal((await request('/books/documents?kind=invoice',{token:teamToken})).status,403);
 // Existing membership/financial rows survive a repeatable installer run.
 await initializeCompanyBooks(sql,'books_nexmaxx','Nexmaxx');assert.equal((await call('/reports',nexmaxx)).data.income,20000);
 const connection=await sql.reserve();try{await connection.unsafe(fs.readFileSync(path.join(__dirname,'../../src/db/migrations/29_books_companies.sql'),'utf8'));}finally{connection.release();}
 assert.deepEqual((await request('/books/organizations',{token:teamToken})).data,[]);
 assert.equal(getEffectivePermissions('CA_LEAD',[{permission:'users.manage',effect:'GRANT'}]).includes('users.manage'),false);
});
