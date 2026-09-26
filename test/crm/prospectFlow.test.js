const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

const SECRET = 'test-secret-test-secret-test-secret';
const IDS = {
  superUser: '11111111-1111-4111-8111-111111111111',
  userApprover: '44444444-4444-4444-8444-444444444444',
  founderApprover: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

let request;
let app;
let crmSql;
let schoolSql;
let token;
let approver;
const handles = [];

async function startDb() {
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 10 });
  await server.start();
  const address = server.server.address();
  handles.push({ db, server });
  return `postgres://postgres:postgres@127.0.0.1:${address.port}/postgres`;
}

test('school import creates prospects without tenants', async (t) => {
  const crmUrl = await startDb();
  const schoolUrl = await startDb();
  t.after(async () => {
    if (crmSql) await crmSql.end({ timeout: 5 }).catch(() => {});
    if (schoolSql) await schoolSql.end({ timeout: 5 }).catch(() => {});
    for (const item of handles) {
      await item.server.stop().catch(() => {});
      await item.db.close().catch(() => {});
    }
  });
  process.env.SCHOOL_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SCHOOL_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SCHOOL_SUPABASE_SERVICE_ROLE_KEY = 'test-service';
  process.env.SCHOOL_SUPABASE_JWT_SECRET = SECRET;
  process.env.SCHOOL_DATABASE_URL = schoolUrl;
  process.env.CRM_DATABASE_URL = crmUrl;
  process.env.CRM_FEATURE_IMPORT_EXECUTE = 'true';
  process.env.ALLOWED_ORIGINS = '*';

  const bootstrap = postgres(crmUrl, { ssl: false, max: 1, onnotice: () => {} });
  await bootstrap.unsafe(`
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await bootstrap.end();
  const { applyCrmMigrations } = require('../../src/db/applyCrmMigrations');
  await applyCrmMigrations(crmUrl);

  const school = postgres(schoolUrl, { ssl: false, max: 1 });
  await school.unsafe(`
    CREATE TABLE super_admins (id uuid PRIMARY KEY, is_active boolean, email text, full_name text);
    CREATE TABLE founders (id uuid PRIMARY KEY, user_id uuid, is_active boolean, email text, full_name text, role text);
    CREATE TABLE clusters (cluster_id text PRIMARY KEY, status text NOT NULL);
    CREATE TABLE schools (id int PRIMARY KEY, name text);
  `);
  await school`INSERT INTO super_admins (id, is_active, email, full_name) VALUES (${IDS.superUser}, true, 'super@example.com', 'Super Admin')`;
  await school`INSERT INTO founders (id, user_id, is_active, email, full_name, role) VALUES (${IDS.founderApprover}, ${IDS.userApprover}, true, 'ap@example.com', 'Approver', 'APPROVER')`;
  await school`INSERT INTO clusters (cluster_id, status) VALUES ('cluster_test', 'active')`;
  await school.end();

  request = require('supertest');
  ({ createApp } = require('../../src/app'));
  app = createApp();
  crmSql = require('../../src/config/crmDb');
  schoolSql = require('../../src/config/db');
  await crmSql`INSERT INTO crm_directory_refreshes (cluster_id, status, last_success_at, school_count) VALUES ('cluster_test', 'OK', now(), 0)`;
  token = jwt.sign({ sub: IDS.superUser, email: 'super@example.com' }, SECRET, { algorithm: 'HS256' });
  approver = jwt.sign({ sub: IDS.userApprover, email: 'ap@example.com' }, SECRET, { algorithm: 'HS256' });

  const denied = await request(app).post('/api/super-admin/crm/imports').set('Authorization', `Bearer ${approver}`).attach('file', Buffer.from('school_name\n'), 'schools.csv');
  assert.equal(denied.status, 403);

  const csv = [
    'school_name,udise,country,state,city,organization_phone,contact_1_name,contact_1_role,contact_1_phone',
    'Sunrise Public School,01234567890,IN,Telangana,Hyderabad,,Ada Lovelace,Principal,9876543210',
    'Sunrise Public School,01234567890,IN,Telangana,Hyderabad,,Grace Hopper,Correspondent,9123456780',
    'Quiet Academy,,IN,Telangana,Warangal,,,,',
  ].join('\n');
  const uploaded = await request(app).post('/api/super-admin/crm/imports').set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(csv), 'schools.csv');
  assert.equal(uploaded.status, 202);
  const batchId = uploaded.body.id;
  const { processNext } = require('../../src/services/crm/importWorker');
  assert.equal(await processNext(crmSql, schoolSql), true);

  const mapping = await request(app).put(`/api/super-admin/crm/imports/${batchId}/mapping`).set('Authorization', `Bearer ${token}`).send({
    sheet_name: 'CSV',
    header_row: 1,
    columns: { 0: 'school_name', 1: 'udise', 2: 'country', 3: 'state', 4: 'city', 5: 'organization_phone', 6: 'contact_1_name', 7: 'contact_1_role', 8: 'contact_1_phone' },
    defaults: { country_code: 'IN' },
  });
  assert.equal(mapping.status, 200);
  const queued = await request(app).post(`/api/super-admin/crm/imports/${batchId}/preview`).set('Authorization', `Bearer ${token}`);
  assert.equal(queued.status, 202);
  assert.equal(await processNext(crmSql, schoolSql), true);
  const [accountsBefore] = await crmSql`SELECT COUNT(*)::int AS count FROM crm_accounts`;
  assert.equal(accountsBefore.count, 0);

  const ready = await request(app).get(`/api/super-admin/crm/imports/${batchId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(ready.body.status, 'PREVIEW_READY');
  assert.equal(ready.body.counts.school_groups, 2);
  const confirmed = await request(app).post(`/api/super-admin/crm/imports/${batchId}/confirm`).set('Authorization', `Bearer ${token}`).send({
    expected_version: ready.body.row_version,
    preview_revision: ready.body.preview_revision,
    preview_hash: ready.body.preview_hash,
    idempotency_key: 'confirm-school-import-1',
    accept_new: true,
  });
  assert.equal(confirmed.status, 202, JSON.stringify(confirmed.body));
  const replay = await request(app).post(`/api/super-admin/crm/imports/${batchId}/confirm`).set('Authorization', `Bearer ${token}`).send({
    expected_version: ready.body.row_version,
    preview_revision: ready.body.preview_revision,
    preview_hash: ready.body.preview_hash,
    idempotency_key: 'confirm-school-import-1',
    accept_new: true,
  });
  assert.equal(replay.status, 202);
  assert.equal(await processNext(crmSql, schoolSql), true);

  const accounts = await crmSql`SELECT id, name, account_type, lifecycle_stage, external_client_id FROM crm_accounts ORDER BY name`;
  assert.equal(accounts.length, 2);
  assert.equal(accounts.every((row) => row.account_type === 'PROSPECT' && row.lifecycle_stage === 'LEAD' && !row.external_client_id), true);
  const [contacts] = await crmSql`SELECT COUNT(*)::int AS count FROM crm_contacts`;
  const [enquiries] = await crmSql`SELECT COUNT(*)::int AS count FROM enquiries`;
  assert.equal(contacts.count, 2);
  assert.equal(enquiries.count, 1);
  const [schools] = await schoolSql`SELECT COUNT(*)::int AS count FROM schools`;
  assert.equal(schools.count, 0);
  const quiet = accounts.find((row) => row.name === 'Quiet Academy');
  const detail = await request(app).get(`/api/super-admin/crm/prospects/${quiet.id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(detail.body.profile_channel, 'no_contact_channel');
  assert.equal(detail.body.pipeline, 'not_in_pipeline');
  const logs = await request(app).get('/api/super-admin/crm/audit-logs').set('Authorization', `Bearer ${token}`);
  assert.equal(logs.status, 200);
  assert.equal(logs.body.source, 'crm');
  assert.equal(logs.body.data.some((row) => row.action === 'UPLOAD' || row.action === 'CONFIRM' || row.action === 'CREATE'), true);
});
