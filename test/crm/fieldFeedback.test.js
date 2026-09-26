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
  accountA: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  accountB: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  enquiryA: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

test('manifest orders field feedback after trackable links', () => {
  const { orderedCrmMigrations } = require('../../src/db/crmMigrationManifest');
  const ids = orderedCrmMigrations().map((item) => item.id);
  assert.ok(ids.indexOf('19_field_feedback') > ids.indexOf('18_trackable_links'));
});

test('default routing, conflicts, and mixed-issue hints do not auto-split', () => {
  const { resolveDestination, mixedIssueHint } = require('../../src/services/crm/feedbackRules');
  const defaults = [
    { id: '1', category: 'feature_request', destination_key: 'product', active: true, priority: 10 },
    { id: '2', category: 'objection', destination_key: 'sales_enablement', active: true, priority: 10 },
    { id: '3', category: 'curriculum_finding', destination_key: 'curriculum', active: true, priority: 10 },
    { id: '4', category: 'unsure', destination_key: 'triage', active: true, priority: 10 },
  ];
  assert.equal(resolveDestination(defaults, 'feature_request').destination_key, 'product');
  assert.equal(resolveDestination(defaults, 'objection').destination_key, 'sales_enablement');
  assert.equal(resolveDestination(defaults, 'curriculum_finding').destination_key, 'curriculum');
  assert.equal(resolveDestination(defaults, 'unsure').destination_key, 'triage');
  assert.equal(resolveDestination(defaults, 'feature_request').routing_reason, 'rule');
  const conflict = resolveDestination([
    ...defaults,
    { id: '5', category: 'feature_request', destination_key: 'curriculum', active: true, priority: 20 },
  ], 'feature_request');
  assert.equal(conflict.destination_key, 'triage');
  assert.equal(conflict.routing_reason, 'conflict');
  assert.equal(resolveDestination([], 'feature_request').routing_reason, 'no_rule');
  assert.equal(mixedIssueHint('Allow offline attendance'), null);
  assert.equal(mixedIssueHint('The price exceeds our budget'), null);
  assert.equal(mixedIssueHint('Lesson 4 assumes fractions before they are taught'), null);
  const mixed = mixedIssueHint('We cannot buy without offline attendance');
  assert.deepEqual(mixed.categories.sort(), ['feature_request', 'objection']);
  assert.match(mixed.message, /split/i);
});

