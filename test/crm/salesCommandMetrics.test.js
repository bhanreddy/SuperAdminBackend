const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

const SECRET = 'test-secret-test-secret-test-secret';
const IDS = {
  superUser: '11111111-1111-4111-8111-111111111111',
  userA: '22222222-2222-4222-8222-222222222222',
  userB: '33333333-3333-4333-8333-333333333333',
  founderA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  founderB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const handles = [];
let request;
let app;
let crmSql;
let appCrm;
let appSchool;

async function startDb() {
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 12 });
  await server.start();
  handles.push({ db, server });
  const address = server.server.address();
  return `postgres://postgres:postgres@127.0.0.1:${address.port}/postgres`;
}

function sign(userId, email) {
  return jwt.sign({ sub: userId, email }, SECRET, { algorithm: 'HS256' });
}

test('sales command metrics, isolation, and pilot lifecycle', async (t) => {
  const crmUrl = await startDb();
  const schoolUrl = await startDb();
  t.after(async () => {
    if (crmSql) await crmSql.end({ timeout: 5 }).catch(() => {});
    if (appCrm) await appCrm.end({ timeout: 5 }).catch(() => {});
    if (appSchool) await appSchool.end({ timeout: 5 }).catch(() => {});
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
  process.env.CRM_FEATURE_SALES_COMMAND_READ = 'true';
  process.env.CRM_FEATURE_PILOT_WRITE = 'true';
  process.env.ALLOWED_ORIGINS = '*';

  const bootstrap = postgres(crmUrl, { ssl: false, max: 1, onnotice: () => {} });
  await bootstrap.unsafe(`
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await bootstrap.end();
  const { applyCrmMigrations } = require('../../src/db/applyCrmMigrations');
  await applyCrmMigrations(crmUrl);

  const school = postgres(schoolUrl, { ssl: false, max: 1, onnotice: () => {} });
  await school.unsafe(`
    CREATE TABLE super_admins (id uuid PRIMARY KEY, is_active boolean, email text, full_name text);
    CREATE TABLE founders (id uuid PRIMARY KEY, user_id uuid, is_active boolean, email text, full_name text, role text);
    CREATE TABLE schools (id int PRIMARY KEY, name text);
  `);
  await school`INSERT INTO super_admins (id, is_active, email, full_name) VALUES (${IDS.superUser}, true, 'super@example.com', 'Super Admin')`;
  await school`
    INSERT INTO founders (id, user_id, is_active, email, full_name, role) VALUES
      (${IDS.founderA}, ${IDS.userA}, true, 'a@example.com', 'Founder A', 'FOUNDER'),
      (${IDS.founderB}, ${IDS.userB}, true, 'b@example.com', 'Founder B', 'FOUNDER')
  `;
  await school.end();

  crmSql = postgres(crmUrl, { ssl: false, max: 4, onnotice: () => {} });
  await crmSql`
    INSERT INTO founders (id, full_name, email, is_active, auth_user_id) VALUES
      (${IDS.founderA}, 'Founder A', 'a@example.com', true, ${IDS.userA}),
      (${IDS.founderB}, 'Founder B', 'b@example.com', true, ${IDS.userB})
  `;
  const inserted = await crmSql`
    INSERT INTO enquiries (name, email, phone, organization, status, assigned_to, pipeline_stage_code, outcome, product_vertical, category, sales_model_version, currency, value_amount)
    VALUES
      ('Alpha School', 'alpha@example.com', '9000000001', 'Alpha School', 'NEW', ${IDS.founderA}, 'NEW', 'OPEN', 'SCHOOL', 'SCHOOL', 1, 'INR', 150000),
      ('Beta School', 'beta@example.com', '9000000002', 'Beta School', 'NEW', ${IDS.founderA}, 'QUALIFIED', 'OPEN', 'SCHOOL', 'SCHOOLIMS', 1, 'INR', 20000),
      ('Gamma School', 'gamma@example.com', '9000000003', 'Gamma School', 'NEW', ${IDS.founderA}, 'NEW', 'OPEN', 'SCHOOL', 'SCHOOL', 1, 'INR', 1000),
      ('Clinic Lead', 'clinic@example.com', '9000000004', 'Clinic', 'NEW', ${IDS.founderA}, 'NEW', 'OPEN', 'MEDICAL', 'MEDICAL', 1, 'INR', 5000)
    RETURNING id, name, row_version
  `;
  const byName = Object.fromEntries(inserted.map((row) => [row.name, row]));
  await crmSql`
    INSERT INTO crm_accounts (name, account_type, lifecycle_stage, vertical, created_at)
    VALUES ('Quiet Academy', 'PROSPECT', 'LEAD', 'SCHOOL', now() - interval '3 days')
  `;
  await crmSql`
    UPDATE enquiries SET stage_entered_at = now() - interval '3 days', stage_time_quality = 'OBSERVED'
    WHERE id = ${byName['Beta School'].id}
  `;

  request = require('supertest');
  ({ createApp } = require('../../src/app'));
  app = createApp();
  appCrm = require('../../src/config/crmDb');
  appSchool = require('../../src/config/db');
  const superToken = sign(IDS.superUser, 'super@example.com');
  const tokenB = sign(IDS.userB, 'b@example.com');
  const api = (method, url, token, body) => {
    let call = request(app)[method](url).set('Authorization', `Bearer ${token}`);
    if (body !== undefined) call = call.send(body);
    return call;
  };

  const dueSevere = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
  const dueRecent = new Date(Date.now() - 3600 * 1000).toISOString();
  let version = byName['Alpha School'].row_version;
  const firstTask = await api('post', `/api/super-admin/crm/leads/${byName['Alpha School'].id}/tasks`, superToken, {
    expected_version: version, title: 'Call the principal', due_at: dueSevere, assignee_founder_id: IDS.founderA, task_type: 'FOLLOW_UP',
  });
  assert.equal(firstTask.status, 200, JSON.stringify(firstTask.body));
  version = firstTask.body.lead.row_version;
  const secondTask = await api('post', `/api/super-admin/crm/leads/${byName['Alpha School'].id}/tasks`, superToken, {
    expected_version: version, title: 'Send the notes', due_at: dueRecent, assignee_founder_id: IDS.founderA, task_type: 'CALL', set_as_next: false,
  });
  assert.equal(secondTask.status, 200, JSON.stringify(secondTask.body));

  const demoStart = new Date(Date.now() - 4 * 86400 * 1000).toISOString();
  const demoEnd = new Date(Date.now() - 4 * 86400 * 1000 + 3600 * 1000).toISOString();
  const [beta] = await crmSql`SELECT row_version FROM enquiries WHERE id = ${byName['Beta School'].id}`;
  const demo = await api('post', `/api/super-admin/crm/leads/${byName['Beta School'].id}/demos`, superToken, {
    expected_version: beta.row_version, starts_at: demoStart, ends_at: demoEnd, timezone: 'Asia/Kolkata', location: 'School hall',
  });
  assert.equal(demo.status, 201, JSON.stringify(demo.body));
  const [betaAfter] = await crmSql`SELECT row_version FROM enquiries WHERE id = ${byName['Beta School'].id}`;
  const finished = await api('post', `/api/super-admin/crm/demos/${demo.body.id}/finish`, superToken, {
    expected_version: betaAfter.row_version, status: 'COMPLETED', result: 'Principal attended', occurred_at: new Date(Date.now() - 3 * 86400 * 1000).toISOString(),
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.ok(finished.body.demo.completed_at);

  const [gamma] = await crmSql`SELECT row_version FROM enquiries WHERE id = ${byName['Gamma School'].id}`;
  const spam = await api('post', `/api/super-admin/crm/leads/${byName['Gamma School'].id}/close`, superToken, {
    expected_version: gamma.row_version, outcome: 'DISQUALIFIED', reason_code: 'SPAM',
  });
  assert.equal(spam.status, 200, JSON.stringify(spam.body));

  const summary = await api('get', '/api/super-admin/crm/sales-command/summary?period=month&timezone=Asia/Kolkata', superToken);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.scope_label, 'Company school sales');
  assert.equal(summary.body.meta.permissions.view_company, true);
  assert.equal(summary.body.metrics.new_leads.value, 3);
  assert.equal(summary.body.metrics.open_pipeline.value, 2);
  assert.equal(summary.body.metrics.overdue.value, 1);
  assert.equal(summary.body.metrics.severely_overdue.value, 1);
  assert.equal(summary.body.metrics.demo_completed.value, 1);
  assert.equal(summary.body.metrics.intake_backlog.value, 1);
  assert.equal(summary.body.metrics.new_prospects.value, 1);
  assert.equal(summary.body.cohort.denominator, 2);
  assert.equal(summary.body.cohort.numerator, 0);
  assert.equal(summary.body.cohort.excluded_spam, 1);
  assert.equal(summary.body.metrics.cohort_conversion.value, 0);
  const stageSum = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL', 'NEGOTIATION', 'PILOT']
    .reduce((sum, code) => sum + summary.body.current_stage[code].value, 0) + summary.body.current_stage.unknown.value;
  assert.equal(stageSum, summary.body.metrics.open_pipeline.value);
  assert.equal(summary.headers['cache-control'], 'private, no-store');

  const overdue = await api('get', '/api/super-admin/crm/sales-command/opportunities?metric=overdue&period=today&timezone=Asia/Kolkata', superToken);
  assert.equal(overdue.status, 200, JSON.stringify(overdue.body));
  assert.equal(overdue.body.page.total, 1);
  assert.equal(overdue.body.rows[0].id, byName['Alpha School'].id);
  const [taskCount] = await crmSql`
    SELECT COUNT(*)::int AS count FROM crm_tasks
    WHERE enquiry_id = ${byName['Alpha School'].id} AND status IN ('OPEN','IN_PROGRESS') AND due_at < now()
  `;
  assert.equal(taskCount.count, 2);

  const attention = summary.body.attention_preview;
  const alpha = attention.find((row) => row.id === byName['Alpha School'].id);
  assert.ok(alpha);
  assert.equal(alpha.reasons.filter((item) => item.code === 'FOLLOWUP_SEVERE').length, 1);
  assert.equal(attention.filter((row) => row.name === 'Alpha School').length, 1);
  const quiet = attention.find((row) => row.name === 'Quiet Academy');
  assert.ok(quiet);
  assert.ok(quiet.reasons.some((item) => item.code === 'CONTACTLESS_INTAKE'));
  const betaRow = attention.find((row) => row.id === byName['Beta School'].id);
  assert.ok(betaRow.reasons.some((item) => item.code === 'DEMO_WITHOUT_PROPOSAL'));

  const mine = await api('get', '/api/super-admin/crm/sales-command/summary?period=today&timezone=Asia/Kolkata', tokenB);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.scope_label, 'My pipeline');
  assert.equal(mine.body.meta.permissions.view_company, false);
  assert.equal(mine.body.metrics.open_pipeline.value, 0);
  assert.equal(JSON.stringify(mine.body).includes('Alpha School'), false);
  const widened = await api('get', `/api/super-admin/crm/sales-command/summary?owner=${IDS.founderA}`, tokenB);
  assert.equal(widened.status, 403);

  const hidden = await api('get', `/api/super-admin/crm/leads/${byName['Alpha School'].id}`, tokenB);
  assert.equal(hidden.status, 404);

  const [betaVersion] = await crmSql`SELECT row_version, pipeline_stage_code FROM enquiries WHERE id = ${byName['Beta School'].id}`;
  const proposal = await api('post', `/api/super-admin/crm/leads/${byName['Beta School'].id}/proposals`, superToken, {
    expected_version: betaVersion.row_version, amount: '20000.00', currency: 'INR',
  });
  assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
  const [afterProposal] = await crmSql`SELECT row_version FROM enquiries WHERE id = ${byName['Beta School'].id}`;
  await api('post', `/api/super-admin/crm/proposal-versions/${proposal.body.version.id}/transition`, superToken, {
    expected_version: afterProposal.row_version, status: 'SENT',
  });
  const [sentVersion] = await crmSql`SELECT row_version FROM enquiries WHERE id = ${byName['Beta School'].id}`;
  const demoStage = await api('post', `/api/super-admin/crm/leads/${byName['Beta School'].id}/stage`, superToken, {
    expected_version: sentVersion.row_version, stage: 'DEMO',
  });
  assert.equal(demoStage.status, 200, JSON.stringify(demoStage.body));
  const moved = await api('post', `/api/super-admin/crm/leads/${byName['Beta School'].id}/stage`, superToken, {
    expected_version: demoStage.body.row_version, stage: 'PROPOSAL',
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const pilot = await api('post', `/api/super-admin/crm/leads/${byName['Beta School'].id}/pilots`, superToken, {
    expected_version: moved.body.row_version,
    idempotency_key: 'pilot-beta-0001',
    objective: 'Run a two-week classroom pilot',
    planned_start_at: new Date().toISOString(),
    planned_end_at: new Date(Date.now() + 14 * 86400 * 1000).toISOString(),
  });
  assert.equal(pilot.status, 201, JSON.stringify(pilot.body));
  const pilotStartAt = new Date().toISOString();
  const started = await api('post', `/api/super-admin/crm/pilots/${pilot.body.pilot.id}/transition`, superToken, {
    action: 'START',
    expected_version: moved.body.row_version,
    pilot_expected_version: pilot.body.pilot.row_version,
    idempotency_key: 'pilot-beta-start',
    occurred_at: pilotStartAt,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.lead.pipeline_stage_code, 'PILOT');
  const replay = await api('post', `/api/super-admin/crm/pilots/${pilot.body.pilot.id}/transition`, superToken, {
    action: 'START',
    expected_version: moved.body.row_version,
    pilot_expected_version: pilot.body.pilot.row_version,
    idempotency_key: 'pilot-beta-start',
    occurred_at: pilotStartAt,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const changedReplay = await api('post', `/api/super-admin/crm/pilots/${pilot.body.pilot.id}/transition`, superToken, {
    action: 'START',
    expected_version: moved.body.row_version,
    pilot_expected_version: pilot.body.pilot.row_version,
    idempotency_key: 'pilot-beta-start',
    occurred_at: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  assert.equal(changedReplay.status, 409);
  const [pilotRows] = await crmSql`SELECT COUNT(*)::int AS count FROM crm_pilots WHERE enquiry_id = ${byName['Beta School'].id} AND status = 'ACTIVE'`;
  assert.equal(pilotRows.count, 1);
  const schoolCheck = postgres(schoolUrl, { ssl: false, max: 1 });
  const [schoolRows] = await schoolCheck`SELECT COUNT(*)::int AS count FROM schools`;
  await schoolCheck.end({ timeout: 5 });
  assert.equal(schoolRows.count, 0);

  const disabled = await api('get', '/api/super-admin/crm/sales-command/summary?period=not-a-period', superToken);
  assert.equal(disabled.status, 400);
});
