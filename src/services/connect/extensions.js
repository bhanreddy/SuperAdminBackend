const { randomUUID } = require('node:crypto');
const { uuid, text, ConnectError } = require('./service');
const { validateFile } = require('./files');
const ensure = (v, m, s = 400) => {
  if (!v) throw new ConnectError(m, s);
};
function createConnectExtensions(service, storage) {
  return {
    async attachments(user, messageId) {
      uuid(messageId);
      return service.run(
        user,
        (tx) =>
          tx`SELECT id,message_id,filename,mime,byte_size,created_at FROM collaboration_attachments WHERE message_id=${messageId}`,
      );
    },
    async upload(user, messageId, file) {
      uuid(messageId);
      // Authorize before processing or contacting storage.
      const original = await service.getMessage(user, messageId);
      ensure(
        original.sender_id === user.id && !original.deleted_at,
        'Only the author can attach files to a live message',
        403,
      );
      let metadata = validateFile(file);
      if (metadata.mime.startsWith('image/')) {
        try {
          const sharp = require('sharp');
          const image = sharp(file.buffer, {
            limitInputPixels: 16000000,
            failOn: 'warning',
          }).rotate();
          file = {
            ...file,
            buffer: await (
              metadata.mime === 'image/png' ? image.png() : image.jpeg()
            ).toBuffer(),
          };
          metadata = validateFile(file);
        } catch {
          throw new ConnectError('Invalid or oversized image');
        }
      }
      ensure(storage, 'Private storage is unavailable', 503);
      let key = null;
      try {
        return await service.run(
          user,
          async (tx, org) => {
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${messageId},0))`;
            const [m] =
              await tx`SELECT id,conversation_id FROM collaboration_messages WHERE id=${messageId} AND sender_id=${user.id} AND deleted_at IS NULL`;
            ensure(m, 'Message not found', 404);
            const [existing] =
              await tx`SELECT id,filename,mime,byte_size FROM collaboration_attachments WHERE message_id=${messageId} AND sha256=${metadata.sha256}`;
            if (existing) return existing;
            const [count] =
              await tx`SELECT count(*)::int AS n FROM collaboration_attachments WHERE message_id=${messageId}`;
            ensure(count.n < 5, 'At most five attachments per message');
            const id = randomUUID();
            key = `${org.id}/${m.conversation_id}/${id}.${metadata.extension}`;
            await storage.put(key, file.buffer, metadata.mime);
            const [row] =
              await tx`INSERT INTO collaboration_attachments(id,message_id,uploaded_by,filename,mime,byte_size,storage_path,sha256)
          VALUES(${id},${messageId},${user.id},${metadata.filename},${metadata.mime},${metadata.byte_size},${key},${metadata.sha256}) RETURNING id,filename,mime,byte_size`;
            await tx`INSERT INTO audit_logs(user_id,action,entity,entity_id,details,created_at) VALUES(${user.id},'CONNECT_ATTACHMENT_ADDED','CONNECT',${id},'{}',now())`;
            return row;
          },
          'upload',
        );
      } catch (err) {
        if (key)
          try {
            await storage.remove(key);
          } catch {
            console.error('[Connect] private attachment cleanup required');
          }
        throw err;
      }
    },
    async download(user, id) {
      uuid(id);
      ensure(storage, 'Private storage is unavailable', 503);
      // Return bytes through the authenticated API, never a public/signed URL.
      return service.run(user, async (tx) => {
        const [row] =
          await tx`SELECT * FROM collaboration_attachments WHERE id=${id}`;
        ensure(row, 'Attachment not found', 404);
        return { ...row, bytes: await storage.get(row.storage_path) };
      });
    },
    async save(user, id, remove = false) {
      uuid(id);
      return service.run(user, async (tx) => {
        if (remove)
          await tx`DELETE FROM collaboration_saved_messages WHERE user_id=${user.id} AND message_id=${id}`;
        else
          await tx`INSERT INTO collaboration_saved_messages(user_id,message_id) VALUES(${user.id},${id}) ON CONFLICT DO NOTHING`;
        return { success: true };
      });
    },
    async saved(user) {
      return service.run(
        user,
        (tx) =>
          tx`SELECT s.message_id,m.conversation_id,left(m.body,180) AS preview,m.deleted_at,s.created_at FROM collaboration_saved_messages s JOIN collaboration_messages m ON m.id=s.message_id WHERE s.user_id=${user.id} ORDER BY s.created_at DESC LIMIT 100`,
      );
    },
    async pin(user, id, remove = false) {
      uuid(id);
      return service.run(user, async (tx) => {
        const [m] =
          await tx`SELECT id,conversation_id FROM collaboration_messages WHERE id=${id} AND deleted_at IS NULL`;
        ensure(m, 'Message not found', 404);
        const [p] =
          await tx`SELECT collaboration_manages(${m.conversation_id}::uuid) AS ok`;
        ensure(p.ok, 'Channel manager required', 403);
        if (remove)
          await tx`DELETE FROM collaboration_pinned_messages WHERE message_id=${id}`;
        else
          await tx`INSERT INTO collaboration_pinned_messages(message_id,pinned_by) VALUES(${id},${user.id}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO audit_logs(user_id,action,entity,entity_id,details,created_at) VALUES(${user.id},${remove ? 'CONNECT_UNPINNED' : 'CONNECT_PINNED'},'CONNECT',${id},'{}',now())`;
        return { success: true };
      });
    },
    async pins(user, conversationId) {
      uuid(conversationId);
      return service.run(
        user,
        (tx) =>
          tx`SELECT p.message_id,m.conversation_id,left(m.body,180) AS preview,m.deleted_at,p.created_at FROM collaboration_pinned_messages p JOIN collaboration_messages m ON m.id=p.message_id WHERE m.conversation_id=${conversationId} ORDER BY p.created_at DESC LIMIT 100`,
      );
    },
    async presence(user, input) {
      ensure(
        ['online', 'away', 'busy'].includes(input.status),
        'Invalid presence',
      );
      const note = text(input.note || '', 120, false);
      return service.run(user, async (tx, org) => {
        const [row] =
          await tx`INSERT INTO collaboration_presence(organization_id,user_id,status,note,expires_at)
          VALUES(${org.id},${user.id},${input.status},${note},now()+interval '5 minutes') ON CONFLICT(organization_id,user_id)
          DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,expires_at=EXCLUDED.expires_at,updated_at=now() RETURNING user_id,status,note,expires_at`;
        return row;
      });
    },
    async listPresence(user) {
      return service.run(
        user,
        (tx, org) =>
          tx`SELECT user_id,CASE WHEN expires_at>now() THEN status ELSE 'away' END AS status,CASE WHEN expires_at>now() THEN note ELSE '' END AS note FROM collaboration_presence WHERE organization_id=${org.id} LIMIT 500`,
      );
    },
    async task(user, id, input) {
      uuid(id);
      uuid(input.assigned_to);
      const school = Number(input.school_id);
      ensure(
        Number.isSafeInteger(school) && school > 0,
        'Choose a valid school',
      );
      const title = text(input.title, 180),
        description = text(input.description || '', 4000, false),
        priority = input.priority || 'MEDIUM',
        status = input.status || 'NOT_STARTED';
      ensure(
        ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority) &&
          ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED'].includes(status),
        'Invalid task priority/status',
      );
      const deadline = input.deadline ? new Date(input.deadline) : null;
      ensure(
        !deadline || !Number.isNaN(deadline.getTime()),
        'Invalid deadline',
      );
      return service.run(user, async (tx) => {
        const [row] =
          await tx`SELECT collaboration_convert_task(${id}::uuid,${school},${title},${description},${input.assigned_to}::uuid,${priority},${deadline},${status}) AS task_id`;
        return { ...row, school_id: school };
      });
    },
  };
}
module.exports = { createConnectExtensions };
