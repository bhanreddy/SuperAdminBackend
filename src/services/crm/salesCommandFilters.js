const { CrmError } = require('./errors');
const { parseTimezone, stableHash } = require('./helpers');
const { RULE_VERSION } = require('./salesCommandRules');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = new Set(['today', 'week', 'month', 'custom']);
const OUTCOMES = new Set(['OPEN', 'WON', 'LOST', 'DISQUALIFIED', 'LEGACY_UNKNOWN']);
const FOLLOWUP_STATES = new Set(['DUE_TODAY', 'OVERDUE', 'SEVERELY_OVERDUE', 'UPCOMING', 'MISSING', 'EXEMPT']);
const PILOT_STATES = new Set(['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'NONE', 'ENDING', 'END_OVERDUE']);
const METRICS = new Set([
  'new_leads', 'contacted', 'qualified', 'demo_scheduled', 'demo_completed', 'demo_cancelled', 'demo_no_show',
  'demos_upcoming', 'proposals_sent', 'active_proposals', 'active_pilots', 'pilot_started', 'wins', 'losses',
  'disqualified', 'open_pipeline', 'current_stage', 'due_today', 'overdue', 'severely_overdue', 'no_followup',
  'founder_attention', 'new_prospects', 'intake_backlog', 'cohort_numerator', 'cohort_denominator',
  'decision_numerator', 'decision_denominator',
  'campaign_leads', 'track_demo_requests', 'track_booked_demos', 'track_completed_demos', 'track_wins', 'track_losses',
]);
const BUCKETS = new Set(['0_2', '3_7', '8_14', '15_30', '31_plus', 'unknown']);
const ATTRIBUTION_MODELS = new Set(['first', 'latest']);
const CONVERSION_KINDS = new Set(['ENQUIRY_CREATED', 'DEMO_REQUESTED', 'DEMO_BOOKED', 'DEMO_COMPLETED', 'WON', 'LOST']);
const MEDIA = new Set(['QR', 'LINK']);
const QUERY_KEYS = new Set([
  'period', 'from_date', 'to_date', 'timezone', 'owner', 'assignee', 'territory_id', 'account_id', 'channel_id',
  'source', 'country', 'state', 'district', 'city', 'stage', 'outcome', 'followup_state', 'pilot_state',
  'reason_code', 'q', 'metric', 'bucket', 'part', 'limit', 'cursor', 'created_in_period', 'group', 'expected_total',
  'campaign_id', 'track_link_id', 'distribution_medium', 'attribution_model', 'conversion_kind', 'mandal', 'locality',
]);

function reject(message, code, details) {
  throw new CrmError(400, message, code, details);
}

function optionalUuid(value, label) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!UUID.test(text)) reject(`${label} must be a UUID`, 'BAD_FILTER');
  return text;
}

function optionalToken(value, max) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) reject('Filter text is invalid', 'BAD_FILTER');
  return text;
}

function geoToken(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (text === 'unknown') return 'unknown';
  if (text.length > 80 || /[\u0000-\u001f]/.test(text)) reject('Geography filter is invalid', 'BAD_FILTER');
  return text;
}

function partsInZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: bag.weekday,
  };
}

function zoneOffsetMs(instant, timeZone) {
  const part = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return asUtc - instant.getTime();
}

function zonedDateTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - zoneOffsetMs(new Date(utc), timeZone);
    if (Math.abs(next - utc) < 1000) return new Date(next);
    utc = next;
  }
  return new Date(utc);
}

