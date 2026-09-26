const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

const SECRET = 'boundary-secret-boundary-secret-ok';
const IDS = {
  superUser: '11111111-1111-4111-8111-111111111111',
  userA: '22222222-2222-4222-8222-222222222222',
  userB: '33333333-3333-4333-8333-333333333333',
  userApprover: '44444444-4444-4444-8444-444444444444',
  attacker: '55555555-5555-4555-8555-555555555555',
  unboundUser: '66666666-6666-4666-8666-666666666666',
  founderA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  founderB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  founderApprover: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  founderUnbound: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  noteA: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  noteB: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

let servers = [];
let request;
let app;
let schoolSql;
let tokens;

async function startDb() {
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 20 });
  await server.start();
  const address = server.server.address();
  servers.push({ db, server });
  return `postgres://postgres:postgres@127.0.0.1:${address.port}/postgres`;
}

function sign(userId, email) {
  return jwt.sign({ sub: userId, email }, SECRET, { algorithm: 'HS256' });
}

test.before(async () => {
  const schoolUrl = await startDb();
  const crmUrl = await startDb();
  process.env.SCHOOL_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SCHOOL_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SCHOOL_SUPABASE_SERVICE_ROLE_KEY = 'test-service';
  process.env.SCHOOL_SUPABASE_JWT_SECRET = SECRET;
  process.env.SCHOOL_DATABASE_URL = schoolUrl;
  process.env.CRM_DATABASE_URL = crmUrl;
  process.env.ALLOWED_ORIGINS = '*';

  const school = postgres(schoolUrl, { ssl: false, max: 1, onnotice: () => {} });
  await school.unsafe(`
    CREATE TABLE super_admins (
      id uuid PRIMARY KEY,
      is_active boolean,
      email text,
      full_name text,
      last_login timestamptz
    );
    CREATE TABLE founders (
      id uuid PRIMARY KEY,
      user_id uuid,
      is_active boolean,
      email text,
      full_name text,
      role text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE settings (key text PRIMARY KEY, value text);
    CREATE TABLE activity_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type text,
      action text,
      actor_id uuid,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE notifications (
      id uuid PRIMARY KEY,
      user_id uuid,
      founder_id uuid,
      title text,
      body text,
      type text,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE rbac_pilot_config (
      school_id int PRIMARY KEY,
      mode text,
      enforce_school_1 boolean,
      notes text,
      updated_at timestamptz,
      activated_at timestamptz,
      activated_by text
    );
    CREATE TABLE rbac_audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id int,
      action text,
      decision text,
      reason text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await school`
    INSERT INTO super_admins (id, is_active, email, full_name, last_login)
    VALUES (${IDS.superUser}, true, 'super@example.com', 'Super Admin', now())
  `;
  await school`
    INSERT INTO founders (id, user_id, is_active, email, full_name, role) VALUES
      (${IDS.founderA}, ${IDS.userA}, true, 'a@example.com', 'Founder A', 'FOUNDER'),
      (${IDS.founderB}, ${IDS.userB}, true, 'b@example.com', 'Founder B', 'FOUNDER'),
      (${IDS.founderApprover}, ${IDS.userApprover}, true, 'ap@example.com', 'Approver', 'APPROVER'),
      (${IDS.founderUnbound}, NULL, true, 'new@example.com', 'Unbound Founder', 'FOUNDER')
  `;
  await school`
    INSERT INTO notifications (id, user_id, founder_id, title, body) VALUES
      (${IDS.noteA}, ${IDS.userA}, ${IDS.founderA}, 'A', 'private to A'),
      (${IDS.noteB}, ${IDS.userB}, ${IDS.founderB}, 'B', 'private to B')
  `;
  await school`
    INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
    VALUES ('expense', 'APPROVE', ${IDS.userApprover}, ${school.json({ amount: 10 })})
  `;
  await school`
    INSERT INTO rbac_pilot_config (school_id, mode, enforce_school_1)
    VALUES (1, 'ENFORCED', true)
  `;
  await school.end();

  request = require('supertest');
  ({ createApp } = require('../../src/app'));
  app = createApp();
  schoolSql = require('../../src/config/db');
  tokens = {
    super: sign(IDS.superUser, 'super@example.com'),
    a: sign(IDS.userA, 'a@example.com'),
    b: sign(IDS.userB, 'b@example.com'),
    approver: sign(IDS.userApprover, 'ap@example.com'),
    emailThief: sign(IDS.attacker, 'super@example.com'),
    founderEmailThief: sign(IDS.attacker, 'a@example.com'),
    unbound: sign(IDS.unboundUser, 'new@example.com'),
    stranger: sign('99999999-9999-4999-8999-999999999999', 'stranger@example.com'),
  };
});

test.after(async () => {
  if (schoolSql) await schoolSql.end({ timeout: 5 }).catch(() => {});
  for (const item of servers) {
    await item.server.stop().catch(() => {});
    await item.db.close().catch(() => {});
  }
});

function authed(method, url, token) {
  return request(app)[method](url).set('Authorization', `Bearer ${token}`);
}

test('a founder cannot disable school authorization or replace cluster credentials', async () => {
  const kill = await authed('post', '/api/super-admin/rbac/kill-switch', tokens.a).send({ reason: 'founder bypass' });
  assert.equal(kill.status, 403);
  const [pilot] = await schoolSql`SELECT mode, enforce_school_1 FROM rbac_pilot_config WHERE school_id = 1`;
  assert.equal(pilot.mode, 'ENFORCED');
  assert.equal(pilot.enforce_school_1, true);

  const enforce = await authed('post', '/api/super-admin/rbac/enforce', tokens.a).send({ confirmation: 'ENFORCE_SCHOOL_1' });
  assert.equal(enforce.status, 403);

  const cluster = await authed('patch', '/api/super-admin/clusters/cluster_a', tokens.a).send({
    school_service_role_key: 'stolen-key',
  });
  assert.equal(cluster.status, 403);
  const created = await authed('post', '/api/super-admin/clusters', tokens.a).send({
    cluster_id: 'cluster_evil',
    label: 'Evil',
    school_backend_url: 'http://evil',
    medical_backend_url: 'http://evil',
    school_service_role_key: 'key',
    medical_service_role_key: 'key',
  });
  assert.equal(created.status, 403);
});

test('a super admin can still engage the authorization kill switch', async () => {
  await schoolSql`UPDATE rbac_pilot_config SET mode = 'ENFORCED', enforce_school_1 = true WHERE school_id = 1`;
  const kill = await authed('post', '/api/super-admin/rbac/kill-switch', tokens.super).send({ reason: 'operator rollback' });
  assert.equal(kill.status, 200, JSON.stringify(kill.body));
  const [pilot] = await schoolSql`SELECT mode, enforce_school_1 FROM rbac_pilot_config WHERE school_id = 1`;
  assert.equal(pilot.mode, 'SHADOW');
  assert.equal(pilot.enforce_school_1, false);
});

test('founders cannot read backups or publish posters that every tenant app displays', async () => {
  const backups = await authed('get', '/api/super-admin/backups/stats', tokens.a);
  assert.equal(backups.status, 403);
  const trigger = await authed('post', '/api/super-admin/backups/trigger', tokens.a).send({});
  assert.equal(trigger.status, 403);
  const poster = await authed('post', '/api/super-admin/posters', tokens.a).send({ title: 'broadcast' });
  assert.equal(poster.status, 403);
});

test('a sales founder cannot change organization settings, founder access, or audit history', async () => {
  const write = await authed('put', '/api/super-admin/founder/settings', tokens.a).send({ key: 'budget_lock', value: { locked: false } });
  assert.equal(write.status, 403);
  const [setting] = await schoolSql`SELECT value FROM settings WHERE key = 'budget_lock'`;
  assert.equal(setting, undefined);

  const toggle = await authed('patch', `/api/super-admin/founder/settings/founders/${IDS.founderB}/toggle`, tokens.a).send({ is_active: false });
  assert.equal(toggle.status, 403);
  const [founderB] = await schoolSql`SELECT is_active FROM founders WHERE id = ${IDS.founderB}`;
  assert.equal(founderB.is_active, true);

  const logs = await authed('get', '/api/super-admin/founder/audit-logs', tokens.a);
  assert.equal(logs.status, 403);

  const approverWrite = await authed('put', '/api/super-admin/founder/settings', tokens.approver).send({ key: 'budget_lock', value: { locked: true } });
  assert.equal(approverWrite.status, 200, JSON.stringify(approverWrite.body));
  const approverLogs = await authed('get', '/api/super-admin/founder/audit-logs', tokens.approver);
  assert.equal(approverLogs.status, 200);
  assert.equal(approverLogs.body.length, 1);
});

test('notification reads and deletes stay inside the caller account', async () => {
  const listed = await authed('get', '/api/super-admin/founder/notifications', tokens.a).query({ user_id: IDS.userB, founder_id: IDS.founderB });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.map((row) => row.id), [IDS.noteA]);

  const removed = await authed('delete', `/api/super-admin/founder/notifications/${IDS.noteB}`, tokens.a);
  assert.equal(removed.status, 404);
  const [stillThere] = await schoolSql`SELECT id FROM notifications WHERE id = ${IDS.noteB}`;
  assert.equal(stillThere.id, IDS.noteB);

  const marked = await authed('patch', `/api/super-admin/founder/notifications/${IDS.noteB}/read`, tokens.a);
  assert.equal(marked.status, 404);
  const markedOwn = await authed('patch', `/api/super-admin/founder/notifications/${IDS.noteA}/read`, tokens.a);
  assert.equal(markedOwn.status, 200, JSON.stringify(markedOwn.body));
  const [ownNote] = await schoolSql`SELECT read_at FROM notifications WHERE id = ${IDS.noteA}`;
  assert.ok(ownNote.read_at);

  const platform = await authed('get', '/api/super-admin/founder/notifications', tokens.super);
  assert.equal(platform.status, 200);
  assert.equal(platform.body.length, 2);
});

test('directory email does not grant another account, and an inactive binding does not fall through', async () => {
  const thief = await authed('get', '/api/super-admin/auth/me', tokens.emailThief);
  assert.equal(thief.status, 403);
  const founderThief = await authed('get', '/api/super-admin/auth/me', tokens.founderEmailThief);
  assert.equal(founderThief.status, 403);

  const unbound = await authed('get', '/api/super-admin/auth/me', tokens.unbound);
  assert.equal(unbound.status, 200, JSON.stringify(unbound.body));
  assert.equal(unbound.body.isSuperAdmin, false);
  assert.equal(unbound.body.founder.id, IDS.founderUnbound);

  const founderProfile = await authed('get', '/api/super-admin/auth/me', tokens.a);
  assert.equal(founderProfile.status, 200, JSON.stringify(founderProfile.body));
  assert.equal(founderProfile.body.isSuperAdmin, false);
  assert.equal(founderProfile.body.founder.id, IDS.founderA);
  assert.equal(founderProfile.body.admin, null);

  await schoolSql`UPDATE founders SET is_active = false WHERE id = ${IDS.founderA}`;
  await schoolSql`
    INSERT INTO founders (id, user_id, is_active, email, full_name, role)
    VALUES ('abababab-abab-4aba-8aba-abababababab', NULL, true, 'a@example.com', 'Stale email', 'FOUNDER')
  `;
  const deactivated = await authed('get', '/api/super-admin/crm/leads', tokens.a);
  assert.equal(deactivated.status, 403);
  const [stale] = await schoolSql`SELECT user_id FROM founders WHERE id = 'abababab-abab-4aba-8aba-abababababab'`;
  assert.equal(stale.user_id, null);
});

test('login binds an unused super admin email once and will not retarget a used row', async () => {
  const { claimUnusedSuperAdminByEmail, claimUnboundFounder } = require('../../src/services/directoryAuth');
  const placeholder = '77777777-7777-4777-8777-777777777777';
  const claimant = '88888888-8888-4888-8888-888888888888';
  const second = '99999999-9999-4999-8999-999999999998';
  await schoolSql`
    INSERT INTO super_admins (id, is_active, email, full_name, last_login)
    VALUES (${placeholder}, true, 'invite@example.com', 'Invited', NULL)
  `;
  const claimed = await claimUnusedSuperAdminByEmail(schoolSql, claimant, 'invite@example.com');
  assert.equal(claimed.id, claimant);
  const stolen = await claimUnusedSuperAdminByEmail(schoolSql, second, 'invite@example.com');
  assert.equal(stolen, null);
  const [row] = await schoolSql`SELECT id, last_login IS NOT NULL AS used FROM super_admins WHERE email = 'invite@example.com'`;
  assert.equal(row.id, claimant);
  assert.equal(row.used, true);

  const bound = await claimUnboundFounder(schoolSql, IDS.founderUnbound, IDS.unboundUser);
  assert.equal(bound.user_id, IDS.unboundUser);
  const rebound = await claimUnboundFounder(schoolSql, IDS.founderUnbound, IDS.attacker);
  assert.equal(rebound, null);
});
