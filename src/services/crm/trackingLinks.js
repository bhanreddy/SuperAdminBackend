const crypto = require('crypto');
const { CrmError } = require('./errors');
const { assertCrmWrite, assertAccountAccess, assertLeadAccess } = require('./accessPolicy');
const { assertActiveFounder } = require('./founderSync');
const { stableHash } = require('./helpers');
const { normalizeLocation, fold } = require('./normalization');
const { validateDestination } = require('./trackingDestination');
const { classifyOpen, referrerOrigin } = require('./trackingClassify');
const { hashToken, browserKey } = require('./trackingIngress');
const {
  CODE_PATTERN,
  CONTEXT_TTL_MS,
  ATTRIBUTION_RULE_VERSION,
  currentTrackingConfig,
  assertTrackingFlag,
} = require('./trackingConfig');

let codeFactory = () => crypto.randomBytes(12).toString('base64url');
let untrackedRedirects = 0;

function setShortCodeFactory(factory) {
  codeFactory = typeof factory === 'function' ? factory : () => crypto.randomBytes(12).toString('base64url');
}

function untrackedRedirectCount() {
  return untrackedRedirects;
}

function requireKey(body) {
  const key = String(body?.idempotency_key || '').trim();
  if (key.length < 8 || key.length > 200) throw new CrmError(400, 'idempotency_key is required', 'IDEMPOTENCY_KEY');
  return key;
}

function clip(value, max) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > max || /[\u0000-\u001f]/.test(text)) throw new CrmError(400, 'A text field is invalid', 'BAD_TEXT');
  return text;
}

function parseTags(tags) {
  if (tags == null || tags === '') return [];
  if (!Array.isArray(tags) || tags.length > 20) throw new CrmError(400, 'tags must be a list of at most 20', 'BAD_TAGS');
  return tags.map((tag) => {
    const text = String(tag || '').trim();
    if (!/^[A-Za-z0-9 _-]{1,40}$/.test(text)) throw new CrmError(400, 'A tag is invalid', 'BAD_TAGS');
    return text;
  });
}

function parseExpiry(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new CrmError(400, 'expires_at is invalid', 'BAD_TIME');
  return date.toISOString();
}

function enumValue(value, allowed, label) {
  const text = String(value || '').trim().toUpperCase();
  if (!allowed.has(text)) throw new CrmError(400, `${label} is invalid`, 'BAD_ENUM');
  return text;
}

function campaignCode(value, name) {
  const source = String(value || name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const code = source.slice(0, 48);
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(code)) throw new CrmError(400, 'Campaign code is invalid', 'BAD_CAMPAIGN');
  return code;
}

function stableUrl(code) {
  const origin = currentTrackingConfig().publicOrigin;
  if (!origin) throw new CrmError(503, 'TRACKING_PUBLIC_ORIGIN is not configured', 'TRACK_UNCONFIGURED');
  return `${origin}/d/${code}`;
}

function presentLink(link, revision) {
  return {
    id: link.id,
    short_code: link.short_code,
    stable_url: stableUrl(link.short_code),
    status: link.status,
    expires_at: link.expires_at,
    row_version: link.row_version,
    owner_founder_id: link.owner_founder_id,
    campaign_id: link.campaign_id,
    revision_id: revision.id,
    revision_version: revision.version,
    destination_url: revision.destination_url,
    destination_class: revision.destination_class,
    medium: revision.medium,
    purpose: revision.purpose,
    coverage: revision.destination_class === 'OWNED_SITE' ? 'owned_site' : 'unavailable',
    target_account_id: revision.target_account_id,
    target_enquiry_id: revision.target_enquiry_id,
    target_school_name_snapshot: revision.target_school_name_snapshot,
    target_cluster_id: revision.target_cluster_id,
    target_school_id: revision.target_school_id,
    district_normalized: revision.district_normalized,
    mandal_normalized: revision.mandal_normalized,
    created_at: link.created_at,
  };
}