function addCalendarDays(year, month, day, delta) {
  const utc = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function localMidnight(year, month, day, timeZone) {
  return zonedDateTimeToUtc(year, month, day, 0, 0, 0, timeZone);
}

function calendarDaysInclusive(start, end) {
  const a = Date.UTC(start.year, start.month - 1, start.day);
  const b = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((b - a) / 86400000) + 1;
}

function bindPeriod(input, evaluatedAt) {
  const T = new Date(evaluatedAt);
  if (Number.isNaN(T.getTime())) reject('Evaluation time is invalid', 'BAD_TIME');
  const tz = input.timezone;
  const local = partsInZone(T, tz);
  let from;
  let to = T;
  if (input.period === 'today') {
    from = localMidnight(local.year, local.month, local.day, tz);
  } else if (input.period === 'week') {
    const weekday = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[local.weekday];
    const monday = addCalendarDays(local.year, local.month, local.day, -weekday);
    from = localMidnight(monday.year, monday.month, monday.day, tz);
  } else if (input.period === 'month') {
    from = localMidnight(local.year, local.month, 1, tz);
  } else {
    const start = input.fromDate;
    const end = input.toDate;
    if (!start || !end) reject('Custom ranges require from_date and to_date', 'BAD_RANGE');
    if (start > end) reject('The date range is reversed', 'BAD_RANGE');
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    if (calendarDaysInclusive({ year: sy, month: sm, day: sd }, { year: ey, month: em, day: ed }) > 366) {
      reject('Date ranges are limited to 366 calendar days', 'BAD_RANGE');
    }
    from = localMidnight(sy, sm, sd, tz);
    const after = addCalendarDays(ey, em, ed, 1);
    to = localMidnight(after.year, after.month, after.day, tz);
    if (from >= T && to > T) reject('The range is entirely in the future', 'BAD_RANGE');
    if (to > T) to = T;
    if (!(from < to)) reject('The date range is empty', 'BAD_RANGE');
  }
  if (!(from < to)) reject('The date range is empty', 'BAD_RANGE');
  const duration = to.getTime() - from.getTime();
  const previousTo = from;
  const previousFrom = new Date(from.getTime() - duration);
  const nextLocal = addCalendarDays(local.year, local.month, local.day, 1);
  return {
    from,
    to,
    previousFrom,
    previousTo,
    nextLocalMidnight: localMidnight(nextLocal.year, nextLocal.month, nextLocal.day, tz),
    label: input.period === 'custom'
      ? 'custom local dates'
      : `${input.period} to date`,
  };
}

function parseSalesCommandQuery(query, scope) {
  const source = query || {};
  if (source && (Array.isArray(source) || typeof source !== 'object')) reject('Filters must be a query object', 'BAD_FILTER');
  for (const key of Object.keys(source)) {
    if (!QUERY_KEYS.has(key)) reject(`Unsupported filter: ${key}`, 'UNSUPPORTED_FILTER');
    const value = source[key];
    if (value && typeof value === 'object') reject(`Unsupported filter: ${key}`, 'UNSUPPORTED_FILTER');
  }
  const period = String(source.period || 'month').trim().toLowerCase();
  if (!PERIODS.has(period)) reject('period must be today, week, month, or custom', 'BAD_FILTER');
  const timezone = parseTimezone(source.timezone);
  const fromDate = source.from_date ? String(source.from_date).trim() : null;
  const toDate = source.to_date ? String(source.to_date).trim() : null;
  if ((fromDate && !DATE.test(fromDate)) || (toDate && !DATE.test(toDate))) reject('Dates must be YYYY-MM-DD', 'BAD_RANGE');
  if (period !== 'custom' && (fromDate || toDate)) reject('from_date and to_date are only valid for a custom period', 'BAD_RANGE');

  let owner = null;
  let unassigned = false;
  if (source.owner != null && source.owner !== '') {
    const text = String(source.owner).trim();
    if (text === 'unassigned') unassigned = true;
    else if (!UUID.test(text)) reject('owner must be a UUID or unassigned', 'BAD_FILTER');
    else owner = text;
  }
  if (unassigned && scope.kind !== 'platform') {
    throw new CrmError(403, 'Unassigned company intake is outside this scope', 'SCOPE_DENIED');
  }
  if (owner && scope.kind !== 'platform' && owner !== scope.founderId) {
    throw new CrmError(403, 'That owner is outside this scope', 'SCOPE_DENIED');
  }
  if (scope.kind !== 'platform') owner = owner || scope.founderId;

  const metric = source.metric ? String(source.metric).trim() : null;
  if (metric && !METRICS.has(metric)) reject('Unknown metric', 'BAD_METRIC');
  const bucket = source.bucket ? String(source.bucket).trim() : null;
  if (bucket && !BUCKETS.has(bucket)) reject('Unknown aging bucket', 'BAD_FILTER');
  const outcome = source.outcome ? String(source.outcome).trim().toUpperCase() : null;
  if (outcome && !OUTCOMES.has(outcome)) reject('Unknown outcome', 'BAD_FILTER');
  const followupState = source.followup_state ? String(source.followup_state).trim().toUpperCase() : null;
  if (followupState && !FOLLOWUP_STATES.has(followupState)) reject('Unknown follow-up state', 'BAD_FILTER');
  const pilotState = source.pilot_state ? String(source.pilot_state).trim().toUpperCase() : null;
  if (pilotState && !PILOT_STATES.has(pilotState)) reject('Unknown pilot state', 'BAD_FILTER');
  const group = source.group ? String(source.group).trim().toLowerCase() : 'day';
  if (!['day', 'week'].includes(group)) reject('group must be day or week', 'BAD_FILTER');
  const part = source.part ? String(source.part).trim().toLowerCase() : null;
  if (part && !['numerator', 'denominator'].includes(part)) reject('part must be numerator or denominator', 'BAD_FILTER');
  const limit = source.limit == null || source.limit === '' ? 25 : Number(source.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) reject('limit must be from 1 to 100', 'BAD_FILTER');
  const createdInPeriod = ['1', 'true', 'yes'].includes(String(source.created_in_period || '').toLowerCase());
  const stage = optionalToken(source.stage, 40);
  if (stage && !/^[A-Z0-9_]{2,40}$/.test(stage.toUpperCase())) reject('Unknown stage', 'BAD_FILTER');
  const attributionModel = source.attribution_model ? String(source.attribution_model).trim().toLowerCase() : 'first';
  if (!ATTRIBUTION_MODELS.has(attributionModel)) reject('attribution_model must be first or latest', 'BAD_FILTER');
  const medium = source.distribution_medium ? String(source.distribution_medium).trim().toUpperCase() : null;
  if (medium && !MEDIA.has(medium)) reject('distribution_medium must be QR or LINK', 'BAD_FILTER');
  const conversionKind = source.conversion_kind ? String(source.conversion_kind).trim().toUpperCase() : null;
  if (conversionKind && !CONVERSION_KINDS.has(conversionKind)) reject('Unknown conversion kind', 'BAD_FILTER');

  return {
    period,
    fromDate,
    toDate,
    timezone,
    ownerId: unassigned ? null : owner,
    unassigned,
    assigneeId: optionalUuid(source.assignee, 'assignee'),
    territoryId: optionalUuid(source.territory_id, 'territory_id'),
    accountId: optionalUuid(source.account_id, 'account_id'),
    channelId: optionalUuid(source.channel_id, 'channel_id'),
    source: optionalToken(source.source, 80),
    country: geoToken(source.country),
    state: geoToken(source.state),
    district: geoToken(source.district),
    city: geoToken(source.city),
    stage: stage ? stage.toUpperCase() : null,
    outcome,
    followupState,
    pilotState,
    reasonCode: optionalToken(source.reason_code, 40),
    q: optionalToken(source.q, 120),
    metric,
    bucket,
    part,
    limit,
    cursor: source.cursor ? String(source.cursor) : null,
    createdInPeriod,
    group,
    expectedTotal: source.expected_total == null || source.expected_total === '' ? null : Number(source.expected_total),
    campaignId: optionalUuid(source.campaign_id, 'campaign_id'),
    trackLinkId: optionalUuid(source.track_link_id, 'track_link_id'),
    distributionMedium: medium,
    attributionModel,
    conversionKind,
    mandal: geoToken(source.mandal),
    locality: geoToken(source.locality),
    scopeFingerprint: `${scope.kind}:${scope.founderId || 'platform'}`,
    scopeKind: scope.kind,
    founderId: scope.kind === 'platform' ? null : scope.founderId,
  };
}

function normalizedFilters(input, period) {
  return {
    period: input.period,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    timezone: input.timezone,
    owner: input.unassigned ? 'unassigned' : input.ownerId,
    assignee: input.assigneeId,
    territory_id: input.territoryId,
    account_id: input.accountId,
    channel_id: input.channelId,
    source: input.source,
    country: input.country,
    state: input.state,
    district: input.district,
    city: input.city,
    stage: input.stage,
    outcome: input.outcome,
    followup_state: input.followupState,
    pilot_state: input.pilotState,
    reason_code: input.reasonCode,
    q: input.q,
    created_in_period: input.createdInPeriod,
    metric: input.metric,
    bucket: input.bucket,
    part: input.part,
    group: input.group,
    campaign_id: input.campaignId,
    track_link_id: input.trackLinkId,
    distribution_medium: input.distributionMedium,
    attribution_model: input.attributionModel,
    conversion_kind: input.conversionKind,
    mandal: input.mandal,
    locality: input.locality,
  };
}

function filterHash(input, period) {
  return stableHash({
    rule_version: RULE_VERSION,
    scope: input.scopeFingerprint,
    filters: normalizedFilters(input, period),
  });
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(token, expectedHash) {
  if (!token) return null;
  if (token.length > 800) reject('Invalid cursor', 'BAD_CURSOR');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    reject('Invalid cursor', 'BAD_CURSOR');
  }
  if (!payload || payload.v !== 1 || payload.h !== expectedHash) reject('Invalid cursor', 'BAD_CURSOR');
  if (payload.id && !UUID.test(payload.id)) reject('Invalid cursor', 'BAD_CURSOR');
  if (payload.entity_key && !/^(enquiry|account):[0-9a-f-]{36}$/i.test(payload.entity_key)) reject('Invalid cursor', 'BAD_CURSOR');
  return payload;
}

module.exports = {
  METRICS,
  parseSalesCommandQuery,
  bindPeriod,
  normalizedFilters,
  filterHash,
  encodeCursor,
  decodeCursor,
  partsInZone,
  localMidnight,
};
