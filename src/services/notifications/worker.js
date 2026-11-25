const { randomUUID } = require("node:crypto");
const { eligible } = require("./service");
const retrySeconds = (attempt, random = Math.random) =>
  Math.min(21600, 30 * 2 ** Math.min(attempt - 1, 10)) +
  Math.floor(random() * 15);
function createNotificationWorker(sql, providers, bridge = null) {
  let timer = null;
  let running = null;
  let stopped = false;
  let schemaWarned = false;
  let bridgeWarned = false;
  let bridgeRunning = null;
  async function fanout() {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout='15s'`;
      const [event] =
        await tx`SELECT * FROM superadmin_notification_events WHERE processed_at IS NULL AND dead_at IS NULL AND available_at<=now() ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!event) return false;
      try {
        await tx.savepoint(async (sp) => {
          // One event, one atomic fanout. Unique(event,user) makes replay harmless.
          await sp`INSERT INTO superadmin_notification_inbox(event_id,user_id,created_at,read_at)
        SELECT e.id,u.id,e.created_at,e.mirror_read_at FROM superadmin_notification_events e CROSS JOIN internal_users u
        WHERE e.id=${event.id} AND ${eligible(sp)} ON CONFLICT(event_id,user_id) DO NOTHING`;
          const caps = providers.capabilities();
          for (const transport of ["email", "sms", "push"]) {
            if (!caps[transport]) continue;
            const enabled =
              transport === "email"
                ? sp`p.email_enabled`
                : transport === "sms"
                  ? sp`p.sms_enabled`
                  : sp`p.push_enabled`;
            if (transport === "push") {
              await sp`INSERT INTO superadmin_notification_deliveries(inbox_id,transport,device_id,target_key)
            SELECT n.id,'push',d.id,d.id::text FROM superadmin_notification_inbox n
            JOIN superadmin_notification_preferences p ON p.user_id=n.user_id AND p.channel=${event.channel}
            JOIN superadmin_notification_devices d ON d.user_id=n.user_id
            JOIN internal_user_sessions s ON s.id=d.session_id AND s.user_id=d.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
            WHERE n.event_id=${event.id} AND ${enabled} ON CONFLICT DO NOTHING`;
            } else {
              await sp`INSERT INTO superadmin_notification_deliveries(inbox_id,transport,target_key)
            SELECT n.id,${transport},n.user_id::text FROM superadmin_notification_inbox n
            JOIN superadmin_notification_preferences p ON p.user_id=n.user_id AND p.channel=${event.channel}
            JOIN internal_users u ON u.id=n.user_id
            WHERE n.event_id=${event.id} AND ${enabled} AND ${transport === "email" ? sp`NULLIF(u.email,'') IS NOT NULL` : sp`NULLIF(u.phone,'') IS NOT NULL`}
            ON CONFLICT DO NOTHING`;
            }
          }
          await sp`UPDATE superadmin_notification_events SET processed_at=now(),last_error=NULL WHERE id=${event.id}`;
        });
      } catch (error) {
        const attempts = event.attempts + 1;
        await tx`UPDATE superadmin_notification_events SET attempts=${attempts},available_at=now()+${retrySeconds(attempts)}*interval '1 second',
          dead_at=CASE WHEN ${attempts}>=8 THEN now() ELSE NULL END,last_error='FANOUT_FAILED' WHERE id=${event.id}`;
        console.error(
          JSON.stringify({
            component: "notifications",
            event: "fanout_failed",
            event_id: event.id,
            code: error.code || "FANOUT_FAILED",
          }),
        );
      }
      return true;
    });
  }
  async function claim() {
    const lease = randomUUID();
    const [job] =
      await sql`UPDATE superadmin_notification_deliveries SET state='processing',lease_until=now()+interval '2 minutes',lease_token=${lease},attempts=attempts+1
      WHERE id IN (SELECT id FROM superadmin_notification_deliveries WHERE available_at<=now() AND (state='pending' OR (state='processing' AND lease_until<now()))
        ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
    return job;
  }
  async function deliver(job) {
    try {
      const [current] =
        await sql`SELECT n.user_id,n.id AS inbox_id,e.channel,u.email,u.phone,d.token
        FROM superadmin_notification_inbox n JOIN superadmin_notification_events e ON e.id=n.event_id JOIN internal_users u ON u.id=n.user_id
        JOIN superadmin_notification_deliveries delivery ON delivery.inbox_id=n.id AND delivery.id=${job.id} AND delivery.lease_token=${job.lease_token} AND delivery.state='processing' AND delivery.lease_until>now()
        JOIN superadmin_notification_preferences p ON p.user_id=u.id AND p.channel=e.channel
        LEFT JOIN superadmin_notification_devices d ON d.id=${job.device_id} AND d.user_id=u.id
        LEFT JOIN internal_user_sessions s ON s.id=d.session_id AND s.user_id=u.id
        WHERE n.id=${job.inbox_id} AND n.archived_at IS NULL AND ${eligible(sql)}
          AND ${job.transport === "email" ? sql`p.email_enabled AND NULLIF(u.email,'') IS NOT NULL` : job.transport === "sms" ? sql`p.sms_enabled AND NULLIF(u.phone,'') IS NOT NULL` : sql`p.push_enabled AND d.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>now()`}`;
      if (!current) {
        await sql`UPDATE superadmin_notification_deliveries SET state='skipped',lease_until=NULL,lease_token=NULL,last_error='NO_LONGER_ELIGIBLE' WHERE id=${job.id} AND lease_token=${job.lease_token}`;
        return;
      }
      const result = await providers.send({ ...job, ...current });
      if (result?.receipt_id) {
        await sql`UPDATE superadmin_notification_deliveries SET state='awaiting_receipt',receipt_id=${result.receipt_id},receipt_started_at=now(),available_at=now()+interval '15 minutes',lease_until=NULL,lease_token=NULL WHERE id=${job.id} AND lease_token=${job.lease_token}`;
        return;
      }
      await sql`UPDATE superadmin_notification_deliveries SET state='sent',sent_at=now(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=${job.id} AND lease_token=${job.lease_token}`;
    } catch (e) {
      const dead = Boolean(e.permanent) || job.attempts >= 8;
      // Never persist provider messages, addresses or tokens in failure logs.
      const code = /^PROVIDER_[A-Z0-9_]+$|^FCM_AUTH_RESPONSE$/.test(e.message)
        ? e.message
        : "DELIVERY_FAILED";
      await sql`UPDATE superadmin_notification_deliveries SET state=${dead ? "dead" : "pending"},available_at=now()+${retrySeconds(job.attempts)}*interval '1 second',lease_until=NULL,lease_token=NULL,last_error=${code}
        WHERE id=${job.id} AND lease_token=${job.lease_token}`;
      if (e.invalidToken && job.device_id)
        await sql`DELETE FROM superadmin_notification_devices WHERE id=${job.device_id}`;
      console.error(
        JSON.stringify({
          component: "notifications",
          event: dead ? "delivery_dead" : "delivery_retry",
          delivery_id: job.id,
          code,
        }),
      );
    }
  }
  async function checkReceipts() {
    if (!providers.receipt) return;
    const jobs =
      await sql`SELECT id,receipt_id,device_id,receipt_attempts,receipt_started_at FROM superadmin_notification_deliveries WHERE state='awaiting_receipt' AND available_at<=now() ORDER BY available_at,id LIMIT 50`;
    for (const job of jobs) {
      try {
        const confirmed = await providers.receipt(job.receipt_id);
        const expired =
          Date.now() - new Date(job.receipt_started_at).getTime() >
          23 * 3600000;
        await sql`UPDATE superadmin_notification_deliveries SET state=${confirmed ? "sent" : expired ? "dead" : "awaiting_receipt"},
          sent_at=CASE WHEN ${confirmed} THEN now() ELSE sent_at END,
          receipt_attempts=receipt_attempts+1,available_at=now()+interval '15 minutes',
          last_error=${confirmed ? null : expired ? "PROVIDER_RECEIPT_MISSING" : null}
          WHERE id=${job.id} AND receipt_id=${job.receipt_id} AND state='awaiting_receipt'`;
      } catch (e) {
        const terminal = Boolean(e.permanent) || job.receipt_attempts >= 7;
        await sql`UPDATE superadmin_notification_deliveries SET state=${terminal ? "dead" : "awaiting_receipt"},receipt_attempts=receipt_attempts+1,
          available_at=now()+interval '15 minutes',last_error=${e.invalidToken ? "PROVIDER_EXPO_UNREGISTERED" : "PROVIDER_RECEIPT_FAILED"}
          WHERE id=${job.id} AND receipt_id=${job.receipt_id} AND state='awaiting_receipt'`;
        if (e.invalidToken && job.device_id)
          await sql`DELETE FROM superadmin_notification_devices WHERE id=${job.device_id}`;
      }
    }
  }
  async function tick() {
    if (running) return running;
    running = (async () => {
      if (bridge && !stopped && !bridgeRunning) {
        // An unavailable CRM must not stall control-plane fanout or delivery.
        bridgeRunning = bridge()
          .then(() => {
            bridgeWarned = false;
          })
          .catch((e) => {
            if (!bridgeWarned)
              console.error(
                JSON.stringify({
                  component: "notifications",
                  event: "crm_bridge_unavailable",
                  code: e.code || "BRIDGE_FAILED",
                }),
              );
            bridgeWarned = true;
          })
          .finally(() => {
            bridgeRunning = null;
          });
      }
      try {
        for (let i = 0; i < 10 && !stopped; i++) {
          if (!(await fanout())) break;
        }
        for (let i = 0; i < 25 && !stopped; i++) {
          const job = await claim();
          if (!job) break;
          await deliver(job);
        }
        await checkReceipts();
        schemaWarned = false;
      } catch (e) {
        if (e.code === "42P01") {
          if (!schemaWarned)
            console.error(
              "[notifications] Migration 34 is required; worker will retry without blocking the API",
            );
          schemaWarned = true;
        } else
          console.error(
            JSON.stringify({
              component: "notifications",
              event: "worker_error",
              code: e.code || "WORKER_FAILED",
            }),
          );
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    checkReceipts,
    fanout,
    claim,
    deliver,
    tick,
    start() {
      if (timer) return;
      stopped = false;
      void tick();
      timer = setInterval(() => void tick(), 5000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
      if (bridgeRunning) await bridgeRunning;
    },
  };
}
module.exports = { createNotificationWorker, retrySeconds };