async function replayOrStart(tx, scope, command, key, hash) {
  const receiptScope = `${scope.actor.id}:${command}`;
  const [existing] = await tx`
    SELECT response, request_hash FROM crm_command_receipts
    WHERE scope = ${receiptScope} AND idempotency_key = ${key}
  `;
  if (existing) {
    if (existing.request_hash !== hash) throw new CrmError(409, 'This idempotency key was already used for a different request', 'IDEMPOTENCY_CONFLICT');
    return { replay: existing.response, receiptScope };
  }
  return { replay: null, receiptScope };
}

async function storeReceipt(tx, receiptScope, key, hash, response) {
  await tx`
    INSERT INTO crm_command_receipts (scope, idempotency_key, request_hash, status_code, response)
    VALUES (${receiptScope}, ${key}, ${hash}, 200, ${tx.json(response)})
  `;
}

function ownerFor(scope, requested) {
  if (scope.kind !== 'platform') {
    if (requested && requested !== scope.founderId) throw new CrmError(403, 'Owner is outside this scope', 'SCOPE_DENIED');
    return scope.founderId;
  }
  if (!requested) throw new CrmError(400, 'owner_founder_id is required', 'OWNER_REQUIRED');
  return requested;
}

async function assertLinkVisible(scope, link) {
  if (!link) throw new CrmError(404, 'Track link not found', 'NOT_FOUND');
  if (scope.kind === 'platform') return link;
  if (link.owner_founder_id && link.owner_founder_id === scope.founderId) return link;
  throw new CrmError(404, 'Track link not found', 'NOT_FOUND');
}

async function loadCampaign(tx, scope, campaignId) {
  if (!campaignId) return null;
  const [campaign] = await tx`SELECT * FROM crm_campaigns WHERE id = ${campaignId}`;
  if (!campaign || campaign.status !== 'ACTIVE') throw new CrmError(400, 'Campaign is not active', 'BAD_CAMPAIGN');
  if (scope.kind !== 'platform' && campaign.owner_founder_id && campaign.owner_founder_id !== scope.founderId) {
    throw new CrmError(404, 'Campaign not found', 'NOT_FOUND');
  }
  return campaign;
}

async function loadChannel(tx, channelId) {
  if (!channelId) return null;
  const [channel] = await tx`SELECT * FROM crm_acquisition_channels WHERE id = ${channelId} AND archived_at IS NULL`;
  if (!channel) throw new CrmError(400, 'Channel is not active', 'BAD_CHANNEL');
  return channel;
}

async function loadTerritory(tx, scope, territoryId) {
  if (!territoryId) return null;
  const [territory] = await tx`SELECT * FROM crm_territories WHERE id = ${territoryId} AND archived_at IS NULL`;
  if (!territory) throw new CrmError(400, 'Territory is not active', 'BAD_TERRITORY');
  if (scope.kind !== 'platform') {
    const [member] = await tx`
      SELECT 1 FROM crm_territory_members WHERE territory_id = ${territory.id} AND founder_id = ${scope.founderId}
    `;
    if (!member) throw new CrmError(403, 'Territory is outside this scope', 'SCOPE_DENIED');
  }
  return territory;
}

