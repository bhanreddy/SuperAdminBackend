const crypto = require('crypto');
const { CrmError } = require('./errors');
const { classifyUpload } = require('../../utils/uploadBytes');

const CATEGORIES = ['feature_request', 'objection', 'curriculum_finding', 'unsure'];
const CONTEXTS = ['customer_interaction', 'class_session', 'demo', 'visit', 'other'];
const STATUSES = ['new', 'needs_clarification', 'accepted', 'in_progress', 'resolved', 'duplicate', 'declined'];
const URGENCIES = ['low', 'normal', 'high', 'critical'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const DESTINATIONS = ['product', 'sales_enablement', 'curriculum', 'triage'];
const VIEWS = ['mine', 'triage', 'product', 'sales_enablement', 'curriculum'];
const ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);
const REASON_STATUSES = new Set(['needs_clarification', 'resolved', 'duplicate', 'declined']);

const CATEGORY_LABELS = {
  feature_request: 'Feature request',
  objection: 'Objection',
  curriculum_finding: 'Curriculum finding',
  unsure: 'Unsure',
};

const CONTEXT_LABELS = {
  customer_interaction: 'Customer interaction',
  class_session: 'Class/session',
  demo: 'Demo',
  visit: 'Visit',
  other: 'Other',
};

const STATUS_LABELS = {
  new: 'New',
  needs_clarification: 'Needs clarification',
  accepted: 'Accepted',
  in_progress: 'In progress',
  resolved: 'Resolved',
  duplicate: 'Duplicate',
  declined: 'Declined',
};

const SIGNALS = [
  { category: 'objection', pattern: /\b(price|budget|expensive|too long|cannot buy|can't buy|cannot afford|too costly|onboarding takes)\b/i },
  { category: 'feature_request', pattern: /\b(offline|bulk import|feature request|allow offline|add bulk)\b/i },
  { category: 'curriculum_finding', pattern: /\b(lesson|answer key|fractions|curriculum)\b/i },
];

function mixedIssueHint(text) {
  const hits = SIGNALS.filter((signal) => signal.pattern.test(String(text || ''))).map((signal) => signal.category);
  if (hits.length < 2) return null;
  return {
    categories: hits,
    message: 'This note may contain more than one issue. A triager can split it into linked backlog items. Nothing is split automatically.',
  };
}

function resolveDestination(rules, category) {
  const active = (rules || []).filter((rule) => rule.active !== false && rule.category === category);
  if (!active.length) {
    return { destination_key: 'triage', routing_reason: 'no_rule', rule_ids: [] };
  }
  const keys = [...new Set(active.map((rule) => rule.destination_key))];
  if (keys.length > 1) {
    return { destination_key: 'triage', routing_reason: 'conflict', rule_ids: active.map((rule) => rule.id).filter(Boolean) };
  }
  const winner = [...active].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0))[0];
  return { destination_key: winner.destination_key, routing_reason: 'rule', rule_ids: winner.id ? [winner.id] : [] };
}

function cleanText(value, max, field, { required = false, min = 1 } = {}) {
  const text = String(value ?? '').trim();
  if (!text && !required) return null;
  if (!text) throw new CrmError(400, `${field} is required`, 'VALIDATION', { field });
  if (text.length < min) throw new CrmError(400, `${field} is too short`, 'VALIDATION', { field });
  if (text.length > max) throw new CrmError(400, `${field} is too long`, 'VALIDATION', { field });
  return text;
}

function enumValue(value, allowed, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new CrmError(400, `${field} is required`, 'VALIDATION', { field });
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) throw new CrmError(400, `${field} is not recognized`, 'VALIDATION', { field });
  return text;
}

function uuidOrNull(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new CrmError(400, `${field} is not a valid id`, 'VALIDATION', { field });
  }
  return text;
}

function reasonText(value, field = 'reason') {
  return cleanText(value, 500, field, { required: true, min: 8 });
}

