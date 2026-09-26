const crypto = require('crypto');
const { CrmError } = require('./errors');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const OPEN_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL', 'NEGOTIATION', 'PILOT'];
const INTERACTION_TYPES = new Set(['CALL', 'EMAIL', 'MEETING', 'NOTE', 'DEMO', 'CUSTOMER_MESSAGE']);

function parseTimezone(value) {
  const tz = String(value || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new CrmError(400, 'Invalid timezone', 'BAD_TIMEZONE');
  }
  return tz;
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new CrmError(400, 'Amount must be a non-negative decimal with up to 2 places', 'BAD_AMOUNT');
  }
  return text;
}

function parseCurrency(value, fallback = 'INR') {
  const currency = String(value || fallback).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CrmError(400, 'Currency must be a 3-letter code', 'BAD_CURRENCY');
  return currency;
}

function legacyStatusFor(stage, outcome, previousStatus) {
  if (outcome === 'LEGACY_UNKNOWN') return previousStatus;
  if (outcome === 'WON') return 'CLOSED';
  if (outcome === 'LOST' || outcome === 'DISQUALIFIED') return 'REJECTED';
  if (stage === 'NEW' || stage === 'CONTACTED' || stage === 'QUALIFIED') return stage;
  return 'QUALIFIED';
}

function requireVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new CrmError(400, 'expected_version is required', 'VERSION_REQUIRED');
  }
  return version;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = /password|token|secret/i.test(key) ? '[redacted]' : redactSecrets(item);
  }
  return copy;
}

/**
 * School CRM accounts become ACTIVE only when the tenant is live and the
 * school has seeded defaults plus its first admin. Suspension is not churn.
 * pending_build and apk_delivered stay ONBOARDING.
 */
function evaluateActivation({ onboardingStatus, defaultsSeeded, firstAdminExists, currentLifecycle }) {
  if (onboardingStatus === 'suspended') {
    return { lifecycle: currentLifecycle || 'ONBOARDING', changed: false, reason: 'suspension_is_not_churn' };
  }
  if (onboardingStatus === 'live' && defaultsSeeded === true && firstAdminExists === true) {
    return { lifecycle: 'ACTIVE', changed: currentLifecycle !== 'ACTIVE', reason: 'live_and_ready' };
  }
  const next = currentLifecycle === 'ACTIVE' ? 'ACTIVE' : 'ONBOARDING';
  return { lifecycle: next === 'ACTIVE' ? 'ONBOARDING' : (currentLifecycle || 'ONBOARDING'), changed: currentLifecycle === 'ACTIVE', reason: 'not_live_ready' };
}

function interpretSchoolMatches(matches) {
  const found = (matches || []).filter(Boolean);
  if (found.length === 0) return { status: 404, error: 'School not found', code: 'NOT_FOUND' };
  if (found.length > 1) {
    return {
      status: 409,
      error: 'School id exists in more than one cluster. Pass cluster_id.',
      code: 'AMBIGUOUS_SCHOOL',
    };
  }
  return { status: 200, match: found[0] };
}

module.exports = {
  DEFAULT_TIMEZONE,
  OPEN_STAGES,
  INTERACTION_TYPES,
  parseTimezone,
  parseMoney,
  parseCurrency,
  legacyStatusFor,
  requireVersion,
  stableHash,
  redactSecrets,
  evaluateActivation,
  interpretSchoolMatches,
};
