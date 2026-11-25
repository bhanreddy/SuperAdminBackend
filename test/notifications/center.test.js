const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
const postgres = require("postgres");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { migrate } = require("../../src/db/run-notification-migration");
const {
  createNotificationService,
} = require("../../src/services/notifications/service");
const {
  createNotificationWorker,
  retrySeconds,
} = require("../../src/services/notifications/worker");
const { ROLES, getEffectivePermissions } = require("../../src/config/rbac");
const { errorHandler } = require("../../src/middleware/errorHandler");
const secret = "notification-test-secret";
let db,
  socket,
  sql,
  service,
  worker,
  app,
  root,
  alice,
  bob,
  manager,
  ca,
  users = [];
const sent = [];
let sendError = null;
const providers = {
  capabilities: () => ({ email: true, sms: true, push: true }),
  send: async (job) => {
    if (sendError) throw sendError;
    sent.push(job);
  },
};
function mock(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
async function employee(role, name = role) {
  const [u] =
    await sql`INSERT INTO internal_users(full_name,email,employee_id,role,phone) VALUES(${name},${name + "@example.test"},${name},${role},'+919999999999') RETURNING *`;
  const [s] =
    await sql`INSERT INTO internal_user_sessions(user_id,refresh_token_hash,expires_at) VALUES(${u.id},${randomUUID()},now()+interval '1 day') RETURNING id`;
  const actor = {
    ...u,
    isFounder: ["FOUNDER", "SUPER_ADMIN"].includes(role),
    permissions: getEffectivePermissions(role),
    assignedSchoolIds: [],
    sessionId: s.id,
  };
  actor.token = jwt.sign(
    { sub: u.id, email: u.email, sid: s.id, tv: 0 },
    secret,
    {
      issuer: "nexsyrus-superadmin",
      audience: "nexsyrus-superadmin-app",
      expiresIn: 600,
    },
  );
  users.push(actor);
  return actor;
}
async function drain() {
  for (let n = 0; n < 100; n++) {
    if (!(await worker.fanout())) break;
  }
}
async function event(options = {}) {
  const [e] =
    await sql`INSERT INTO notification_events(source_key,channel,kind,title,audience,required_permission,school_id,priority)
 VALUES(${randomUUID()},${options.channel || "system"},'test','Private update',${sql.json(options.audience || { mode: "direct", user_ids: [alice.id] })},${options.permission || null},${options.school || null},${options.priority || "normal"}) RETURNING *`;
  return e;
}
const auth = (u) => ({ Authorization: "Bearer " + u.token });
const base = "/api/super-admin/notifications";
test.before(async () => {
  db = new PGlite();
  socket = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await socket.start();
  sql = postgres(
    `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`,
    { ssl: false, max: 1, onnotice: () => {} },
  );
  const schema = fs.readFileSync(
    path.join(__dirname, "../../src/db/migrations/001_create_rbac_tables.sql"),
    "utf8",
  );
  await sql.unsafe(
    schema.slice(
      schema.indexOf("CREATE TABLE IF NOT EXISTS internal_users"),
      schema.indexOf("-- 5. School Requirements"),
    ),
  );
  await sql`ALTER TABLE internal_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false`;
  await sql`CREATE TABLE founders(id uuid PRIMARY KEY,user_id uuid)`;
  await sql`CREATE TABLE notifications(id uuid PRIMARY KEY,user_id uuid,founder_id uuid,title text,body text,read_at timestamptz,created_at timestamptz DEFAULT now())`;
  await sql`CREATE TABLE school_requirements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id int,status text,priority text,raised_by uuid,assigned_to uuid)`;
  await sql`CREATE TABLE complaints(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id int,status text,priority text,raised_by uuid,assigned_to uuid)`;
  await sql`CREATE TABLE school_onboarding_checklists(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id int,status text,assigned_to uuid)`;
  await sql`CREATE TABLE collaboration_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,kind text,read_at timestamptz)`;
  await sql`CREATE TABLE audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,action text,entity text,entity_id text,details jsonb,school_id int,created_at timestamptz)`;
  for (const role of Object.values(ROLES)) await employee(role);
  root = users.find((u) => u.role === "FOUNDER");
  alice = users.find((u) => u.role === "IMPLEMENTATION_EXECUTIVE");
  bob = users.find((u) => u.role === "SALES_EXECUTIVE");
  manager = users.find((u) => u.role === "IMPLEMENTATION_MANAGER");
  ca = users.find((u) => u.role === "CA");
  await sql`UPDATE internal_users SET manager_id=${manager.id} WHERE id=${alice.id}`;
  await sql`INSERT INTO internal_user_schools(user_id,school_id) VALUES(${alice.id},101),(${bob.id},202)`;
  alice.assignedSchoolIds = [101];
  bob.assignedSchoolIds = [202];
  manager.assignedSchoolIds = [101];
  await migrate(sql);
  await migrate(sql);
  service = createNotificationService(sql, providers.capabilities);
  worker = createNotificationWorker(sql, providers);
  process.env.SUPERADMIN_JWT_SECRET = secret;
  mock("../../src/config/db", sql);
  mock("../../src/config/env", { schoolSupabase: { jwtSecret: secret } });
  mock("../../src/config/supabase", {
    schoolSupabaseAdmin: {
      auth: { getUser: async () => ({ error: new Error("Invalid") }) },
    },
  });
  const { authenticateUser } = require("../../src/middleware/rbac");
  const {
    createNotificationRouter,
  } = require("../../src/services/notifications/router");
  app = express();
  app.use(express.json());
  app.use(
    base,
    createNotificationRouter({ service, authenticate: authenticateUser }),
  );
  app.use(errorHandler);
});
test.after(async () => {
  if (sql) await sql.end({ timeout: 2 });
  if (socket) await socket.stop();
  if (db) await db.close();
});
test.beforeEach(async () => {
  sendError = null;
  sent.length = 0;
});

test("all 16 active roles receive independent inboxes; authentication and CA password boundaries remain enforced", async () => {
  await service.publish(
    root,
    { title: "Company update", body: "For all employees" },
    randomUUID(),
  );
  await drain();
  for (const u of users) {
    const res = await request(app).get(base).set(auth(u));
    assert.equal(res.status, 200, res.text);
    assert.ok(
      res.body.data.some((n) => n.title === "Company update"),
      u.role,
    );
  }
  assert.equal((await request(app).get(base)).status, 401);
  assert.equal(
    (await request(app).get(base).set("Authorization", "Bearer forged")).status,
    401,
  );
  await sql`UPDATE internal_users SET must_change_password=true WHERE id=${ca.id}`;
  assert.equal((await request(app).get(base).set(auth(ca))).status, 403);
  await sql`UPDATE internal_users SET must_change_password=false WHERE id=${ca.id}`;
});
test("role announcements are idempotent; payload mismatch and non-founder publishing are rejected", async () => {
  const key = randomUUID();
  const body = {
    title: "Sales update",
    body: "Sales team only",
    roles: ["SALES_EXECUTIVE"],
  };
  const first = await service.publish(root, body, key);
  const second = await service.publish(root, body, key);
  assert.equal(first.id, second.id);
  await assert.rejects(
    service.publish(root, { ...body, title: "Changed" }, key),
    { status: 409 },
  );
  await assert.rejects(service.publish(bob, body, randomUUID()), {
    status: 403,
  });
  await drain();
  assert.ok(
    (await service.list(bob)).data.some((n) => n.event_id === first.id),
  );
  assert.ok(
    !(await service.list(alice)).data.some((n) => n.event_id === first.id),
  );
});
test("transactional source capture rolls back with business data; updates produce one event without raw customer content", async () => {
  const [before] =
    await sql`SELECT count(*)::int AS n FROM notification_events`;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`INSERT INTO complaints(school_id,status,raised_by) VALUES(101,'OPEN',${alice.id})`;
      throw new Error("rollback");
    }),
  );
  const [after] = await sql`SELECT count(*)::int AS n FROM notification_events`;
  assert.equal(after.n, before.n);
  const [ticket] =
    await sql`INSERT INTO complaints(school_id,status,raised_by,assigned_to) VALUES(101,'OPEN',${alice.id},${alice.id}) RETURNING id`;
  await sql`UPDATE complaints SET status='ESCALATED' WHERE id=${ticket.id}`;
  await drain();
  const inbox = (await service.list(alice)).data.filter((n) =>
    n.kind.startsWith("complaints."),
  );
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].body, "");
  assert.equal(
    inbox.find((n) => n.kind === "complaints.update").priority,
    "high",
  );
  assert.ok(
    !(await service.list(bob)).data.some((n) =>
      n.kind.startsWith("complaints."),
    ),
  );
});
test("school routing includes current manager scope, excludes other schools, and rechecks permission overrides on read", async () => {
  await sql`INSERT INTO school_onboarding_checklists(school_id,status,assigned_to) VALUES(101,'BLOCKED',${alice.id})`;
  await drain();
  const row = (await service.list(alice)).data.find(
    (n) => n.channel === "assignments",
  );
  assert.ok(row);
  assert.ok(
    (await service.list(manager)).data.some((n) => n.event_id === row.event_id),
  );
  assert.ok(
    !(await service.list(bob)).data.some((n) => n.event_id === row.event_id),
  );
  assert.equal(
    (
      await request(app)
        .patch(`${base}/${row.id}`)
        .set(auth(bob))
        .send({ operation: "read" })
    ).status,
    404,
  );
  await sql`INSERT INTO internal_user_permission_overrides(user_id,permission,effect) VALUES(${alice.id},'checklist.read','DENY')`;
  const res = await request(app).get(base).set(auth(alice));
  assert.ok(!res.body.data.some((n) => n.id === row.id));
  await sql`DELETE FROM internal_user_permission_overrides WHERE user_id=${alice.id}`;
  await sql`DELETE FROM internal_user_schools WHERE user_id=${alice.id} AND school_id=101`;
  const revoked = await request(app).get(base).set(auth(alice));
  assert.ok(!revoked.body.data.some((n) => n.id === row.id));
  await sql`INSERT INTO internal_user_schools(user_id,school_id) VALUES(${alice.id},101)`;
});
test("keyset pagination preserves tied microsecond timestamps without gaps or duplicates", async () => {
  const e = await event();
  await drain();
  const targets = [];
  for (let i = 0; i < 6; i++) {
    const x = await event();
    targets.push(x.id);
  }
  await drain();
  await sql`UPDATE notification_inbox SET created_at='2028-01-01 00:00:00.123456+00' WHERE event_id=ANY(${sql.array(targets)}::uuid[])`;
  let next,
    ids = [];
  do {
    const page = await service.list(alice, { limit: 2, before: next });
    ids.push(
      ...page.data.filter((r) => targets.includes(r.event_id)).map((r) => r.id),
    );
    next = page.next_cursor;
  } while (next);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  await assert.rejects(service.list(alice, { before: "invalid" }), {
    status: 400,
  });
});
test("mark-all uses a watermark and never changes another user; archive and read operations are idempotent", async () => {
  const e = await event();
  await drain();
  const n = (await service.list(alice)).data.find((x) => x.event_id === e.id);
  await service.update(alice, n.id, "read");
  await service.update(alice, n.id, "read");
  await service.update(alice, n.id, "unread");
  const later = await event();
  await drain();
  await service.readAll(alice, { through: n.created_at });
  const page = await service.list(alice);
  assert.ok(page.data.find((x) => x.event_id === later.id).read_at === null);
  await service.update(alice, n.id, "archive");
  await service.update(alice, n.id, "archive");
  assert.ok(!(await service.list(alice)).data.some((x) => x.id === n.id));
  await assert.rejects(service.update(bob, n.id, "read"), { status: 404 });
});
test("channel preferences suppress inbox only, preserve mandatory security and require configured providers", async () => {
  await service.setPreferences(alice, "system", {
    inbox_enabled: false,
    email_enabled: true,
  });
  const e = await event();
  await drain();
  assert.ok(!(await service.list(alice)).data.some((x) => x.event_id === e.id));
  const deliveries =
    await sql`SELECT d.* FROM notification_deliveries d JOIN notification_inbox n ON n.id=d.inbox_id WHERE n.event_id=${e.id}`;
  assert.equal(deliveries.length, 1);
  await assert.rejects(
    service.setPreferences(alice, "security", { inbox_enabled: false }),
    { status: 400 },
  );
  const unconfigured = createNotificationService(sql);
  await assert.rejects(
    unconfigured.setPreferences(alice, "system", { email_enabled: true }),
    { status: 409 },
  );
  await assert.rejects(
    service.setPreferences(alice, "system", { email_enabled: "true" }),
    { status: 400 },
  );
  await service.setPreferences(alice, "system", { inbox_enabled: true });
});
test("queued delivery rechecks opt-outs and account suspension; claim leases recover without duplicate claims", async () => {
  await service.setPreferences(alice, "system", { email_enabled: true });
  const e = await event();
  await drain();
  const jobs =
    await sql`SELECT d.* FROM notification_deliveries d JOIN notification_inbox n ON n.id=d.inbox_id WHERE n.event_id=${e.id}`;
  assert.equal(jobs.length, 1);
  await sql`UPDATE notification_deliveries SET available_at=now()+interval '1 day' WHERE id<>${jobs[0].id}`;
  const job = await worker.claim();
  assert.equal(job.id, jobs[0].id);
  assert.equal(await worker.claim(), undefined);
  await sql`UPDATE notification_deliveries SET lease_until=now()-interval '1 second' WHERE id=${job.id}`;
  const replacement = await worker.claim();
  assert.equal(replacement.id, job.id);
  assert.notEqual(replacement.lease_token, job.lease_token);
  await service.setPreferences(alice, "system", { email_enabled: false });
  await worker.deliver(replacement);
  const [skipped] =
    await sql`SELECT state FROM notification_deliveries WHERE id=${job.id}`;
  assert.equal(skipped.state, "skipped");
  assert.equal(sent.length, 0);
});
test("provider failures back off, exhaust to dead letters, and can be retried by a founder", async () => {
  await service.setPreferences(alice, "system", { email_enabled: true });
  const e = await event();
  await drain();
  await sql`UPDATE notification_deliveries SET available_at=now()+interval '1 day' WHERE inbox_id NOT IN(SELECT id FROM notification_inbox WHERE event_id=${e.id})`;
  let job = await worker.claim();
  sendError = Object.assign(new Error("PROVIDER_TIMEOUT"), {
    permanent: false,
  });
  await worker.deliver(job);
  let [state] =
    await sql`SELECT state,available_at>now() AS delayed FROM notification_deliveries WHERE id=${job.id}`;
  assert.equal(state.state, "pending");
  assert.ok(state.delayed);
  await sql`UPDATE notification_deliveries SET attempts=7,available_at=now() WHERE id=${job.id}`;
  job = await worker.claim();
  await worker.deliver(job);
  [state] =
    await sql`SELECT state FROM notification_deliveries WHERE id=${job.id}`;
  assert.equal(state.state, "dead");
  await assert.rejects(service.retry(bob, job.id), { status: 403 });
  await service.retry(root, job.id);
  sendError = null;
  await worker.deliver(await worker.claim());
  assert.equal(sent.length, 1);
  assert.ok(retrySeconds(8, () => 0) > retrySeconds(1, () => 0));
});
test("device registration is session-bound; stale FCM tokens are removed without deleting delivery evidence", async () => {
  const token = "valid-fcm-token-" + randomUUID();
  const device = await service.registerDevice(alice, {
    token,
    platform: "android",
  });
  await assert.rejects(
    service.registerDevice(bob, { token, platform: "android" }),
    { status: 409 },
  );
  await service.setPreferences(alice, "security", { push_enabled: true });
  const e = await event({ channel: "security" });
  await drain();
  const [job] =
    await sql`SELECT d.* FROM notification_deliveries d JOIN notification_inbox n ON n.id=d.inbox_id WHERE n.event_id=${e.id}`;
  await sql`UPDATE notification_deliveries SET available_at=now()+interval '1 day' WHERE id<>${job.id}`;
  const claimed = await worker.claim();
  sendError = Object.assign(new Error("PROVIDER_HTTP_404_UNREGISTERED"), {
    permanent: true,
    invalidToken: true,
  });
  await worker.deliver(claimed);
  assert.equal(
    (await sql`SELECT id FROM notification_devices WHERE id=${device.id}`)
      .length,
    0,
  );
  const [dead] =
    await sql`SELECT state,device_id FROM notification_deliveries WHERE id=${job.id}`;
  assert.equal(dead.state, "dead");
  assert.equal(dead.device_id, null);
});
test("Connect and legacy targeted notifications join the shared inbox without exposing message bodies or other recipients", async () => {
  await sql`INSERT INTO collaboration_notifications(user_id,kind) VALUES(${ca.id},'mention')`;
  await sql`INSERT INTO notifications(id,user_id,title,body) VALUES(${randomUUID()},${bob.id},'Field feedback','Assigned feedback')`;
  await drain();
  assert.ok(
    (await service.list(ca)).data.some(
      (n) =>
        n.channel === "connect" &&
        n.title === "You were mentioned" &&
        n.body === "",
    ),
  );
  assert.ok(
    (await service.list(bob)).data.some((n) => n.title === "Field feedback"),
  );
  assert.ok(
    !(await service.list(alice)).data.some((n) => n.title === "Field feedback"),
  );
});
test("migration backfills addressed legacy notices when founder_id is absent", async () => {
  const legacy = new PGlite();
  try {
    await legacy.exec(`
      CREATE TABLE internal_users (id uuid PRIMARY KEY, auth_user_id uuid);
      CREATE TABLE internal_user_sessions (id uuid PRIMARY KEY);
      CREATE TABLE internal_user_schools (user_id uuid);
      CREATE TABLE founders (id uuid PRIMARY KEY, user_id uuid);
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text,
        body text, read_at timestamptz, created_at timestamptz DEFAULT now()
      );
      INSERT INTO internal_users VALUES
        ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001'),
        ('10000000-0000-0000-0000-000000000002', NULL);
      INSERT INTO notifications (user_id,title,read_at) VALUES
        ('20000000-0000-0000-0000-000000000001', 'Addressed notice', now()),
        (NULL, 'Global notice', NULL);
    `);
    await legacy.exec(fs.readFileSync(
      path.join(__dirname, "../../src/db/migrations/34_notification_center.sql"),
      "utf8",
    ));
    const { rows } = await legacy.query(`
      SELECT event.title, inbox.user_id, inbox.read_at IS NOT NULL AS was_read
      FROM notification_inbox inbox JOIN notification_events event ON event.id=inbox.event_id
    `);
    assert.deepEqual(rows, [{
      title: "Addressed notice",
      user_id: "10000000-0000-0000-0000-000000000001",
      was_read: true,
    }]);
  } finally {
    await legacy.close();
  }
});
test("one poisoned fanout cannot block later events; retries roll back partial recipients and dead-letter after eight attempts", async () => {
  const poison = await event();
  const healthy = await event();
  await sql.unsafe(
    `ALTER TABLE notification_inbox ADD CONSTRAINT notification_test_poison CHECK(event_id<>'${poison.id}'::uuid) NOT VALID`,
  );
  try {
    await drain();
    let [failed] =
      await sql`SELECT attempts,processed_at,dead_at FROM notification_events WHERE id=${poison.id}`;
    assert.equal(failed.attempts, 1);
    assert.equal(failed.processed_at, null);
    assert.equal(
      (await sql`SELECT id FROM notification_inbox WHERE event_id=${poison.id}`)
        .length,
      0,
    );
    assert.ok(
      (await service.list(alice)).data.some((n) => n.event_id === healthy.id),
    );
    await sql`UPDATE notification_events SET attempts=7,available_at=now() WHERE id=${poison.id}`;
    await drain();
    [failed] =
      await sql`SELECT dead_at FROM notification_events WHERE id=${poison.id}`;
    assert.ok(failed.dead_at);
  } finally {
    await sql`ALTER TABLE notification_inbox DROP CONSTRAINT notification_test_poison`;
  }
  await service.retryEvent(root, poison.id);
  await drain();
  assert.equal(
    (await sql`SELECT id FROM notification_inbox WHERE event_id=${poison.id}`)
      .length,
    1,
  );
});
test("suspended users and revoked push sessions cannot receive queued external notifications", async () => {
  await service.setPreferences(alice, "system", { email_enabled: true });
  const e = await event();
  await drain();
  const [j] =
    await sql`SELECT d.* FROM notification_deliveries d JOIN notification_inbox n ON n.id=d.inbox_id WHERE n.event_id=${e.id}`;
  await sql`UPDATE internal_users SET status='SUSPENDED' WHERE id=${alice.id}`;
  await sql`UPDATE notification_deliveries SET state='processing',lease_token=${randomUUID()},lease_until=now()+interval '1 minute' WHERE id=${j.id}`;
  const [leased] =
    await sql`SELECT * FROM notification_deliveries WHERE id=${j.id}`;
  await worker.deliver(leased);
  assert.equal(sent.length, 0);
  assert.equal((await request(app).get(base).set(auth(alice))).status, 401);
  await sql`UPDATE internal_users SET status='ACTIVE' WHERE id=${alice.id}`;
  const device = await service.registerDevice(alice, {
    token: "another-fcm-token-" + randomUUID(),
    platform: "ios",
  });
  const push = await event({ channel: "security" });
  await drain();
  const [p] =
    await sql`SELECT d.* FROM notification_deliveries d JOIN notification_inbox n ON n.id=d.inbox_id WHERE n.event_id=${push.id}`;
  await sql`UPDATE internal_user_sessions SET revoked_at=now() WHERE id=${alice.sessionId}`;
  await sql`UPDATE notification_deliveries SET state='processing',lease_token=${randomUUID()},lease_until=now()+interval '1 minute' WHERE id=${p.id}`;
  const [leasedPush] =
    await sql`SELECT * FROM notification_deliveries WHERE id=${p.id}`;
  await worker.deliver(leasedPush);
  assert.equal(sent.length, 0);
  await sql`UPDATE internal_user_sessions SET revoked_at=NULL WHERE id=${alice.sessionId}`;
});
test("CRM outbox crosses databases idempotently and never acknowledges a failed target insert", async () => {
  const crmDb = new PGlite();
  const crmSocket = new PGLiteSocketServer({
    db: crmDb,
    host: "127.0.0.1",
    port: 0,
  });
  await crmSocket.start();
  const crm = postgres(
    `postgres://postgres:postgres@127.0.0.1:${crmSocket.server.address().port}/postgres`,
    { ssl: false, max: 1, onnotice: () => {} },
  );
  try {
    await crm`CREATE TABLE enquiries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,assigned_user_id uuid,name text)`;
    await migrate(crm, "35_notification_crm_outbox.sql");
    await migrate(crm, "35_notification_crm_outbox.sql");
    const [lead] =
      await crm`INSERT INTO enquiries(status,assigned_user_id,name) VALUES('NEW',${bob.id},'Private customer name') RETURNING id`;
    let fail = true;
    const target = (strings, ...values) => {
      if (fail && strings[0].includes("INSERT INTO notification_events"))
        throw new Error("target down");
      return sql(strings, ...values);
    };
    target.array = sql.array;
    target.json = sql.json;
    const bridge =
      require("../../src/services/notifications/crmBridge").createCrmNotificationBridge(
        target,
        crm,
      );
    await assert.rejects(bridge());
    assert.equal(
      (await crm`SELECT copied_at FROM crm_notification_outbox`)[0].copied_at,
      null,
    );
    fail = false;
    assert.equal(await bridge(), 1);
    assert.equal(await bridge(), 0);
    await drain();
    const notices = (await service.list(bob, { channel: "sales" })).data.filter(
      (n) => n.kind === "enquiries.insert",
    );
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, "Enquiry created");
    assert.ok(!JSON.stringify(notices).includes("Private customer"));
  } finally {
    await crm.end({ timeout: 2 });
    await crmSocket.stop();
    await crmDb.close();
  }
});
test("Expo acceptance waits for a receipt; delayed receipts do not resend and successful receipts finish delivery", async () => {
  let confirmed = false;
  let sends = 0;
  const expo = {
    capabilities: providers.capabilities,
    send: async () => {
      sends++;
      return { receipt_id: "expo-ticket" };
    },
    receipt: async () => confirmed,
  };
  const nativeWorker = createNotificationWorker(sql, expo);
  await service.setPreferences(alice, "system", { email_enabled: true });
  const e = await event();
  await drain();
  const [job] =
    await sql`SELECT d.* FROM notification_deliveries d JOIN notification_inbox n ON n.id=d.inbox_id WHERE n.event_id=${e.id}`;
  await sql`UPDATE notification_deliveries SET available_at=now()+interval '1 day' WHERE id<>${job.id}`;
  await nativeWorker.deliver(await nativeWorker.claim());
  assert.equal(
    (await sql`SELECT state FROM notification_deliveries WHERE id=${job.id}`)[0]
      .state,
    "awaiting_receipt",
  );
  await sql`UPDATE notification_deliveries SET available_at=now() WHERE id=${job.id}`;
  await nativeWorker.checkReceipts();
  assert.equal(sends, 1);
  confirmed = true;
  await sql`UPDATE notification_deliveries SET available_at=now() WHERE id=${job.id}`;
  await nativeWorker.checkReceipts();
  assert.equal(
    (await sql`SELECT state FROM notification_deliveries WHERE id=${job.id}`)[0]
      .state,
    "sent",
  );
  assert.equal(sends, 1);
});

