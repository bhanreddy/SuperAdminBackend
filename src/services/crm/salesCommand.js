const { CrmError } = require('./errors');
const {
  RULE_VERSION,
  SCHEMA_VERSION,
  SEVERITY,
  SUGGESTED_ACTION,
  SEVERE_FOLLOWUP_SECONDS,
  DAY_SECONDS,
  QUALIFIED_PLUS,
  changeRatio,
  percentRatio,
  attentionPriority,
  stageIsStale,
} = require('./salesCommandRules');
const {
  parseSalesCommandQuery,
  bindPeriod,
  normalizedFilters,
  filterHash,
  encodeCursor,
} = require('./salesCommandFilters');
const queries = require('./salesCommandQueries');

function metric(value, extra) {
  return {
    value,
    unit: extra.unit,
    basis: extra.basis,
    numerator: extra.numerator ?? null,
    denominator: extra.denominator ?? null,
    excluded_count: extra.excluded_count ?? 0,
    comparison_value: extra.comparison_value ?? null,
    change_ratio: extra.change_ratio ?? null,
    comparison_note: extra.comparison_note ?? null,
    drilldown: extra.drilldown,
  };
}

function counted(current, previous, drill, basis) {
  const change = changeRatio(current, previous);
  return metric(current, {
    unit: 'enquiry',
    basis,
    comparison_value: previous,
    ...change,
    drilldown: drill,
  });
}

function permissions(scope) {
  return {
    view_company: scope.kind === 'platform',
    write_sales: scope.canWrite === true,
    reassign: scope.kind === 'platform' && scope.canWrite === true,
    view_performance: true,
  };
}

function reason(code, ageSeconds, evidence) {
  return {
    code,
    severity: SEVERITY[code],
    age_seconds: ageSeconds == null ? null : Math.floor(Number(ageSeconds)),
    suggested_action: SUGGESTED_ACTION[code],
    evidence: evidence || {},
  };
}