async function assertTargets(tx, scope, body) {
  let account = null;
  let enquiry = null;
  if (body.target_account_id) {
    const [row] = await tx`SELECT * FROM crm_accounts WHERE id = ${body.target_account_id}`;
    account = assertAccountAccess(scope, row);
  }
  if (body.target_enquiry_id) {
    const [row] = await tx`SELECT * FROM enquiries WHERE id = ${body.target_enquiry_id}`;
    enquiry = assertLeadAccess(scope, row);
    if (account && enquiry.account_id && enquiry.account_id !== account.id) {
      throw new CrmError(400, 'Target enquiry does not belong to the target account', 'TARGET_MISMATCH');
    }
  }
  const clusterId = clip(body.target_cluster_id, 80);
  const schoolId = clip(body.target_school_id, 64);
  if (!clusterId && !schoolId) return { account, enquiry, directory: null };
  if (!clusterId || !schoolId) throw new CrmError(400, 'Verified schools need cluster_id and school_id', 'BAD_SCHOOL_TUPLE');
  const [directory] = await tx`
    SELECT cluster_id, school_id, crm_account_id, name
    FROM crm_school_customer_directory
    WHERE cluster_id = ${clusterId} AND school_id = ${schoolId} AND is_active = true
  `;
  if (!directory) throw new CrmError(400, 'Verified school tuple was not found in the CRM directory', 'SCHOOL_TUPLE_UNKNOWN');
  if (account && directory.crm_account_id && directory.crm_account_id !== account.id) {
    throw new CrmError(400, 'School tuple does not match the target account', 'SCHOOL_TUPLE_MISMATCH');
  }
  return { account, enquiry, directory };
}

function geoSnapshot(body) {
  const location = normalizeLocation({
    country: body.country || body.country_code,
    state: body.state,
    district: body.district,
    city: body.city,
    locality: body.locality,
  });
  const mandalRaw = clip(body.mandal, 80);
  return {
    country_code: location.country_code,
    state_raw: location.state_raw,
    state_normalized: location.state_normalized,
    district_raw: location.district_raw,
    district_normalized: location.district_normalized,
    mandal_raw: mandalRaw,
    mandal_normalized: mandalRaw ? fold(mandalRaw) : null,
    locality_raw: location.locality_raw,
    locality_normalized: location.locality_normalized,
  };
}

async function insertRevision(tx, scope, link, body, version, previous) {
  const destination = validateDestination(body.destination_url || previous?.destination_url);
  const ownerId = ownerFor(scope, body.owner_founder_id || previous?.owner_founder_id || link.owner_founder_id);
  await assertActiveFounder(tx, ownerId);
  const [owner] = await tx`SELECT id, full_name FROM founders WHERE id = ${ownerId}`;
  const campaign = await loadCampaign(tx, scope, body.campaign_id === undefined ? previous?.campaign_id : body.campaign_id);
  const channel = await loadChannel(tx, body.channel_id === undefined ? previous?.channel_id : body.channel_id);
  const territory = await loadTerritory(tx, scope, body.territory_id === undefined ? previous?.territory_id : body.territory_id);
  const targets = await assertTargets(tx, scope, {
    target_account_id: body.target_account_id === undefined ? previous?.target_account_id : body.target_account_id,
    target_enquiry_id: body.target_enquiry_id === undefined ? previous?.target_enquiry_id : body.target_enquiry_id,
    target_cluster_id: body.target_cluster_id === undefined ? previous?.target_cluster_id : body.target_cluster_id,
    target_school_id: body.target_school_id === undefined ? previous?.target_school_id : body.target_school_id,
  });
  const geo = geoSnapshot({
    country: body.country ?? body.country_code ?? previous?.country_code,
    state: body.state ?? previous?.state_raw,
    district: body.district ?? previous?.district_raw,
    locality: body.locality ?? previous?.locality_raw,
    mandal: body.mandal ?? previous?.mandal_raw,
  });
  const schoolName = targets.account?.name || targets.directory?.name || clip(body.target_school_name, 200) || previous?.target_school_name_snapshot || null;
  const medium = enumValue(body.medium || previous?.medium, new Set(['QR', 'LINK']), 'medium');
  const purpose = enumValue(body.purpose || previous?.purpose, new Set(['BROCHURE', 'DEMO', 'EVENT', 'LANDING']), 'purpose');
  const [revision] = await tx`
    INSERT INTO crm_track_link_revisions (
      link_id, version, destination_url, destination_class, source_code,
      channel_id, channel_code_snapshot, channel_label_snapshot,
      campaign_id, campaign_code_snapshot, campaign_name_snapshot, campaign_type_snapshot,
      medium, purpose, owner_founder_id, owner_name_snapshot,
      territory_id, territory_code_snapshot, territory_name_snapshot,
      country_code, state_raw, state_normalized, district_raw, district_normalized,
      mandal_raw, mandal_normalized, locality_raw, locality_normalized,
      target_account_id, target_enquiry_id, target_school_name_snapshot,
      target_cluster_id, target_school_id, tags, notes, actor_id, change_reason
    ) VALUES (
      ${link.id}, ${version}, ${destination.url}, ${destination.destinationClass}, ${clip(body.source, 80) || previous?.source_code || null},
      ${channel?.id || null}, ${channel?.code || null}, ${channel?.label || null},
      ${campaign?.id || null}, ${campaign?.code || null}, ${campaign?.name || null}, ${campaign?.type || null},
      ${medium}, ${purpose}, ${owner.id}, ${owner.full_name || null},
      ${territory?.id || null}, ${territory?.code || null}, ${territory?.name || null},
      ${geo.country_code}, ${geo.state_raw}, ${geo.state_normalized}, ${geo.district_raw}, ${geo.district_normalized},
      ${geo.mandal_raw}, ${geo.mandal_normalized}, ${geo.locality_raw}, ${geo.locality_normalized},
      ${targets.account?.id || null}, ${targets.enquiry?.id || null}, ${schoolName},
      ${targets.directory?.cluster_id || null}, ${targets.directory?.school_id || null},
      ${parseTags(body.tags == null ? previous?.tags : body.tags)}, ${clip(body.notes, 2000) || null},
      ${scope.actor.id}, ${clip(body.change_reason, 200)}
    ) RETURNING *
  `;
  return revision;
}