test('field feedback is saved, routed, split, and permissioned without duplicate queue items', async (t) => {
  const servers = [];
  async function startDb() {
    const db = new PGlite();
    const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 20 });
    await server.start();
    servers.push({ db, server });
    return `postgres://postgres:postgres@127.0.0.1:${server.server.address().port}/postgres`;
  }
  const crmUrl = await startDb();
  const schoolUrl = await startDb();
  process.env.SCHOOL_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SCHOOL_SUPABASE_ANON_KEY = 'test-anon';
  process.env.SCHOOL_SUPABASE_SERVICE_ROLE_KEY = 'test-service';
  process.env.SCHOOL_SUPABASE_JWT_SECRET = SECRET;
  process.env.SCHOOL_DATABASE_URL = schoolUrl;
  process.env.CRM_DATABASE_URL = crmUrl;
  process.env.ALLOWED_ORIGINS = 'https://admin.example';

  t.after(async () => {
    for (const item of servers) {
      await item.server.stop();
      await item.db.close();
    }
  });

  const bootstrap = postgres(crmUrl, { ssl: false, max: 1, onnotice: () => {} });
  await bootstrap.unsafe(`
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await bootstrap.end();
  const { applyCrmMigrations } = require('../../src/db/applyCrmMigrations');
  await applyCrmMigrations(crmUrl);

  const prep = postgres(crmUrl, { ssl: false, max: 1, onnotice: () => {} });
  await prep`
    INSERT INTO founders (id, full_name, email, is_active) VALUES
      (${IDS.founderA}, 'Founder A', 'a@example.com', true),
      (${IDS.founderB}, 'Founder B', 'b@example.com', true),
      (${IDS.founderApprover}, 'Approver', 'ap@example.com', true)
  `;
  await prep`
    INSERT INTO crm_accounts (id, name, account_type, vertical, owner_founder_id) VALUES
      (${IDS.accountA}, 'Prospect School A', 'PROSPECT', 'SCHOOL', ${IDS.founderA}),
      (${IDS.accountB}, 'Prospect School B', 'PROSPECT', 'SCHOOL', ${IDS.founderB})
  `;
  await prep`
    INSERT INTO enquiries (id, name, email, organization, account_id, assigned_to)
    VALUES (${IDS.enquiryA}, 'Ada', 'ada@school.example', 'Prospect School A', ${IDS.accountA}, ${IDS.founderA})
  `;
  await prep.end();

  const school = postgres(schoolUrl, { ssl: false, max: 1, onnotice: () => {} });
  await school.unsafe(`
    CREATE TABLE super_admins (id uuid PRIMARY KEY, is_active boolean, email text, full_name text);
    CREATE TABLE founders (id uuid PRIMARY KEY, user_id uuid, is_active boolean, email text, full_name text, role text);
    CREATE TABLE notifications (
      id uuid PRIMARY KEY,
      user_id uuid,
      founder_id uuid,
      title text,
      body text,
      type text,
      read_at timestamptz,
      created_at timestamptz DEFAULT now()
    );
  `);
  await school`INSERT INTO super_admins (id, is_active, email, full_name) VALUES (${IDS.superUser}, true, 'super@example.com', 'Super Admin')`;
  await school`
    INSERT INTO founders (id, user_id, is_active, email, full_name, role) VALUES
      (${IDS.founderA}, ${IDS.userA}, true, 'a@example.com', 'Founder A', 'FOUNDER'),
      (${IDS.founderB}, ${IDS.userB}, true, 'b@example.com', 'Founder B', 'FOUNDER'),
      (${IDS.founderApprover}, ${IDS.userApprover}, true, 'ap@example.com', 'Approver', 'APPROVER')
  `;
  await school.end();

  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const app = createApp();
  const feedback = require('../../src/services/crm/fieldFeedback');
  const crmSql = require('../../src/config/crmDb');
  const tokenSuper = jwt.sign({ sub: IDS.superUser, email: 'super@example.com' }, SECRET, { algorithm: 'HS256' });
  const tokenA = jwt.sign({ sub: IDS.userA, email: 'a@example.com' }, SECRET, { algorithm: 'HS256' });
  const tokenB = jwt.sign({ sub: IDS.userB, email: 'b@example.com' }, SECRET, { algorithm: 'HS256' });
  const tokenApprover = jwt.sign({ sub: IDS.userApprover, email: 'ap@example.com' }, SECRET, { algorithm: 'HS256' });
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  function body(overrides) {
    return {
      feedback_type: 'feature_request',
      title: 'Allow offline attendance',
      observation: 'Teachers said they need to mark attendance without a signal.',
      context_kind: 'visit',
      urgency: 'high',
      ...overrides,
    };
  }

  assert.equal((await request(app).get('/api/super-admin/crm/feedback/items')).status, 401);
  assert.equal((await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenApprover)).send(body({ client_key: 'approver-no' }))).status, 403);

  const owner = await request(app).patch('/api/super-admin/crm/feedback/destinations/product').set(auth(tokenSuper)).send({
    default_owner_founder_id: IDS.founderA,
    reason: 'Product queue owner for field feedback',
  });
  assert.equal(owner.status, 200);

  for (const [type, destination] of [
    ['feature_request', 'product'],
    ['objection', 'sales_enablement'],
    ['curriculum_finding', 'curriculum'],
    ['unsure', 'triage'],
  ]) {
    const preview = await request(app).post('/api/super-admin/crm/feedback/preview').set(auth(tokenA)).send({ feedback_type: type });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.destination_key, destination);
    assert.equal(preview.body.delivery_commitment, false);
  }

  const blocked = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'account-denied-1',
    account_id: IDS.accountB,
  }));
  assert.equal(blocked.status, 404);

  const feature = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'feature-offline-1',
    account_id: IDS.accountA,
    customer_label: 'Prospect School A',
    product_area: 'Attendance',
    impact: 'Blocks purchase conversations',
    evidence: 'Heard on the campus walk',
    source_type: 'enquiry',
    source_id: IDS.enquiryA,
    attachments: [{
      file_name: 'note.txt',
      content_type: 'text/plain',
      data_base64: Buffer.from('offline attendance').toString('base64'),
    }],
  }));
  assert.equal(feature.status, 201);
  assert.equal(feature.body.item.destination_key, 'product');
  assert.equal(feature.body.item.routing_state, 'routed');
  assert.equal(feature.body.item.status, 'new');
  assert.equal(feature.body.item.reported_urgency, 'high');
  assert.equal(feature.body.item.triage_priority, null);
  assert.equal(feature.body.delivery_commitment, false);
  assert.equal(feature.body.item.source_href.includes(IDS.enquiryA), true);

  const replay = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'feature-offline-1',
    account_id: IDS.accountA,
    customer_label: 'Prospect School A',
    product_area: 'Attendance',
    impact: 'Blocks purchase conversations',
    evidence: 'Heard on the campus walk',
    source_type: 'enquiry',
    source_id: IDS.enquiryA,
    attachments: [{
      file_name: 'note.txt',
      content_type: 'text/plain',
      data_base64: Buffer.from('offline attendance').toString('base64'),
    }],
  }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.item.id, feature.body.item.id);
  const changed = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'feature-offline-1',
    title: 'A different request',
    observation: 'This is a different observation than the saved draft.',
  }));
  assert.equal(changed.status, 409);

  const objection = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'objection-budget-1',
    feedback_type: 'objection',
    title: 'The price exceeds our budget',
    observation: 'The principal said the price exceeds our budget for this term.',
    context_kind: 'customer_interaction',
    account_id: IDS.accountA,
    urgency: 'normal',
  }));
  assert.equal(objection.body.item.destination_key, 'sales_enablement');

  const curriculum = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'curriculum-fractions-1',
    feedback_type: 'curriculum_finding',
    title: 'Lesson 4 assumes fractions',
    observation: 'Lesson 4 assumes fractions before they are taught in the prior module.',
    context_kind: 'class_session',
    urgency: 'critical',
    course_name: 'Class 4 maths',
    module_name: 'Number sense',
    lesson_name: 'Lesson 4',
  }));
  assert.equal(curriculum.body.item.destination_key, 'curriculum');

  const unsure = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'unsure-note-1',
    feedback_type: 'unsure',
    title: 'Not sure where this belongs',
    observation: 'A teacher mentioned something unclear at the end of the visit.',
    context_kind: 'other',
  }));
  assert.equal(unsure.body.item.destination_key, 'triage');

  const secondFeature = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'feature-import-1',
    title: 'Add bulk student import',
    observation: 'Office staff asked for a bulk student import before term start.',
    account_id: IDS.accountA,
    product_area: 'Students',
  }));
  assert.equal(secondFeature.body.item.destination_key, 'product');

  const product = await request(app).get('/api/super-admin/crm/feedback/items').set(auth(tokenSuper)).query({ view: 'product', category: 'feature_request', account: IDS.accountA });
  assert.equal(product.status, 200);
  assert.equal(product.body.counts.total_reports, 2);
  assert.equal(product.body.counts.distinct_accounts, 1);
  assert.equal(product.body.delivery_commitment, false);

  const triageDenied = await request(app).get('/api/super-admin/crm/feedback/items').set(auth(tokenB)).query({ view: 'triage' });
  assert.equal(triageDenied.status, 403);
  const triage = await request(app).get('/api/super-admin/crm/feedback/items').set(auth(tokenSuper)).query({ view: 'triage', q: 'unclear' });
  assert.equal(triage.body.items.some((item) => item.id === unsure.body.item.id), true);

  feedback.setRoutingFailureCount(1);
  const failed = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'feature-failed-1',
    title: 'Export attendance reports',
    observation: 'They want attendance reports they can export after each period.',
    account_id: IDS.accountA,
  }));
  assert.equal(failed.status, 201);
  assert.equal(failed.body.item.routing_state, 'failed');
  const [failedQueues] = await crmSql`SELECT COUNT(*)::int AS count FROM field_feedback_queue_entries WHERE item_id = ${failed.body.item.id}`;
  assert.equal(failedQueues.count, 0);
  const hiddenError = await request(app).get(`/api/super-admin/crm/feedback/items/${failed.body.item.id}`).set(auth(tokenA));
  assert.equal(hiddenError.status, 200);
  assert.equal(hiddenError.body.item.routing_error, null);
  const visibleError = await request(app).get(`/api/super-admin/crm/feedback/items/${failed.body.item.id}`).set(auth(tokenSuper));
  assert.match(visibleError.body.item.routing_error, /did not accept/);
  const retried = await request(app).post(`/api/super-admin/crm/feedback/items/${failed.body.item.id}/retry-routing`).set(auth(tokenSuper)).send({
    expected_version: visibleError.body.item.row_version,
  });
  assert.equal(retried.body.item.routing_state, 'routed');
  assert.equal(retried.body.queue_entries, 1);
  const retriedAgain = await request(app).post(`/api/super-admin/crm/feedback/items/${retried.body.item.id}/retry-routing`).set(auth(tokenSuper)).send({
    expected_version: retried.body.item.row_version,
  });
  assert.equal(retriedAgain.body.created_queue_entry, false);
  assert.equal(retriedAgain.body.queue_entries, 1);

  const conflictRule = await request(app).post('/api/super-admin/crm/feedback/rules').set(auth(tokenSuper)).send({
    category: 'feature_request',
    destination_key: 'curriculum',
    priority: 1,
    reason: 'Temporary conflicting test rule',
  });
  assert.equal(conflictRule.status, 201);
  const conflictPreview = await request(app).post('/api/super-admin/crm/feedback/preview').set(auth(tokenA)).send({ feedback_type: 'feature_request' });
  assert.equal(conflictPreview.body.destination_key, 'triage');
  assert.equal(conflictPreview.body.routing_reason, 'conflict');
  const conflicted = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'feature-conflict-1',
    title: 'Conflict goes to triage',
    observation: 'This request should wait in triage while two rules disagree.',
  }));
  assert.equal(conflicted.body.item.destination_key, 'triage');
  assert.equal((await request(app).patch(`/api/super-admin/crm/feedback/rules/${conflictRule.body.id}`).set(auth(tokenSuper)).send({
    active: false,
    reason: 'Remove the conflicting test rule',
  })).status, 200);

  const mixedPreview = await request(app).post('/api/super-admin/crm/feedback/preview').set(auth(tokenA)).send({
    feedback_type: 'objection',
    observation: 'We cannot buy without offline attendance',
  });
  assert.equal(mixedPreview.body.destination_key, 'sales_enablement');
  assert.match(mixedPreview.body.hint.message, /Nothing is split automatically/);
  const mixed = await request(app).post('/api/super-admin/crm/feedback').set(auth(tokenA)).send(body({
    client_key: 'mixed-buy-offline-1',
    feedback_type: 'objection',
    title: 'We cannot buy without offline attendance',
    observation: 'We cannot buy without offline attendance',
    context_kind: 'demo',
    account_id: IDS.accountA,
  }));
  const split = await request(app).post(`/api/super-admin/crm/feedback/items/${mixed.body.item.id}/split`).set(auth(tokenSuper)).send({
    expected_version: mixed.body.item.row_version,
    reason: 'Price objection and offline attendance are separate issues',
    parts: [{
      category: 'feature_request',
      title: 'Allow offline attendance',
      observation: 'Purchase depends on offline attendance.',
    }],
  });
  assert.equal(split.status, 200);
  assert.equal(split.body.original_submission.observation, 'We cannot buy without offline attendance');
  assert.equal(split.body.original_item.destination_key, 'sales_enablement');
  assert.equal(split.body.items[0].destination_key, 'product');
  assert.equal(split.body.items[0].source_observation, 'We cannot buy without offline attendance');
  assert.equal(split.body.items[0].submission_id, mixed.body.submission.id);
  const [submissionCount] = await crmSql`SELECT COUNT(*)::int AS count FROM field_feedback_submissions WHERE id = ${mixed.body.submission.id}`;
  assert.equal(submissionCount.count, 1);
  const [splitQueues] = await crmSql`
    SELECT COUNT(*)::int AS count FROM field_feedback_queue_entries
    WHERE item_id IN (${mixed.body.item.id}, ${split.body.items[0].id})
  `;
  assert.equal(splitQueues.count, 2);

  const duplicate = await request(app).post(`/api/super-admin/crm/feedback/items/${secondFeature.body.item.id}/duplicates`).set(auth(tokenSuper)).send({
    expected_version: secondFeature.body.item.row_version,
    duplicate_of_id: feature.body.item.id,
    reason: 'Same attendance import need already captured',
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.item.status, 'duplicate');
  const [stillThere] = await crmSql`SELECT COUNT(*)::int AS count FROM field_feedback_submissions WHERE id IN (${feature.body.submission.id}, ${secondFeature.body.submission.id})`;
  assert.equal(stillThere.count, 2);
  const suggestions = await request(app).get(`/api/super-admin/crm/feedback/items/${feature.body.item.id}`).set(auth(tokenSuper));
  assert.equal(suggestions.body.suggestions.every((item) => item.auto_merge === false), true);

  const outsider = await request(app).get(`/api/super-admin/crm/feedback/items/${objection.body.item.id}`).set(auth(tokenB));
  assert.equal(outsider.status, 404);
  const attachmentId = hiddenError.body.attachments[0]?.id
    || (await request(app).get(`/api/super-admin/crm/feedback/items/${feature.body.item.id}`).set(auth(tokenA))).body.attachments[0].id;
  assert.equal((await request(app).get(`/api/super-admin/crm/feedback/attachments/${attachmentId}`).set(auth(tokenB))).status, 404);
  const file = await request(app).get(`/api/super-admin/crm/feedback/attachments/${attachmentId}`).set(auth(tokenA));
  assert.equal(Buffer.from(file.body.content_base64, 'base64').toString(), 'offline attendance');

  const clarified = await request(app).post(`/api/super-admin/crm/feedback/items/${curriculum.body.item.id}/comments`).set(auth(tokenSuper)).send({
    kind: 'clarification_request',
    body: 'Which class saw Lesson 4 taught before fractions?',
  });
  assert.equal(clarified.status, 201);
  assert.equal(clarified.body.item.status, 'needs_clarification');
  const internal = await request(app).post(`/api/super-admin/crm/feedback/items/${curriculum.body.item.id}/comments`).set(auth(tokenSuper)).send({
    kind: 'comment',
    body: 'Internal note for the curriculum owner only.',
  });
  assert.equal(internal.body.comment.visibility, 'internal');
  const submitterView = await request(app).get(`/api/super-admin/crm/feedback/items/${curriculum.body.item.id}`).set(auth(tokenA));
  assert.equal(submitterView.body.comments.some((comment) => comment.kind === 'clarification_request'), true);
  assert.equal(submitterView.body.comments.some((comment) => comment.visibility === 'internal'), false);

  const resolved = await request(app).post(`/api/super-admin/crm/feedback/items/${clarified.body.item.id}/status`).set(auth(tokenSuper)).send({
    expected_version: clarified.body.item.row_version,
    status: 'resolved',
    triage_priority: 'high',
    reason: 'Answer key corrected and lesson order updated',
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.item.status, 'resolved');
  assert.equal(resolved.body.item.triage_priority, 'high');
  assert.equal(resolved.body.item.reported_urgency, 'critical');
  const seen = await request(app).get(`/api/super-admin/crm/feedback/items/${curriculum.body.item.id}`).set(auth(tokenA));
  assert.equal(seen.body.item.resolution_note, 'Answer key corrected and lesson order updated');
  assert.equal(seen.body.permissions.submitter, true);

  const declined = await request(app).post(`/api/super-admin/crm/feedback/items/${unsure.body.item.id}/status`).set(auth(tokenSuper)).send({
    expected_version: unsure.body.item.row_version,
    status: 'declined',
    reason: 'Not enough detail to act on this note',
  });
  assert.equal(declined.body.item.status, 'declined');

  const mine = await request(app).get('/api/super-admin/crm/feedback/items').set(auth(tokenA)).query({
    view: 'mine',
    from: '2020-01-01T00:00:00.000Z',
    to: '2100-01-01T00:00:00.000Z',
    area: 'Attendance',
  });
  assert.equal(mine.body.items.some((item) => item.id === feature.body.item.id), true);
  assert.equal(mine.body.counts.total_reports >= 1, true);

  const notices = await postgres(schoolUrl, { ssl: false, max: 1, onnotice: () => {} });
  const schoolNotes = await notices`SELECT title, user_id, type FROM notifications WHERE type = 'field_feedback'`;
  await notices.end();
  assert.equal(schoolNotes.some((note) => note.user_id === IDS.userA && /Product backlog/.test(note.title)), true);
  assert.equal(schoolNotes.some((note) => note.user_id === IDS.userA && /Clarification requested/.test(note.title)), true);
  assert.equal(schoolNotes.some((note) => note.user_id === IDS.userA && /Feedback resolved/.test(note.title)), true);

  await assert.rejects(
    crmSql`UPDATE field_feedback_submissions SET observation = 'rewritten' WHERE id = ${feature.body.submission.id}`,
    /immutable/,
  );
  const [history] = await crmSql`SELECT COUNT(*)::int AS count FROM field_feedback_routing_history WHERE item_id = ${feature.body.item.id}`;
  assert.equal(history.count >= 1, true);
  const [events] = await crmSql`SELECT COUNT(*)::int AS count FROM field_feedback_events WHERE action IN ('capture', 'route', 'status', 'split', 'duplicate_link')`;
  assert.equal(events.count >= 4, true);
});
