const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

const SECRET = 'test-secret-test-secret-test-secret';
const INGRESS = 'ingress-secret-value';
const IDS = {
  superUser: '11111111-1111-4111-8111-111111111111',
  userA: '22222222-2222-4222-8222-222222222222',
  userB: '33333333-3333-4333-8333-333333333333',
  userApprover: '44444444-4444-4444-8444-444444444444',
  founderA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  founderB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  founderApprover: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  accountA: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

test('manifest orders trackable links after founder sales command', () => {
  const { orderedCrmMigrations } = require('../../src/db/crmMigrationManifest');
  const ids = orderedCrmMigrations().map((item) => item.id);
  assert.ok(ids.indexOf('18_trackable_links') > ids.indexOf('17_founder_sales_command'));
});

test('destinations fail closed and external stores are not owned-site coverage', () => {
  process.env.TRACKING_PUBLIC_ORIGIN = 'https://school.example';
  process.env.TRACKING_OWNED_SITE_ORIGINS = 'https://school.example';
  process.env.TRACKING_ALLOWED_DESTINATION_HOSTS = 'files.example';
  const { validateDestination } = require('../../src/services/crm/trackingDestination');
  assert.equal(validateDestination('https://school.example/contact').destinationClass, 'OWNED_SITE');
  assert.equal(validateDestination('https://play.google.com/store/apps/details?id=com.schoolims.app').coverage, 'unavailable');
  for (const bad of [
    'http://school.example/contact',
    'javascript:alert(1)',
    'https://user:pass@school.example/contact',
    'https://127.0.0.1/contact',
    'https://10.0.0.8/contact',
    'https://evil.example/go?next=https://school.example',
    'https://files.example.evil.com/brochure.pdf',
  ]) {
    assert.throws(() => validateDestination(bad), /Destination/);
  }
});

test('ingress signatures reject replay windows and match the website canonical body', async () => {
  const { signIngress, verifyIngress, canonicalJson } = require('../../src/services/crm/trackingIngress');
  const web = await import('../../../../NexsyrusWebsite/apps/SchoolIMS/src/lib/trackingIngress.ts');
  const body = { code: 'abcdefghijklmnop', z: 1, a: 'ok' };
  assert.equal(canonicalJson(body), web.canonicalJson(body));
  const rawBody = canonicalJson(body);
  const now = Date.now();
  const signature = signIngress({ secret: INGRESS, timestamp: now, nonce: 'nonce-1234', method: 'POST', path: '/api/internal/track/resolve', rawBody });
  assert.equal(signature, web.signIngress({ secret: INGRESS, timestamp: now, nonce: 'nonce-1234', method: 'POST', path: '/api/internal/track/resolve', rawBody }));
  assert.equal(verifyIngress({ secret: INGRESS, timestamp: now, nonce: 'nonce-1234', method: 'POST', path: '/api/internal/track/resolve', rawBody, signature, now }), true);
  assert.throws(() => verifyIngress({
    secret: INGRESS, timestamp: now - 120000, nonce: 'nonce-1234', method: 'POST', path: '/api/internal/track/resolve', rawBody, signature, now,
  }), /expired/);
});

test('open classification and page URL redaction', async () => {
  const { classifyOpen } = require('../../src/services/crm/trackingClassify');
  assert.equal(classifyOpen({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0', purpose: '', method: 'GET' }).event_class, 'QUALIFIED');
  assert.equal(classifyOpen({ userAgent: 'facebookexternalhit/1.1', purpose: '', method: 'GET' }).countable, false);
  assert.equal(classifyOpen({ userAgent: 'Mozilla/5.0', purpose: 'prefetch', method: 'GET' }).event_class, 'PREVIEW');
  const { sanitizePageUrl, buildCrmEnquiry } = await import('../../../../NexsyrusWebsite/apps/SchoolIMS/src/lib/trackingIngress.ts');
  const clean = sanitizePageUrl('https://school.example/contact?at=secret-token&utm=fall');
  assert.equal(clean.includes('secret-token'), false);
  assert.equal(clean.includes('utm=fall'), true);
  const payload = buildCrmEnquiry({ name: 'Ada', email: 'a@ex.com', phone: '9999999999', schoolName: 'School C', message: 'demo please', studentCount: '120' }, 'ctx', 'https://school.example');
  assert.equal(payload.website_source, 'SCHOOL_ERP');
  assert.equal(payload.product, 'SchoolIMS');
  assert.equal(payload.intent, 'DEMO');
  assert.equal(payload.organization, 'School C');
  assert.equal(payload.budget_range, '120');
  assert.equal(payload.owner_founder_id, undefined);
});

test('trackable links attribute opens without merging a different school', async (t) => {
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
  process.env.TRACKING_PUBLIC_ORIGIN = 'https://school.example';
  process.env.TRACKING_OWNED_SITE_ORIGINS = 'https://school.example';
  process.env.TRACKING_ALLOWED_DESTINATION_HOSTS = 'files.example';
  process.env.TRACKING_INGRESS_SECRET = INGRESS;
  process.env.TRACKING_BROWSER_KEY_SECRET = 'browser-key-secret-value';
  process.env.CRM_FEATURE_TRACK_WRITE = 'true';
  process.env.CRM_FEATURE_TRACK_RESOLVE = 'true';
  process.env.CRM_FEATURE_TRACK_ATTRIBUTION = 'true';
  process.env.CRM_FEATURE_TRACK_REPORTS = 'true';
  process.env.CRM_FEATURE_SALES_COMMAND_READ = 'true';

  t.after(async () => {
    process.env.CRM_FEATURE_TRACK_WRITE = 'false';
    process.env.CRM_FEATURE_TRACK_RESOLVE = 'false';
    process.env.CRM_FEATURE_TRACK_ATTRIBUTION = 'false';
    process.env.CRM_FEATURE_TRACK_REPORTS = 'false';
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
    INSERT INTO crm_accounts (id, name, account_type, vertical, owner_founder_id)
    VALUES (${IDS.accountA}, 'Prospect School A', 'PROSPECT', 'SCHOOL', ${IDS.founderA})
  `;
  await prep`
    INSERT INTO crm_school_customer_directory (
      cluster_id, school_id, name, school_name_normalized, school_name_loose, crm_account_id,
      normalization_version, last_refresh_status
    ) VALUES ('cluster_telangana', '1', 'Verified School 1', 'verified school 1', 'verified school 1', ${IDS.accountA}, 1, 'OK')
  `;
  await prep.end();

  const school = postgres(schoolUrl, { ssl: false, max: 1, onnotice: () => {} });
  await school.unsafe(`
    CREATE TABLE super_admins (id uuid PRIMARY KEY, is_active boolean, email text, full_name text);
    CREATE TABLE founders (id uuid PRIMARY KEY, user_id uuid, is_active boolean, email text, full_name text, role text);
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
  const crmSql = require('../../src/config/crmDb');
  const links = require('../../src/services/crm/trackingLinks');
  const attribution = require('../../src/services/crm/trackingAttribution');
  const reports = require('../../src/services/crm/trackingReports');
  const { renderQr } = require('../../src/services/crm/trackingQr');
  const { signForTests } = require('../../src/routes/internalTracking');
  const platform = { kind: 'platform', canWrite: true, founderId: null, actor: { id: IDS.superUser, isSuperAdmin: true } };
  const founderA = { kind: 'owner', canWrite: true, founderId: IDS.founderA, actor: { id: IDS.userA, founderRole: 'FOUNDER' } };

  const scripted = ['Abcdefghijklmnop', 'Abcdefghijklmnop', 'Zyxwvutsrqponmlk'];
  links.setShortCodeFactory(() => scripted.length ? scripted.shift() : crypto.randomBytes(12).toString('base64url'));
  const first = await links.createLink(crmSql, platform, {
    idempotency_key: 'create-link-0001',
    owner_founder_id: IDS.founderA,
    destination_url: 'https://school.example/contact',
    medium: 'QR',
    purpose: 'BROCHURE',
    target_account_id: IDS.accountA,
    district: 'Rangareddy',
    change_reason: 'Issue',
  });
  const collided = await links.createLink(crmSql, platform, {
    idempotency_key: 'create-link-0002',
    owner_founder_id: IDS.founderA,
    destination_url: 'https://school.example/contact',
    medium: 'QR',
    purpose: 'BROCHURE',
  });
  assert.equal(first.short_code, 'Abcdefghijklmnop');
  assert.equal(collided.short_code, 'Zyxwvutsrqponmlk');
  assert.equal(first.stable_url, 'https://school.example/d/Abcdefghijklmnop');
  const replay = await links.createLink(crmSql, platform, {
    idempotency_key: 'create-link-0001',
    owner_founder_id: IDS.founderA,
    destination_url: 'https://school.example/contact',
    medium: 'QR',
    purpose: 'BROCHURE',
    target_account_id: IDS.accountA,
    district: 'Rangareddy',
    change_reason: 'Issue',
  });
  assert.equal(replay.id, first.id);

  await assert.rejects(prepLike(crmSql, first.revision_id), /append-only/);
  const revised = await links.updateLink(crmSql, platform, first.id, {
    expected_version: first.row_version,
    destination_url: 'https://school.example/contact?demo=1',
    change_reason: 'Retarget landing',
  });
  assert.equal(revised.short_code, first.short_code);
  assert.notEqual(revised.revision_id, first.revision_id);

  const verified = await links.createLink(crmSql, platform, {
    idempotency_key: 'create-link-school-1',
    owner_founder_id: IDS.founderA,
    destination_url: 'https://files.example/brochure.pdf',
    medium: 'LINK',
    purpose: 'BROCHURE',
    target_cluster_id: 'cluster_telangana',
    target_school_id: '1',
    target_account_id: IDS.accountA,
  });
  assert.equal(verified.target_school_id, '1');
  assert.equal(verified.coverage, 'unavailable');
  await assert.rejects(links.createLink(crmSql, platform, {
    idempotency_key: 'create-link-bad-school',
    owner_founder_id: IDS.founderA,
    destination_url: 'https://school.example/contact',
    medium: 'QR',
    purpose: 'BROCHURE',
    target_school_id: '2',
  }), /cluster_id and school_id|not found/);

  const qr = await renderQr(first.stable_url, 'svg', 256);
  assert.equal(qr.contentType.includes('svg'), true);
  assert.equal(/<script/i.test(qr.body), false);
  const plan = await crmSql.unsafe(`EXPLAIN SELECT id FROM crm_track_opens WHERE link_id = '${first.id}' ORDER BY observed_at DESC LIMIT 20`);
  assert.ok(plan.length > 0);

  const token = crypto.randomBytes(24).toString('base64url');
  const opened = await links.resolveCode(crmSql, {
    code: first.short_code,
    request_id: 'request-open-1',
    context_token: token,
    user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/605',
    consent: false,
    referrer: 'https://partner.example/path?secret=1',
    site_origin: 'https://school.example',
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.event_class, 'QUALIFIED');
  assert.equal(opened.context.token, token);
  assert.equal(opened.redirect.includes('demo=1'), true);
  const again = await links.resolveCode(crmSql, {
    code: first.short_code,
    request_id: 'request-open-1',
    context_token: token,
    user_agent: 'Mozilla/5.0 Safari',
    site_origin: 'https://school.example',
  });
  assert.equal(again.replay, true);
  assert.equal(again.context, null);
  const bot = await links.resolveCode(crmSql, {
    code: first.short_code,
    request_id: 'request-bot-1',
    user_agent: 'Slackbot-LinkExpanding 1.0',
    site_origin: 'https://school.example',
  });
  assert.equal(bot.countable, false);
  const [storedReferrer] = await crmSql`SELECT referrer_origin FROM crm_track_opens WHERE request_id = 'request-open-1'`;
  assert.equal(storedReferrer.referrer_origin, 'https://partner.example');

  const submitted = await attribution.submitPublicEnquiry(crmSql, {
    name: 'School B Rep',
    email: 'b@schoolb.example',
    phone: '9000000000',
    organization: 'School B',
    message: 'Please show us a demo of attendance',
    product: 'SchoolIMS',
    website_source: 'SCHOOL_ERP',
    intent: 'DEMO',
    idempotency_key: 'form-attempt-0001',
    assigned_to: IDS.founderB,
    campaign: 'forged-campaign',
    target_school_id: '9',
  }, { contextToken: token, origin: 'https://school.example', rateKey: 'enquiry:test-a' });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.attribution, 'ATTRIBUTED');
  const retry = await attribution.submitPublicEnquiry(crmSql, {
    name: 'School B Rep',
    email: 'b@schoolb.example',
    phone: '9000000000',
    organization: 'School B',
    message: 'Please show us a demo of attendance',
    product: 'SchoolIMS',
    website_source: 'SCHOOL_ERP',
    intent: 'DEMO',
    idempotency_key: 'form-attempt-0001',
  }, { contextToken: token, origin: 'https://school.example', rateKey: 'enquiry:test-b' });
  assert.equal(retry.body.enquiryId, submitted.body.enquiryId);
  const [lead] = await crmSql`SELECT organization, assigned_to, campaign_name FROM enquiries WHERE id = ${submitted.body.enquiryId}`;
  assert.equal(lead.organization, 'School B');
  assert.equal(lead.assigned_to, null);
  const [snapshot] = await crmSql`SELECT target_school_name_snapshot, district_normalized FROM crm_track_link_revisions WHERE id = ${revised.revision_id}`;
  assert.equal(snapshot.target_school_name_snapshot, 'Prospect School A');
  const [review] = await crmSql`SELECT reason FROM crm_review_queue WHERE enquiry_id = ${submitted.body.enquiryId}`;
  assert.equal(review.reason, 'TRACK_TARGET_SCHOOL_MISMATCH');
  const [facts] = await crmSql`
    SELECT COUNT(*) FILTER (WHERE kind = 'DEMO_REQUESTED')::int AS requests,
           COUNT(*) FILTER (WHERE kind = 'DEMO_BOOKED')::int AS booked
    FROM crm_track_conversions WHERE enquiry_id = ${submitted.body.enquiryId}
  `;
  assert.equal(facts.requests, 1);
  assert.equal(facts.booked, 0);

  const district = await links.createLink(crmSql, founderA, {
    idempotency_key: 'district-link-01',
    destination_url: 'https://school.example/contact',
    medium: 'QR',
    purpose: 'EVENT',
    district: 'Rangareddy',
    mandal: 'Chevella',
  });
  const districtToken = crypto.randomBytes(24).toString('base64url');
  await links.resolveCode(crmSql, {
    code: district.short_code,
    request_id: 'request-district-1',
    context_token: districtToken,
    user_agent: 'Mozilla/5.0 Chrome/120.0',
    site_origin: 'https://school.example',
  });
  const schoolC = await attribution.submitPublicEnquiry(crmSql, {
    name: 'School C Admin',
    email: 'c@schoolc.example',
    phone: '9111111111',
    organization: 'School C',
    message: 'We need a walkthrough for our campus',
    website_source: 'SCHOOL_ERP',
    intent: 'DEMO',
    idempotency_key: 'form-school-c-01',
  }, { contextToken: districtToken, origin: 'https://school.example', rateKey: 'enquiry:test-c' });
  const [districtRev] = await crmSql`SELECT district_normalized, mandal_normalized, target_account_id FROM crm_track_link_revisions WHERE id = ${district.revision_id}`;
  assert.equal(districtRev.district_normalized, 'rangareddy');
  assert.equal(districtRev.mandal_normalized, 'chevella');
  assert.equal(districtRev.target_account_id, null);
  const [current] = await crmSql`SELECT first_open_id, latest_open_id FROM crm_enquiry_attribution_current WHERE enquiry_id = ${schoolC.body.enquiryId}`;
  assert.equal(current.first_open_id, current.latest_open_id);

  const disabled = await links.setLinkStatus(crmSql, founderA, district.id, { expected_version: district.row_version, reason: 'Pause print run' }, 'DISABLED');
  assert.equal(disabled.status, 'DISABLED');
  const hidden = await links.resolveCode(crmSql, {
    code: district.short_code,
    request_id: 'request-disabled-1',
    user_agent: 'Mozilla/5.0 Chrome/120.0',
    site_origin: 'https://school.example',
  });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.redirect, undefined);

  const signed = signForTests({
    code: 'not-a-real-code!!',
    request_id: 'request-http-1',
    site_origin: 'https://school.example',
  }, INGRESS);
  const missing = await request(app).post('/api/internal/track/resolve').set({
    'x-track-timestamp': signed.timestamp,
    'x-track-nonce': signed.nonce,
    'x-track-signature': signed.signature,
  }).send({ code: 'not-a-real-code!!', request_id: 'request-http-1', site_origin: 'https://school.example' });
  assert.equal(missing.status, 404);
  assert.equal(JSON.stringify(missing.body).includes('Prospect'), false);
  const replayHttp = await request(app).post('/api/internal/track/resolve').set({
    'x-track-timestamp': signed.timestamp,
    'x-track-nonce': signed.nonce,
    'x-track-signature': signed.signature,
  }).send({ code: 'not-a-real-code!!', request_id: 'request-http-1', site_origin: 'https://school.example' });
  assert.equal(replayHttp.status, 401);

  const tokenA = jwt.sign({ sub: IDS.userA, email: 'a@example.com' }, SECRET, { algorithm: 'HS256' });
  const tokenB = jwt.sign({ sub: IDS.userB, email: 'b@example.com' }, SECRET, { algorithm: 'HS256' });
  const tokenApprover = jwt.sign({ sub: IDS.userApprover, email: 'ap@example.com' }, SECRET, { algorithm: 'HS256' });
  const other = await request(app).get(`/api/super-admin/crm/track-links/${district.id}`).set('Authorization', `Bearer ${tokenB}`);
  assert.equal(other.status, 404);
  const approver = await request(app).post('/api/super-admin/crm/track-links').set('Authorization', `Bearer ${tokenApprover}`).send({ idempotency_key: 'approver-nope' });
  assert.equal(approver.status, 403);
  const anon = await request(app).get('/api/super-admin/crm/track-links');
  assert.equal(anon.status, 401);
  const ownerRead = await request(app).get(`/api/super-admin/crm/track-links/${district.id}`).set('Authorization', `Bearer ${tokenA}`);
  assert.equal(ownerRead.status, 200);
  const untracked = await request(app).post('/api/public/enquiries').send({
    name: 'Walk In',
    email: 'walkin@example.com',
    organization: 'Walk In School',
    message: 'Hello from the form',
    website_source: 'SCHOOL_ERP',
    product: 'SchoolIMS',
    campaign: 'typed-by-visitor',
  });
  assert.equal(untracked.status, 201);
  assert.equal(untracked.body.attribution, 'UNATTRIBUTED');
  const csv = reports.exportCsv({ groups: [{ campaign_name_snapshot: '=HYPERLINK("http://evil")', medium: 'QR', purpose: 'BROCHURE', raw_opens: 1 }], coverage: { external_conversion_coverage: 'unavailable' } });
  assert.equal(csv.includes(`"'=HYPERLINK`), true);
  const { parseSalesCommandQuery } = require('../../src/services/crm/salesCommandFilters');
  const parsed = parseSalesCommandQuery({ campaign_id: district.campaign_id, attribution_model: 'latest', distribution_medium: 'QR', mandal: 'chevella' }, platform);
  assert.equal(parsed.attributionModel, 'latest');
  assert.throws(() => parseSalesCommandQuery({ made_up: '1' }, platform), /Unsupported filter/);
});

async function prepLike(crmSql, revisionId) {
  await crmSql`UPDATE crm_track_link_revisions SET notes = 'mutated' WHERE id = ${revisionId}`;
}