async function insertLink(tx, scope, body) {
  const ownerId = ownerFor(scope, body.owner_founder_id);
  await assertActiveFounder(tx, ownerId);
  const campaign = await loadCampaign(tx, scope, body.campaign_id || null);
  let code = null;
  let link = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    code = codeFactory();
    if (!CODE_PATTERN.test(code)) throw new CrmError(500, 'Generated code was invalid', 'BAD_CODE');
    const [row] = await tx`
      INSERT INTO crm_track_links (short_code, campaign_id, created_by, owner_founder_id, status, expires_at)
      VALUES (${code}, ${campaign?.id || null}, ${scope.actor.id}, ${ownerId}, 'ACTIVE', ${parseExpiry(body.expires_at)})
      ON CONFLICT (short_code) DO NOTHING
      RETURNING *
    `;
    if (row) {
      link = row;
      break;
    }
  }
  if (!link) throw new CrmError(503, 'Could not allocate a tracking code', 'CODE_EXHAUSTED');
  const revision = await insertRevision(tx, scope, link, { ...body, owner_founder_id: ownerId, campaign_id: campaign?.id || null }, 1, null);
  const [fresh] = await tx`
    UPDATE crm_track_links SET current_revision_id = ${revision.id} WHERE id = ${link.id} RETURNING *
  `;
  return presentLink(fresh, revision);
}

