const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, generateKeyPairSync } = require("node:crypto");
const {
  createProviders,
} = require("../../src/services/notifications/providers");
const job = {
  id: "delivery-1",
  inbox_id: "inbox-1",
  user_id: "user-1",
  channel: "security",
  transport: "email",
  email: "user@example.test",
  phone: "+919999999999",
  token: "test-fcm-token",
};
test("unconfigured transports stay disabled; unsafe endpoints and weak signing secrets fail closed", () => {
  assert.deepEqual(createProviders({}).capabilities(), {
    email: false,
    sms: false,
    push: false,
    expo_push: false,
  });
  assert.throws(() =>
    createProviders({
      NOTIFICATION_EMAIL_WEBHOOK_URL: "http://internal",
      NOTIFICATION_WEBHOOK_SECRET: "s".repeat(32),
    }),
  );
  assert.throws(() =>
    createProviders({
      NOTIFICATION_EMAIL_WEBHOOK_URL: "https://provider.test",
      NOTIFICATION_WEBHOOK_SECRET: "weak",
    }),
  );
});
test("webhooks use a stable idempotency key, timestamped HMAC and generic private payload", async () => {
  const calls = [];
  const secret = "x".repeat(32);
  const p = createProviders(
    {
      NOTIFICATION_EMAIL_WEBHOOK_URL: "https://provider.test/mail",
      NOTIFICATION_WEBHOOK_SECRET: secret,
    },
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 202, json: async () => ({}) };
    },
  );
  await p.send(job);
  await p.send(job);
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.headers["Idempotency-Key"], job.id);
    assert.equal(options.redirect, "error");
    const t = options.headers["X-NexSyrus-Timestamp"];
    assert.equal(
      options.headers["X-NexSyrus-Signature"],
      createHmac("sha256", secret).update(`${t}.${options.body}`).digest("hex"),
    );
    const body = JSON.parse(options.body);
    assert.equal(body.recipient, job.email);
    assert.ok(!body.body.includes("Private update"));
  }
});
test("provider 429 retries; permanent provider errors never retain provider bodies", async () => {
  const env = {
    NOTIFICATION_SMS_WEBHOOK_URL: "https://provider.test/sms",
    NOTIFICATION_WEBHOOK_SECRET: "x".repeat(32),
  };
  for (const [status, permanent] of [
    [429, false],
    [503, false],
    [400, true],
    [403, true],
  ]) {
    const p = createProviders(env, async () => ({
      ok: false,
      status,
      json: async () => ({ error: "private recipient details" }),
    }));
    await assert.rejects(
      p.send({ ...job, transport: "sms" }),
      (e) => e.permanent === permanent && !e.message.includes("private"),
    );
  }
});
test("FCM HTTP v1 exchanges a signed OAuth assertion once and identifies unregistered tokens", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    project_id: "test-project",
    client_email: "fcm@test-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  let authCalls = 0;
  let failed = false;
  const p = createProviders(
    { NOTIFICATION_FCM_SERVICE_ACCOUNT: JSON.stringify(account) },
    async (url, options) => {
      if (url === "https://oauth2.googleapis.com/token") {
        authCalls++;
        assert.equal(
          options.headers["content-type"],
          "application/x-www-form-urlencoded",
        );
        const params = new URLSearchParams(options.body);
        assert.equal(params.get("assertion").split(".").length, 3);
        return {
          ok: true,
          json: async () => ({
            access_token: "access-token",
            expires_in: 3600,
          }),
        };
      }
      assert.ok(
        url.startsWith("https://fcm.googleapis.com/v1/projects/test-project/"),
      );
      const payload = JSON.parse(options.body);
      assert.equal(payload.message.token, job.token);
      assert.equal(payload.message.android.notification.channel_id, "security");
      assert.equal(payload.message.data.notification_id, job.inbox_id);
      return failed
        ? {
            ok: false,
            status: 404,
            json: async () => ({
              error: { details: [{ errorCode: "UNREGISTERED" }] },
            }),
          }
        : { ok: true, json: async () => ({ name: "accepted" }) };
    },
  );
  await p.send({ ...job, transport: "push" });
  await p.send({ ...job, transport: "push" });
  assert.equal(authCalls, 1);
  failed = true;
  await assert.rejects(
    p.send({ ...job, transport: "push" }),
    (e) => e.permanent && e.invalidToken,
  );
});
test("Expo native push persists a ticket and checks receipts; invalid tokens terminate delivery", async () => {
  let receiptReady = false;
  let invalid = false;
  const calls = [];
  const p = createProviders(
    {
      NOTIFICATION_EXPO_PUSH_ENABLED: "true",
      NOTIFICATION_EXPO_ACCESS_TOKEN: "server-only-access-token",
    },
    async (url, options) => {
      calls.push(url);
      assert.equal(
        options.headers.authorization,
        "Bearer server-only-access-token",
      );
      if (url.endsWith("/send")) {
        const body = JSON.parse(options.body);
        assert.equal(body.channelId, "security");
        assert.equal(body.data.user_id, job.user_id);
        return {
          ok: true,
          json: async () => ({ data: { status: "ok", id: "expo-receipt-1" } }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: receiptReady
            ? {
                "expo-receipt-1": invalid
                  ? {
                      status: "error",
                      details: { error: "DeviceNotRegistered" },
                    }
                  : { status: "ok" },
              }
            : {},
        }),
      };
    },
  );
  assert.ok(p.capabilities().expo_push);
  const ticket = await p.send({
    ...job,
    transport: "push",
    token: "ExponentPushToken[test-token]",
  });
  assert.equal(ticket.receipt_id, "expo-receipt-1");
  assert.equal(await p.receipt(ticket.receipt_id), false);
  receiptReady = true;
  assert.equal(await p.receipt(ticket.receipt_id), true);
  invalid = true;
  await assert.rejects(
    p.receipt(ticket.receipt_id),
    (e) => e.permanent && e.invalidToken,
  );
});