function decodeAttachment(file) {
  const fileName = cleanText(file?.file_name, 120, 'attachment file name', { required: true });
  if (!/^[\w.\- ()]+$/.test(fileName)) {
    throw new CrmError(400, 'Attachment file name contains unsupported characters', 'VALIDATION', { field: 'attachments' });
  }
  const contentType = enumValue(String(file?.content_type || '').toLowerCase(), [...ATTACHMENT_TYPES], 'attachment type', { required: true });
  let bytes;
  try {
    bytes = Buffer.from(String(file?.data_base64 || ''), 'base64');
  } catch {
    throw new CrmError(400, 'Attachment could not be read', 'VALIDATION', { field: 'attachments' });
  }
  if (!bytes.length || bytes.length > 1_000_000) {
    throw new CrmError(400, 'Each attachment must be between 1 byte and 1 MB', 'VALIDATION', { field: 'attachments' });
  }
  const classified = classifyUpload(bytes, contentType);
  if (!classified.ok) {
    throw new CrmError(400, classified.error, 'VALIDATION', { field: 'attachments' });
  }
  return {
    file_name: fileName,
    content_type: contentType,
    byte_size: bytes.length,
    checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
    content: bytes,
  };
}

function validateSubmission(body) {
  const feedbackType = enumValue(body?.feedback_type, CATEGORIES, 'feedback type', { required: true });
  const title = cleanText(body?.title, 140, 'title', { required: true, min: 3 });
  const observation = cleanText(body?.observation, 4000, 'what was heard or observed', { required: true, min: 10 });
  const contextKind = enumValue(body?.context_kind, CONTEXTS, 'context', { required: true });
  const attachments = Array.isArray(body?.attachments) ? body.attachments.map(decodeAttachment) : [];
  if (attachments.length > 5) throw new CrmError(400, 'No more than 5 attachments', 'VALIDATION', { field: 'attachments' });
  const clientKey = cleanText(body?.client_key, 80, 'client key', { required: true, min: 8 });
  if (!/^[A-Za-z0-9:_-]+$/.test(clientKey)) {
    throw new CrmError(400, 'client key contains unsupported characters', 'VALIDATION', { field: 'client_key' });
  }
  const normalized = {
    client_key: clientKey,
    feedback_type: feedbackType,
    title,
    observation,
    context_kind: contextKind,
    context_note: cleanText(body?.context_note, 500, 'context note'),
    source_type: enumValue(body?.source_type, ['enquiry', 'account', 'school'], 'source type'),
    source_id: cleanText(body?.source_id, 80, 'source id'),
    account_id: uuidOrNull(body?.account_id, 'account'),
    customer_label: cleanText(body?.customer_label, 200, 'account, school, or customer'),
    product_area: cleanText(body?.product_area, 120, 'product area'),
    course_name: cleanText(body?.course_name ?? body?.course, 120, 'course'),
    module_name: cleanText(body?.module_name ?? body?.module, 120, 'module'),
    lesson_name: cleanText(body?.lesson_name ?? body?.lesson, 120, 'lesson'),
    impact: cleanText(body?.impact, 1000, 'impact'),
    reported_urgency: enumValue(body?.urgency ?? body?.reported_urgency, URGENCIES, 'urgency'),
    evidence: cleanText(body?.evidence, 2000, 'evidence'),
    attachments,
  };
  if (normalized.source_type && !normalized.source_id) {
    throw new CrmError(400, 'source id is required when a source record is set', 'VALIDATION', { field: 'source_id' });
  }
  normalized.payload_hash = payloadHash(normalized);
  return normalized;
}

function payloadHash(input) {
  const canonical = {
    feedback_type: input.feedback_type,
    title: input.title,
    observation: input.observation,
    context_kind: input.context_kind,
    account_id: input.account_id,
    customer_label: input.customer_label,
    source_type: input.source_type,
    source_id: input.source_id,
    attachments: (input.attachments || []).map((file) => ({ file_name: file.file_name, checksum: file.checksum })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function titleTokens(title) {
  return new Set(String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3));
}

module.exports = {
  CATEGORIES,
  CONTEXTS,
  STATUSES,
  URGENCIES,
  PRIORITIES,
  DESTINATIONS,
  VIEWS,
  REASON_STATUSES,
  CATEGORY_LABELS,
  CONTEXT_LABELS,
  STATUS_LABELS,
  mixedIssueHint,
  resolveDestination,
  validateSubmission,
  payloadHash,
  uuidOrNull,
  reasonText,
  enumValue,
  cleanText,
  titleTokens,
};