async function withReceipt(crmSql, scope, command, body, work) {
  assertCrmWrite(scope);
  assertTrackingFlag('write');
  const key = requireKey(body);
  const { idempotency_key, ...rest } = body;
  const hash = stableHash(rest);
  return crmSql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '3s'`);
    const started = await replayOrStart(tx, scope, command, key, hash);
    if (started.replay) return started.replay;
    const response = await work(tx);
    await storeReceipt(tx, started.receiptScope, key, hash, response);
    return response;
  });
}

async function createLink(crmSql, scope, body) {
  return withReceipt(crmSql, scope, 'track.link.create', body, (tx) => insertLink(tx, scope, body));
}

async function createBulk(crmSql, scope, body) {
  const rows = body?.links;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new CrmError(400, 'Bulk create accepts 1 to 100 links', 'BAD_BULK');
  }
  const errors = [];
  rows.forEach((row, index) => {
    try {
      validateDestination(row?.destination_url);
    } catch (err) {
      errors.push({ index, error: err.message, code: err.code || 'BAD_BULK' });
    }
  });
  if (errors.length) throw new CrmError(400, 'Bulk rows failed validation', 'BAD_BULK', errors);
  return withReceipt(crmSql, scope, 'track.link.bulk', body, async (tx) => {
    const links = [];
    for (const row of rows) {
      links.push(await insertLink(tx, scope, { ...body, ...row }));
    }
    return { links };
  });
}

async function listLinks(crmSql, scope, query) {
  assertTrackingFlag('write');
  const limit = Math.min(Number(query.limit || 50), 100);
  const search = clip(query.q, 80);
  const founderId = scope.kind === 'platform' ? (query.owner || null) : scope.founderId;
  const rows = await crmSql`
    SELECT l.*, r.destination_class, r.destination_url, r.medium, r.purpose, r.version,
           r.target_school_name_snapshot, r.target_account_id
    FROM crm_track_links l
    JOIN crm_track_link_revisions r ON r.id = l.current_revision_id
    WHERE (${founderId}::uuid IS NULL OR l.owner_founder_id = ${founderId})
      AND (${query.status || null}::text IS NULL OR l.status = ${query.status || null})
      AND (${search}::text IS NULL OR l.short_code = ${search})
    ORDER BY l.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => presentLink(row, {
    id: row.current_revision_id,
    version: row.version,
    destination_url: row.destination_url,
    destination_class: row.destination_class,
    medium: row.medium,
    purpose: row.purpose,
    target_account_id: row.target_account_id,
    target_enquiry_id: null,
    target_school_name_snapshot: row.target_school_name_snapshot,
    target_cluster_id: null,
    target_school_id: null,
    district_normalized: null,
    mandal_normalized: null,
  }));
}

async function getLink(crmSql, scope, linkId) {
  assertTrackingFlag('write');
  const [link] = await crmSql`SELECT * FROM crm_track_links WHERE id = ${linkId}`;
  await assertLinkVisible(scope, link);
  const [revision] = await crmSql`SELECT * FROM crm_track_link_revisions WHERE id = ${link.current_revision_id}`;
  const revisions = await crmSql`
    SELECT id, version, destination_class, destination_url, medium, purpose, campaign_name_snapshot,
           owner_name_snapshot, territory_name_snapshot, district_normalized, mandal_normalized,
           target_school_name_snapshot, target_account_id, created_at, change_reason
    FROM crm_track_link_revisions WHERE link_id = ${link.id} ORDER BY version
  `;
  const statusEvents = await crmSql`
    SELECT id, previous_status, new_status, previous_expires_at, new_expires_at, recorded_at, reason, old_version, new_version
    FROM crm_track_status_events WHERE link_id = ${link.id} ORDER BY recorded_at
  `;
  return { ...presentLink(link, revision), revisions, status_events: statusEvents };
}

async function updateLink(crmSql, scope, linkId, body) {
  assertCrmWrite(scope);
  assertTrackingFlag('write');
  const version = Number(body.expected_version);
  if (!Number.isInteger(version)) throw new CrmError(400, 'expected_version is required', 'VERSION_REQUIRED');
  return crmSql.begin(async (tx) => {
    const [link] = await tx`SELECT * FROM crm_track_links WHERE id = ${linkId} FOR UPDATE`;
    await assertLinkVisible(scope, link);
    if (link.row_version !== version) throw new CrmError(409, 'Link was updated', 'VERSION_CONFLICT');
    const [current] = await tx`SELECT * FROM crm_track_link_revisions WHERE id = ${link.current_revision_id}`;
    const revision = await insertRevision(tx, scope, link, body, current.version + 1, current);
    const [fresh] = await tx`
      UPDATE crm_track_links
      SET current_revision_id = ${revision.id},
          campaign_id = ${revision.campaign_id},
          owner_founder_id = ${revision.owner_founder_id}
      WHERE id = ${link.id}
      RETURNING *
    `;
    return presentLink(fresh, revision);
  });
}