function buildAttention(scanned, accounts, reviews, ctx) {
  const T = new Date(ctx.evaluatedAt).getTime();
  const rows = [];
  for (const row of scanned) {
    const reasons = [];
    const age = Number(row.age_seconds);
    if (row.severe) reasons.push(reason('FOLLOWUP_SEVERE', age, { threshold_seconds: SEVERE_FOLLOWUP_SECONDS }));
    if (row.overdue) reasons.push(reason('FOLLOWUP_OVERDUE', age, { threshold_seconds: SEVERE_FOLLOWUP_SECONDS }));
    if (row.pilot_completed_at && T - new Date(row.pilot_completed_at).getTime() >= 2 * DAY_SECONDS * 1000) {
      reasons.push(reason('PILOT_DECISION_OVERDUE', (T - new Date(row.pilot_completed_at).getTime()) / 1000, { completed_at: row.pilot_completed_at }));
    }
    if (row.pilot_end_at && new Date(row.pilot_end_at).getTime() < T) {
      reasons.push(reason('PILOT_END_OVERDUE', (T - new Date(row.pilot_end_at).getTime()) / 1000, { planned_end_at: row.pilot_end_at }));
    } else if (row.pilot_end_at && new Date(row.pilot_end_at).getTime() < T + 48 * 60 * 60 * 1000) {
      reasons.push(reason('PILOT_ENDING', (new Date(row.pilot_end_at).getTime() - T) / 1000, { planned_end_at: row.pilot_end_at }));
    }
    const highValue = row.currency === 'INR' && row.value_amount != null && Number(row.value_amount) >= 100000
      && QUALIFIED_PLUS.includes(row.pipeline_stage_code);
    if (highValue && row.stage_time_quality === 'OBSERVED') {
      const contactAge = row.last_success_at
        ? (T - new Date(row.last_success_at).getTime()) / 1000
        : Number(row.stage_age);
      if (contactAge != null && contactAge >= 3 * DAY_SECONDS) {
        reasons.push(reason('HIGH_VALUE_NO_CONTACT', contactAge, {
          threshold: 'INR 100000.00',
          last_successful_contact_at: row.last_success_at,
        }));
      }
    }
    if (row.demo_completed_at && T - new Date(row.demo_completed_at).getTime() >= 2 * DAY_SECONDS * 1000) {
      const sentAfter = row.proposal_sent_at && new Date(row.proposal_sent_at).getTime() >= new Date(row.demo_completed_at).getTime();
      if (!sentAfter) {
        reasons.push(reason('DEMO_WITHOUT_PROPOSAL', (T - new Date(row.demo_completed_at).getTime()) / 1000, { completed_at: row.demo_completed_at }));
      }
    }
    if (row.proposal_sent_at && T - new Date(row.proposal_sent_at).getTime() >= 5 * DAY_SECONDS * 1000) {
      const responded = row.last_response_at && new Date(row.last_response_at).getTime() >= new Date(row.proposal_sent_at).getTime();
      if (!responded) {
        reasons.push(reason('PROPOSAL_NO_RESPONSE', (T - new Date(row.proposal_sent_at).getTime()) / 1000, {
          sent_recorded_at: row.proposal_sent_at,
          response_coverage: 'recorded inbound responses only',
        }));
      }
    }
    if (stageIsStale(row.pipeline_stage_code, row.stage_age == null ? null : Number(row.stage_age), row.pilot_end_at, ctx.evaluatedAt)) {
      reasons.push(reason('STAGE_STALE', Number(row.stage_age), { stage: row.pipeline_stage_code }));
    }
    if (row.missing_next && row.assigned_to) reasons.push(reason('MISSING_NEXT_ACTION', age, {}));
    if (row.assigned_to && row.owner_active === false) reasons.push(reason('OWNER_INACTIVE', age, { founder_id: row.assigned_to }));
    if (!row.assigned_to && age >= DAY_SECONDS) reasons.push(reason('INTAKE_UNASSIGNED', age, {}));
    if (!reasons.length) continue;
    reasons.sort((a, b) => b.severity - a.severity);
    rows.push({
      entity_type: 'enquiry',
      entity_key: `enquiry:${row.id}`,
      id: row.id,
      name: row.name,
      organization: row.organization,
      created_at: row.created_at,
      severity: reasons[0].severity,
      age_seconds: Math.floor(age),
      reasons,
    });
  }
  for (const account of accounts) {
    const age = (T - new Date(account.created_at).getTime()) / 1000;
    const reasons = [];
    if (!account.owner_founder_id && age >= DAY_SECONDS) reasons.push(reason('INTAKE_UNASSIGNED', age, {}));
    if (!account.has_channel && age >= 2 * DAY_SECONDS) reasons.push(reason('CONTACTLESS_INTAKE', age, {}));
    if (!reasons.length) continue;
    reasons.sort((a, b) => b.severity - a.severity);
    rows.push({
      entity_type: 'account',
      entity_key: `account:${account.id}`,
      id: account.id,
      name: account.name,
      organization: null,
      created_at: account.created_at,
      severity: reasons[0].severity,
      age_seconds: Math.floor(age),
      reasons,
    });
  }
  for (const review of reviews) {
    rows.push({
      entity_type: 'enquiry',
      entity_key: `enquiry:${review.enquiry_id}`,
      id: review.enquiry_id,
      name: review.name,
      organization: review.organization,
      created_at: review.created_at,
      severity: SEVERITY.LOSS_REVIEW,
      age_seconds: Math.floor((T - new Date(review.created_at).getTime()) / 1000),
      reasons: [reason('LOSS_REVIEW', (T - new Date(review.created_at).getTime()) / 1000, { review_id: review.id, closure_id: review.closure_id })],
    });
  }
  rows.sort(attentionPriority);
  return rows;
}

