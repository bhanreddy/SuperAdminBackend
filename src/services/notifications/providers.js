const { createHmac, sign } = require("node:crypto");
const fetch = require("cross-fetch");

function providerError(code, permanent = false, invalidToken = false) {
  return Object.assign(new Error(code), { permanent, invalidToken });
}
// No user-controlled URLs. A transport is enabled only with an explicit HTTPS
// endpoint + signing secret (or a complete FCM service account for push).
function createProviders(env = process.env, http = fetch) {
  let cachedToken = null;
  let tokenExpires = 0;
  let tokenPromise = null;
  let account = null;
  if (env.NOTIFICATION_FCM_SERVICE_ACCOUNT) {
    try {
      account = JSON.parse(env.NOTIFICATION_FCM_SERVICE_ACCOUNT);
      if (
        !account.client_email ||
        !account.private_key ||
        !/^[a-z0-9-]+$/.test(account.project_id)
      )
        throw new Error();
    } catch {
      throw new Error(
        "NOTIFICATION_FCM_SERVICE_ACCOUNT must be a valid service account JSON",
      );
    }
  }
  const expoEnabled = env.NOTIFICATION_EXPO_PUSH_ENABLED === "true";
  const expoHeaders = env.NOTIFICATION_EXPO_ACCESS_TOKEN
    ? { authorization: "Bearer " + env.NOTIFICATION_EXPO_ACCESS_TOKEN }
    : {};
  function expoResult(data) {
    const code = data?.details?.error;
    if (data?.status === "error")
      throw providerError(
        code === "DeviceNotRegistered"
          ? "PROVIDER_EXPO_UNREGISTERED"
          : "PROVIDER_EXPO_REJECTED",
        code !== "MessageRateExceeded",
        code === "DeviceNotRegistered",
      );
    if (data?.status !== "ok") throw providerError("PROVIDER_EXPO_RESPONSE");
    return data;
  }
  const endpoints = {};
  for (const transport of ["email", "sms", "push"]) {
    const value = env[`NOTIFICATION_${transport.toUpperCase()}_WEBHOOK_URL`];
    if (value) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !env.NOTIFICATION_WEBHOOK_SECRET ||
        env.NOTIFICATION_WEBHOOK_SECRET.length < 32
      ) {
        throw new Error(
          "Notification webhooks require HTTPS and a signing secret of at least 32 characters",
        );
      }
      endpoints[transport] = url.href;
    }
  }
  async function post(url, body, headers = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await http(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        /* providers may return an empty 202 */
      }
      if (!response.ok) {
        const fcmCode = data?.error?.details?.find(
          (d) => d.errorCode,
        )?.errorCode;
        const invalid = fcmCode === "UNREGISTERED";
        // Log stable codes only. Provider bodies may contain personal data/tokens.
        throw providerError(
          `PROVIDER_HTTP_${response.status}${invalid ? "_UNREGISTERED" : ""}`,
          response.status >= 400 &&
            response.status < 500 &&
            ![401, 408, 429].includes(response.status),
          invalid,
        );
      }
      return data;
    } catch (e) {
      if (e.permanent !== undefined) throw e;
      throw providerError(
        e.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  async function accessToken() {
    if (cachedToken && tokenExpires > Date.now() + 60000) return cachedToken;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const now = Math.floor(Date.now() / 1000);
      const encode = (v) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
      const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url")}`;
      // OAuth JWT bearer exchange uses form encoding.
      const data = await post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        { "content-type": "application/x-www-form-urlencoded" },
      );
      if (!data.access_token) throw providerError("FCM_AUTH_RESPONSE");
      cachedToken = data.access_token;
      tokenExpires = Date.now() + Number(data.expires_in || 3600) * 1000;
      return cachedToken;
    })().finally(() => {
      tokenPromise = null;
    });
    return tokenPromise;
  }
  return {
    capabilities: () => ({
      email: Boolean(endpoints.email),
      sms: Boolean(endpoints.sms),
      push: Boolean(account || endpoints.push || expoEnabled),
      expo_push: expoEnabled,
    }),
    async receipt(id) {
      const response = await post(
        "https://exp.host/--/api/v2/push/getReceipts",
        JSON.stringify({ ids: [id] }),
        expoHeaders,
      );
      const result = response?.data?.[id];
      if (!result) return false;
      expoResult(result);
      return true;
    },
    async send(job) {
      if (
        job.transport === "push" &&
        /^(ExponentPushToken|ExpoPushToken)\[/.test(job.token || "")
      ) {
        if (!expoEnabled) throw providerError("PROVIDER_EXPO_DISABLED", true);
        const response = await post(
          "https://exp.host/--/api/v2/push/send",
          JSON.stringify({
            to: job.token,
            title: "NexSyrus",
            body: "You have a new notification. Open your inbox to view it.",
            data: {
              notification_id: job.inbox_id,
              user_id: job.user_id,
              channel: job.channel,
              path: "/notifications",
            },
            channelId: job.channel,
            collapseId: job.inbox_id,
            ttl: 86400,
          }),
          expoHeaders,
        );
        const ticket = expoResult(response?.data);
        if (typeof ticket.id !== "string")
          throw providerError("PROVIDER_EXPO_RESPONSE");
        return { receipt_id: ticket.id };
      }
      if (job.transport === "push" && account) {
        const token = await accessToken();
        try {
          await post(
            `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
            JSON.stringify({
              message: {
                token: job.token,
                notification: {
                  title: "NexSyrus",
                  body: "You have a new notification. Open your inbox to view it.",
                },
                data: {
                  notification_id: job.inbox_id,
                  channel: job.channel,
                  path: "/notifications",
                },
                android: {
                  notification: { channel_id: job.channel, tag: job.inbox_id },
                },
                apns: { headers: { "apns-collapse-id": job.inbox_id } },
                webpush: {
                  notification: { tag: job.inbox_id },
                  fcm_options: { link: env.NOTIFICATION_APP_URL || undefined },
                },
              },
            }),
            { authorization: `Bearer ${token}` },
          );
        } catch (e) {
          if (e.message === "PROVIDER_HTTP_401") {
            cachedToken = null;
            tokenExpires = 0;
          }
          throw e;
        }
        return;
      }
      const endpoint = endpoints[job.transport];
      if (!endpoint) throw providerError("PROVIDER_NOT_CONFIGURED");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        id: job.id,
        user_id: job.user_id,
        notification_id: job.inbox_id,
        channel: job.channel,
        transport: job.transport,
        recipient:
          job.transport === "email"
            ? job.email
            : job.transport === "sms"
              ? job.phone
              : job.token,
        title: "NexSyrus notification",
        body: "You have a new notification. Open your inbox to view it.",
        path: "/notifications",
      });
      const signature = createHmac("sha256", env.NOTIFICATION_WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      await post(endpoint, body, {
        "Idempotency-Key": job.id,
        "X-NexSyrus-Timestamp": timestamp,
        "X-NexSyrus-Signature": signature,
      });
    },
  };
}
module.exports = { createProviders, providerError };