async function setLinkStatus(crmSql, scope, linkId, body, status) {
  assertCrmWrite(scope);
  assertTrackingFlag('write');
  const version = Number(body.expected_version);
  if (!Number.isInteger(version)) throw new CrmError(400, 'expected_version is required', 'VERSION_REQUIRED');
  return crmSql.begin(async (tx) => {
    const [link] = await tx`SELECT * FROM crm_track_links WHERE id = ${linkId} FOR UPDATE`;
    await assertLinkVisible(scope, link);
    if (link.row_version !== version) throw new CrmError(409, 'Link was updated', 'VERSION_CONFLICT');
    const expires = body.expires_at === undefined ? (link.expires_at ? new Date(link.expires_at).toISOString() : null) : parseExpiry(body.expires_at);
    const currentExpiry = link.expires_at ? new Date(link.expires_at).toISOString() : null;
    if (link.status === status && currentExpiry === expires) {
      const [revision] = await tx`SELECT * FROM crm_track_link_revisions WHERE id = ${link.current_revision_id}`;
      return presentLink(link, revision);
    }
    const [fresh] = await tx`
      UPDATE crm_track_links SET status = ${status}, expires_at = ${expires} WHERE id = ${link.id} RETURNING *
    `;
    await tx`
      INSERT INTO crm_track_status_events (
        link_id, previous_status, new_status, previous_expires_at, new_expires_at,
        actor_id, reason, old_version, new_version
      ) VALUES (
        ${link.id}, ${link.status}, ${status}, ${link.expires_at}, ${expires},
        ${scope.actor.id}, ${clip(body.reason, 200)}, ${link.row_version}, ${fresh.row_version}
      )
    `;
    const [revision] = await tx`SELECT * FROM crm_track_link_revisions WHERE id = ${fresh.current_revision_id}`;
    return presentLink(fresh, revision);
  });
}

async function createCampaign(crmSql, scope, body) {
  assertCrmWrite(scope);
  assertTrackingFlag('write');
  const name = clip(body.name, 160);
  if (!name || name.length < 2) throw new CrmError(400, 'Campaign name is required', 'BAD_CAMPAIGN');
  const type = enumValue(body.type || 'OTHER', new Set(['BROCHURE', 'DEMO', 'EVENT', 'LANDING', 'OTHER']), 'type');
  const ownerId = scope.kind === 'platform' ? (body.owner_founder_id || null) : scope.founderId;
  if (scope.kind !== 'platform' && body.owner_founder_id && body.owner_founder_id !== scope.founderId) {
    throw new CrmError(403, 'Owner is outside this scope', 'SCOPE_DENIED');
  }
  if (ownerId) await assertActiveFounder(crmSql, ownerId);
  if (body.territory_id) await loadTerritory(crmSql, scope, body.territory_id);
  const [row] = await crmSql`
    INSERT INTO crm_campaigns (code, name, type, owner_founder_id, territory_id, created_by)
    VALUES (${campaignCode(body.code, name)}, ${name}, ${type}, ${ownerId}, ${body.territory_id || null}, ${scope.actor.id})
    RETURNING *
  `;
  return row;
}

async function listCampaigns(crmSql, scope) {
  assertTrackingFlag('write');
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  return crmSql`
    SELECT * FROM crm_campaigns
    WHERE (${founderId}::uuid IS NULL OR owner_founder_id = ${founderId} OR owner_founder_id IS NULL)
    ORDER BY created_at DESC
    LIMIT 200
  `;
}

