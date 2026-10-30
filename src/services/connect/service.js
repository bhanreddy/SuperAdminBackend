const { randomUUID } = require('node:crypto');

class ConnectError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
function ensure(condition, message, status) {
  if (!condition) throw new ConnectError(message, status);
}
function uuid(value) {
  ensure(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
    'Invalid identifier',
  );
  return value.toLowerCase();
}
function text(value, max, required = true) {
  ensure(typeof value === 'string', 'Text is required');
  const result = value.trim();
  ensure(
    result.length <= max &&
      (!required || result.length > 0) &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result),
    `Text must be ${required ? '1' : '0'}–${max} characters`,
  );
  return result;
}
function sequence(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  ensure(Number.isSafeInteger(n) && n >= 0, 'Invalid sequence');
  return n;
}
const EMOJI = ['👍', '❤️', '🎉', '👀', '✅'];

function createConnectService(db, { organizationCode = 'nexsyrus' } = {}) {
  async function run(user, fn, action = 'request') {
    uuid(user?.id);
    return db.begin(async (tx) => {
      await tx`SET LOCAL ROLE collaboration_api`;
      await tx`SELECT set_config('connect.actor',${user.id},true)`;
      const [organization] =
        await tx`SELECT id,code,name FROM collaboration_organizations WHERE code=${organizationCode}`;
      ensure(
        organization,
        'Active company employee membership is required',
        403,
      );
      await tx`SELECT set_config('connect.organization',${organization.id},true)`;
      const [rate] =
        await tx`INSERT INTO collaboration_rate_limits(user_id,action,bucket)
        VALUES(${user.id},${action},date_trunc('minute',clock_timestamp()))
        ON CONFLICT(user_id,action,bucket) DO UPDATE SET count=collaboration_rate_limits.count+1 RETURNING count`;
      ensure(
        rate.count <= ({ send: 30, upload: 10 }[action] || 180),
        'Too many requests; try again shortly',
        429,
      );
      return fn(tx, organization);
    });
  }
  async function audit(tx, user, action, entityId, details = {}) {
    // Transactional: unlike best-effort global logAudit, failure rolls back the mutation.
    await tx`INSERT INTO audit_logs(user_id,action,entity,entity_id,details,created_at)
      VALUES(${user.id},${action},'CONNECT',${entityId},${tx.json(details)},now())`;
  }
  async function readable(tx, id, lock = false) {
    uuid(id);
    // A row SELECT FOR UPDATE also applies UPDATE policies and hides read-only
    // announcement/archive rows. A transaction advisory lock preserves read authorization.
    if (lock) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
    const rows =
      await tx`SELECT c.*,ch.archived_at,ch.announcements_only FROM collaboration_conversations c
          LEFT JOIN collaboration_channels ch ON ch.id=c.id WHERE c.id=${id}`;
    ensure(rows[0], 'Conversation not found', 404);
    return rows[0];
  }
  async function hydrate(tx, ids) {
    if (!ids.length) return [];
    const rows = await tx`SELECT m.*,u.full_name AS sender_name,
      (SELECT count(*)::int FROM collaboration_messages t WHERE t.parent_id=m.id) AS reply_count,
      COALESCE((SELECT json_agg(json_build_object('user_id',r.user_id,'emoji',r.emoji)) FROM collaboration_message_reactions r WHERE r.message_id=m.id),'[]') AS reactions,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'filename',a.filename,'mime',a.mime,'byte_size',a.byte_size)) FROM collaboration_attachments a WHERE a.message_id=m.id),'[]') AS attachments,
      COALESCE((SELECT json_agg(json_build_object('user_id',mm.user_id,'name',mu.full_name)) FROM collaboration_message_mentions mm JOIN internal_users mu ON mu.id=mm.user_id WHERE mm.message_id=m.id),'[]') AS mentions
      FROM collaboration_messages m JOIN internal_users u ON u.id=m.sender_id WHERE m.id IN ${tx(ids)}`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }
  async function message(tx, id) {
    uuid(id);
    const [row] = await hydrate(tx, [id]);
    ensure(row, 'Message not found', 404);
    return row;
  }
  async function mentions(tx, messageId, conversationId, ids, user) {
    ensure(
      Array.isArray(ids) && ids.length <= 12,
      'At most 12 employee mentions are allowed',
    );
    const targets = [...new Set(ids.map(uuid))];
    for (const id of targets) {
      const [valid] =
        await tx`SELECT collaboration_can_read(${conversationId}::uuid,${id}::uuid) AS allowed`;
      ensure(valid.allowed, 'Mention target is not a conversation member', 403);
    }
    await tx`DELETE FROM collaboration_message_mentions WHERE message_id=${messageId}`;
    for (const id of targets) {
      await tx`INSERT INTO collaboration_message_mentions(message_id,user_id) VALUES(${messageId},${id}) ON CONFLICT DO NOTHING`;
    }
  }
  return {
    run,
    async bootstrap(user) {
      return run(user, async (tx, organization) => {
        const [self] =
          await tx`SELECT id,full_name,employee_id,role FROM internal_users WHERE id=${user.id}`;
        const [permissions] =
          await tx`SELECT collaboration_admin(${organization.id}) AS can_manage`;
        const channels =
          await tx`SELECT ch.*,EXISTS(SELECT 1 FROM collaboration_channel_members cm WHERE cm.channel_id=ch.id AND cm.user_id=${user.id}) AS joined,
          collaboration_manages(ch.id) AS can_manage,
          (SELECT count(*)::int FROM collaboration_messages m WHERE m.conversation_id=ch.id AND m.deleted_at IS NULL
            AND m.sender_id<>${user.id} AND m.sequence>COALESCE((SELECT last_sequence FROM collaboration_message_reads r WHERE r.conversation_id=ch.id AND r.user_id=${user.id}),0)) AS unread_count
          FROM collaboration_channels ch WHERE ch.organization_id=${organization.id} ORDER BY ch.name`;
        const directMessages =
          await tx`SELECT c.id,c.kind,c.last_sequence,c.created_at,
          CASE WHEN c.dm_low=${user.id} THEN c.dm_high ELSE c.dm_low END AS employee_id,
          u.full_name AS name,
          (SELECT count(*)::int FROM collaboration_messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL AND m.sender_id<>${user.id}
            AND m.sequence>COALESCE((SELECT last_sequence FROM collaboration_message_reads r WHERE r.conversation_id=c.id AND r.user_id=${user.id}),0)) AS unread_count
          FROM collaboration_conversations c JOIN internal_users u ON u.id=CASE WHEN c.dm_low=${user.id} THEN c.dm_high ELSE c.dm_low END
          WHERE c.organization_id=${organization.id} AND c.kind='dm' ORDER BY c.updated_at DESC LIMIT 200`;
        const [notifications] =
          await tx`SELECT count(*)::int AS unread FROM collaboration_notifications WHERE read_at IS NULL`;
        const [preferences] =
          await tx`SELECT mode,push_enabled FROM collaboration_notification_preferences WHERE organization_id=${organization.id} AND user_id=${user.id}`;
        return {
          organization,
          self,
          can_manage: permissions.can_manage,
          channels,
          direct_messages: directMessages,
          unread_notifications: notifications.unread,
          preferences: preferences || { mode: 'mentions', push_enabled: false },
        };
      });
    },
    async employees(user, query = '', conversationId) {
      const q = text(String(query), 80, false).replace(/[\\%_]/g, '\\$&');
      return run(user, async (tx, org) => {
        if (conversationId) await readable(tx, conversationId);
        return tx`SELECT u.id,u.full_name,u.employee_id,u.role FROM internal_users u
          JOIN collaboration_organization_members om ON om.user_id=u.id AND om.organization_id=${org.id}
          WHERE u.status='ACTIVE' AND u.role NOT IN ('CA','CA_LEAD')
          AND (u.full_name ILIKE ${`%${q}%`} OR u.employee_id ILIKE ${`%${q}%`})
          AND (${conversationId || null}::uuid IS NULL OR collaboration_can_read(${conversationId || null}::uuid,u.id))
          ORDER BY u.full_name,u.id LIMIT 40`;
      });
    },
    async createChannel(user, input) {
      const name = text(input.name, 64).toLowerCase();
      ensure(
        /^[a-z0-9][a-z0-9-]{1,63}$/.test(name),
        'Use 2–64 lowercase letters, numbers or hyphens',
      );
      const description = text(input.description || '', 1000, false),
        purpose = text(input.purpose || '', 250, false);
      const visibility = input.visibility || 'public',
        category = input.category || 'company';
      ensure(
        ['public', 'private'].includes(visibility) &&
          ['company', 'department', 'project'].includes(category),
        'Invalid channel type',
      );
      ensure(
        input.announcements_only === undefined ||
          typeof input.announcements_only === 'boolean',
        'Invalid posting permission',
      );
      return run(user, async (tx, org) => {
        const [allowed] = await tx`SELECT collaboration_admin(${org.id}) AS ok`;
        ensure(allowed.ok, 'Company administrator required', 403);
        const id = randomUUID();
        await tx`INSERT INTO collaboration_conversations(id,organization_id,kind,created_by) VALUES(${id},${org.id},'channel',${user.id})`;
        await tx`INSERT INTO collaboration_channels(id,organization_id,name,description,purpose,visibility,category,announcements_only)
          VALUES(${id},${org.id},${name},${description},${purpose},${visibility},${category},${input.announcements_only === true})`;
        await tx`INSERT INTO collaboration_channel_members(channel_id,user_id,role) VALUES(${id},${user.id},'manager')`;
        await audit(tx, user, 'CONNECT_CHANNEL_CREATED', id, {
          name,
          visibility,
        });
        return { id, name };
      });
    },
    async updateChannel(user, id, input) {
      uuid(id);
      return run(user, async (tx) => {
        const [channel] =
          await tx`SELECT *,collaboration_manages(id) AS can_manage FROM collaboration_channels WHERE id=${id} FOR UPDATE`;
        ensure(channel?.can_manage, 'Channel manager required', 403);
        const description =
          input.description === undefined
            ? channel.description
            : text(input.description, 1000, false);
        const purpose =
          input.purpose === undefined
            ? channel.purpose
            : text(input.purpose, 250, false);
        ensure(
          input.archived === undefined || typeof input.archived === 'boolean',
          'Invalid archive state',
        );
        ensure(
          input.announcements_only === undefined ||
            typeof input.announcements_only === 'boolean',
          'Invalid posting permission',
        );
        const [row] =
          await tx`UPDATE collaboration_channels SET description=${description},purpose=${purpose},
          archived_at=${input.archived === undefined ? channel.archived_at : input.archived ? new Date() : null},
          announcements_only=${input.announcements_only ?? channel.announcements_only},updated_at=now() WHERE id=${id} RETURNING *`;
        await audit(tx, user, 'CONNECT_CHANNEL_UPDATED', id, {
          archived: !!row.archived_at,
          announcements_only: row.announcements_only,
        });
        return row;
      });
    },
    async members(user, id) {
      uuid(id);
      return run(
        user,
        (tx) =>
          tx`SELECT m.user_id,m.role,u.full_name,u.employee_id FROM collaboration_channel_members m JOIN internal_users u ON u.id=m.user_id WHERE m.channel_id=${id} ORDER BY u.full_name`,
      );
    },
    async membership(
      user,
      channelId,
      targetId,
      role = 'member',
      remove = false,
    ) {
      uuid(channelId);
      uuid(targetId);
      ensure(['member', 'manager'].includes(role), 'Invalid member role');
      return run(user, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${channelId},0))`;
        const [channel] =
          await tx`SELECT *,collaboration_manages(id) AS manages FROM collaboration_channels WHERE id=${channelId}`;
        ensure(channel, 'Channel not found', 404);
        ensure(
          channel.manages ||
            (targetId === user.id &&
              (remove ||
                (channel.visibility === 'public' && role === 'member'))),
          'Membership management denied',
          403,
        );
        if (remove) {
          const [target] =
            await tx`SELECT role FROM collaboration_channel_members WHERE channel_id=${channelId} AND user_id=${targetId}`;
          if (target?.role === 'manager') {
            const [others] =
              await tx`SELECT count(*)::int AS n FROM collaboration_channel_members WHERE channel_id=${channelId} AND role='manager' AND user_id<>${targetId}`;
            ensure(
              others.n > 0,
              'Assign another channel manager before removing the last manager',
            );
          }
          await tx`DELETE FROM collaboration_channel_members WHERE channel_id=${channelId} AND user_id=${targetId}`;
        } else {
          if (channel.manages) {
            const [old] =
              await tx`SELECT role FROM collaboration_channel_members WHERE channel_id=${channelId} AND user_id=${targetId}`;
            if (old?.role === 'manager' && role === 'member') {
              const [others] =
                await tx`SELECT count(*)::int AS n FROM collaboration_channel_members WHERE channel_id=${channelId} AND role='manager' AND user_id<>${targetId}`;
              ensure(others.n > 0, 'Keep at least one channel manager');
            }
            await tx`INSERT INTO collaboration_channel_members(channel_id,user_id,role) VALUES(${channelId},${targetId},${role})
              ON CONFLICT(channel_id,user_id) DO UPDATE SET role=EXCLUDED.role`;
          } else
            await tx`INSERT INTO collaboration_channel_members(channel_id,user_id,role) VALUES(${channelId},${targetId},'member') ON CONFLICT DO NOTHING`;
        }
        await audit(
          tx,
          user,
          remove ? 'CONNECT_MEMBER_REMOVED' : 'CONNECT_MEMBER_ADDED',
          channelId,
          { user_id: targetId, role },
        );
        return { success: true };
      });
    },
    async provisionEmployee(user, targetId, remove = false) {
      uuid(targetId);
      return run(user, async (tx, org) => {
        const [allowed] = await tx`SELECT collaboration_admin(${org.id}) AS ok`;
        ensure(allowed.ok, 'Company administrator required', 403);
        if (remove)
          await tx`DELETE FROM collaboration_organization_members WHERE organization_id=${org.id} AND user_id=${targetId}`;
        else {
          const [target] =
            await tx`SELECT id FROM internal_users WHERE id=${targetId} AND status='ACTIVE' AND role NOT IN ('CA','CA_LEAD')`;
          ensure(target, 'Active internal employee required', 400);
          await tx`INSERT INTO collaboration_organization_members(organization_id,user_id) VALUES(${org.id},${targetId}) ON CONFLICT DO NOTHING`;
        }
        await audit(
          tx,
          user,
          remove ? 'CONNECT_EMPLOYEE_REMOVED' : 'CONNECT_EMPLOYEE_PROVISIONED',
          targetId,
        );
        return { success: true };
      });
    },
    async directMessage(user, targetId) {
      uuid(targetId);
      ensure(targetId !== user.id, 'Choose another employee');
      const [low, high] = [user.id, targetId].sort();
      return run(user, async (tx, org) => {
        const [target] =
          await tx`SELECT collaboration_in_org(${org.id},${targetId}::uuid) AS ok`;
        ensure(target.ok, 'Employee not found', 404);
        await tx`INSERT INTO collaboration_conversations(organization_id,kind,dm_low,dm_high,created_by)
          VALUES(${org.id},'dm',${low},${high},${user.id}) ON CONFLICT(organization_id,dm_low,dm_high) DO NOTHING`;
        const [row] =
          await tx`SELECT id FROM collaboration_conversations WHERE organization_id=${org.id} AND dm_low=${low} AND dm_high=${high}`;
        return row;
      });
    },
    async history(user, id, options = {}) {
      uuid(id);
      const before = sequence(options.before, Number.MAX_SAFE_INTEGER),
        after = sequence(options.after),
        limit = Math.min(100, Math.max(1, sequence(options.limit, 50)));
      const parent = options.parent ? uuid(options.parent) : null;
      return run(user, async (tx) => {
        const conv = await readable(tx, id);
        if (parent) {
          const root = await message(tx, parent);
          ensure(
            root.conversation_id === id && !root.parent_id,
            'Invalid thread parent',
          );
        }
        const rows =
          await tx`SELECT m.id FROM collaboration_messages m WHERE m.conversation_id=${id}
          AND m.sequence<${before} AND m.sequence>${after}
          AND (${options.after !== undefined} OR m.parent_id IS NOT DISTINCT FROM ${parent}::uuid)
          ORDER BY m.sequence ${options.after !== undefined ? tx`ASC` : tx`DESC`} LIMIT ${limit + 1}`;
        const ids = rows.slice(0, limit);
        if (options.after === undefined) ids.reverse();
        const messages = await hydrate(
          tx,
          ids.map((row) => row.id),
        );
        return {
          messages,
          has_more: rows.length > limit,
          last_sequence: Number(conv.last_sequence),
        };
      });
    },
    async getMessage(user, id) {
      return run(user, (tx) => message(tx, id));
    },
    async send(user, conversationId, input) {
      uuid(conversationId);
      const clientId = uuid(input.client_id),
        body = text(input.body, 8000);
      const parent = input.parent_id ? uuid(input.parent_id) : null;
      return run(
        user,
        async (tx) => {
          const conv = await readable(tx, conversationId, true);
          const [existing] =
            await tx`SELECT id FROM collaboration_messages WHERE conversation_id=${conversationId} AND sender_id=${user.id} AND client_id=${clientId}`;
          if (existing) return message(tx, existing.id);
          const [post] =
            await tx`SELECT collaboration_can_post(${conversationId}::uuid) AS allowed`;
          ensure(
            post.allowed,
            'Posting is disabled for this conversation',
            403,
          );
          const [counter] =
            await tx`UPDATE collaboration_conversations SET last_sequence=last_sequence+1,updated_at=now() WHERE id=${conv.id} RETURNING last_sequence`;
          const [row] =
            await tx`INSERT INTO collaboration_messages(conversation_id,sender_id,client_id,sequence,parent_id,body)
          VALUES(${conversationId},${user.id},${clientId},${counter.last_sequence},${parent},${body}) RETURNING id`;
          await mentions(
            tx,
            row.id,
            conversationId,
            input.mentions || [],
            user,
          );
          await tx`SELECT collaboration_notify(${row.id}::uuid)`;
          return message(tx, row.id);
        },
        'send',
      );
    },
    async edit(user, id, input, remove = false) {
      uuid(id);
      return run(user, async (tx) => {
        const old = await message(tx, id);
        await readable(tx, old.conversation_id, true);
        ensure(
          old.sender_id === user.id,
          'Only the author can change this message',
          403,
        );
        ensure(!old.deleted_at, 'Message was deleted', 409);
        const body = remove ? '' : text(input.body, 8000);
        const [row] =
          await tx`UPDATE collaboration_messages SET body=${body},edited_at=now(),deleted_at=${remove ? new Date() : null}
          WHERE id=${id} RETURNING id`;
        ensure(row, 'Message cannot be changed', 403);
        await mentions(
          tx,
          id,
          old.conversation_id,
          remove ? [] : input.mentions || [],
          user,
        );
        if (!remove) await tx`SELECT collaboration_notify(${id}::uuid)`;
        await audit(
          tx,
          user,
          remove ? 'CONNECT_MESSAGE_DELETED' : 'CONNECT_MESSAGE_EDITED',
          id,
        );
        return message(tx, id);
      });
    },
    async react(user, id, emoji, remove = false) {
      uuid(id);
      ensure(EMOJI.includes(emoji), 'Unsupported reaction');
      return run(user, async (tx) => {
        const m = await message(tx, id);
        ensure(!m.deleted_at, 'Message was deleted', 409);
        if (remove)
          await tx`DELETE FROM collaboration_message_reactions WHERE message_id=${id} AND user_id=${user.id} AND emoji=${emoji}`;
        else
          await tx`INSERT INTO collaboration_message_reactions(message_id,user_id,emoji) VALUES(${id},${user.id},${emoji}) ON CONFLICT DO NOTHING`;
        return message(tx, id);
      });
    },
    async markRead(user, id, value) {
      uuid(id);
      const last = sequence(value);
      return run(user, async (tx) => {
        const conv = await readable(tx, id);
        const watermark = Math.min(last, Number(conv.last_sequence));
        const [row] =
          await tx`INSERT INTO collaboration_message_reads(conversation_id,user_id,last_sequence)
          VALUES(${id},${user.id},${watermark}) ON CONFLICT(conversation_id,user_id)
          DO UPDATE SET last_sequence=GREATEST(collaboration_message_reads.last_sequence,EXCLUDED.last_sequence),updated_at=now() RETURNING last_sequence`;
        await tx`UPDATE collaboration_notifications n SET read_at=COALESCE(read_at,now()) WHERE conversation_id=${id} AND user_id=${user.id}
          AND EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=n.message_id AND m.sequence<=${row.last_sequence}) AND read_at IS NULL`;
        return { last_sequence: Number(row.last_sequence) };
      });
    },
    async notifications(user, before) {
      if (before)
        ensure(
          !Number.isNaN(Date.parse(before)),
          'Invalid notification cursor',
        );
      return run(
        user,
        (
          tx,
        ) => tx`SELECT n.id,n.kind,n.read_at,n.created_at,n.conversation_id,n.message_id,m.parent_id,
        CASE WHEN m.deleted_at IS NULL THEN left(m.body,180) ELSE 'Message deleted' END AS preview,u.full_name AS sender_name
        FROM collaboration_notifications n JOIN collaboration_messages m ON m.id=n.message_id JOIN internal_users u ON u.id=m.sender_id
        WHERE n.user_id=${user.id} AND (${before || null}::timestamptz IS NULL OR n.created_at<${before || null}::timestamptz)
        ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,
      );
    },
    async readNotification(user, id) {
      uuid(id);
      return run(user, async (tx) => {
        const [row] =
          await tx`UPDATE collaboration_notifications SET read_at=COALESCE(read_at,now()) WHERE id=${id} AND user_id=${user.id} RETURNING id`;
        ensure(row, 'Notification not found', 404);
        return row;
      });
    },
    async preferences(user, input) {
      ensure(
        ['all', 'mentions', 'muted'].includes(input.mode),
        'Invalid notification preference',
      );
      ensure(
        input.push_enabled === undefined ||
          typeof input.push_enabled === 'boolean',
        'Invalid push preference',
      );
      ensure(
        input.push_enabled !== true,
        'Employee push delivery has not been configured',
        503,
      );
      return run(user, async (tx, org) => {
        const [row] =
          await tx`INSERT INTO collaboration_notification_preferences(organization_id,user_id,mode,push_enabled)
          VALUES(${org.id},${user.id},${input.mode},${input.push_enabled === true}) ON CONFLICT(organization_id,user_id)
          DO UPDATE SET mode=EXCLUDED.mode,push_enabled=EXCLUDED.push_enabled,updated_at=now() RETURNING mode,push_enabled`;
        return row;
      });
    },
    async search(user, options = {}) {
      const q = text(options.q || '', 120, false);
      const channel = options.conversation_id
          ? uuid(options.conversation_id)
          : null,
        sender = options.sender_id ? uuid(options.sender_id) : null;
      for (const date of [options.after_date, options.before_date])
        if (date)
          ensure(
            /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)),
            'Invalid search date',
          );
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      return run(user, async (tx, org) => {
        const rows = await tx`SELECT m.id FROM collaboration_messages m
          WHERE m.deleted_at IS NULL AND (${q === '' ? true : false} OR to_tsvector('simple',m.body) @@ plainto_tsquery('simple',${q}))
          AND (${channel}::uuid IS NULL OR m.conversation_id=${channel}) AND (${sender}::uuid IS NULL OR m.sender_id=${sender})
          AND (${options.after_date || null}::date IS NULL OR m.created_at>=${options.after_date || null}::date)
          AND (${options.before_date || null}::date IS NULL OR m.created_at<${options.before_date || null}::date+interval '1 day')
          AND (${options.mentions_only === 'true' || options.mentions_only === true} IS FALSE OR EXISTS(SELECT 1 FROM collaboration_message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=${user.id}))
          ORDER BY m.created_at DESC,m.id DESC LIMIT 50`;
        const messages = await hydrate(
          tx,
          rows.map((row) => row.id),
        );
        const channels =
          await tx`SELECT id,name,purpose FROM collaboration_channels WHERE organization_id=${org.id} AND name ILIKE ${`%${escaped}%`} ORDER BY name LIMIT 30`;
        const employees =
          await tx`SELECT u.id,u.full_name,u.employee_id,u.role FROM internal_users u JOIN collaboration_organization_members om ON om.user_id=u.id
          WHERE om.organization_id=${org.id} AND u.status='ACTIVE' AND u.role NOT IN ('CA','CA_LEAD') AND u.full_name ILIKE ${`%${escaped}%`} ORDER BY u.full_name LIMIT 30`;
        return { messages, channels, employees };
      });
    },
  };
}
module.exports = {
  createConnectService,
  ConnectError,
  uuid,
  text,
  sequence,
  EMOJI,
};
