const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createConnectService } = require('../../src/services/connect/service');
const { createConnectRouter } = require('../../src/services/connect/router');
const {
  createConnectExtensions,
} = require('../../src/services/connect/extensions');
const { validateFile } = require('../../src/services/connect/files');
const { migrate } = require('../../src/db/run-connect-migration');
let db,
  socket,
  sql,
  service,
  extras,
  app,
  root,
  alice,
  bob,
  outsider,
  ca,
  channel,
  privateChannel,
  dm;
const stored = new Map();
const secret = 'local-connect-tests-only-secret';
function mock(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const send = (user, conv, body = 'Hello', extra = {}) =>
  service.send(user, conv, { client_id: randomUUID(), body, ...extra });
async function employee(name, role = 'QA', status = 'ACTIVE') {
  const [u] =
    await sql`INSERT INTO internal_users(full_name,email,employee_id,role,status) VALUES(${name},${name + '@example.test'},${name},${role},${status}) RETURNING *`;
  const [s] =
    await sql`INSERT INTO internal_user_sessions(user_id,refresh_token_hash,expires_at) VALUES(${u.id},${randomUUID()},now()+interval '1 day') RETURNING id`;
  return {
    ...u,
    sessionId: s.id,
    token: jwt.sign({ sub: u.id, email: u.email, sid: s.id, tv: 0 }, secret, {
      issuer: 'nexsyrus-superadmin',
      audience: 'nexsyrus-superadmin-app',
      expiresIn: 600,
    }),
  };
}
async function rawAs(user, fn) {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE collaboration_api`;
    await tx`SELECT set_config('connect.actor',${user.id},true)`;
    return fn(tx);
  });
}
test.before(async () => {
  db = new PGlite();
  socket = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 8,
  });
  await socket.start();
  sql = postgres(
    `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`,
    { ssl: false, max: 3, onnotice: () => {} },
  );
  const schema = fs.readFileSync(
    path.join(__dirname, '../../src/db/migrations/001_create_rbac_tables.sql'),
    'utf8',
  );
  await sql.unsafe(
    schema.slice(
      schema.indexOf('CREATE TABLE IF NOT EXISTS internal_users'),
      schema.indexOf('-- 5. School Requirements'),
    ),
  );
  await sql`ALTER TABLE internal_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`;
  await sql`CREATE TABLE audit_logs(user_id uuid,action text,entity text,entity_id text,details jsonb,created_at timestamptz)`;
  await sql`CREATE TABLE schools(id integer PRIMARY KEY,name text)`;
  await sql.unsafe(
    schema.slice(
      schema.indexOf('-- 6. School Onboarding Checklists'),
      schema.indexOf('-- 7. Support Ticket Notes'),
    ),
  );
  await sql.unsafe(
    fs.readFileSync(
      path.join(
        __dirname,
        '../../src/db/migrations/23_operational_delegation.sql',
      ),
      'utf8',
    ),
  );
  await sql`INSERT INTO schools(id,name) VALUES(101,'School A'),(202,'School B')`;
  await sql.unsafe(
    'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE authenticator NOLOGIN;',
  );
  root = await employee('founder', 'FOUNDER');
  alice = await employee('alice');
  bob = await employee('bob');
  ca = await employee('ca', 'CA');
  await migrate(sql);
  outsider = await employee('external');
  await sql`DELETE FROM collaboration_organization_members WHERE user_id=${outsider.id}`;
  const [otherOrg] =
    await sql`INSERT INTO collaboration_organizations(code,name) VALUES('other','Other company') RETURNING id`;
  await sql`INSERT INTO collaboration_organization_members(organization_id,user_id) VALUES(${otherOrg.id},${outsider.id})`;
  service = createConnectService(sql);
  extras = createConnectExtensions(service, {
    put: async (k, bytes) => stored.set(k, bytes),
    get: async (k) => stored.get(k),
    remove: async (k) => stored.delete(k),
  });
  process.env.SUPERADMIN_JWT_SECRET = secret;
  mock('../../src/config/db', sql);
  mock('../../src/config/env', { schoolSupabase: { jwtSecret: secret } });
  mock('../../src/config/supabase', {
    schoolSupabaseAdmin: {
      auth: { getUser: async () => ({ error: new Error('Invalid') }) },
    },
  });
  const { authenticateUser } = require('../../src/middleware/rbac');
  app = express();
  app.use(express.json());
  app.use(
    '/api/super-admin/connect',
    createConnectRouter({
      service,
      authenticate: authenticateUser,
      extensions: extras,
    }),
  );
  channel = await service.createChannel(root, {
    name: 'general',
    purpose: 'Company updates',
  });
  await service.membership(root, channel.id, alice.id);
  await service.membership(root, channel.id, bob.id);
  privateChannel = await service.createChannel(root, {
    name: 'founders',
    visibility: 'private',
  });
});
test.after(async () => {
  if (sql) await sql.end({ timeout: 3 });
  if (socket) await socket.stop();
  if (db) await db.close();
});

test('M1 actual employee JWT authentication rejects missing, forged, revoked, suspended and foreign-company identities', async () => {
  const url = '/api/super-admin/connect/bootstrap';
  assert.equal((await request(app).get(url)).status, 401);
  assert.equal(
    (await request(app).get(url).set('Authorization', 'Bearer invalid')).status,
    401,
  );
  const expired = jwt.sign(
    { sub: alice.id, email: alice.email, sid: alice.sessionId, tv: 0 },
    secret,
    {
      issuer: 'nexsyrus-superadmin',
      audience: 'nexsyrus-superadmin-app',
      expiresIn: -1,
    },
  );
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + expired)
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + alice.token)
    ).status,
    200,
  );
  const schoolToken = jwt.sign({ sub: alice.id, email: alice.email }, secret, {
    expiresIn: 60,
  });
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + schoolToken)
    ).status,
    403,
    'legacy/school Supabase tokens cannot enter Connect even with a matching employee email',
  );
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + ca.token)
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + outsider.token)
    ).status,
    403,
  );
  await sql`UPDATE internal_users SET status='SUSPENDED' WHERE id=${alice.id}`;
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + alice.token)
    ).status,
    401,
  );
  await sql`UPDATE internal_users SET status='ACTIVE' WHERE id=${alice.id}`;
  await sql`UPDATE internal_user_sessions SET revoked_at=now() WHERE id=${bob.sessionId}`;
  assert.equal(
    (
      await request(app)
        .get(url)
        .set('Authorization', 'Bearer ' + bob.token)
    ).status,
    401,
  );
  await sql`UPDATE internal_user_sessions SET revoked_at=NULL WHERE id=${bob.sessionId}`;
});
test('M1 channels require company admins; private metadata and history are hidden from nonmembers', async () => {
  await assert.rejects(
    service.createChannel(alice, { name: 'unauthorized' }),
    (e) => e.status === 403,
  );
  assert.equal(
    (await service.bootstrap(alice)).channels.some(
      (c) => c.id === privateChannel.id,
    ),
    false,
  );
  await assert.rejects(
    service.history(alice, privateChannel.id),
    (e) => e.status === 404,
  );
  await assert.rejects(
    service.membership(alice, privateChannel.id, alice.id),
    (e) => e.status === 404,
  );
  await assert.rejects(
    service.membership(alice, channel.id, bob.id, 'manager'),
    (e) => e.status === 403,
  );
  await assert.rejects(
    service.history(outsider, channel.id),
    (e) => e.status === 403,
  );
});
test('M1 public join is idempotent; channel names, company identity and manager permissions are constrained', async () => {
  const publicChannel = await service.createChannel(root, {
    name: 'project-alpha',
    category: 'project',
  });
  await service.membership(alice, publicChannel.id, alice.id);
  await service.membership(alice, publicChannel.id, alice.id);
  assert.equal(
    (await service.members(alice, publicChannel.id)).filter(
      (m) => m.user_id === alice.id,
    ).length,
    1,
  );
  await assert.rejects(
    service.membership(root, publicChannel.id, root.id, 'member', true),
    /another channel manager/,
  );
  await assert.rejects(service.createChannel(root, { name: 'x' }));
  await assert.rejects(
    service.createChannel(root, { name: 'general' }),
    (e) => e.code === '23505',
  );
});
test('M1 send retry and concurrent sends produce unique ordered durable messages, including identical text', async () => {
  const key = randomUUID();
  const [a, b] = await Promise.all([
    send(alice, channel.id, 'Repeated', { client_id: key }),
    send(alice, channel.id, 'Repeated', { client_id: key }),
  ]);
  assert.equal(a.id, b.id);
  const rows = await Promise.all([
    send(alice, channel.id, 'Same'),
    send(bob, channel.id, 'Same'),
    send(alice, channel.id, 'Same'),
  ]);
  assert.equal(new Set(rows.map((r) => r.sequence)).size, 3);
  const h = await service.history(bob, channel.id);
  assert.equal(new Set(h.messages.map((m) => m.id)).size, h.messages.length);
  const page = await service.history(alice, channel.id, { limit: 2 });
  assert.equal(page.messages.length, 2);
  assert.equal(page.has_more, true);
  const older = await service.history(alice, channel.id, {
    before: page.messages[0].sequence,
    limit: 2,
  });
  assert.ok(
    older.messages.every(
      (m) => Number(m.sequence) < Number(page.messages[0].sequence),
    ),
  );
});
test('M1 edits/deletes enforce author, audited tombstones and immutable identities at SQL level', async () => {
  const m = await send(alice, channel.id, 'Original');
  await assert.rejects(
    service.edit(bob, m.id, { body: 'Stolen' }),
    (e) => e.status === 403,
  );
  assert.equal(
    (await service.edit(alice, m.id, { body: 'Corrected' })).body,
    'Corrected',
  );
  await assert.rejects(
    rawAs(
      alice,
      (tx) =>
        tx`UPDATE collaboration_messages SET sender_id=${bob.id} WHERE id=${m.id}`,
    ),
  );
  const deleted = await service.edit(alice, m.id, {}, true);
  assert.equal(deleted.body, '');
  assert.ok(deleted.deleted_at);
  await assert.rejects(
    service.edit(alice, m.id, { body: 'Restore' }),
    (e) => e.status === 409,
  );
  assert.equal(
    (await sql`SELECT action FROM audit_logs WHERE entity_id=${m.id}`).length,
    2,
  );
  assert.equal(
    JSON.stringify(
      await sql`SELECT details FROM audit_logs WHERE entity_id=${m.id}`,
    ).includes('Corrected'),
    false,
  );
});
test('M1 database RLS rejects direct cross-user reads/writes even if API checks are omitted', async () => {
  const hidden = await send(root, privateChannel.id, 'Confidential founders');
  assert.equal(
    (
      await rawAs(
        alice,
        (tx) => tx`SELECT * FROM collaboration_messages WHERE id=${hidden.id}`,
      )
    ).length,
    0,
  );
  await assert.rejects(
    rawAs(
      alice,
      (tx) =>
        tx`INSERT INTO collaboration_messages(conversation_id,sender_id,client_id,sequence,body) VALUES(${privateChannel.id},${alice.id},${randomUUID()},999,'intrusion')`,
    ),
    (e) => e.code === '42501',
  );
  assert.equal(
    (
      await rawAs(
        alice,
        (tx) =>
          tx`UPDATE collaboration_messages SET body='intrusion' WHERE id=${hidden.id} RETURNING id`,
      )
    ).length,
    0,
  );
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE authenticated`;
      return tx`SELECT * FROM collaboration_messages`;
    }),
    (e) => e.code === '42501',
  );
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE anon`;
      return tx`SELECT * FROM collaboration_messages`;
    }),
    (e) => e.code === '42501',
  );
});
test('M1 archived and announcement-only channels enforce posting at API and RLS layers', async () => {
  const c = await service.createChannel(root, {
    name: 'announcements',
    announcements_only: true,
  });
  await service.membership(root, c.id, alice.id);
  await send(root, c.id, 'Announcement');
  await assert.rejects(send(alice, c.id, 'Denied'), (e) => e.status === 403);
  await service.updateChannel(root, c.id, { archived: true });
  await assert.rejects(send(root, c.id, 'Archived'), (e) => e.status === 403);
  assert.equal((await service.history(root, c.id)).messages.length, 1);
});
test('M2 threads preserve parent, count replies and reject cross-channel or nested parents', async () => {
  const parent = await send(alice, channel.id, 'Parent');
  const reply = await send(bob, channel.id, 'Reply', { parent_id: parent.id });
  assert.equal(reply.parent_id, parent.id);
  assert.equal((await service.getMessage(alice, parent.id)).reply_count, 1);
  assert.equal(
    (await service.history(alice, channel.id, { parent: parent.id }))
      .messages[0].id,
    reply.id,
  );
  await assert.rejects(
    send(alice, channel.id, 'Nested', { parent_id: reply.id }),
    (e) => e.code === '23514',
  );
  await assert.rejects(
    send(root, privateChannel.id, 'Cross', { parent_id: parent.id }),
    (e) => ['23503', '23514'].includes(e.code),
  );
});
test('M2 reactions are unique, removable and cannot be injected into private or deleted messages', async () => {
  const m = await send(alice, channel.id, 'React');
  await service.react(bob, m.id, '👍');
  await service.react(bob, m.id, '👍');
  assert.equal((await service.getMessage(alice, m.id)).reactions.length, 1);
  await service.react(bob, m.id, '👍', true);
  assert.equal((await service.getMessage(alice, m.id)).reactions.length, 0);
  await assert.rejects(service.react(bob, m.id, '<script>'));
  const hidden = await send(root, privateChannel.id, 'hidden');
  await assert.rejects(
    service.react(bob, hidden.id, '👍'),
    (e) => e.status === 404,
  );
});
test('M2 mentions validate recipients and deduplicate notification fanout across retries, edits, DM/thread overlap', async () => {
  const m = await send(alice, channel.id, '@bob look', {
    mentions: [bob.id, bob.id],
  });
  assert.equal((await service.getMessage(alice, m.id)).mentions.length, 1);
  assert.equal(
    (await service.notifications(bob)).filter((n) => n.message_id === m.id)
      .length,
    1,
  );
  await service.edit(alice, m.id, {
    body: '@bob look again',
    mentions: [bob.id],
  });
  assert.equal(
    (await service.notifications(bob)).filter((n) => n.message_id === m.id)
      .length,
    1,
  );
  const before = (await service.history(alice, channel.id)).last_sequence;
  await assert.rejects(
    send(alice, channel.id, 'invalid mention', { mentions: [outsider.id] }),
    (e) => e.status === 403,
  );
  assert.equal(
    (await service.history(alice, channel.id)).last_sequence,
    before,
    'failed mention rolls back message and sequence',
  );
  await service.preferences(bob, { mode: 'muted' });
  const silent = await send(alice, channel.id, 'mute', { mentions: [bob.id] });
  assert.equal(
    (await service.notifications(bob)).some((n) => n.message_id === silent.id),
    false,
  );
  await service.preferences(bob, { mode: 'mentions' });
});
test('M3 DMs are canonical under concurrent creation and founders cannot read nonparticipant content', async () => {
  const [a, b] = await Promise.all([
    service.directMessage(alice, bob.id),
    service.directMessage(bob, alice.id),
  ]);
  assert.equal(a.id, b.id);
  dm = a;
  const m = await send(alice, dm.id, 'Secret DM', { mentions: [bob.id] });
  assert.equal(
    (await service.notifications(bob)).filter((n) => n.message_id === m.id)
      .length,
    1,
  );
  await assert.rejects(service.getMessage(root, m.id), (e) => e.status === 404);
  assert.equal(
    (
      await rawAs(
        root,
        (tx) => tx`SELECT * FROM collaboration_messages WHERE id=${m.id}`,
      )
    ).length,
    0,
  );
  await assert.rejects(
    rawAs(
      alice,
      (tx) =>
        tx`UPDATE collaboration_conversations SET dm_high=${root.id} WHERE id=${dm.id}`,
    ),
  );
  await assert.rejects(service.directMessage(alice, alice.id));
  await assert.rejects(
    service.directMessage(alice, outsider.id),
    (e) => e.status === 404,
  );
});
test('M3 search and mention filters obey membership, participant and company boundaries', async () => {
  const hidden = await send(root, privateChannel.id, 'uniquesecret');
  const visible = await send(alice, channel.id, 'uniquesecret', {
    mentions: [bob.id],
  });
  const found = await service.search(bob, { q: 'uniquesecret' });
  assert.ok(found.messages.some((m) => m.id === visible.id));
  assert.equal(
    found.messages.some((m) => m.id === hidden.id),
    false,
  );
  assert.equal(
    (
      await service.search(bob, {
        q: 'uniquesecret',
        conversation_id: privateChannel.id,
      })
    ).messages.length,
    0,
  );
  assert.ok(
    (await service.search(bob, { mentions_only: 'true' })).messages.some(
      (m) => m.id === visible.id,
    ),
  );
  assert.equal(
    (await service.search(root, { q: 'Secret DM' })).messages.length,
    0,
  );
  await assert.rejects(service.search(bob, { before_date: 'not-a-date' }));
});
test('M3 read positions are monotonic, clamp future values and exclude own/deleted messages from unreads', async () => {
  await service.markRead(bob, channel.id, Number.MAX_SAFE_INTEGER);
  const m = await send(alice, channel.id, 'unread');
  await send(bob, channel.id, 'own');
  assert.equal(
    (await service.bootstrap(bob)).channels.find((c) => c.id === channel.id)
      .unread_count,
    1,
  );
  await service.markRead(bob, channel.id, m.sequence);
  await service.markRead(bob, channel.id, 0);
  assert.equal(
    (await service.bootstrap(bob)).channels.find((c) => c.id === channel.id)
      .unread_count,
    0,
  );
  await assert.rejects(
    service.markRead(root, dm.id, Number.MAX_SAFE_INTEGER),
    (e) => e.status === 404,
  );
});
test('M3 removal revokes history/search/notifications/mention choices immediately', async () => {
  const c = await service.createChannel(root, {
    name: 'revocation',
    visibility: 'private',
  });
  await service.membership(root, c.id, bob.id);
  const m = await send(root, c.id, 'revocable', { mentions: [bob.id] });
  assert.equal((await service.getMessage(bob, m.id)).id, m.id);
  await service.membership(root, c.id, bob.id, 'member', true);
  await assert.rejects(service.getMessage(bob, m.id), (e) => e.status === 404);
  assert.equal(
    (await service.search(bob, { q: 'revocable' })).messages.length,
    0,
  );
  assert.equal(
    (await service.notifications(bob)).some((n) => n.message_id === m.id),
    false,
  );
  assert.equal(
    (await service.employees(root, '', c.id)).some((u) => u.id === bob.id),
    false,
  );
});
test('M3 realtime role sees identifier-only authorized events and rejects invalidated sessions', async () => {
  const claims = {
    sub: alice.id,
    sid: alice.sessionId,
    tv: '0',
    purpose: 'nexsyrus-connect',
    organization_id: (await service.bootstrap(alice)).organization.id,
  };
  async function events(c = claims) {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE collaboration_realtime`;
      await tx`SELECT set_config('request.jwt.claims',${JSON.stringify(c)},true)`;
      return tx`SELECT * FROM collaboration_events`;
    });
  }
  const rows = await events();
  assert.ok(rows.length > 0);
  assert.equal(
    rows.some((e) => e.conversation_id === privateChannel.id),
    false,
  );
  assert.ok(
    rows.every(
      (e) =>
        Object.keys(e).sort().join(',') ===
        'conversation_id,created_at,id,message_id,user_id',
    ),
  );
  assert.equal((await events({ ...claims, purpose: 'school' })).length, 0);
  await sql`UPDATE internal_user_sessions SET revoked_at=now() WHERE id=${alice.sessionId}`;
  assert.equal((await events()).length, 0);
  await sql`UPDATE internal_user_sessions SET revoked_at=NULL WHERE id=${alice.sessionId}`;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE collaboration_realtime`;
      return tx`SELECT * FROM internal_users`;
    }),
    (e) => e.code === '42501',
  );
});
test('HTTP endpoints validate identifiers, authorship and rate limits without disclosing SQL errors', async () => {
  const base = '/api/super-admin/connect',
    auth = 'Bearer ' + alice.token;
  assert.equal(
    (
      await request(app)
        .get(base + '/conversations/not-uuid/messages')
        .set('Authorization', auth)
    ).status,
    400,
  );
  const m = await send(bob, channel.id, 'HTTP author');
  assert.equal(
    (
      await request(app)
        .patch(base + '/messages/' + m.id)
        .set('Authorization', auth)
        .send({ body: 'takeover' })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post(base + '/channels')
        .set('Authorization', auth)
        .send({ name: 'forged' })
    ).status,
    403,
  );
  await sql`INSERT INTO collaboration_rate_limits(user_id,action,bucket,count) VALUES(${alice.id},'send',date_trunc('minute',now()),30)
    ON CONFLICT(user_id,action,bucket) DO UPDATE SET count=30`;
  assert.equal(
    (
      await request(app)
        .post(base + '/conversations/' + channel.id + '/messages')
        .set('Authorization', auth)
        .send({ client_id: randomUUID(), body: 'rate limited' })
    ).status,
    429,
  );
  await sql`DELETE FROM collaboration_rate_limits WHERE user_id=${alice.id} AND action='send'`;
});
test('M4 private attachment upload/download validates content, retries by hash and rechecks current membership', async () => {
  const m = await send(alice, channel.id, 'A document');
  const file = {
    originalname: 'plan.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'),
  };
  const a = await extras.upload(alice, m.id, file),
    retry = await extras.upload(alice, m.id, file);
  assert.equal(a.id, retry.id);
  assert.deepEqual((await extras.download(bob, a.id)).bytes, file.buffer);
  await assert.rejects(extras.upload(bob, m.id, file), (e) => e.status === 403);
  const secret = await send(alice, dm.id, 'Private file');
  const privateFile = await extras.upload(alice, secret.id, file);
  await assert.rejects(
    extras.download(root, privateFile.id),
    (e) => e.status === 404,
  );
  await service.edit(alice, m.id, {}, true);
  await assert.rejects(extras.download(bob, a.id), (e) => e.status === 404);
  const response = await request(app)
    .get('/api/super-admin/connect/attachments/' + privateFile.id + '/download')
    .set('Authorization', 'Bearer ' + alice.token);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'], /^attachment;/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});
test('M4 malicious/spoofed files, active PDF, macros and malformed Office ZIP are rejected', () => {
  for (const f of [
    {
      originalname: 'x.svg',
      mimetype: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    },
    {
      originalname: 'x.png',
      mimetype: 'image/png',
      buffer: Buffer.from('<script>evil</script>'),
    },
    {
      originalname: 'x.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 /JavaScript (evil) %%EOF'),
    },
    {
      originalname: 'x.docx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('PK malformed'),
    },
    {
      originalname: 'x.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.alloc(8388609),
    },
  ])
    assert.throws(() => validateFile(f));
});
test('M4 saved/pinned messages preserve authorization, personal scope and manager-only pins', async () => {
  const m = await send(root, channel.id, 'Pinned reference');
  await extras.pin(root, m.id);
  await extras.pin(root, m.id);
  assert.equal((await extras.pins(bob, channel.id)).length, 1);
  await assert.rejects(extras.pin(bob, m.id), (e) => e.status === 403);
  await extras.save(alice, m.id);
  await extras.save(alice, m.id);
  assert.equal((await extras.saved(alice)).length, 1);
  assert.equal((await extras.saved(bob)).length, 0);
  await extras.pin(root, m.id, true);
  assert.equal((await extras.pins(bob, channel.id)).length, 0);
  const secret = await send(root, privateChannel.id, 'Private saved');
  await assert.rejects(extras.save(bob, secret.id), (e) => e.code === '42501');
});
test('M4 presence expires to away and SQL prevents setting another employee status', async () => {
  await extras.presence(alice, { status: 'busy', note: 'Testing' });
  assert.equal(
    (await extras.listPresence(bob)).find((p) => p.user_id === alice.id).status,
    'busy',
  );
  await sql`UPDATE collaboration_presence SET expires_at=now()-interval '1 minute' WHERE user_id=${alice.id}`;
  assert.equal(
    (await extras.listPresence(bob)).find((p) => p.user_id === alice.id).status,
    'away',
  );
  await assert.rejects(
    rawAs(
      bob,
      (tx) =>
        tx`INSERT INTO collaboration_presence(organization_id,user_id,status,expires_at) SELECT organization_id,${alice.id},'online',now()+interval '1 day' FROM collaboration_organization_members WHERE user_id=${bob.id}`,
    ),
    (e) => e.code === '42501',
  );
});
test('M4 task conversion reuses checklist, validates role/school/assignee and never copies private body automatically', async () => {
  const m = await send(root, channel.id, 'Confidential source text');
  const input = {
    school_id: 101,
    title: 'Payment testing',
    description: 'Review the payment module',
    assigned_to: alice.id,
    priority: 'HIGH',
    deadline: '2026-11-10',
    status: 'IN_PROGRESS',
  };
  const t = await extras.task(root, m.id, input);
  assert.equal((await extras.task(root, m.id, input)).task_id, t.task_id);
  const [task] =
    await sql`SELECT * FROM school_onboarding_checklists WHERE id=${t.task_id}`;
  assert.equal(task.title, input.title);
  assert.equal(task.instructions, input.description);
  assert.equal(task.instructions.includes('Confidential'), false);
  await assert.rejects(
    extras.task(bob, m.id, input),
    (e) => e.code === '42501',
  );
  await assert.rejects(
    extras.task(root, m.id, { ...input, school_id: 999 }),
    (e) => e.code === '42501',
  );
  await assert.rejects(
    extras.task(root, m.id, { ...input, assigned_to: outsider.id }),
    (e) => e.code === '42501',
  );
  await assert.rejects(
    extras.task(root, m.id, { ...input, school_id: 202 }),
    (e) => e.code === '23514',
  );
  assert.equal(
    (await sql`SELECT * FROM collaboration_task_links WHERE message_id=${m.id}`)
      .length,
    1,
  );
});
test('company scope is enforced even when the same employee belongs to another company', async () => {
  const [org] =
    await sql`SELECT id FROM collaboration_organizations WHERE code='other'`;
  await sql`INSERT INTO collaboration_organization_members(organization_id,user_id) VALUES(${org.id},${root.id}),(${org.id},${alice.id})`;
  const otherService = createConnectService(sql, { organizationCode: 'other' });
  const c = await otherService.createChannel(root, {
    name: 'other-private',
    visibility: 'private',
  });
  await otherService.membership(root, c.id, alice.id);
  const m = await send(root, c.id, 'Other company data').catch(() => null);
  assert.equal(m, null);
  const other = await otherService.send(root, c.id, {
    body: 'Other company data',
    client_id: randomUUID(),
  });
  await assert.rejects(
    service.getMessage(alice, other.id),
    (e) => e.status === 404,
  );
  assert.equal(
    (await service.search(alice, { q: 'Other company data' })).messages.length,
    0,
  );
});
test('explicit migration runner journals all migrations atomically and safely skips a repeat run', async () => {
  await migrate(sql);
  assert.equal(
    (await sql`SELECT * FROM collaboration_schema_migrations`).length,
    3,
  );
});
test('Office validation accepts bounded DOCX container structure and rejects macros and expansion bombs', async () => {
  const archiver = require('archiver');
  async function zip(entries) {
    const archive = archiver('zip', { zlib: { level: 9 } }),
      parts = [];
    const done = new Promise((resolve, reject) => {
      archive.on('data', (p) => parts.push(p));
      archive.on('end', () => resolve(Buffer.concat(parts)));
      archive.on('error', reject);
    });
    for (const [name, body] of Object.entries(entries))
      archive.append(body, { name });
    await archive.finalize();
    return done;
  }
  const type =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const entries = {
    '[Content_Types].xml':
      '<Types><Default Extension="xml" ContentType="application/xml"/></Types>',
    'word/document.xml':
      '<document><paragraph>Project notes</paragraph></document>',
  };
  const doc = await zip(entries);
  assert.equal(
    validateFile({ originalname: 'project.docx', mimetype: type, buffer: doc })
      .mime,
    type,
  );
  const macro = await zip({ ...entries, 'word/vbaProject.bin': 'macro' });
  assert.throws(
    () =>
      validateFile({
        originalname: 'macro.docx',
        mimetype: type,
        buffer: macro,
      }),
    /Unsafe Office/,
  );
  const bomb = await zip({ ...entries, 'word/large.xml': 'a'.repeat(1000000) });
  assert.throws(
    () =>
      validateFile({ originalname: 'bomb.docx', mimetype: type, buffer: bomb }),
    /expansion limits/,
  );
});
test('deleted thread parents remain tombstones while existing replies can still be edited or deleted', async () => {
  const parent = await send(alice, channel.id, 'Parent to delete'),
    reply = await send(bob, channel.id, 'Reply', { parent_id: parent.id });
  await service.edit(alice, parent.id, {}, true);
  assert.equal(
    (await service.edit(bob, reply.id, { body: 'Updated reply' })).body,
    'Updated reply',
  );
  assert.ok((await service.edit(bob, reply.id, {}, true)).deleted_at);
  await assert.rejects(
    send(bob, channel.id, 'New reply', { parent_id: parent.id }),
    (e) => e.code === '23514',
  );
});
test('image uploads use the actual sharp decoder, re-encode private bytes and reject oversized dimensions', async () => {
  const sharp = require('sharp');
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#112233' },
  })
    .png()
    .toBuffer();
  const m = await send(alice, channel.id, 'Small test image'),
    file = { originalname: 'test.png', mimetype: 'image/png', buffer: bytes };
  const uploaded = await extras.upload(alice, m.id, file),
    download = await extras.download(bob, uploaded.id);
  assert.equal((await sharp(download.bytes).metadata()).width, 2);
  const huge = Buffer.from(bytes);
  huge.writeUInt32BE(100000, 16);
  huge.writeUInt32BE(100000, 20);
  await assert.rejects(
    extras.upload(alice, m.id, { ...file, buffer: huge }),
    /Invalid or oversized image/,
  );
});
test('actual PostgreSQL recovery history walks 215 missed messages in ascending keyset pages', async () => {
  const c = await service.createChannel(root, { name: 'pagination-fixture' });
  await service.membership(root, c.id, alice.id);
  await sql`INSERT INTO collaboration_messages(conversation_id,sender_id,client_id,sequence,body)
    SELECT ${c.id},${root.id},gen_random_uuid(),n,'Recovery fixture '||n FROM generate_series(1,215) AS n`;
  await sql`UPDATE collaboration_conversations SET last_sequence=215 WHERE id=${c.id}`;
  let after = 0,
    ids = [];
  for (;;) {
    const page = await service.history(alice, c.id, { after, limit: 100 });
    ids.push(...page.messages.map((m) => m.id));
    if (!page.has_more) break;
    after = Number(page.messages.at(-1).sequence);
  }
  assert.equal(ids.length, 215);
  assert.equal(new Set(ids).size, 215);
  assert.equal(
    (await service.history(alice, c.id, { after: 0, limit: 100 })).messages[0]
      .sequence,
    '1',
  );
});

test('all app roles bootstrap, find accountants, join public channels and message without private/admin access', async () => {
  const { ROLES } = require('../../src/config/rbac');
  for (const role of Object.values(ROLES)) {
    const user = await employee('allroles_' + role.toLowerCase(), role);
    const result = await request(app)
      .get('/api/super-admin/connect/bootstrap')
      .set('Authorization', 'Bearer ' + user.token);
    assert.equal(result.status, 200, role + ': ' + JSON.stringify(result.body));
    assert.equal(result.body.self.role, role);
    const admin = ['FOUNDER', 'SUPER_ADMIN'].includes(role);
    assert.equal(result.body.can_manage, admin);
    assert.ok(
      !result.body.channels.some((c) => c.id === privateChannel.id) || admin,
    );
    assert.ok(
      (await service.employees(user, 'ca')).some((u) => u.id === ca.id),
    );
    await service.membership(user, channel.id, user.id);
    const sent = await send(user, channel.id, 'Public hello from ' + role);
    assert.equal(sent.sender_id, user.id);
    const conversation = await service.directMessage(user, ca.id);
    const message = await send(
      user,
      conversation.id,
      'Private hello from ' + role,
      { mentions: [ca.id] },
    );
    assert.equal(
      (await service.getMessage(ca, message.id)).body,
      'Private hello from ' + role,
    );
    await assert.rejects(
      service.getMessage(bob, message.id),
      (e) => e.status === 404,
    );
    if (!admin) {
      await assert.rejects(
        service.createChannel(user, {
          name: 'denied-' + role.toLowerCase().replace(/_/g, '-'),
        }),
        (e) => e.code === '42501' || e.status === 403,
      );
      await assert.rejects(
        service.provisionEmployee(user, outsider.id),
        (e) => e.status === 403,
      );
      await assert.rejects(
        service.membership(user, privateChannel.id, user.id),
        (e) => e.status === 403 || e.status === 404,
      );
    }
  }
});

test('account activation enrolls new roles while explicit membership removal survives profile changes and migration reruns', async () => {
  const invited = await employee('invited_account', 'CA_LEAD', 'INVITED');
  assert.equal(
    (
      await sql`SELECT * FROM collaboration_organization_members WHERE user_id=${invited.id}`
    ).length,
    0,
  );
  await assert.rejects(service.bootstrap(invited), (e) => e.status === 403);
  await sql`UPDATE internal_users SET status='ACTIVE' WHERE id=${invited.id}`;
  assert.equal((await service.bootstrap(invited)).self.role, 'CA_LEAD');
  await service.provisionEmployee(root, invited.id, true);
  await sql`UPDATE internal_users SET full_name='Updated accountant',role='CA',status='ACTIVE' WHERE id=${invited.id}`;
  await migrate(sql);
  await assert.rejects(service.bootstrap(invited), (e) => e.status === 403);
  await service.provisionEmployee(root, invited.id);
  assert.equal((await service.bootstrap(invited)).self.role, 'CA');
});

test('CA and Lead CA retain the mandatory password change and cannot access school/users APIs or prefix lookalikes', async () => {
  const { authenticateUser } = require('../../src/middleware/rbac');
  const restricted = express();
  restricted.use(express.json());
  restricted.use(
    '/api/super-admin/connect',
    createConnectRouter({
      service,
      authenticate: authenticateUser,
      extensions: extras,
    }),
  );
  for (const url of [
    '/api/super-admin/schools',
    '/api/super-admin/users',
    '/api/super-admin/connect-unsafe',
    '/api/super-admin/books-unsafe',
  ])
    restricted.get(url, authenticateUser, (_req, res) =>
      res.json({ unexpected: true }),
    );
  for (const role of ['CA', 'CA_LEAD']) {
    const user = await employee('password_' + role.toLowerCase(), role);
    await sql`UPDATE internal_users SET must_change_password=true WHERE id=${user.id}`;
    let r = await request(restricted)
      .get('/api/super-admin/connect/bootstrap')
      .set('Authorization', 'Bearer ' + user.token);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'PASSWORD_CHANGE_REQUIRED');
    await sql`UPDATE internal_users SET must_change_password=false WHERE id=${user.id}`;
    r = await request(restricted)
      .get('/api/super-admin/connect/bootstrap')
      .set('Authorization', 'Bearer ' + user.token);
    assert.equal(r.status, 200);
    for (const url of [
      '/api/super-admin/schools',
      '/api/super-admin/users',
      '/api/super-admin/connect-unsafe',
      '/api/super-admin/books-unsafe',
    ]) {
      r = await request(restricted)
        .get(url)
        .set('Authorization', 'Bearer ' + user.token);
      assert.equal(r.status, 403, url);
      assert.equal(r.body.error, 'CA_MODULE_ACCESS_ONLY');
    }
  }
});