async function updateCampaign(crmSql, scope, id, body) {
  assertCrmWrite(scope);
  assertTrackingFlag('write');
  const version = Number(body.expected_version);
  const [existing] = await crmSql`SELECT * FROM crm_campaigns WHERE id = ${id}`;
  if (!existing) throw new CrmError(404, 'Campaign not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && existing.owner_founder_id !== scope.founderId) {
    throw new CrmError(404, 'Campaign not found', 'NOT_FOUND');
  }
  if (existing.row_version !== version) throw new CrmError(409, 'Campaign was updated', 'VERSION_CONFLICT');
  const name = body.name ? clip(body.name, 160) : existing.name;
  const status = body.status ? enumValue(body.status, new Set(['ACTIVE', 'ARCHIVED']), 'status') : existing.status;
  const [row] = await crmSql`
    UPDATE crm_campaigns SET name = ${name}, status = ${status} WHERE id = ${id} AND row_version = ${version} RETURNING *
  `;
  if (!row) throw new CrmError(409, 'Campaign was updated', 'VERSION_CONFLICT');
  return row;
}

async function consumeRate(db, key, limit) {
  const windowMs = 60 * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const expires = new Date(windowStart.getTime() + windowMs * 2);
  const [row] = await db`
    INSERT INTO crm_track_rate_buckets (bucket_key, window_start, hit_count, expires_at)
    VALUES (${key}, ${windowStart.toISOString()}, 1, ${expires.toISOString()})
    ON CONFLICT (bucket_key, window_start)
    DO UPDATE SET hit_count = crm_track_rate_buckets.hit_count + 1
    RETURNING hit_count
  `;
  if (row.hit_count > limit) throw new CrmError(429, 'Too many requests', 'RATE_LIMITED');
}

async function rememberNonce(db, nonce) {
  const expires = new Date(Date.now() + 2 * 60 * 1000);
  const [row] = await db`
    INSERT INTO crm_track_rate_buckets (bucket_key, window_start, hit_count, expires_at)
    VALUES (${`nonce:${nonce}`}, '1970-01-01T00:00:00.000Z', 1, ${expires.toISOString()})
    ON CONFLICT (bucket_key, window_start) DO NOTHING
    RETURNING id
  `;
  if (!row) throw new CrmError(401, 'Tracking signature was replayed', 'INGRESS_REPLAY');
}

