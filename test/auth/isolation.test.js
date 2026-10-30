const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const request = require('supertest');
const SECRET = 'phase8-isolated-auth-test-secret-only';
const ids = { employee: '10000000-0000-4000-8000-000000000001', founder: '10000000-0000-4000-8000-000000000002', stranger: '10000000-0000-4000-8000-000000000003' };
let db, socket, sql, app, employee, session, createSession;
test.before(async () => {
  db = new PGlite(); socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 }); await socket.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`;
  Object.assign(process.env, { SCHOOL_DATABASE_URL: url, CRM_DATABASE_URL: url, SCHOOL_SUPABASE_URL: 'http://127.0.0.1:9', SCHOOL_SUPABASE_ANON_KEY: 'test', SCHOOL_SUPABASE_SERVICE_ROLE_KEY: 'test', SUPERADMIN_JWT_SECRET: SECRET, SCHOOL_SUPABASE_JWT_SECRET: SECRET });
  const prep = postgres(url, { ssl: false, max: 1, onnotice: () => {} });
  await require('../helpers/authSchema').createAuthSchema(prep);
  await prep.unsafe(`CREATE TABLE super_admins(id uuid PRIMARY KEY, is_active boolean, email text, full_name text);
    CREATE TABLE founders(id uuid PRIMARY KEY,user_id uuid,is_active boolean,email text,full_name text,role text);`);
  await prep.end(); sql = require('../../src/config/db');
  const filename = require.resolve('../../src/config/supabase');
  require.cache[filename] = { id: filename, filename, loaded: true, exports: { schoolSupabaseAdmin: { auth: { getUser: async token => token === 'remote-metadata-test' ? { data: { user: { id: ids.stranger, email: 'stranger@example.invalid', user_metadata: { sub: ids.founder, email: 'founder@example.invalid', sid: 'forged' } } } } : { error: new Error('Not a verified remote session') } } } } };
  [employee] = await sql`INSERT INTO internal_users(id,auth_user_id,employee_id,full_name,email,role) VALUES (${ids.employee},${ids.employee},'QA-E','QA Employee','employee@example.invalid','SALES_EXECUTIVE') RETURNING *`;
  await sql`INSERT INTO internal_users(id,auth_user_id,employee_id,full_name,email,role) VALUES (${ids.founder},${ids.founder},'QA-F','QA Founder','founder@example.invalid','FOUNDER')`;
  await sql`INSERT INTO internal_user_schools(user_id,school_id) VALUES (${ids.employee},101)`;
  ({ createSession } = require('../../src/services/sessionService'));
  session = await createSession(employee);
  const { authenticateUser, requirePermission, requireSchoolAccess } = require('../../src/middleware/rbac');
  app = express(); app.use(express.json());
  app.use('/api/super-admin/auth', require('../../src/routes/superadmin/founderAuth'));
  app.get('/profile', authenticateUser, (req, res) => res.json(req.user));
  app.get('/schools/:id', authenticateUser, requirePermission('schools.read.assigned'), requireSchoolAccess(), (req, res) => res.json({ school_id: Number(req.params.id), actor: req.user.id }));
});
test.after(async () => { if (sql) await sql.end(); if (socket) await socket.stop(); if (db) await db.close(); });
const get = (url, token = session.access_token) => request(app).get(url).set('Authorization', `Bearer ${token}`);
test('real sessions permit the assigned school and reject another school despite query tampering', async () => {
  assert.equal((await get('/schools/101')).status, 200);
  assert.equal((await get('/schools/202?school_id=101&assignedSchools[]=202')).status, 403);
  assert.equal((await get('/schools/invalid')).status, 400);
});
test('authentication forms reject malformed values before credential processing', async () => {
  for (const body of [{ identifier: {}, password: 'password' }, { identifier: 'employee@example.invalid', password: ['password'] }, { identifier: ' ', password: 'password' }]) {
    assert.equal((await request(app).post('/api/super-admin/auth/login').send(body)).status, 400);
  }
  for (const newPassword of [null, [], { length: 12 }, 'short', 'a'.repeat(257)]) {
    assert.equal((await request(app).post('/api/super-admin/auth/change-password').set('Authorization', `Bearer ${session.access_token}`).send({ newPassword })).status, 400);
  }
});
test('database permission denials and account suspension take effect on the same access token', async () => {
  await sql`INSERT INTO internal_user_permission_overrides(user_id,permission,effect) VALUES (${ids.employee},'schools.read.assigned','DENY')`;
  assert.equal((await get('/schools/101')).status, 403);
  await sql`DELETE FROM internal_user_permission_overrides WHERE user_id=${ids.employee}`;
  assert.equal((await get('/schools/101')).status, 200);
  await sql`UPDATE internal_users SET status='SUSPENDED' WHERE id=${ids.employee}`;
  assert.equal((await get('/profile')).status, 401);
  await sql`UPDATE internal_users SET status='ACTIVE' WHERE id=${ids.employee}`;
});
test('matching an internal employee email cannot authenticate another token subject', async () => {
  const token = jwt.sign({ sub: ids.stranger, email: employee.email }, SECRET);
  assert.equal((await get('/profile', token)).status, 403);
  const emailOnly = jwt.sign({ email: 'founder@example.invalid' }, SECRET);
  assert.equal((await get('/profile', emailOnly)).status, 401);
});
test('untrusted remote user metadata cannot replace the verified identity', async () => {
  assert.equal((await get('/profile', 'remote-metadata-test')).status, 403);
});
test('wrong-audience internal tokens cannot fall back to legacy authentication', async () => {
  const payload = jwt.decode(session.access_token); delete payload.exp; delete payload.iat;
  const token = jwt.sign({ ...payload, aud: 'different-application' }, SECRET);
  assert.equal((await get('/profile', token)).status, 401);
});
test('revoked sessions and token-version changes immediately reject an otherwise valid JWT', async () => {
  const payload = jwt.decode(session.access_token);
  await sql`UPDATE internal_user_sessions SET revoked_at=now() WHERE id=${payload.sid}`;
  assert.equal((await get('/profile')).status, 401);
  const next = await createSession(employee);
  await sql`UPDATE internal_users SET token_version=token_version+1 WHERE id=${ids.employee}`;
  assert.equal((await get('/profile', next.access_token)).status, 401);
});
