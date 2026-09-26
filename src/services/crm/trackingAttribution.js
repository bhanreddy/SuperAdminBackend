const { CrmError } = require('./errors');
const { assertCrmWrite, assertLeadAccess } = require('./accessPolicy');
const { stableHash } = require('./helpers');
const { fold } = require('./normalization');
const { hashToken } = require('./trackingIngress');
const { ATTRIBUTION_RULE_VERSION, currentTrackingConfig, assertTrackingFlag } = require('./trackingConfig');
const { consumeRate } = require('./trackingLinks');

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

async function liveOpens(tx, enquiryId) {
  const rows = await tx`
    SELECT e.open_id, e.recorded_at
    FROM crm_enquiry_attribution_events e
    WHERE e.enquiry_id = ${enquiryId}
      AND e.association_kind IN ('FORM_CAPTURE', 'AUTHORIZED_ATTACH')
      AND NOT EXISTS (
        SELECT 1 FROM crm_enquiry_attribution_events later
        WHERE later.supersedes_id = e.id AND later.association_kind = 'CORRECTION_RETRACT'
      )
    ORDER BY e.recorded_at ASC, e.id ASC
  `;
  return rows;
}

async function rebuildProjection(tx, enquiryId) {
  const rows = await liveOpens(tx, enquiryId);
  const first = rows[0]?.open_id || null;
  const latest = rows.length ? rows[rows.length - 1].open_id : null;
  await tx`
    INSERT INTO crm_enquiry_attribution_current (enquiry_id, first_open_id, latest_open_id, version)
    VALUES (${enquiryId}, ${first}, ${latest}, 1)
    ON CONFLICT (enquiry_id) DO UPDATE SET
      first_open_id = EXCLUDED.first_open_id,
      latest_open_id = EXCLUDED.latest_open_id,
      version = crm_enquiry_attribution_current.version + 1,
      updated_at = now()
  `;
  return { first_open_id: first, latest_open_id: latest };
}

async function insertConversion(tx, input) {
  const [current] = await tx`SELECT first_open_id, latest_open_id FROM crm_enquiry_attribution_current WHERE enquiry_id = ${input.enquiryId}`;
  const firstOpen = current?.first_open_id || input.openId || null;
  const triggerOpen = input.openId || current?.latest_open_id || null;
  if (!triggerOpen && input.model !== 'unattributed') return null;
  let revisionId = null;
  if (triggerOpen) {
    const [open] = await tx`SELECT revision_id FROM crm_track_opens WHERE id = ${triggerOpen}`;
    revisionId = open?.revision_id || null;
  }
  const [row] = await tx`
    INSERT INTO crm_track_conversions (
      kind, enquiry_id, demo_id, closure_id, open_id, revision_id, first_open_id,
      converted_at, source_type, source_id, creator_type, attribution_rule_version, attribution_model
    ) VALUES (
      ${input.kind}, ${input.enquiryId}, ${input.demoId || null}, ${input.closureId || null},
      ${triggerOpen}, ${revisionId}, ${firstOpen}, ${input.at || new Date().toISOString()},
      ${input.sourceType}, ${input.sourceId}, ${input.creatorType}, ${ATTRIBUTION_RULE_VERSION},
      ${input.model || 'latest'}
    )
    ON CONFLICT (kind, source_type, source_id) DO NOTHING
    RETURNING id
  `;
  return row || null;
}

async function recordStaffConversion(tx, input) {
  if (!currentTrackingConfig().attribution) return null;
  return insertConversion(tx, { ...input, creatorType: 'STAFF', model: 'latest' });
}

async function redeemContext(tx, token, origin, now) {
  if (!token) return null;
  const [context] = await tx`
    SELECT * FROM crm_track_contexts
    WHERE token_hash = ${hashToken(token)}
    FOR UPDATE
  `;
  if (!context) throw new CrmError(400, 'Attribution context is invalid', 'BAD_CONTEXT');
  if (context.consumed_at) throw new CrmError(409, 'Attribution context was already used', 'CONTEXT_REPLAY');
  if (new Date(context.expires_at).getTime() <= now.getTime()) throw new CrmError(400, 'Attribution context expired', 'CONTEXT_EXPIRED');
  if (String(context.site_origin).replace(/\/$/, '') !== String(origin || '').replace(/\/$/, '')) {
    throw new CrmError(400, 'Attribution context origin does not match', 'CONTEXT_ORIGIN');
  }
  const [open] = await tx`
    SELECT o.*, r.target_account_id, r.target_school_name_snapshot, r.district_normalized, r.campaign_id, r.owner_founder_id, r.destination_class
    FROM crm_track_opens o
    JOIN crm_track_link_revisions r ON r.id = o.revision_id AND r.link_id = o.link_id
    WHERE o.id = ${context.current_open_id}
  `;
  if (!open || open.event_class !== 'QUALIFIED' || !open.countable) {
    throw new CrmError(400, 'Attribution context is not a qualified open', 'CONTEXT_NOT_QUALIFIED');
  }
  await tx`UPDATE crm_track_contexts SET consumed_at = ${now.toISOString()} WHERE id = ${context.id}`;
  return { context, open };
}