async function withSnapshot(crmSql, work) {
  try {
    return await crmSql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL statement_timeout = '3s'`;
      const [clock] = await tx`SELECT now() AS evaluated_at`;
      return work(tx, new Date(clock.evaluated_at));
    });
  } catch (err) {
    if (err?.code === '57014') throw new CrmError(503, 'Sales Command query timed out. Narrow the filters and retry.', 'QUERY_TIMEOUT');
    throw err;
  }
}

function contextFrom(scope, query, evaluatedAt) {
  const parsed = parseSalesCommandQuery(query, scope);
  const period = bindPeriod(parsed, evaluatedAt);
  const ctx = {
    ...parsed,
    period,
    evaluatedAt,
    severeBefore: new Date(evaluatedAt.getTime() - SEVERE_FOLLOWUP_SECONDS * 1000),
    filterHash: filterHash(parsed, period),
  };
  return ctx;
}

async function loadAttention(tx, ctx) {
  const { scanned } = await queries.attentionRows(tx, ctx, { preview: false });
  const accounts = await tx`
    SELECT a.id, a.name, a.created_at, a.owner_founder_id,
      (
        a.phone IS NOT NULL OR a.email IS NOT NULL OR EXISTS (
          SELECT 1 FROM crm_contacts c
          JOIN crm_contact_methods m ON m.contact_id = c.id
          WHERE c.account_id = a.id AND c.archived_at IS NULL AND m.archived_at IS NULL
        )
      ) AS has_channel
    FROM crm_accounts a
    WHERE a.vertical = 'SCHOOL' AND a.archived_at IS NULL AND a.account_type = 'PROSPECT'
      AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.account_id = a.id)
      AND (${ctx.founderId}::uuid IS NULL OR a.owner_founder_id = ${ctx.founderId})
      AND (${ctx.unassigned} = false OR a.owner_founder_id IS NULL)
      AND (${ctx.ownerId}::uuid IS NULL OR a.owner_founder_id = ${ctx.ownerId})
  `;
  const reviews = await tx`
    SELECT q.id, q.enquiry_id, q.closure_id, q.created_at, e.name, e.organization
    FROM crm_review_queue q
    JOIN enquiries e ON e.id = q.enquiry_id
    WHERE q.status = 'OPEN' AND q.reason IN ('LOSS_REVIEW', 'LEGACY_UNKNOWN', 'AMBIGUOUS_NEXT_FOLLOW_UP')
      AND crm_school_sales_class(e) = 'SCHOOL'
      AND (${ctx.founderId}::uuid IS NULL OR e.assigned_to = ${ctx.founderId})
    ORDER BY q.created_at
    LIMIT 100
  `;
  return buildAttention(scanned, accounts, reviews, ctx);
}

function meta(scope, ctx, coverage) {
  return {
    schema_version: SCHEMA_VERSION,
    rule_version: RULE_VERSION,
    evaluated_at: ctx.evaluatedAt,
    timezone: ctx.timezone,
    period: { from: ctx.period.from, to: ctx.period.to, label: ctx.period.label },
    comparison: {
      from: ctx.period.previousFrom,
      to: ctx.period.previousTo,
      label: 'previous equal-length period',
    },
    scope: { kind: scope.kind, founder_id: scope.kind === 'platform' ? null : scope.founderId },
    filters: normalizedFilters(ctx, ctx.period),
    coverage,
    permissions: permissions(scope),
    threshold: { currency: 'INR', high_value: '100000.00', other_currencies: 'threshold not configured' },
  };
}

async function summary(crmSql, scope, query) {
  return withSnapshot(crmSql, async (tx, evaluatedAt) => {
    const ctx = contextFrom(scope, query, evaluatedAt);
    const counts = await queries.countMetrics(tx, ctx);
    const accounts = await queries.accountMetrics(tx, ctx);
    const attention = await loadAttention(tx, ctx);
    const attribution = await queries.attributionSnapshot(tx, ctx);
    const epoch = await tx`SELECT capture_started_at FROM crm_capture_epochs WHERE id = 'sales_command_v1'`;
    const conflicts = await tx`
      SELECT COUNT(*)::int AS count FROM enquiries e
      WHERE crm_school_sales_class(e) = 'CONFLICT'
        AND (${ctx.founderId}::uuid IS NULL OR e.assigned_to = ${ctx.founderId})
    `;
    const decisionDenom = counts.closureEvents.won_events + counts.closureEvents.lost_events;
    const decisionPrev = counts.closureEvents.won_events_prev + counts.closureEvents.lost_events_prev;
    const cohortRate = percentRatio(counts.cohort.numerator, counts.cohort.denominator, true);
    const decisionRate = percentRatio(counts.closureEvents.won_events, decisionDenom, true);
    const drill = (id) => ({ metric: id, filters: normalizedFilters(ctx, ctx.period) });
    const metrics = {
      new_leads: counted(counts.events.new_leads, counts.events.new_leads_prev, drill('new_leads'), 'Enquiries created in the selected period'),
      contacted: counted(counts.events.contacted, counts.events.contacted_prev, drill('contacted'), 'Observed stage entry to CONTACTED in the period. Baseline and reopen events are excluded.'),
      qualified: counted(counts.events.qualified, counts.events.qualified_prev, drill('qualified'), 'Observed stage entry to QUALIFIED in the period'),
      demo_scheduled: counted(counts.events.demo_scheduled, counts.events.demo_scheduled_prev, drill('demo_scheduled'), 'Original demo booking in the period. A reschedule is not another booking.'),
      demo_completed: counted(counts.events.demo_completed, counts.events.demo_completed_prev, drill('demo_completed'), 'Authoritative demo completion in the period'),
      demo_cancelled: metric(counts.events.demo_cancelled, { unit: 'enquiry', basis: 'Authoritative cancellation in the period', drilldown: drill('demo_cancelled') }),
      demo_no_show: metric(counts.events.demo_no_show, { unit: 'enquiry', basis: 'Authoritative no-show in the period', drilldown: drill('demo_no_show') }),
      demos_upcoming: metric(counts.stock.demos_upcoming, { unit: 'enquiry', basis: 'Now. Open enquiries with a scheduled demo at or after evaluation.', drilldown: drill('demos_upcoming') }),
      proposals_sent: counted(counts.events.proposals_sent, counts.events.proposals_sent_prev, drill('proposals_sent'), 'First recorded send of a proposal version in the period. Not proof of email delivery.'),
      active_proposals: metric(counts.stock.active_proposals, { unit: 'enquiry', basis: 'Now. Latest issued version is still SENT and unexpired. A newer draft does not withdraw it.', drilldown: drill('active_proposals') }),
      active_pilots: metric(counts.stock.active_pilots, { unit: 'enquiry', basis: 'Now. Active pilot on an open enquiry. A passed planned end does not auto-complete.', drilldown: drill('active_pilots') }),
      pilot_started: metric(counts.events.pilot_started, { unit: 'enquiry', basis: 'Pilot activation in the period', drilldown: drill('pilot_started') }),
      wins: counted(counts.events.wins, counts.events.wins_prev, drill('wins'), 'Distinct enquiries with a WON closure in the period. Reopening does not erase the event.'),
      losses: counted(counts.events.losses, counts.events.losses_prev, drill('losses'), 'Distinct enquiries with a LOST closure in the period. Disqualified and legacy unknown are excluded.'),
      disqualified: metric(counts.events.disqualified, { unit: 'enquiry', basis: 'DISQUALIFIED closures in the period', drilldown: drill('disqualified') }),
      open_pipeline: metric(counts.stock.open_pipeline, { unit: 'enquiry', basis: 'Now. Current open school enquiries. Stage occupancy sums to this count.', drilldown: drill('open_pipeline') }),
      due_today: metric(counts.stock.due_today, { unit: 'enquiry', basis: 'Now. Remaining follow-ups due before the next local midnight. Earlier today is overdue.', drilldown: drill('due_today') }),
      overdue: metric(counts.stock.overdue, { unit: 'enquiry', basis: 'Now. Includes severely overdue. One enquiry counts once.', drilldown: drill('overdue') }),
      severely_overdue: metric(counts.stock.severely_overdue, { unit: 'enquiry', basis: 'Now. Subset of overdue, 72 hours or more. Not additive to overdue.', drilldown: drill('severely_overdue') }),
      no_followup: metric(counts.stock.no_followup, { unit: 'enquiry', basis: 'Now. Open enquiries without a valid designated next task and without an unexpired exception.', drilldown: drill('no_followup') }),
      founder_attention: metric(attention.length, { unit: 'entity', basis: 'Now. One row per enquiry or account-only prospect. Rule version 1.', drilldown: drill('founder_attention') }),
      new_prospects: metric(accounts.new_prospects, { unit: 'account', basis: 'School accounts created in the period, including contactless schools. Not added to new leads.', drilldown: drill('new_prospects') }),
      intake_backlog: metric(accounts.intake_backlog, { unit: 'account', basis: 'Now. Unarchived school prospects with no enquiry.', drilldown: drill('intake_backlog') }),
      contacts_on_file: metric(accounts.contacts_on_file, { unit: 'contact', basis: 'Now. Active people with a usable contact method. This is not Contacted.', drilldown: null }),
      cohort_conversion: metric(cohortRate, {
        unit: 'ratio',
        basis: 'Ever won as of evaluation, among leads created in the period, excluding duplicate and spam disqualifications.',
        numerator: counts.cohort.numerator,
        denominator: counts.cohort.denominator,
        excluded_count: counts.cohort.excluded_spam,
        drilldown: drill('cohort_numerator'),
      }),
      decision_win_rate: metric(decisionRate, {
        unit: 'ratio',
        basis: 'WON closure events divided by WON plus LOST closure events in the period. Not the distinct win and loss cards.',
        numerator: counts.closureEvents.won_events,
        denominator: decisionDenom,
        comparison_value: percentRatio(counts.closureEvents.won_events_prev, decisionPrev, true),
        ...changeRatio(
          percentRatio(counts.closureEvents.won_events, decisionDenom, true),
          percentRatio(counts.closureEvents.won_events_prev, decisionPrev, true),
        ),
        drilldown: drill('decision_numerator'),
      }),
    };
    const stages = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO', 'PROPOSAL', 'NEGOTIATION', 'PILOT'];
    const stageKeys = {
      NEW: 'stage_new', CONTACTED: 'stage_contacted', QUALIFIED: 'stage_qualified', DEMO: 'stage_demo',
      PROPOSAL: 'stage_proposal', NEGOTIATION: 'stage_negotiation', PILOT: 'stage_pilot',
    };
    const currentStage = {};
    for (const code of stages) {
      currentStage[code] = metric(counts.stock[stageKeys[code]], {
        unit: 'enquiry',
        basis: 'Now. Current occupancy, not historical conversion.',
        drilldown: { metric: 'current_stage', filters: { ...normalizedFilters(ctx, ctx.period), stage: code } },
      });
    }
    currentStage.unknown = metric(counts.stock.stage_unknown, {
      unit: 'enquiry',
      basis: 'Now. Open enquiries whose stage is outside the school catalog.',
      drilldown: null,
    });
    const coverage = {
      capture_started_at: epoch[0]?.capture_started_at || null,
      unknown_counts: {
        demo_completions_without_timestamp: counts.closureEvents.unknown_demo_completions,
        conflicting_product_identity: conflicts[0]?.count || 0,
        archived_accounts_in_historical_events: counts.events.archived_account_enquiries,
      },
      warnings: [
        'Recorded history starts at capture_started_at. Earlier intervals are unknown, not zero.',
        'Historical dimensions use the current owner, geography, and source.',
        'A later list can observe commits made after this snapshot.',
        'Campaign filters use live non-retracted attribution. First and latest are views, not extra sales. External link destinations report unavailable conversion coverage.',
      ],
    };
    return {
      meta: meta(scope, ctx, coverage),
      metrics,
      current_stage: currentStage,
      cohort: {
        ...counts.cohort,
        median_age_seconds: counts.cohort.median_age_seconds == null ? null : Number(counts.cohort.median_age_seconds),
        label: 'ever won as of evaluation',
      },
      open_pipeline_value: counts.values,
      booked_sales: counts.wonValues,
      attention_preview: attention.slice(0, 10),
      scope_label: scope.kind === 'platform' ? 'Company school sales' : 'My pipeline',
      attribution,
    };
  });
}

async function section(crmSql, scope, query, loader) {
  return withSnapshot(crmSql, async (tx, evaluatedAt) => {
    const ctx = contextFrom(scope, query, evaluatedAt);
    const [epoch] = await tx`SELECT capture_started_at FROM crm_capture_epochs WHERE id = 'sales_command_v1'`;
    const body = await loader(tx, ctx);
    return {
      meta: meta(scope, ctx, { capture_started_at: epoch?.capture_started_at || null, unknown_counts: {}, warnings: [] }),
      ...body,
    };
  });
}

async function opportunities(crmSql, scope, query) {
  return section(crmSql, scope, query, async (tx, ctx) => {
    if (!ctx.metric) throw new CrmError(400, 'metric is required', 'BAD_METRIC');
    if (ctx.metric === 'founder_attention') {
      const rows = await loadAttention(tx, ctx);
      const start = ctx.cursor ? rows.findIndex((row) => row.entity_key === decodeAttentionCursor(ctx)) + 1 : 0;
      const pageRows = rows.slice(Math.max(start, 0), Math.max(start, 0) + ctx.limit);
      const last = pageRows[pageRows.length - 1];
      return {
        rows: pageRows,
        page: {
          limit: ctx.limit,
          total: rows.length,
          next_cursor: rows.length > start + ctx.limit && last ? encodeCursor({ v: 1, h: ctx.filterHash, entity_key: last.entity_key }) : null,
          evaluated_at: ctx.evaluatedAt,
        },
      };
    }
    const page = await queries.listOpportunities(tx, ctx);
    const expected = ctx.expectedTotal;
    const changed = expected != null && Number.isFinite(expected) && expected !== page.page.total;
    return { ...page, updated_since_dashboard_refresh: changed };
  });
}

function decodeAttentionCursor(ctx) {
  const { decodeCursor } = require('./salesCommandFilters');
  const payload = decodeCursor(ctx.cursor, ctx.filterHash);
  return payload?.entity_key || '';
}

module.exports = {
  summary,
  funnel: (crmSql, scope, query) => section(crmSql, scope, query, async (tx, ctx) => ({ funnel: await queries.funnel(tx, ctx) })),
  trends: (crmSql, scope, query) => section(crmSql, scope, query, async (tx, ctx) => ({
    trends: await queries.trends(tx, ctx),
    note: 'Daily or weekly buckets count distinct enquiries in each bucket. Their sum can exceed the period card.',
  })),
  aging: (crmSql, scope, query) => section(crmSql, scope, query, async (tx, ctx) => ({ buckets: await queries.aging(tx, ctx) })),
  followUps: (crmSql, scope, query) => section(crmSql, scope, query, async (tx, ctx) => {
    const metricName = ctx.metric || 'overdue';
    if (!['due_today', 'overdue', 'severely_overdue', 'no_followup'].includes(metricName)) {
      throw new CrmError(400, 'follow-up metric is not supported', 'BAD_METRIC');
    }
    const page = await queries.listOpportunities(tx, { ...ctx, metric: metricName });
    return { metric: metricName, ...page };
  }),
  attention: (crmSql, scope, query) => opportunities(crmSql, scope, { ...query, metric: 'founder_attention' }),
  owners: (crmSql, scope, query) => section(crmSql, scope, query, async (tx, ctx) => ({
    owners: await queries.owners(tx, ctx),
    attribution: 'current_owner',
  })),
  opportunities,
};
