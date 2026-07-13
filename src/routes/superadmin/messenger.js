const express = require('express');
const sql = require('../../config/db');
const crmSql = require('../../config/crmDb');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const router = express.Router();
router.use(verifySuperAdminMiddleware);

router.get('/website-conversations', async (_req, res) => {
  try {
    const rows = await crmSql`SELECT id, website_key, visitor_email, visitor_phone, page_url, status, last_message_at, last_message_preview, created_at FROM website_chat_conversations ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT 500`;
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Website messenger list failed:', err);
    return res.status(500).json({ error: 'Failed to list website conversations' });
  }
});

router.get('/website-conversations/:id/messages', async (req, res) => {
  const [conversation] = await crmSql`SELECT id, website_key, visitor_email, visitor_phone, page_url, status, created_at FROM website_chat_conversations WHERE id = ${req.params.id}`;
  if (!conversation) return res.status(404).json({ error: 'Website conversation not found' });
  const messages = await crmSql`SELECT id, conversation_id, sender_type, body, created_at, (sender_type = 'SUPPORT') AS is_support, CASE WHEN sender_type = 'SUPPORT' THEN 'Nexsyrus Support' ELSE ${conversation.visitor_email} END AS sender_name FROM website_chat_messages WHERE conversation_id = ${conversation.id} ORDER BY created_at`;
  return sendResponse(res, 200, { conversation, messages });
});

router.post('/website-conversations/:id/messages', async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > 4000) return res.status(400).json({ error: 'Message must be 1-4000 characters' });
  const [message] = await crmSql.begin(async (tx) => {
    const rows = await tx`INSERT INTO website_chat_messages (conversation_id, sender_type, sender_admin_id, body) VALUES (${req.params.id}, 'SUPPORT', ${req.superAdmin.id}, ${body}) RETURNING id, conversation_id, sender_type, body, created_at`;
    await tx`UPDATE website_chat_conversations SET last_message_at = now(), last_message_preview = ${body.slice(0, 100)}, updated_at = now() WHERE id = ${req.params.id}`;
    return rows;
  });
  return sendResponse(res, 201, { ...message, sender_name: 'Nexsyrus Support', is_support: true });
});

// Primary-DB support inbox only: this reads the shared jztckbup database via
// src/config/db.js. Multi-cluster database fan-out is intentionally out of scope.

