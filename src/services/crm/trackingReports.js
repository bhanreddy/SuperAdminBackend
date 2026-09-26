const { CrmError } = require('./errors');
const { assertTrackingFlag, ATTRIBUTION_RULE_VERSION, CLASSIFIER_VERSION, currentTrackingConfig } = require('./trackingConfig');
const { untrackedRedirectCount } = require('./trackingLinks');

function csvCell(value) {
  const text = value == null ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function definitions(model) {
  return {
    attribution_rule_version: ATTRIBUTION_RULE_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    attribution_model: model,
    time_basis: {
      opens: 'event time of the open',
      enquiries: 'lead creation cohort is separate from conversion event time',
      conversions: 'conversion event time',
      stock: 'current enquiry stock is not used for these link metrics',
    },
    metrics: {
      raw_opens: 'Accepted GET events, including preview, bot, and repeat classes.',
      qualified_opens: 'Eligible opens that are not preview, bot, repeat, or unknown.',
      observed_distinct_browsers: 'Consented browser keys in the period. This is not a count of people or scans.',
      attributed_enquiries: 'Distinct enquiries with a live, non-retracted association.',
      demo_requests: 'DEMO_REQUESTED facts. A request is not a booked demo.',
      booked_demos: 'DEMO_BOOKED facts linked to attributed enquiries.',
      completed_demos: 'DEMO_COMPLETED facts.',
      wins: 'WON closure facts. A later reopen does not erase the fact.',
      losses: 'LOST closure facts. A later reopen does not erase the fact.',
    },
    external_conversion_coverage: 'unavailable',
    external_note: 'External destinations without a first-party return adapter are unavailable, not zero.',
  };
}

function range(query) {
  const from = new Date(query.from || 0);
  const to = new Date(query.to || Date.now());
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to)) {
    throw new CrmError(400, 'from and to must be a valid range', 'BAD_RANGE');
  }
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new CrmError(400, 'Date ranges are limited to 366 days', 'BAD_RANGE');
  }
  return { from, to };
}

async function report(crmSql, scope, query) {
  assertTrackingFlag('reports');
  const model = query.attribution_model === 'latest' ? 'latest' : 'first';
  const { from, to } = range(query);
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  const [opens] = await crmSql`
    SELECT
      COUNT(*)::int AS raw_opens,
      COUNT(*) FILTER (WHERE event_class = 'QUALIFIED' AND countable)::int AS qualified_opens,
      COUNT(*) FILTER (WHERE event_class = 'BOT')::int AS bot_opens,
      COUNT(*) FILTER (WHERE event_class = 'PREVIEW')::int AS preview_opens,
      COUNT(*) FILTER (WHERE event_class = 'REPEAT')::int AS repeat_opens,
      COUNT(*) FILTER (WHERE destination_class <> 'OWNED_SITE')::int AS external_opens
    FROM crm_track_opens o
    WHERE o.observed_at >= ${from.toISOString()} AND o.observed_at < ${to.toISOString()}
      AND (${founderId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM crm_track_links l WHERE l.id = o.link_id AND l.owner_founder_id = ${founderId}
      ))
      AND (${query.link_id || null}::uuid IS NULL OR o.link_id = ${query.link_id || null})
  `;
  const [browsers] = await crmSql`
    SELECT COUNT(DISTINCT browser_key)::int AS observed_distinct_browsers
    FROM crm_track_browser_windows w
    WHERE w.bucket_start >= ${from.toISOString()} AND w.bucket_start < ${to.toISOString()}
      AND (${founderId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM crm_track_links l WHERE l.id = w.link_id AND l.owner_founder_id = ${founderId}
      ))
  `;
  const [conversions] = await crmSql`
    SELECT
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'ENQUIRY_CREATED')::int AS attributed_enquiries,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'DEMO_REQUESTED')::int AS demo_requests,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'DEMO_BOOKED')::int AS booked_demos,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'DEMO_COMPLETED')::int AS completed_demos,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'WON')::int AS wins,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'LOST')::int AS losses
    FROM crm_track_conversions v
    JOIN enquiries e ON e.id = v.enquiry_id
    WHERE v.converted_at >= ${from.toISOString()} AND v.converted_at < ${to.toISOString()}
      AND (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
      AND (${query.campaign_id || null}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM crm_enquiry_attribution_current c
        JOIN crm_track_opens o ON o.id = CASE WHEN ${model} = 'latest' THEN c.latest_open_id ELSE c.first_open_id END
        JOIN crm_track_link_revisions r ON r.id = o.revision_id
        WHERE c.enquiry_id = e.id AND r.campaign_id = ${query.campaign_id || null}
      ))
  `;
  const groups = await crmSql`
    SELECT r.campaign_id, r.campaign_name_snapshot, r.medium, r.purpose, COUNT(o.id)::int AS raw_opens
    FROM crm_track_opens o
    JOIN crm_track_link_revisions r ON r.id = o.revision_id
    JOIN crm_track_links l ON l.id = o.link_id
    WHERE o.observed_at >= ${from.toISOString()} AND o.observed_at < ${to.toISOString()}
      AND (${founderId}::uuid IS NULL OR l.owner_founder_id = ${founderId})
    GROUP BY r.campaign_id, r.campaign_name_snapshot, r.medium, r.purpose
    ORDER BY raw_opens DESC
    LIMIT 100
  `;
  return {
    schema_version: 1,
    scope: scope.kind,
    from: from.toISOString(),
    to: to.toISOString(),
    metrics: {
      ...opens,
      observed_distinct_browsers: browsers.observed_distinct_browsers,
      ...conversions,
    },
    groups,
    coverage: {
      external_conversion_coverage: opens.external_opens > 0 ? 'unavailable' : 'not_applicable',
      observed_distinct_browsers_note: 'Consented browsers only. Missing cookies are excluded and are not people.',
      untracked_redirects: untrackedRedirectCount(),
    },
    definitions: definitions(model),
  };
}

function exportCsv(reportBody) {
  const header = ['group', 'campaign', 'medium', 'purpose', 'raw_opens'];
  const lines = [header.join(',')];
  for (const row of reportBody.groups || []) {
    lines.push([
      csvCell('campaign'),
      csvCell(row.campaign_name_snapshot || ''),
      csvCell(row.medium),
      csvCell(row.purpose),
      csvCell(row.raw_opens),
    ].join(','));
  }
  lines.push([csvCell('coverage'), csvCell(reportBody.coverage.external_conversion_coverage), '', '', ''].join(','));
  return lines.join('\n');
}

async function activity(crmSql, scope, linkId, query) {
  assertTrackingFlag('reports');
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  const [link] = await crmSql`SELECT id, owner_founder_id FROM crm_track_links WHERE id = ${linkId}`;
  if (!link || (founderId && link.owner_founder_id !== founderId)) {
    const { CrmError: Err } = require('./errors');
    throw new Err(404, 'Track link not found', 'NOT_FOUND');
  }
  const limit = Math.min(Number(query.limit || 50), 100);
  return crmSql`
    SELECT id, observed_at, event_class, countable, device_class, browser_class, platform_class,
           referrer_origin, destination_class, processing_version
    FROM crm_track_opens
    WHERE link_id = ${linkId}
    ORDER BY observed_at DESC
    LIMIT ${limit}
  `;
}

function configEcho() {
  const config = currentTrackingConfig();
  return {
    origin_configured: Boolean(config.publicOrigin),
    resolve_enabled: config.resolve,
    attribution_enabled: config.attribution,
    reports_enabled: config.reports,
  };
}

module.exports = { report, exportCsv, csvCell, activity, definitions, configEcho };
