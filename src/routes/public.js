const express = require('express');
const crypto = require('crypto');
const sql = require('../config/db');
const crmSql = require('../config/crmDb');
const { schoolSupabaseAdmin } = require('../config/supabase');
const { sendResponse } = require('../utils/apiResponse');
const { renderVerificationHtml } = require('../utils/employeeDocument');

const BUCKET = 'festival-posters';
const VALID_APPS = ['schoolims', 'medipos', 'paperforge'];

const router = express.Router();
const WEBSITE_KEYS = new Set(['main-site', 'school-erp', 'medical-erp', 'e-commerce', 'restaurant-management', 'bhanu-site']);
const visitorToken = (req) => String(req.get('x-visitor-token') || '').trim();

// GET /api/public/hr-documents/verify/:token
// Public certificate verification deliberately exposes only identity and
// document metadata. Payroll amounts, bank details and statutory identifiers
// never leave the authenticated payroll API.
router.get('/hr-documents/verify/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  try {
    let record = null;
    if (uuid.test(token)) {
      [record] = await sql`
        SELECT d.document_type, d.document_number, d.title, d.generated_at,
               e.full_name, e.employee_code, e.designation, e.department
        FROM employee_documents d
        JOIN employees e ON e.id = d.employee_id
        WHERE d.verification_token = ${token}::uuid
        LIMIT 1
      `.catch(() => []);
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    return res.status(record ? 200 : 404).send(renderVerificationHtml(record));
  } catch (err) {
    console.error('HR document verification failed:', err);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(renderVerificationHtml(null));
  }
});

router.post('/website-chat/start', async (req, res) => {
  try {
    const email = clean(req.body?.email, 180).toLowerCase();
    const phone = clean(req.body?.phone, 30);
    const websiteKey = clean(req.body?.websiteKey, 80).toLowerCase();
    const pageUrl = clean(req.body?.pageUrl, 500);
    if (!WEBSITE_KEYS.has(websiteKey)) return res.status(400).json({ error: 'Unknown website' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!/^[+\d][\d\s()-]{7,20}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
    if (!allowEnquiry(req.ip || 'unknown')) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const token = crypto.randomUUID();
    const [conversation] = await crmSql`
      INSERT INTO website_chat_conversations (visitor_token, website_key, visitor_email, visitor_phone, page_url, user_agent)
      VALUES (${token}, ${websiteKey}, ${email}, ${phone}, ${pageUrl || null}, ${clean(req.get('user-agent'), 500) || null})
      RETURNING id, website_key, created_at
    `;
    return sendResponse(res, 201, { conversationId: conversation.id, visitorToken: token, messages: [] });
  } catch (err) {
    console.error('Website chat start failed:', err);
    return res.status(500).json({ error: 'Unable to start chat' });
  }
});

router.get('/website-chat/:id/messages', async (req, res) => {
  const token = visitorToken(req);
  const [conversation] = await crmSql`SELECT id FROM website_chat_conversations WHERE id = ${req.params.id} AND visitor_token = ${token}::uuid`.catch(() => []);
  if (!conversation) return res.status(403).json({ error: 'Invalid chat session' });
  return sendResponse(res, 200, await crmSql`SELECT id, sender_type, body, created_at FROM website_chat_messages WHERE conversation_id = ${conversation.id} ORDER BY created_at`);
});

router.post('/website-chat/:id/messages', async (req, res) => {
  const token = visitorToken(req);
  const body = clean(req.body?.body, 4000);
  if (!body) return res.status(400).json({ error: 'Message is required' });
  const [conversation] = await crmSql`SELECT id FROM website_chat_conversations WHERE id = ${req.params.id} AND visitor_token = ${token}::uuid AND status = 'OPEN'`.catch(() => []);
  if (!conversation) return res.status(403).json({ error: 'Invalid chat session' });
  const [message] = await crmSql.begin(async (tx) => {
    const rows = await tx`INSERT INTO website_chat_messages (conversation_id, sender_type, body) VALUES (${conversation.id}, 'VISITOR', ${body}) RETURNING id, sender_type, body, created_at`;
    await tx`UPDATE website_chat_conversations SET last_message_at = now(), last_message_preview = ${body.slice(0, 100)}, updated_at = now() WHERE id = ${conversation.id}`;
    return rows;
  });
  return sendResponse(res, 201, message);
});

const clean = (value, max) => String(value || '').trim().slice(0, max);
const enquiryAttempts = new Map();

function allowEnquiry(ip) {
  const now = Date.now();
  const recent = (enquiryAttempts.get(ip) || []).filter((at) => now - at < 60 * 60 * 1000);
  if (recent.length >= 8) return false;
  recent.push(now);
  enquiryAttempts.set(ip, recent);
  return true;
}

// POST /api/public/enquiries
// Public website/app lead capture. The honeypot field is intentionally accepted
// but real submissions must leave it blank.
router.post('/enquiries', async (req, res) => {
  try {
    if (!allowEnquiry(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'Too many enquiries. Try again later.' });
    }
    const name = clean(req.body?.name, 120);
    const email = clean(req.body?.email, 180).toLowerCase();
    const phone = clean(req.body?.phone, 30);
    const message = clean(req.body?.message, 2000);
    const product = clean(req.body?.product, 80) || 'SchoolIMS';
    const website = clean(req.body?.website, 200);

    if (website) return sendResponse(res, 202, { accepted: true });
    if (!name || (!email && !phone)) {
      return res.status(400).json({ error: 'Name and either email or phone are required' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const [lead] = await crmSql`
      INSERT INTO enquiries (name, email, phone, website_source, category, status, message)
      VALUES (${name}, ${email || null}, ${phone || null}, 'NEXSYRUS_WEBSITE', ${product}, 'NEW', ${message || null})
      RETURNING id, created_at
    `;

    return sendResponse(res, 201, { accepted: true, enquiryId: lead.id });
  } catch (err) {
    console.error('Error creating public enquiry:', err);
    return res.status(500).json({ error: 'Failed to submit enquiry' });
  }
});

// GET /api/public/festival-poster?app=schoolims|medipos|paperforge
// Unauthenticated: consumed by every client app on dashboard mount.
router.get('/festival-poster', async (req, res) => {
  try {
    const app = String(req.query.app || '').toLowerCase();
    if (!VALID_APPS.includes(app)) {
      return res.status(400).json({ error: `app must be one of: ${VALID_APPS.join(', ')}` });
    }

    const [row] = await sql`
      SELECT id, title, image_path, ends_at
      FROM festival_posters
      WHERE is_active = TRUE
        AND now() BETWEEN starts_at AND ends_at
        AND ${app} = ANY(target_apps)
      ORDER BY created_at DESC
      LIMIT 1
    `;

    res.set('Cache-Control', 'public, max-age=300');
    if (!row) {
      return sendResponse(res, 200, { poster: null });
    }

    const { data } = schoolSupabaseAdmin.storage.from(BUCKET).getPublicUrl(row.image_path);
    return sendResponse(res, 200, {
      poster: {
        id: row.id,
        title: row.title,
        image_url: data?.publicUrl ?? null,
        ends_at: row.ends_at,
      },
    });
  } catch (err) {
    console.error('Error fetching festival poster:', err);
    return res.status(500).json({ error: 'Failed to fetch festival poster' });
  }
});

module.exports = router;