async function associate(tx, { enquiryId, open, mismatch, actorId, intakeCommandId, kind }) {
  await tx`SELECT id FROM enquiries WHERE id = ${enquiryId} FOR UPDATE`;
  const [event] = await tx`
    INSERT INTO crm_enquiry_attribution_events (
      enquiry_id, open_id, association_kind, actor_id, intake_command_id, mismatch_state
    ) VALUES (
      ${enquiryId}, ${open.id}, ${kind}, ${actorId || null}, ${intakeCommandId || null}, ${mismatch}
    ) RETURNING id
  `;
  if (mismatch === 'TARGET_MISMATCH') {
    await tx`
      INSERT INTO crm_review_queue (enquiry_id, account_id, reason)
      VALUES (${enquiryId}, ${open.target_account_id || null}, 'TRACK_TARGET_SCHOOL_MISMATCH')
    `;
  }
  await rebuildProjection(tx, enquiryId);
  return event;
}

function mismatchFor(open, organization) {
  const submitted = fold(organization || '');
  const target = fold(open?.target_school_name_snapshot || '');
  if (!target || !submitted) return 'NONE';
  return target === submitted ? 'NONE' : 'TARGET_MISMATCH';
}

async function submitPublicEnquiry(crmSql, body, meta) {
  const config = currentTrackingConfig();
  const now = meta.now ? new Date(meta.now) : new Date();
  const name = clean(body?.name, 120);
  const email = clean(body?.email, 180).toLowerCase();
  const phone = clean(body?.phone, 30);
  const message = clean(body?.message, 2000);
  const product = clean(body?.product, 80) || 'SchoolIMS';
  const organization = clean(body?.organization, 180);
  const budget = clean(body?.budget_range, 80);
  const intent = clean(body?.intent, 20).toUpperCase();
  const allowedSources = new Set(['NEXSYRUS_WEBSITE', 'SCHOOL_ERP', 'MAIN', 'WEBSITE']);
  const requestedSource = clean(body?.website_source, 80).toUpperCase();
  const websiteSource = allowedSources.has(requestedSource) ? requestedSource : 'NEXSYRUS_WEBSITE';
  const channel = clean(body?.channel, 40) || 'WEBSITE';
  const campaignText = clean(body?.campaign, 120);
  if (body?.website) return { status: 202, body: { accepted: true } };
  if (!name || (!email && !phone)) return { status: 400, body: { error: 'Name and either email or phone are required' } };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Enter a valid email address' } };
  if (config.attribution) await consumeRate(crmSql, meta.rateKey || 'public-enquiry:global', config.enquiryPerMinute);
  const idempotencyKey = clean(body?.idempotency_key, 200);
  const contextToken = clean(meta.contextToken, 120);
  const hash = stableHash({ name, email, phone, message, organization, budget, intent, websiteSource, context: contextToken ? hashToken(contextToken) : null });
  return crmSql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '3s'`);
    if (idempotencyKey) {
      const [existing] = await tx`
        SELECT response, request_hash FROM crm_command_receipts
        WHERE scope = 'public_enquiry' AND idempotency_key = ${idempotencyKey}
      `;
      if (existing) {
        if (existing.request_hash !== hash) throw new CrmError(409, 'This idempotency key was already used for a different request', 'IDEMPOTENCY_CONFLICT');
        return { status: 201, body: existing.response };
      }
    }
    const [lead] = await tx`
      SELECT id, created_at FROM ingest_website_enquiry(
        ${name}, ${email || null}, ${phone || null}, ${message || null}, ${product},
        ${websiteSource}, ${channel}, ${campaignText || null}, ${organization || null}, ${budget || null}
      )
    `;
    let attributed = false;
    if (config.attribution && contextToken) {
      const redeemed = await redeemContext(tx, contextToken, meta.origin, now);
      const mismatch = mismatchFor(redeemed.open, organization);
      await associate(tx, {
        enquiryId: lead.id,
        open: redeemed.open,
        mismatch,
        intakeCommandId: idempotencyKey || lead.id,
        kind: 'FORM_CAPTURE',
      });
      await insertConversion(tx, {
        kind: 'ENQUIRY_CREATED',
        enquiryId: lead.id,
        openId: redeemed.open.id,
        sourceType: 'enquiry',
        sourceId: lead.id,
        creatorType: 'PUBLIC_INTAKE',
        model: 'first',
        at: now.toISOString(),
      });
      if (intent === 'DEMO') {
        await insertConversion(tx, {
          kind: 'DEMO_REQUESTED',
          enquiryId: lead.id,
          openId: redeemed.open.id,
          sourceType: 'enquiry_demo_request',
          sourceId: lead.id,
          creatorType: 'PUBLIC_INTAKE',
          model: 'latest',
          at: now.toISOString(),
        });
      }
      attributed = true;
    }
    const response = { accepted: true, enquiryId: lead.id, attribution: attributed ? 'ATTRIBUTED' : 'UNATTRIBUTED' };
    if (idempotencyKey) {
      await tx`
        INSERT INTO crm_command_receipts (scope, idempotency_key, request_hash, status_code, response)
        VALUES ('public_enquiry', ${idempotencyKey}, ${hash}, 201, ${tx.json(response)})
      `;
    }
    return { status: 201, body: response };
  });
}

async function attachTouch(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  assertTrackingFlag('attribution');
  const reason = clean(body.reason, 200);
  if (reason.length < 3) throw new CrmError(400, 'A reason is required', 'REASON_REQUIRED');
  return crmSql.begin(async (tx) => {
    const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${enquiryId} FOR UPDATE`;
    assertLeadAccess(scope, lead);
    const [open] = await tx`
      SELECT o.*, r.target_account_id, r.target_school_name_snapshot
      FROM crm_track_opens o
      JOIN crm_track_link_revisions r ON r.id = o.revision_id
      WHERE o.id = ${body.open_id}
    `;
    if (!open) throw new CrmError(404, 'Open not found', 'NOT_FOUND');
    if (open.event_class !== 'QUALIFIED' && body.allow_unqualified !== true) {
      throw new CrmError(400, 'Only a qualified open can be attached', 'OPEN_NOT_QUALIFIED');
    }
    if (scope.kind !== 'platform') {
      const [link] = await tx`SELECT owner_founder_id FROM crm_track_links WHERE id = ${open.link_id}`;
      if (!link || link.owner_founder_id !== scope.founderId) throw new CrmError(404, 'Open not found', 'NOT_FOUND');
    }
    await associate(tx, {
      enquiryId,
      open,
      mismatch: mismatchFor(open, lead.organization),
      actorId: scope.actor.id,
      intakeCommandId: `staff:${scope.actor.id}:${body.open_id}`,
      kind: 'AUTHORIZED_ATTACH',
    });
    return rebuildProjection(tx, enquiryId);
  });
}

async function retractTouch(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  assertTrackingFlag('attribution');
  const reason = clean(body.reason, 200);
  if (reason.length < 3) throw new CrmError(400, 'A reason is required', 'REASON_REQUIRED');
  return crmSql.begin(async (tx) => {
    const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${enquiryId} FOR UPDATE`;
    assertLeadAccess(scope, lead);
    const [event] = await tx`
      SELECT * FROM crm_enquiry_attribution_events
      WHERE id = ${body.event_id} AND enquiry_id = ${enquiryId}
    `;
    if (!event || event.association_kind === 'CORRECTION_RETRACT') throw new CrmError(404, 'Association not found', 'NOT_FOUND');
    await tx`
      INSERT INTO crm_enquiry_attribution_events (
        enquiry_id, open_id, association_kind, actor_id, intake_command_id, supersedes_id, mismatch_state
      ) VALUES (
        ${enquiryId}, ${event.open_id}, 'CORRECTION_RETRACT', ${scope.actor.id}, ${reason}, ${event.id}, ${event.mismatch_state}
      )
    `;
    return rebuildProjection(tx, enquiryId);
  });
}

module.exports = {
  submitPublicEnquiry,
  recordStaffConversion,
  attachTouch,
  retractTouch,
  rebuildProjection,
};
