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
  userApprover: '44444444-4444-4444-8444-444444444444',
  founderA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  founderB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  founderApprover: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

let servers = [];
let request;
let app;
let crm;
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

async function api(method, url, token, body) {
  let call = request(app)[method](url).set('Authorization', `Bearer ${token}`);
  if (body !== undefined) call = call.send(body);
  return call;
}

test.before(async () => {
  const crmUrl = await startDb();
  const schoolUrl = await startDb();
  process.env.SCHOOL_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SCHOOL_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SCHOOL_SUPABASE_SERVICE_ROLE_KEY = 'test-service';
  process.env.SCHOOL_SUPABASE_JWT_SECRET = SECRET;
  process.env.SCHOOL_DATABASE_URL = schoolUrl;
  process.env.CRM_DATABASE_URL = crmUrl;
  process.env.ALLOWED_ORIGINS = '*';

  const bootstrap = postgres(crmUrl, { ssl: false, max: 1, onnotice: () => {} });
  await bootstrap.unsafe(`
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await bootstrap.end();

  const { applyCrmMigrations } = require('../../src/db/applyCrmMigrations');
  await applyCrmMigrations(crmUrl, { through: '07_top_level_crm' });
  const prep = postgres(crmUrl, { ssl: false, max: 1, onnotice: () => {} });
  await prep`
    INSERT INTO founders (id, full_name, email, is_active)
    VALUES (${IDS.founderA}, 'Founder A', 'a@example.com', true)
  `;
  await prep`
    INSERT INTO enquiries (name, email, status, assigned_to, next_follow_up_at, deal_value)
    VALUES ('Known follow up', 'known@example.com', 'NEW', ${IDS.founderA}, now() + interval '1 day', 1000)
  `;
  await prep`
    INSERT INTO enquiries (name, email, status, deal_value)
    VALUES ('Historical close', 'closed@example.com', 'CLOSED', 5000)
  `;
  await prep`
    INSERT INTO enquiries (name, email, status, next_follow_up_at)
    VALUES ('Ambiguous follow up', 'ambiguous@example.com', 'REJECTED', now() + interval '2 day')
  `;
  await prep.end();
  await applyCrmMigrations(crmUrl);

  const school = postgres(schoolUrl, { ssl: false, max: 1, onnotice: () => {} });
  await school.unsafe(`
    CREATE TABLE super_admins (id uuid PRIMARY KEY, is_active boolean, email text, full_name text);
    CREATE TABLE founders (
      id uuid PRIMARY KEY, user_id uuid, is_active boolean, email text, full_name text, role text
    );
    CREATE TABLE clusters (
      cluster_id text PRIMARY KEY,
      status text NOT NULL,
      max_schools int NOT NULL,
      school_count int NOT NULL
    );
  `);
  await school`
    INSERT INTO super_admins (id, is_active, email, full_name)
    VALUES (${IDS.superUser}, true, 'super@example.com', 'Super Admin')
  `;
  await school`
    INSERT INTO founders (id, user_id, is_active, email, full_name, role) VALUES
      (${IDS.founderA}, ${IDS.userA}, true, 'a@example.com', 'Founder A', 'FOUNDER'),
      (${IDS.founderB}, ${IDS.userB}, true, 'b@example.com', 'Founder B', 'FOUNDER'),
      (${IDS.founderApprover}, ${IDS.userApprover}, true, 'ap@example.com', 'Approver', 'APPROVER')
  `;
  await school`
    INSERT INTO clusters (cluster_id, status, max_schools, school_count) VALUES
      ('cluster_telangana', 'active', 10, 0),
      ('cluster_other', 'active', 10, 0),
      ('cluster_full', 'active', 1, 1)
  `;
  await school.end();

  request = require('supertest');
  ({ createApp } = require('../../src/app'));
  app = createApp();
  const { reserveClusterCapacity, consumeClusterCapacity } = require('../../src/services/crm/capacity');
  const crmSql = require('../../src/config/crmDb');
  const schoolSql = require('../../src/config/db');
  crm = { crmSql, schoolSql };
  const directory = [];
  let crash = false;
  const sequences = {};
  app.locals.crmProvisioner = {
    directory,
    crashNext() { crash = true; },
    async reserveCapacity(input) { return reserveClusterCapacity(schoolSql, crmSql, input); },
    async consumeCapacity({ operationId }) { return consumeClusterCapacity(crmSql, operationId); },
    async findByCorrelation(clusterId, correlationKey) {
      return directory.find((schoolRow) => schoolRow.cluster_id === clusterId && schoolRow.crm_correlation_key === correlationKey) || null;
    },
    async createSchool(input) {
      sequences[input.clusterId] = (sequences[input.clusterId] || 0) + 1;
      const schoolRow = {
        id: sequences[input.clusterId],
        cluster_id: input.clusterId,
        crm_correlation_key: input.correlationKey,
        onboarding_status: 'pending_build',
        defaults_seeded: false,
        first_admin_exists: false,
        name: input.name,
      };
      directory.push(schoolRow);
      if (crash) {
        crash = false;
        const error = new Error('crash after school insert');
        error.code = 'CRASH_BEFORE_LINK';
        throw error;
      }
      return schoolRow;
    },
    async seedDefaults(clusterId, schoolId) {
      const schoolRow = directory.find((item) => item.cluster_id === clusterId && String(item.id) === String(schoolId));
      if (!schoolRow) return { ok: false, error: 'School defaults could not be seeded' };
      schoolRow.defaults_seeded = true;
      return { ok: true };
    },
    async createFirstAdmin(clusterId, schoolId) {
      const schoolRow = directory.find((item) => item.cluster_id === clusterId && String(item.id) === String(schoolId));
      if (!schoolRow) return { ok: false, error: 'First admin could not be provisioned' };
      schoolRow.first_admin_exists = true;
      return { ok: true };
    },
    async readiness(clusterId, schoolId) {
      const schoolRow = directory.find((item) => item.cluster_id === clusterId && String(item.id) === String(schoolId));
      if (!schoolRow) return null;
      return {
        onboarding_status: schoolRow.onboarding_status,
        defaults_seeded: schoolRow.defaults_seeded,
        first_admin_exists: schoolRow.first_admin_exists,
      };
    },
  };
  directory.push({
    id: 1,
    cluster_id: 'cluster_other',
    crm_correlation_key: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    onboarding_status: 'live',
    defaults_seeded: true,
    first_admin_exists: true,
    name: 'Other cluster school 1',
  });
  sequences.cluster_other = 1;
  tokens = {
    super: sign(IDS.superUser, 'super@example.com'),
    a: sign(IDS.userA, 'a@example.com'),
    b: sign(IDS.userB, 'b@example.com'),
    approver: sign(IDS.userApprover, 'ap@example.com'),
    stranger: sign('99999999-9999-4999-8999-999999999999', 'stranger@example.com'),
  };
});

test.after(async () => {
  if (crm?.crmSql) await crm.crmSql.end({ timeout: 5 }).catch(() => {});
  if (crm?.schoolSql) await crm.schoolSql.end({ timeout: 5 }).catch(() => {});
  for (const item of servers) {
    await item.server.stop().catch(() => {});
    await item.db.close().catch(() => {});
  }
});

test('activation and ambiguous school identity are explicit', () => {
  const { evaluateActivation, interpretSchoolMatches } = require('../../src/services/crm/helpers');
  const pending = evaluateActivation({ onboardingStatus: 'pending_build', defaultsSeeded: true, firstAdminExists: true, currentLifecycle: 'ONBOARDING' });
  assert.equal(pending.lifecycle, 'ONBOARDING');
  assert.equal(pending.changed, false);
  const live = evaluateActivation({ onboardingStatus: 'live', defaultsSeeded: true, firstAdminExists: true, currentLifecycle: 'ONBOARDING' });
  assert.equal(live.lifecycle, 'ACTIVE');
  const suspended = evaluateActivation({ onboardingStatus: 'suspended', defaultsSeeded: true, firstAdminExists: true, currentLifecycle: 'ONBOARDING' });
  assert.equal(suspended.lifecycle, 'ONBOARDING');
  assert.equal(suspended.reason, 'suspension_is_not_churn');
  const ambiguous = interpretSchoolMatches([{ cluster_id: 'a' }, { cluster_id: 'b' }]);
  assert.equal(ambiguous.status, 409);
  assert.equal(interpretSchoolMatches([{ cluster_id: 'a' }]).status, 200);
});

test('migration backfill preserves uncertain history and projects follow-ups', async () => {
  const { crmSql } = crm;
  const [closed] = await crmSql`SELECT status, outcome, outcome_review_required FROM enquiries WHERE email = 'closed@example.com'`;
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.outcome, 'LEGACY_UNKNOWN');
  assert.equal(closed.outcome_review_required, true);
  const [known] = await crmSql`SELECT next_action_task_id, next_follow_up_at FROM enquiries WHERE email = 'known@example.com'`;
  assert.ok(known.next_action_task_id);
  assert.ok(known.next_follow_up_at);
  const [ambiguous] = await crmSql`
    SELECT e.id FROM enquiries e
    JOIN crm_review_queue q ON q.enquiry_id = e.id AND q.reason = 'AMBIGUOUS_NEXT_FOLLOW_UP'
    WHERE e.email = 'ambiguous@example.com'
  `;
  assert.ok(ambiguous);
  const [wonByMistake] = await crmSql`SELECT COUNT(*)::int AS count FROM enquiries WHERE outcome = 'WON' AND email = 'closed@example.com'`;
  assert.equal(wonByMistake.count, 0);
});

test('public ingestion accepts phone-only leads and blocks privileged columns', async () => {
  const phone = await request(app).post('/api/public/enquiries').send({ name: 'Phone Lead', phone: '9876543210', product: 'SchoolIMS' });
  assert.equal(phone.status, 201);
  const [row] = await crm.crmSql`SELECT email, phone, assigned_to, outcome, intake_queue, value_amount FROM enquiries WHERE id = ${phone.body.enquiryId}`;
  assert.equal(row.email, null);
  assert.equal(row.phone, '9876543210');
  assert.equal(row.assigned_to, null);
  assert.equal(row.outcome, 'OPEN');
  assert.equal(row.intake_queue, 'UNASSIGNED_INTAKE');
  assert.equal(row.value_amount, null);

  const email = await request(app).post('/api/public/enquiries').send({ name: 'Email Lead', email: 'web@example.com', message: 'Need a demo please' });
  assert.equal(email.status, 201);

  await assert.rejects(
    () => crm.crmSql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE anon');
      await tx`
        INSERT INTO enquiries (name, email, assigned_to, outcome, value_amount)
        VALUES ('Hacker', 'hacker@example.com', ${IDS.founderA}, 'WON', 99999)
      `;
    }),
    /permission denied/,
  );
});

test('scope fails closed and founder A cannot touch founder B', async () => {
  const sync = await api('post', '/api/super-admin/crm/founders/sync', tokens.super, {});
  assert.equal(sync.status, 200);
  const denied = await api('get', '/api/super-admin/crm/leads', tokens.stranger);
  assert.equal(denied.status, 403);

  const territory = await api('post', '/api/super-admin/crm/catalog/territories', tokens.super, { code: 'TELANGANA', name: 'Telangana' });
  assert.equal(territory.status, 201);
  await api('post', `/api/super-admin/crm/catalog/territories/${territory.body.id}/members`, tokens.super, { founder_id: IDS.founderA });
  await api('post', `/api/super-admin/crm/catalog/territories/${territory.body.id}/members`, tokens.super, { founder_id: IDS.founderB });

  const created = await crm.crmSql`
    INSERT INTO enquiries (name, email, phone, website_source, category, status, assigned_to, pipeline_stage_code, outcome, territory_id, product_vertical, sales_model_version)
    VALUES ('Referral School', 'b-lead@example.com', '9000000000', 'REFERRAL', 'SchoolIMS', 'NEW', ${IDS.founderB}, 'NEW', 'OPEN', ${territory.body.id}, 'SCHOOL', 1)
    RETURNING id, row_version
  `;
  const lead = created[0];
  const hidden = await api('get', `/api/super-admin/crm/leads/${lead.id}`, tokens.a);
  assert.equal(hidden.status, 404);
  const legacy = await api('patch', `/api/super-admin/founder/enquiries/${lead.id}`, tokens.a, { status: 'QUALIFIED', expected_version: lead.row_version });
  assert.equal(legacy.status, 404);
  const steal = await api('post', `/api/super-admin/crm/leads/${lead.id}/owner`, tokens.a, { owner_founder_id: IDS.founderA, expected_version: lead.row_version });
  assert.equal(steal.status, 403);
  const approverWrite = await api('post', `/api/super-admin/crm/leads/${lead.id}/stage`, tokens.approver, { stage: 'CONTACTED', expected_version: lead.row_version });
  assert.equal(approverWrite.status, 403);

  const visible = await api('get', `/api/super-admin/crm/leads/${lead.id}`, tokens.b);
  assert.equal(visible.status, 200);
  const stats = await api('get', '/api/super-admin/founder/enquiries/stats', tokens.a);
  assert.equal(stats.status, 200);
  const allStats = await api('get', '/api/super-admin/founder/enquiries/stats', tokens.super);
  assert.ok(allStats.body.enquiriesToday >= stats.body.enquiriesToday);
});

test('example A wins a school sale and activates only when live', async () => {
  const { crmSql } = crm;
  const territory = await crmSql`SELECT id FROM crm_territories WHERE code = 'TELANGANA'`;
  const [lead] = await crmSql`
    INSERT INTO enquiries (name, email, phone, website_source, category, status, pipeline_stage_code, outcome, product_vertical, intake_queue, sales_model_version, territory_id)
    VALUES ('Sunrise School', 'sunrise@example.com', '9123456780', 'NEXSYRUS_WEBSITE', 'SchoolIMS', 'NEW', 'NEW', 'OPEN', 'SCHOOL', 'UNASSIGNED_INTAKE', 1, ${territory[0].id})
    RETURNING id, row_version
  `;
  const due = new Date(Date.now() + 3600_000).toISOString();
  const assigned = await api('post', `/api/super-admin/crm/leads/${lead.id}/owner`, tokens.super, {
    expected_version: lead.row_version,
    owner_founder_id: IDS.founderA,
    next_action: { title: 'Qualification call', due_at: due, assignee_founder_id: IDS.founderA },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  let version = assigned.body.row_version;
  const called = await api('post', `/api/super-admin/crm/leads/${lead.id}/activities`, tokens.a, {
    expected_version: version,
    activity_type: 'CALL',
    summary: 'Qualified the academic year and budget',
    result: 'Qualified',
    follow_up: { title: 'Schedule demo', due_at: due, assignee_founder_id: IDS.founderA },
  });
  assert.equal(called.status, 200, JSON.stringify(called.body));
  version = called.body.row_version;
  const contacted = await api('post', `/api/super-admin/crm/leads/${lead.id}/stage`, tokens.a, { expected_version: version, stage: 'CONTACTED' });
  assert.equal(contacted.status, 200, JSON.stringify(contacted.body));
  version = contacted.body.row_version;
  const qualified = await api('post', `/api/super-admin/crm/leads/${lead.id}/stage`, tokens.a, { expected_version: version, stage: 'QUALIFIED' });
  assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
  version = qualified.body.row_version;
  const starts = new Date(Date.now() + 86400_000).toISOString();
  const ends = new Date(Date.now() + 90000_000).toISOString();
  const demo = await api('post', `/api/super-admin/crm/leads/${lead.id}/demos`, tokens.a, {
    expected_version: version, starts_at: starts, ends_at: ends, timezone: 'Asia/Kolkata', host_founder_id: IDS.founderA,
  });
  assert.equal(demo.status, 201, JSON.stringify(demo.body));
  const [afterSchedule] = await crmSql`SELECT pipeline_stage_code, outcome FROM enquiries WHERE id = ${lead.id}`;
  assert.equal(afterSchedule.pipeline_stage_code, 'QUALIFIED');
  assert.equal(afterSchedule.outcome, 'OPEN');
  const finished = await api('post', `/api/super-admin/crm/demos/${demo.body.id}/finish`, tokens.a, {
    expected_version: demo.body.id ? (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version : version,
    status: 'COMPLETED',
    result: 'Demo completed with the principal',
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  version = finished.body.lead.row_version;
  const toDemo = await api('post', `/api/super-admin/crm/leads/${lead.id}/stage`, tokens.a, { expected_version: version, stage: 'DEMO' });
  assert.equal(toDemo.status, 200, JSON.stringify(toDemo.body));
  version = toDemo.body.row_version;
  const proposal = await api('post', `/api/super-admin/crm/leads/${lead.id}/proposals`, tokens.a, {
    expected_version: version, amount: '120000.50', currency: 'INR', validity_date: '2026-12-31',
  });
  assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const sent = await api('post', `/api/super-admin/crm/proposal-versions/${proposal.body.version.id}/transition`, tokens.a, {
    expected_version: version, status: 'SENT',
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.delivery_state, 'RECORDED_SENT');
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const revised = await api('post', `/api/super-admin/crm/proposals/${proposal.body.proposal.id}/revise`, tokens.a, {
    expected_version: version, amount: '110000.00', currency: 'INR',
  });
  assert.equal(revised.status, 201, JSON.stringify(revised.body));
  assert.equal(revised.body.version_no, 2);
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const sentV2 = await api('post', `/api/super-admin/crm/proposal-versions/${revised.body.id}/transition`, tokens.a, { expected_version: version, status: 'SENT' });
  assert.equal(sentV2.status, 200);
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const accepted = await api('post', `/api/super-admin/crm/proposal-versions/${revised.body.id}/transition`, tokens.a, { expected_version: version, status: 'ACCEPTED' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const mutated = await crm.crmSql`
    UPDATE crm_proposal_versions SET amount = 1 WHERE id = ${proposal.body.version.id}
  `.then(() => 'updated', (err) => err.message);
  assert.match(mutated, /immutable/i);
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const won = await api('post', `/api/super-admin/crm/leads/${lead.id}/close`, tokens.a, {
    expected_version: version, outcome: 'WON', value_amount: '110000.00', currency: 'INR',
  });
  assert.equal(won.status, 200, JSON.stringify(won.body));
  assert.equal(won.body.outcome, 'WON');
  assert.equal(won.body.status, 'CLOSED');
  const [openTasks] = await crmSql`SELECT COUNT(*)::int AS count FROM crm_tasks WHERE enquiry_id = ${lead.id} AND status IN ('OPEN','IN_PROGRESS')`;
  assert.equal(openTasks.count, 0);

  const idempotencyKey = 'sunrise-school-onboarding-001';
  const payload = {
    idempotency_key: idempotencyKey,
    enquiry_id: lead.id,
    vertical: 'SCHOOL',
    cluster_id: 'cluster_telangana',
    name: 'Sunrise School',
    code: 'SUNRISE',
    admin: { email: 'admin@sunrise.example', password: 'temporary-password' },
  };
  const onboard = await api('post', '/api/super-admin/crm/onboarding', tokens.a, payload);
  assert.equal(onboard.status, 200, JSON.stringify(onboard.body));
  assert.equal(onboard.body.cluster_id, 'cluster_telangana');
  assert.equal(onboard.body.target_school_id, '1');
  const [account] = await crmSql`SELECT lifecycle_stage, cluster_id, external_client_id, vertical FROM crm_accounts WHERE id = ${onboard.body.account_id}`;
  assert.equal(account.lifecycle_stage, 'ONBOARDING');
  assert.equal(account.cluster_id, 'cluster_telangana');
  assert.equal(account.external_client_id, '1');
  const early = await api('post', `/api/super-admin/crm/accounts/${account.id || onboard.body.account_id}/sync-activation`, tokens.super, {
    onboarding_status: 'pending_build', defaults_seeded: true, first_admin_exists: true,
  });
  assert.equal(early.body.account.lifecycle_stage, 'ONBOARDING');
  const schoolRow = app.locals.crmProvisioner.directory.find((item) => item.cluster_id === 'cluster_telangana' && item.crm_correlation_key === onboard.body.correlation_key);
  schoolRow.onboarding_status = 'live';
  const activated = await api('post', `/api/super-admin/crm/accounts/${onboard.body.account_id}/sync-activation`, tokens.super, {});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.account.lifecycle_stage, 'ACTIVE');
  const replay = await api('post', '/api/super-admin/crm/onboarding', tokens.a, payload);
  assert.equal(replay.body.target_school_id, onboard.body.target_school_id);
  const schoolsNamed = app.locals.crmProvisioner.directory.filter((item) => item.name === 'Sunrise School');
  assert.equal(schoolsNamed.length, 1);
});

test('example B recovers a crashed handoff and keeps loss history', async () => {
  const { crmSql, schoolSql } = crm;
  const [before] = await schoolSql`SELECT school_count FROM clusters WHERE cluster_id = 'cluster_telangana'`;
  const [lead] = await crmSql`
    INSERT INTO enquiries (name, email, phone, website_source, status, pipeline_stage_code, outcome, assigned_to, product_vertical, sales_model_version, currency, value_amount)
    VALUES ('Budget Referral', 'budget@example.com', '9000001111', 'REFERRAL', 'QUALIFIED', 'QUALIFIED', 'OPEN', ${IDS.founderB}, 'SCHOOL', 1, 'INR', 80000)
    RETURNING id, row_version
  `;
  const due = new Date(Date.now() + 7200_000).toISOString();
  const task = await api('post', `/api/super-admin/crm/leads/${lead.id}/tasks`, tokens.b, {
    expected_version: lead.row_version,
    title: 'Budget follow-up',
    due_at: due,
    assignee_founder_id: IDS.founderB,
  });
  assert.equal(task.status, 200, JSON.stringify(task.body));
  let version = task.body.lead.row_version;
  const missed = await api('post', `/api/super-admin/crm/leads/${lead.id}/demos`, tokens.b, {
    expected_version: version,
    starts_at: new Date(Date.now() + 10000).toISOString(),
    ends_at: new Date(Date.now() + 20000).toISOString(),
  });
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  await api('post', `/api/super-admin/crm/demos/${missed.body.id}/finish`, tokens.b, { expected_version: version, status: 'NO_SHOW', result: 'No show' });
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const lost = await api('post', `/api/super-admin/crm/leads/${lead.id}/close`, tokens.b, {
    expected_version: version, outcome: 'LOST', reason_code: 'BUDGET', notes: 'Budget freeze',
  });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  version = lost.body.row_version;
  const reopened = await api('post', `/api/super-admin/crm/leads/${lead.id}/reopen`, tokens.b, {
    expected_version: version,
    reason: 'Budget returned next term',
    next_action: { title: 'Reconfirm budget', due_at: due, assignee_founder_id: IDS.founderB },
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  const [loss] = await crmSql`SELECT outcome, reopened_at FROM crm_closures WHERE enquiry_id = ${lead.id}`;
  assert.equal(loss.outcome, 'LOST');
  assert.ok(loss.reopened_at);
  version = reopened.body.row_version;
  const proposal = await api('post', `/api/super-admin/crm/leads/${lead.id}/proposals`, tokens.b, { expected_version: version, amount: '90000.00', currency: 'INR' });
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const versionId = proposal.body.version.id;
  await api('post', `/api/super-admin/crm/proposal-versions/${versionId}/transition`, tokens.b, { expected_version: version, status: 'SENT' });
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  await api('post', `/api/super-admin/crm/proposal-versions/${versionId}/transition`, tokens.b, { expected_version: version, status: 'ACCEPTED' });
  const document = await api('post', `/api/super-admin/crm/proposal-versions/${versionId}/documents`, tokens.b, {
    expected_version: (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version,
    filename: 'proposal.txt',
    content_base64: Buffer.from('private proposal').toString('base64'),
    content_type: 'text/plain',
  });
  assert.equal(document.status, 201, JSON.stringify(document.body));
  const stolen = await api('get', `/api/super-admin/crm/documents/${document.body.id}`, tokens.a);
  assert.equal(stolen.status, 404);
  const downloaded = await api('get', `/api/super-admin/crm/documents/${document.body.id}`, tokens.b);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.text, /private proposal/);
  assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
  const htmlDoc = await api('post', `/api/super-admin/crm/proposal-versions/${versionId}/documents`, tokens.b, {
    expected_version: (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version,
    filename: 'proposal.html',
    content_base64: Buffer.from('<script>alert(1)</script>').toString('base64'),
    content_type: 'text/html',
  });
  assert.equal(htmlDoc.status, 400);
  version = (await crmSql`SELECT row_version FROM enquiries WHERE id = ${lead.id}`)[0].row_version;
  const won = await api('post', `/api/super-admin/crm/leads/${lead.id}/close`, tokens.b, {
    expected_version: version, outcome: 'WON', value_amount: '90000.00', currency: 'INR',
  });
  assert.equal(won.status, 200, JSON.stringify(won.body));
  const closures = await crmSql`SELECT outcome FROM crm_closures WHERE enquiry_id = ${lead.id} ORDER BY created_at`;
  assert.deepEqual(closures.map((row) => row.outcome), ['LOST', 'WON']);

  app.locals.crmProvisioner.crashNext();
  const payload = {
    idempotency_key: 'budget-referral-onboarding-001',
    enquiry_id: lead.id,
    vertical: 'SCHOOL',
    cluster_id: 'cluster_telangana',
    name: 'Budget School',
    code: 'BUDGET',
  };
  const crashed = await api('post', '/api/super-admin/crm/onboarding', tokens.b, payload);
  assert.equal(crashed.status, 200, JSON.stringify(crashed.body));
  const recovered = await api('post', '/api/super-admin/crm/onboarding', tokens.b, payload);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.target_school_id, crashed.body.target_school_id);
  const budgetSchools = app.locals.crmProvisioner.directory.filter((item) => item.name === 'Budget School');
  assert.equal(budgetSchools.length, 1);
  const other = app.locals.crmProvisioner.directory.find((item) => item.cluster_id === 'cluster_other' && item.id === 1);
  assert.equal(other.name, 'Other cluster school 1');
  const changed = await api('post', '/api/super-admin/crm/onboarding', tokens.b, { ...payload, code: 'OTHER-CODE' });
  assert.equal(changed.status, 409);
  const [after] = await schoolSql`SELECT school_count FROM clusters WHERE cluster_id = 'cluster_telangana'`;
  assert.equal(Number(after.school_count), Number(before.school_count) + 1);
  const full = await api('post', '/api/super-admin/crm/onboarding', tokens.super, {
    idempotency_key: 'full-cluster-onboarding-001',
    enquiry_id: lead.id,
    vertical: 'SCHOOL',
    cluster_id: 'cluster_full',
    name: 'No Room',
    code: 'NOROOM',
  });
  assert.equal(full.status, 503);
});

test('automation retries dedupe and later occurrences still run', async () => {
  const { enqueueAutomationEvent, processOneRun } = require('../../src/services/crmAutomation');
  const { crmSql } = crm;
  const [account] = await crmSql`INSERT INTO crm_accounts (name, vertical) VALUES ('Automation account', 'SCHOOL') RETURNING id`;
  const [rule] = await crmSql`
    INSERT INTO crm_automation_rules (name, trigger_event, conditions, actions, is_enabled)
    VALUES ('Retry probe', 'test.event', '{}'::jsonb, ${crmSql.json([{ type: 'NOT_A_REAL_ACTION' }])}, true)
    RETURNING id
  `;
  await enqueueAutomationEvent(crmSql, 'test.event', 'crm_account', account.id, {
    account_id: account.id,
    owner_founder_id: IDS.founderA,
    occurrence_id: 'once',
  });
  await processOneRun();
  const [failed] = await crmSql`SELECT status, error FROM crm_automation_runs WHERE rule_id = ${rule.id}`;
  assert.equal(failed.status, 'FAILED');
  await crmSql`
    UPDATE crm_automation_rules
    SET actions = ${crmSql.json([{ type: 'CREATE_TASK', title: 'Retry task', due_in_minutes: 30 }])}
    WHERE id = ${rule.id}
  `;
  await crmSql`
    UPDATE crm_automation_runs SET status = 'FAILED', available_at = now(), error = NULL WHERE rule_id = ${rule.id}
  `;
  await processOneRun();
  const tasks = await crmSql`SELECT id FROM crm_tasks WHERE automation_rule_id = ${rule.id}`;
  assert.equal(tasks.length, 1);
  await processOneRun();
  const stillOne = await crmSql`SELECT id FROM crm_tasks WHERE automation_rule_id = ${rule.id}`;
  assert.equal(stillOne.length, 1);
  await enqueueAutomationEvent(crmSql, 'test.event', 'crm_account', account.id, {
    account_id: account.id,
    owner_founder_id: IDS.founderA,
    occurrence_id: 'second-real-event',
  });
  await processOneRun();
  const again = await crmSql`SELECT id FROM crm_tasks WHERE automation_rule_id = ${rule.id}`;
  assert.equal(again.length, 2);
});

test('concurrent stage updates conflict once', async () => {
  const [lead] = await crm.crmSql`
    INSERT INTO enquiries (name, email, status, pipeline_stage_code, outcome, assigned_to, sales_model_version)
    VALUES ('Race', 'race@example.com', 'NEW', 'NEW', 'OPEN', ${IDS.founderA}, 1)
    RETURNING id, row_version
  `;
  const results = await Promise.all([
    api('post', `/api/super-admin/crm/leads/${lead.id}/stage`, tokens.a, { expected_version: lead.row_version, stage: 'CONTACTED' }),
    api('post', `/api/super-admin/crm/leads/${lead.id}/stage`, tokens.a, { expected_version: lead.row_version, stage: 'CONTACTED' }),
  ]);
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [200, 409]);
});
