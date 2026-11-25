const { createHash } = require("node:crypto");
const {
  CHANNELS,
  check,
  uuid,
  channel,
  cursor,
  announcement,
  preferences,
} = require("./catalog");
const { ROLE_PERMISSIONS } = require("../../config/rbac");

// Used at BOTH fanout and transport send. Role overrides and school hierarchy
// are read from current database state, never an event payload or client claims.
function eligible(sql) {
  return sql`u.status='ACTIVE'
    AND (e.required_permission IS NULL OR u.role IN ('FOUNDER','SUPER_ADMIN') OR (
      NOT EXISTS(SELECT 1 FROM internal_user_permission_overrides o WHERE o.user_id=u.id AND o.permission=e.required_permission AND o.effect='DENY')
      AND ((${sql.json(ROLE_PERMISSIONS)}::jsonb -> u.role) ? e.required_permission
        OR EXISTS(SELECT 1 FROM internal_user_permission_overrides o WHERE o.user_id=u.id AND o.permission=e.required_permission AND o.effect='GRANT'))))
    AND (e.school_id IS NULL OR u.role IN ('FOUNDER','SUPER_ADMIN')
      OR (NOT EXISTS(SELECT 1 FROM internal_user_permission_overrides o WHERE o.user_id=u.id AND o.permission='schools.read.all' AND o.effect='DENY')
        AND ((${sql.json(ROLE_PERMISSIONS)}::jsonb -> u.role) ? 'schools.read.all' OR EXISTS(SELECT 1 FROM internal_user_permission_overrides o WHERE o.user_id=u.id AND o.permission='schools.read.all' AND o.effect='GRANT')))
      OR EXISTS(
      WITH RECURSIVE team AS (SELECT u.id AS id UNION SELECT child.id FROM internal_users child JOIN team t ON child.manager_id=t.id WHERE child.status='ACTIVE')
      SELECT 1 FROM internal_user_schools s WHERE s.school_id=e.school_id AND s.user_id IN (SELECT id FROM team)))
    AND (e.audience->>'mode' IN ('all','school')
      OR (e.audience->>'mode'='roles' AND (e.audience->'roles') ? u.role)
      OR (e.audience->>'mode'='founders' AND u.role IN ('FOUNDER','SUPER_ADMIN'))
      OR ((e.audience->'user_ids') ? u.id::text)
      OR (e.audience->>'include_founders'='true' AND u.role IN ('FOUNDER','SUPER_ADMIN')))
    AND (e.expires_at IS NULL OR e.expires_at>now())`;
}
function visible(sql, user, includeArchived = false) {
  // authenticateUser has already loaded fresh effective permissions and scope.
  return sql`n.user_id=${user.id} AND (n.archived_at IS NULL OR ${includeArchived})
    AND (e.expires_at IS NULL OR e.expires_at>now())
    AND (e.required_permission IS NULL OR ${Boolean(user.isFounder)} OR e.required_permission=ANY(${sql.array(user.permissions || [])}::text[]))
    AND (e.school_id IS NULL OR ${Boolean(user.isFounder || user.permissions?.includes("schools.read.all"))} OR e.school_id=ANY(${sql.array(user.assignedSchoolIds || [])}::int[]))
    AND (e.audience->>'mode'<>'roles' OR (e.audience->'roles') ? ${user.role})
    AND (e.channel='security' OR e.priority='critical' OR COALESCE(p.inbox_enabled,true))`;
}
// Mirrored source reads and inbox reads may contend in opposite lock orders.
// These mutations are idempotent, so retry a PostgreSQL-aborted deadlock only.
async function retryDeadlock(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error.code !== "40P01" || attempt >= 2) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 20 + Math.random() * 40),
      );
    }
  }
}
function createNotificationService(
  sql,
  capabilities = () => ({ email: false, push: false, sms: false }),
) {
  return {
    async rateLimit(user) {
      const [rate] =
        await sql`INSERT INTO notification_write_limits(user_id) VALUES(${user.id})
        ON CONFLICT(user_id) DO UPDATE SET
          hits=CASE WHEN notification_write_limits.window_at<now()-interval '1 minute' THEN 1 ELSE notification_write_limits.hits+1 END,
          window_at=CASE WHEN notification_write_limits.window_at<now()-interval '1 minute' THEN now() ELSE notification_write_limits.window_at END
        RETURNING hits`;
      check(
        rate.hits <= 120,
        "Too many notification updates. Try again in a minute.",
        429,
      );
    },
    async bootstrap(user) {
      const [counts, prefs, devices] = await Promise.all([
        sql`SELECT e.channel,count(*)::int AS total,count(*) FILTER(WHERE n.read_at IS NULL)::int AS unread
          FROM notification_inbox n JOIN notification_events e ON e.id=n.event_id
          LEFT JOIN notification_preferences p ON p.user_id=n.user_id AND p.channel=e.channel
          WHERE ${visible(sql, user)} GROUP BY e.channel`,
        sql`SELECT channel,inbox_enabled,email_enabled,push_enabled,sms_enabled FROM notification_preferences WHERE user_id=${user.id}`,
        sql`SELECT count(*)::int AS count FROM notification_devices d JOIN internal_user_sessions s ON s.id=d.session_id
          WHERE d.user_id=${user.id} AND s.user_id=d.user_id AND s.revoked_at IS NULL AND s.expires_at>now()`,
      ]);
      return {
        channels: CHANNELS.map((c) => ({
          ...c,
          total: counts.find((x) => x.channel === c.id)?.total || 0,
          unread: counts.find((x) => x.channel === c.id)?.unread || 0,
          inbox_enabled: true,
          email_enabled: false,
          push_enabled: false,
          sms_enabled: false,
          ...prefs.find((p) => p.channel === c.id),
        })),
        unread: counts.reduce((n, c) => n + c.unread, 0),
        capabilities: capabilities(),
        registered_devices: devices[0].count,
      };
    },
    async list(user, query = {}) {
      const before = cursor(query.before);
      const selected = query.channel ? channel(query.channel) : null;
      check(
        query.unread === undefined || ["true", "false"].includes(query.unread),
        "Invalid unread filter",
      );
      const limit = query.limit === undefined ? 30 : Number(query.limit);
      check(
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
        "Limit must be 1–100",
      );
      const rows =
        await sql`SELECT n.id,n.event_id,n.created_at::text AS created_at,n.read_at,e.school_id,e.channel,e.kind,e.priority,e.title,e.body,e.action_path
        FROM notification_inbox n JOIN notification_events e ON e.id=n.event_id
        LEFT JOIN notification_preferences p ON p.user_id=n.user_id AND p.channel=e.channel
        WHERE ${visible(sql, user)}
          AND (${selected}::text IS NULL OR e.channel=${selected})
          AND (${query.unread === "true"}=false OR n.read_at IS NULL)
          ${before ? sql`AND (n.created_at,n.id)<(${before.at}::text::timestamptz,${before.id}::uuid)` : sql``}
        ORDER BY n.created_at DESC,n.id DESC LIMIT ${limit + 1}`;
      const more = rows.length > limit;
      const data = rows.slice(0, limit);
      const last = data[data.length - 1];
      return {
        data,
        next_cursor: more
          ? Buffer.from(
              JSON.stringify({ at: last.created_at, id: last.id }),
            ).toString("base64url")
          : null,
      };
    },
    async update(user, id, operation) {
      uuid(id);
      check(
        ["read", "unread", "archive"].includes(operation),
        "Invalid operation",
      );
      const [row] = await retryDeadlock(
        () => sql`UPDATE notification_inbox target SET
        read_at=CASE WHEN ${operation}='read' THEN COALESCE(target.read_at,now()) WHEN ${operation}='unread' THEN NULL ELSE target.read_at END,
        archived_at=CASE WHEN ${operation}='archive' THEN COALESCE(target.archived_at,now()) ELSE target.archived_at END
        WHERE target.id=${id} AND target.user_id=${user.id} AND target.id IN (
          SELECT n.id FROM notification_inbox n JOIN notification_events e ON e.id=n.event_id
          LEFT JOIN notification_preferences p ON p.user_id=n.user_id AND p.channel=e.channel WHERE ${visible(sql, user, operation === "archive")}
        ) RETURNING id,read_at,archived_at`,
      );
      check(row, "Notification not found", 404);
      return row;
    },
    async readAll(user, body = {}) {
      const selected = body.channel ? channel(body.channel) : null;
      // Snapshot watermark stops a refresh race from silently marking new arrivals.
      check(
        typeof body.through === "string" &&
          Number.isFinite(Date.parse(body.through)),
        "A valid through timestamp is required",
      );
      const rows = await retryDeadlock(
        () => sql`UPDATE notification_inbox target SET read_at=now()
        WHERE target.user_id=${user.id} AND target.read_at IS NULL AND target.id IN (
          SELECT n.id FROM notification_inbox n JOIN notification_events e ON e.id=n.event_id
          LEFT JOIN notification_preferences p ON p.user_id=n.user_id AND p.channel=e.channel
          WHERE ${visible(sql, user)} AND n.created_at<=${body.through}::text::timestamptz AND (${selected}::text IS NULL OR e.channel=${selected})) RETURNING id`,
      );
      return { updated: rows.length };
    },
    async setPreferences(user, id, body) {
      channel(id);
      const values = preferences(body);
      check(
        id !== "security" || values.inbox_enabled !== false,
        "Security inbox alerts cannot be disabled",
      );
      const caps = capabilities();
      for (const transport of ["email", "push", "sms"])
        check(
          !values[transport + "_enabled"] || caps[transport],
          `${transport} delivery is not configured`,
          409,
        );
      return sql.begin(async (tx) => {
        await tx`INSERT INTO notification_preferences(user_id,channel) VALUES(${user.id},${id}) ON CONFLICT DO NOTHING`;
        const [row] = await tx`UPDATE notification_preferences SET
          inbox_enabled=COALESCE(${values.inbox_enabled ?? null},inbox_enabled),email_enabled=COALESCE(${values.email_enabled ?? null},email_enabled),
          push_enabled=COALESCE(${values.push_enabled ?? null},push_enabled),sms_enabled=COALESCE(${values.sms_enabled ?? null},sms_enabled),updated_at=now()
          WHERE user_id=${user.id} AND channel=${id} RETURNING channel,inbox_enabled,email_enabled,push_enabled,sms_enabled`;
        return row;
      });
    },
    async publish(user, body, key) {
      check(user.isFounder, "Only founders can publish announcements", 403);
      const input = announcement(body, key);
      const hash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const source = `announcement:${user.id}:${key}`;
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${user.id},34))`;
        const [existing] =
          await tx`SELECT id,payload_hash,created_at FROM notification_events WHERE source_key=${source}`;
        if (existing) {
          check(
            existing.payload_hash === hash,
            "Idempotency key was already used for another announcement",
            409,
          );
          return { id: existing.id, created_at: existing.created_at };
        }
        const [rate] =
          await tx`SELECT count(*)::int AS count FROM notification_events WHERE source_key LIKE ${"announcement:" + user.id + ":%"} AND created_at>now()-interval '1 minute'`;
        check(
          rate.count < 10,
          "Announcement limit reached. Try again in a minute.",
          429,
        );
        const [row] =
          await tx`INSERT INTO notification_events(source_key,channel,kind,title,body,priority,audience,payload_hash)
          VALUES(${source},'announcements','announcement',${input.title},${input.body},${input.priority},${tx.json({ mode: input.roles.length ? "roles" : "all", roles: input.roles })},${hash})
          ON CONFLICT(source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id,payload_hash,created_at`;
        check(
          row.payload_hash === hash,
          "Idempotency key was already used for another announcement",
          409,
        );
        return { id: row.id, created_at: row.created_at };
      });
    },
    async registerDevice(user, body) {
      check(
        user.sessionId,
        "Device registration requires an internal session",
        403,
      );
      check(
        body &&
          typeof body.token === "string" &&
          body.token.length >= 20 &&
          body.token.length <= 4096 &&
          /^[\x21-\x7E]+$/.test(body.token),
        "Invalid push token",
      );
      check(
        ["web", "android", "ios"].includes(body.platform),
        "Invalid device platform",
      );
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${user.sessionId},35))`;
        // Token rotation replaces the previous token for this installation's
        // session, preventing duplicate sends to old and new tokens.
        await tx`DELETE FROM notification_devices WHERE user_id=${user.id} AND session_id=${user.sessionId} AND token<>${body.token}`;
        // A token bound to another active session cannot be stolen by guessing it.
        const [row] =
          await tx`INSERT INTO notification_devices(user_id,session_id,token,platform)
          VALUES(${user.id},${user.sessionId},${body.token},${body.platform})
          ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,session_id=EXCLUDED.session_id,platform=EXCLUDED.platform,updated_at=now()
          WHERE notification_devices.user_id=EXCLUDED.user_id OR NOT EXISTS(SELECT 1 FROM internal_user_sessions s WHERE s.id=notification_devices.session_id AND s.revoked_at IS NULL AND s.expires_at>now())
          RETURNING id,platform`;
        check(
          row,
          "Device belongs to another active account. Sign out of that account first.",
          409,
        );
        return row;
      });
    },
    async deviceStatus(user) {
      if (!user.sessionId) return { enabled: false };
      const [row] =
        await sql`SELECT EXISTS(SELECT 1 FROM notification_devices WHERE user_id=${user.id} AND session_id=${user.sessionId}) AS enabled`;
      return row;
    },
    async removeSessionDevices(user) {
      if (user.sessionId)
        await sql`DELETE FROM notification_devices WHERE user_id=${user.id} AND session_id=${user.sessionId}`;
      return { success: true };
    },
    async removeDevice(user, id) {
      uuid(id);
      await sql`DELETE FROM notification_devices WHERE id=${id} AND user_id=${user.id}`;
      return { success: true };
    },
    async health(user) {
      check(user.isFounder, "Founder access required", 403);
      const [events, deliveries] = await Promise.all([
        sql`SELECT count(*) FILTER(WHERE processed_at IS NULL AND dead_at IS NULL)::int AS pending,count(*) FILTER(WHERE dead_at IS NOT NULL)::int AS dead,min(created_at) FILTER(WHERE processed_at IS NULL AND dead_at IS NULL) AS oldest_pending FROM notification_events`,
        sql`SELECT transport,state,count(*)::int AS count FROM notification_deliveries GROUP BY transport,state`,
      ]);
      const [failedEvents, failedDeliveries] = await Promise.all([
        sql`SELECT id,channel,kind,attempts,last_error FROM notification_events WHERE dead_at IS NOT NULL ORDER BY dead_at DESC LIMIT 50`,
        sql`SELECT id,transport,attempts,last_error FROM notification_deliveries WHERE state='dead' ORDER BY available_at DESC LIMIT 50`,
      ]);
      return {
        events: events[0],
        deliveries,
        failed_events: failedEvents,
        failed_deliveries: failedDeliveries,
        capabilities: capabilities(),
      };
    },
    async retryEvent(user, id) {
      check(user.isFounder, "Founder access required", 403);
      uuid(id);
      const [row] =
        await sql`UPDATE notification_events SET dead_at=NULL,attempts=0,available_at=now(),last_error=NULL WHERE id=${id} AND dead_at IS NOT NULL RETURNING id`;
      check(row, "Failed event not found", 404);
      return row;
    },
    async retry(user, id) {
      check(user.isFounder, "Founder access required", 403);
      uuid(id);
      const [row] =
        await sql`UPDATE notification_deliveries SET state='pending',attempts=0,available_at=now(),last_error=NULL WHERE id=${id} AND state='dead' RETURNING id`;
      check(row, "Failed delivery not found", 404);
      return row;
    },
  };
}
module.exports = { createNotificationService, eligible, visible };