function lockParts(key) {
  const digest = crypto.createHash('sha256').update(key).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function resolveCode(crmSql, input) {
  const config = assertTrackingFlag('resolve');
  const code = String(input.code || '');
  if (!CODE_PATTERN.test(code)) return { ok: false, public_status: 404 };
  const requestId = String(input.request_id || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) throw new CrmError(400, 'request_id is invalid', 'BAD_REQUEST');
  await consumeRate(crmSql, `resolve:${code}`, config.resolvePerMinute);
  try {
    return await crmSql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '2s'`);
      const [existing] = await tx`
        SELECT o.*, r.destination_url, r.destination_class
        FROM crm_track_opens o
        JOIN crm_track_link_revisions r ON r.id = o.revision_id
        WHERE o.request_id = ${requestId}
      `;
      if (existing) {
        let destination;
        try { destination = validateDestination(existing.destination_url); } catch { return { ok: false, public_status: 503 }; }
        return {
          ok: true,
          replay: true,
          redirect: destination.url,
          event_id: existing.id,
          event_class: existing.event_class,
          countable: existing.countable,
          context: null,
          coverage: destination.coverage,
        };
      }
      const [link] = await tx`SELECT * FROM crm_track_links WHERE short_code = ${code} FOR UPDATE`;
      if (!link) return { ok: false, public_status: 404 };
      const now = input.now ? new Date(input.now) : new Date();
      if (link.status !== 'ACTIVE') return { ok: false, public_status: 404 };
      if (link.expires_at && new Date(link.expires_at).getTime() <= now.getTime()) return { ok: false, public_status: 410 };
      const [revision] = await tx`SELECT * FROM crm_track_link_revisions WHERE id = ${link.current_revision_id}`;
      let destination;
      try { destination = validateDestination(revision.destination_url); } catch { return { ok: false, public_status: 503 }; }
      const classified = classifyOpen({ userAgent: input.user_agent, purpose: input.purpose, method: 'GET' });
      let eventClass = classified.event_class;
      let countable = classified.countable;
      let repeatOf = null;
      let key = null;
      let bucket = null;
      if (eventClass === 'QUALIFIED' && input.consent && input.browser_key) {
        key = browserKey(config.browserKeySecret, input.browser_key);
        bucket = new Date(Math.floor(now.getTime() / (30 * 60 * 1000)) * (30 * 60 * 1000)).toISOString();
        const [lockA, lockB] = lockParts(`${key}:${link.id}:${bucket}`);
        await tx`SELECT pg_advisory_xact_lock(${lockA}, ${lockB})`;
        const [windowRow] = await tx`
          SELECT open_id FROM crm_track_browser_windows
          WHERE browser_key = ${key} AND link_id = ${link.id} AND bucket_start = ${bucket}
        `;
        if (windowRow) {
          eventClass = 'REPEAT';
          countable = false;
          repeatOf = windowRow.open_id;
        }
      }
      const [open] = await tx`
        INSERT INTO crm_track_opens (
          link_id, revision_id, request_id, observed_at, event_class, countable,
          device_class, browser_class, platform_class, referrer_origin, destination_class, repeat_of_id, processing_version
        ) VALUES (
          ${link.id}, ${revision.id}, ${requestId}, ${now.toISOString()}, ${eventClass}, ${countable},
          ${classified.device_class}, ${classified.browser_class}, ${classified.platform_class},
          ${referrerOrigin(input.referrer)}, ${destination.destinationClass}, ${repeatOf}, ${classified.classifier_version}
        ) RETURNING id
      `;
      if (key && eventClass === 'QUALIFIED') {
        const expires = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
        await tx`
          INSERT INTO crm_track_browser_windows (browser_key, link_id, bucket_start, open_id, expires_at)
          VALUES (${key}, ${link.id}, ${bucket}, ${open.id}, ${expires})
        `;
      }
      let contextToken = null;
      if (eventClass === 'QUALIFIED' && destination.destinationClass === 'OWNED_SITE') {
        contextToken = String(input.context_token || crypto.randomBytes(24).toString('base64url'));
        if (!/^[A-Za-z0-9_-]{20,120}$/.test(contextToken)) throw new CrmError(400, 'context token is invalid', 'BAD_CONTEXT');
        const origin = String(input.site_origin || '').replace(/\/$/, '');
        if (!origin) throw new CrmError(400, 'site_origin is required', 'BAD_ORIGIN');
        await tx`
          INSERT INTO crm_track_contexts (
            token_hash, first_open_id, current_open_id, link_id, revision_id, issued_at, expires_at, site_origin
          ) VALUES (
            ${hashToken(contextToken)}, ${open.id}, ${open.id}, ${link.id}, ${revision.id},
            ${now.toISOString()}, ${new Date(now.getTime() + CONTEXT_TTL_MS).toISOString()}, ${origin.slice(0, 200)}
          )
        `;
      }
      return {
        ok: true,
        redirect: destination.url,
        event_id: open.id,
        event_class: eventClass,
        countable,
        context: contextToken ? { token: contextToken, max_age: 1800, cookie: 'nx_attr' } : null,
        coverage: destination.coverage,
      };
    });
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (err.code === '23505') throw new CrmError(409, 'Request id was already used', 'REQUEST_REPLAY');
    if (err.code === '57014') {
      untrackedRedirects += 1;
      console.error(JSON.stringify({ component: 'crm', event: 'untracked_redirect', count: untrackedRedirects }));
      return { ok: false, public_status: 503, degraded: true };
    }
    throw err;
  }
}

module.exports = {
  setShortCodeFactory,
  untrackedRedirectCount,
  createLink,
  createBulk,
  listLinks,
  getLink,
  updateLink,
  setLinkStatus,
  createCampaign,
  listCampaigns,
  updateCampaign,
  resolveCode,
  consumeRate,
  rememberNonce,
  presentLink,
  ATTRIBUTION_RULE_VERSION,
};