test("device token rotation replaces the prior session token; status and disabling stay session-scoped", async () => {
  await service.registerDevice(alice, {
    token: "rotated-token-" + randomUUID(),
    platform: "android",
  });
  await service.registerDevice(alice, {
    token: "rotated-token-" + randomUUID(),
    platform: "android",
  });
  assert.equal(
    (
      await sql`SELECT id FROM notification_devices WHERE session_id=${alice.sessionId}`
    ).length,
    1,
  );
  assert.equal((await service.deviceStatus(alice)).enabled, true);
  assert.equal(
    (
      await request(app)
        .get(base + "/devices/current")
        .set(auth(alice))
    ).body.data.enabled,
    true,
  );
  await service.registerDevice(bob, {
    token: "another-user-token-" + randomUUID(),
    platform: "android",
  });
  assert.equal(
    (
      await request(app)
        .delete(base + "/devices/current")
        .set(auth(alice))
    ).status,
    200,
  );
  assert.equal((await service.deviceStatus(alice)).enabled, false);
  assert.equal((await service.deviceStatus(bob)).enabled, true);
});

test("Connect read state is mirrored in both directions, including reads before fanout", async () => {
  const [source] =
    await sql`INSERT INTO collaboration_notifications(user_id,kind) VALUES(${ca.id},'dm') RETURNING id`;
  await sql`UPDATE collaboration_notifications SET read_at=now() WHERE id=${source.id}`;
  await drain();
  const [inbox] =
    await sql`SELECT n.id,n.read_at FROM notification_inbox n JOIN notification_events e ON e.id=n.event_id WHERE n.user_id=${ca.id} AND e.source_key=${"public.collaboration_notifications:" + source.id + ":insert"}`;
  assert.ok(inbox.read_at);
  await service.update(ca, inbox.id, "unread");
  assert.equal(
    (
      await sql`SELECT read_at FROM collaboration_notifications WHERE id=${source.id}`
    )[0].read_at,
    null,
  );
  await sql`UPDATE collaboration_notifications SET read_at=now() WHERE id=${source.id}`;
  assert.ok(
    (await sql`SELECT read_at FROM notification_inbox WHERE id=${inbox.id}`)[0]
      .read_at,
  );
});