router.get('/conversations', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT mc.id, mc.school_id, s.name AS school_name,
             school_user.id AS user_id,
             school_person.display_name AS user_name,
             school_person.photo_url AS user_photo,
             COALESCE(role_info.portal_role, 'unknown') AS portal_role,
             mc.last_message_at, mc.last_message_preview, mc.created_at,
             COALESCE((
               SELECT COUNT(*) FROM messages m
               WHERE m.conversation_id = mc.id
                 AND m.deleted_at IS NULL
                 AND m.sender_user_id != support_user.id
                 AND (support_participant.last_read_at IS NULL OR m.created_at > support_participant.last_read_at)
             ), 0)::int AS unread_count
      FROM message_conversations mc
      JOIN schools s ON s.id = mc.school_id
      JOIN message_participants support_participant ON support_participant.conversation_id = mc.id
        AND support_participant.school_id = mc.school_id
      JOIN users support_user ON support_user.id = support_participant.user_id
        AND support_user.school_id = mc.school_id
        AND support_user.is_support_bot = true
        AND support_user.deleted_at IS NULL
      JOIN message_participants school_participant ON school_participant.conversation_id = mc.id
        AND school_participant.school_id = mc.school_id
        AND school_participant.user_id != support_user.id
      JOIN users school_user ON school_user.id = school_participant.user_id
        AND school_user.school_id = mc.school_id
      JOIN persons school_person ON school_person.id = school_user.person_id
        AND school_person.school_id = mc.school_id
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN bool_or(r.code = 'admin') THEN 'admin'
          WHEN bool_or(r.code = 'principal') THEN 'principal'
          WHEN bool_or(r.code = 'accountant') THEN 'accounts'
          WHEN bool_or(r.code IN ('teacher', 'staff')) THEN 'staff'
          WHEN bool_or(r.code = 'driver') THEN 'driver'
          WHEN bool_or(r.code IN ('student', 'parent')) THEN 'student'
          ELSE 'unknown' END AS portal_role
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id AND r.school_id = mc.school_id
        WHERE ur.user_id = school_user.id AND ur.school_id = mc.school_id
      ) role_info ON true
      WHERE mc.pair_type = 'support' AND mc.deleted_at IS NULL
      ORDER BY mc.last_message_at DESC NULLS LAST, mc.created_at DESC
      LIMIT 500
    `;
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Support messenger list failed:', err);
    return res.status(500).json({ error: 'Failed to list support conversations' });
  }
});

async function getSupportConversation(id) {
  const [row] = await sql`
    SELECT mc.id, mc.school_id, s.name AS school_name,
           support_user.id AS support_user_id,
           school_user.id AS user_id,
           school_person.display_name AS user_name,
           school_person.photo_url AS user_photo,
           COALESCE(role_info.portal_role, 'unknown') AS portal_role
    FROM message_conversations mc
    JOIN schools s ON s.id = mc.school_id
    JOIN message_participants support_mp ON support_mp.conversation_id = mc.id AND support_mp.school_id = mc.school_id
    JOIN users support_user ON support_user.id = support_mp.user_id
      AND support_user.school_id = mc.school_id AND support_user.is_support_bot = true AND support_user.deleted_at IS NULL
    JOIN message_participants school_mp ON school_mp.conversation_id = mc.id
      AND school_mp.school_id = mc.school_id AND school_mp.user_id != support_user.id
    JOIN users school_user ON school_user.id = school_mp.user_id AND school_user.school_id = mc.school_id
    JOIN persons school_person ON school_person.id = school_user.person_id AND school_person.school_id = mc.school_id
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN bool_or(r.code = 'admin') THEN 'admin'
        WHEN bool_or(r.code = 'principal') THEN 'principal'
        WHEN bool_or(r.code = 'accountant') THEN 'accounts'
        WHEN bool_or(r.code IN ('teacher', 'staff')) THEN 'staff'
        WHEN bool_or(r.code = 'driver') THEN 'driver'
        WHEN bool_or(r.code IN ('student', 'parent')) THEN 'student'
        ELSE 'unknown' END AS portal_role
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.school_id = mc.school_id
      WHERE ur.user_id = school_user.id AND ur.school_id = mc.school_id
    ) role_info ON true
    WHERE mc.id = ${id} AND mc.pair_type = 'support' AND mc.deleted_at IS NULL
    LIMIT 1
  `;
  return row || null;
}

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conversation = await getSupportConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Support conversation not found' });
    const rows = await sql`
      SELECT m.id, m.conversation_id, m.sender_user_id, m.body,
             m.created_at, m.edited_at, m.deleted_at,
             p.display_name AS sender_name,
             (m.sender_user_id = ${conversation.support_user_id}) AS is_support
      FROM messages m
      JOIN users u ON u.id = m.sender_user_id AND u.school_id = ${conversation.school_id}
      JOIN persons p ON p.id = u.person_id AND p.school_id = ${conversation.school_id}
      WHERE m.conversation_id = ${conversation.id} AND m.school_id = ${conversation.school_id}
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 1000
    `;
    return sendResponse(res, 200, { conversation, messages: rows });
  } catch (err) {
    console.error('Support messenger thread failed:', err);
    return res.status(500).json({ error: 'Failed to load support messages' });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Message body is required' });
    if (body.length > 4000) return res.status(400).json({ error: 'Message body cannot exceed 4000 characters' });
    const conversation = await getSupportConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Support conversation not found' });
    const message = await sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO messages (conversation_id, school_id, sender_user_id, body)
        VALUES (${conversation.id}, ${conversation.school_id}, ${conversation.support_user_id}, ${body})
        RETURNING id, conversation_id, sender_user_id, body, created_at, edited_at, deleted_at
      `;
      // Durable hand-off to the SchoolIMS Firebase worker. This is in the same
      // transaction as the message, so a committed reply can never lose its push.
      await tx`
        INSERT INTO support_message_notification_outbox
          (message_id, conversation_id, school_id, target_user_id, preview)
        VALUES (${created.id}, ${conversation.id}, ${conversation.school_id}, ${conversation.user_id}, ${body.slice(0, 120)})
        ON CONFLICT (message_id) DO NOTHING
      `;
      return created;
    });
    return sendResponse(res, 201, { ...message, sender_name: 'Nexsyrus Support', is_support: true });
  } catch (err) {
    console.error('Support messenger send failed:', err);
    return res.status(500).json({ error: 'Failed to send support message' });
  }
});

router.post('/conversations/:id/read', async (req, res) => {
  try {
    const conversation = await getSupportConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Support conversation not found' });
    await sql`
      UPDATE message_participants
      SET last_read_at = GREATEST(COALESCE(last_read_at, to_timestamp(0)), now())
      WHERE conversation_id = ${conversation.id}
        AND school_id = ${conversation.school_id}
        AND user_id = ${conversation.support_user_id}
    `;
    return sendResponse(res, 200, { read: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to mark support conversation read' });
  }
});

module.exports = router;
