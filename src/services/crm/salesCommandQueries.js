const { CrmError } = require('./errors');
const { SALES_TASK_TYPES } = require('./salesCommandRules');
const { decodeCursor } = require('./salesCommandFilters');

const TASK_TYPES = SALES_TASK_TYPES;

function geoMatch(sql, column, value) {
  if (!value) return sql`TRUE`;
  if (value === 'unknown') {
    return sql`NOT EXISTS (
      SELECT 1 FROM crm_school_profiles p
      WHERE p.account_id = e.account_id AND NULLIF(btrim(p.${sql.unsafe(column)}), '') IS NOT NULL
    )`;
  }
  return sql`EXISTS (
    SELECT 1 FROM crm_school_profiles p
    WHERE p.account_id = e.account_id AND p.${sql.unsafe(column)} = ${value}
  )`;
}

function attributionMatch(sql, ctx) {
  if (!ctx.campaignId && !ctx.trackLinkId && !ctx.distributionMedium && !ctx.conversionKind) return sql`TRUE`;
  return sql`EXISTS (
    SELECT 1
    FROM crm_enquiry_attribution_current c
    JOIN crm_track_opens o ON o.id = CASE WHEN ${ctx.attributionModel} = 'latest' THEN c.latest_open_id ELSE c.first_open_id END
    JOIN crm_track_link_revisions r ON r.id = o.revision_id AND r.link_id = o.link_id
    WHERE c.enquiry_id = e.id
      AND EXISTS (
        SELECT 1 FROM crm_enquiry_attribution_events ev
        WHERE ev.enquiry_id = e.id AND ev.open_id = o.id
          AND ev.association_kind IN ('FORM_CAPTURE', 'AUTHORIZED_ATTACH')
          AND NOT EXISTS (
            SELECT 1 FROM crm_enquiry_attribution_events later
            WHERE later.supersedes_id = ev.id AND later.association_kind = 'CORRECTION_RETRACT'
          )
      )
      AND (${ctx.campaignId}::uuid IS NULL OR r.campaign_id = ${ctx.campaignId})
      AND (${ctx.trackLinkId}::uuid IS NULL OR o.link_id = ${ctx.trackLinkId})
      AND (${ctx.distributionMedium}::text IS NULL OR r.medium = ${ctx.distributionMedium})
      AND (${ctx.conversionKind}::text IS NULL OR EXISTS (
        SELECT 1 FROM crm_track_conversions v
        WHERE v.enquiry_id = e.id AND v.kind = ${ctx.conversionKind}
      ))
  )`;
}

function enquiryBase(sql, ctx, { stock }) {
  return sql`
    crm_school_sales_class(e) = 'SCHOOL'
    AND (${ctx.founderId}::uuid IS NULL OR e.assigned_to = ${ctx.founderId})
    AND (${ctx.unassigned} = false OR e.assigned_to IS NULL)
    AND (${ctx.ownerId}::uuid IS NULL OR (${ctx.unassigned} = true AND e.assigned_to IS NULL) OR e.assigned_to = ${ctx.ownerId})
    AND (${ctx.territoryId}::uuid IS NULL OR e.territory_id = ${ctx.territoryId})
    AND (${ctx.accountId}::uuid IS NULL OR e.account_id = ${ctx.accountId})
    AND (${ctx.channelId}::uuid IS NULL OR e.acquisition_channel_id = ${ctx.channelId})
    AND (${ctx.source}::text IS NULL OR e.website_source = ${ctx.source})
    AND (${ctx.stage}::text IS NULL OR e.pipeline_stage_code = ${ctx.stage})
    AND (${ctx.outcome}::text IS NULL OR e.outcome = ${ctx.outcome})
    AND (${ctx.reasonCode}::text IS NULL OR EXISTS (
      SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.reason_code = ${ctx.reasonCode}
    ))
    AND (${ctx.q}::text IS NULL OR e.name ILIKE ${ctx.q ? `%${ctx.q}%` : null} OR e.organization ILIKE ${ctx.q ? `%${ctx.q}%` : null})
    AND (${ctx.assigneeId}::uuid IS NULL OR EXISTS (
      SELECT 1 FROM crm_tasks t
      WHERE t.enquiry_id = e.id AND t.owner_founder_id = ${ctx.assigneeId}
        AND t.task_type IN ('FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING')
    ))
    AND ${geoMatch(sql, 'country_code', ctx.country)}
    AND ${geoMatch(sql, 'state_normalized', ctx.state)}
    AND ${geoMatch(sql, 'district_normalized', ctx.district)}
    AND ${geoMatch(sql, 'city_normalized', ctx.city)}
    AND ${geoMatch(sql, 'mandal_normalized', ctx.mandal)}
    AND ${geoMatch(sql, 'locality_normalized', ctx.locality)}
    AND ${attributionMatch(sql, ctx)}
    AND (${stock} = false OR NOT EXISTS (
      SELECT 1 FROM crm_accounts a WHERE a.id = e.account_id AND a.archived_at IS NOT NULL
    ))
    AND (${ctx.createdInPeriod} = false OR (e.created_at >= ${ctx.period.from} AND e.created_at < ${ctx.period.to}))
    AND ${followupFilter(sql, ctx)}
    AND ${pilotFilter(sql, ctx)}
  `;
}

function followupFilter(sql, ctx) {
  if (!ctx.followupState) return sql`TRUE`;
  if (ctx.followupState === 'DUE_TODAY') return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at >= ${ctx.evaluatedAt} AND t.due_at < ${ctx.period.nextLocalMidnight}`)}`;
  if (ctx.followupState === 'OVERDUE') return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at < ${ctx.evaluatedAt}`)}`;
  if (ctx.followupState === 'SEVERELY_OVERDUE') return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at <= ${ctx.severeBefore}`)}`;
  if (ctx.followupState === 'UPCOMING') return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at >= ${ctx.period.nextLocalMidnight}`)}`;
  if (ctx.followupState === 'MISSING') return missingFollowup(sql, ctx);
  return sql`e.outcome = 'OPEN' AND e.next_action_task_id IS NULL AND EXISTS (
    SELECT 1 FROM crm_next_action_exceptions x WHERE x.enquiry_id = e.id AND x.expires_at > ${ctx.evaluatedAt}
  )`;
}

function eligible(sql, ctx, extra) {
  return sql`EXISTS (
    SELECT 1 FROM crm_tasks t
    JOIN founders assignee ON assignee.id = t.owner_founder_id AND assignee.is_active = true
    WHERE t.enquiry_id = e.id
      AND t.task_type IN ('FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING')
      AND t.status IN ('OPEN', 'IN_PROGRESS')
      AND t.due_at IS NOT NULL
      AND ${extra}
  )`;
}

function missingFollowup(sql, ctx) {
  return sql`
    e.outcome = 'OPEN'
    AND NOT EXISTS (
      SELECT 1 FROM crm_tasks t
      JOIN founders assignee ON assignee.id = t.owner_founder_id AND assignee.is_active = true
      WHERE t.id = e.next_action_task_id
        AND t.enquiry_id = e.id
        AND t.task_type IN ('FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING')
        AND t.status IN ('OPEN', 'IN_PROGRESS')
        AND t.due_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_next_action_exceptions x
      WHERE x.enquiry_id = e.id AND x.expires_at > ${ctx.evaluatedAt}
    )
  `;
}

function pilotFilter(sql, ctx) {
  if (!ctx.pilotState) return sql`TRUE`;
  if (ctx.pilotState === 'NONE') {
    return sql`NOT EXISTS (SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.status IN ('PLANNED', 'ACTIVE'))`;
  }
  if (ctx.pilotState === 'ENDING') {
    return sql`EXISTS (
      SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.status = 'ACTIVE'
        AND p.planned_end_at >= ${ctx.evaluatedAt} AND p.planned_end_at < ${ctx.evaluatedAt}::timestamptz + interval '48 hours'
    )`;
  }
  if (ctx.pilotState === 'END_OVERDUE') {
    return sql`EXISTS (
      SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.status = 'ACTIVE' AND p.planned_end_at < ${ctx.evaluatedAt}
    )`;
  }
  return sql`EXISTS (SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.status = ${ctx.pilotState})`;
}

function conversionKind(sql, ctx, kind) {
  const from = ctx.period.from;
  const to = ctx.period.to;
  return sql`EXISTS (
    SELECT 1 FROM crm_track_conversions v
    WHERE v.enquiry_id = e.id AND v.kind = ${kind}
      AND v.converted_at >= ${from} AND v.converted_at < ${to}
  )`;
}

function metricPredicate(sql, ctx) {
  const metric = ctx.metric;
  const from = ctx.period.from;
  const to = ctx.period.to;
  const T = ctx.evaluatedAt;
  switch (metric) {
    case 'new_leads':
      return sql`e.created_at >= ${from} AND e.created_at < ${to}`;
    case 'contacted':
    case 'qualified':
      return sql`EXISTS (
        SELECT 1 FROM crm_stage_history h
        WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED'
          AND h.to_code = ${metric === 'contacted' ? 'CONTACTED' : 'QUALIFIED'}
          AND h.entered_at >= ${from} AND h.entered_at < ${to}
      )`;
    case 'demo_scheduled':
      return sql`EXISTS (
        SELECT 1 FROM crm_demos d
        WHERE d.enquiry_id = e.id AND d.created_at >= ${from} AND d.created_at < ${to}
      )`;
    case 'demo_completed':
    case 'demo_cancelled':
    case 'demo_no_show': {
      const column = metric === 'demo_completed' ? 'completed_at' : metric === 'demo_cancelled' ? 'cancelled_at' : 'no_show_at';
      const status = metric === 'demo_completed' ? 'COMPLETED' : metric === 'demo_cancelled' ? 'CANCELLED' : 'NO_SHOW';
      return sql`EXISTS (
        SELECT 1 FROM crm_demos d
        WHERE d.enquiry_id = e.id AND d.status = ${status} AND d.${sql.unsafe(column)} IS NOT NULL
          AND d.${sql.unsafe(column)} >= ${from} AND d.${sql.unsafe(column)} < ${to}
      )`;
    }
    case 'demos_upcoming':
      return sql`e.outcome = 'OPEN' AND EXISTS (
        SELECT 1 FROM crm_demos d
        WHERE d.enquiry_id = e.id AND d.status = 'SCHEDULED' AND d.starts_at >= ${T}
      )`;
    case 'proposals_sent':
      return sql`EXISTS (
        SELECT 1 FROM crm_proposal_versions v
        JOIN crm_proposals p ON p.id = v.proposal_id
        WHERE p.enquiry_id = e.id AND v.sent_recorded_at >= ${from} AND v.sent_recorded_at < ${to}
      )`;
    case 'active_proposals':
      return sql`e.outcome = 'OPEN' AND EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (v.proposal_id) v.status, v.validity_date
          FROM crm_proposal_versions v
          JOIN crm_proposals p ON p.id = v.proposal_id
          WHERE p.enquiry_id = e.id AND v.status <> 'DRAFT'
          ORDER BY v.proposal_id, v.version_no DESC
        ) latest
        WHERE latest.status = 'SENT'
          AND (latest.validity_date IS NULL OR latest.validity_date >= (${T} AT TIME ZONE ${ctx.timezone})::date)
      )`;
    case 'active_pilots':
      return sql`e.outcome = 'OPEN' AND EXISTS (
        SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.status = 'ACTIVE'
      )`;
    case 'pilot_started':
      return sql`EXISTS (
        SELECT 1 FROM crm_pilots p
        WHERE p.enquiry_id = e.id AND p.started_at >= ${from} AND p.started_at < ${to}
      )`;
    case 'wins':
    case 'losses':
    case 'disqualified':
      return sql`EXISTS (
        SELECT 1 FROM crm_closures c
        WHERE c.enquiry_id = e.id
          AND c.outcome = ${metric === 'wins' ? 'WON' : metric === 'losses' ? 'LOST' : 'DISQUALIFIED'}
          AND c.closed_at >= ${from} AND c.closed_at < ${to}
      )`;
    case 'open_pipeline':
      return sql`e.outcome = 'OPEN'`;
    case 'current_stage':
      if (!ctx.stage) throw new CrmError(400, 'current_stage requires a stage', 'BAD_FILTER');
      return sql`e.outcome = 'OPEN' AND e.pipeline_stage_code = ${ctx.stage}`;
    case 'due_today':
      return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at >= ${T} AND t.due_at < ${ctx.period.nextLocalMidnight}`)}`;
    case 'overdue':
      return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at < ${T}`)}`;
    case 'severely_overdue':
      return sql`e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at <= ${ctx.severeBefore}`)}`;
    case 'no_followup':
      return missingFollowup(sql, ctx);
    case 'cohort_denominator':
      return sql`
        e.created_at >= ${from} AND e.created_at < ${to}
        AND NOT EXISTS (
          SELECT 1 FROM crm_closures c
          WHERE c.enquiry_id = e.id AND c.outcome = 'DISQUALIFIED' AND c.reason_code IN ('DUPLICATE', 'SPAM')
        )
      `;
    case 'cohort_numerator':
      return sql`
        e.created_at >= ${from} AND e.created_at < ${to}
        AND NOT EXISTS (
          SELECT 1 FROM crm_closures c
          WHERE c.enquiry_id = e.id AND c.outcome = 'DISQUALIFIED' AND c.reason_code IN ('DUPLICATE', 'SPAM')
        )
        AND EXISTS (
          SELECT 1 FROM crm_closures c
          WHERE c.enquiry_id = e.id AND c.outcome = 'WON' AND c.closed_at <= ${T}
        )
      `;
    case 'decision_numerator':
    case 'decision_denominator':
      return sql`TRUE`;
    case 'campaign_leads':
      return conversionKind(sql, ctx, 'ENQUIRY_CREATED');
    case 'track_demo_requests':
      return conversionKind(sql, ctx, 'DEMO_REQUESTED');
    case 'track_booked_demos':
      return conversionKind(sql, ctx, 'DEMO_BOOKED');
    case 'track_completed_demos':
      return conversionKind(sql, ctx, 'DEMO_COMPLETED');
    case 'track_wins':
      return conversionKind(sql, ctx, 'WON');
    case 'track_losses':
      return conversionKind(sql, ctx, 'LOST');
    default:
      throw new CrmError(400, 'This metric has no enquiry drill-down', 'BAD_METRIC');
  }
}

function stockPredicate(metric) {
  return [
    'demos_upcoming', 'active_proposals', 'active_pilots', 'open_pipeline', 'current_stage',
    'due_today', 'overdue', 'severely_overdue', 'no_followup',
  ].includes(metric);
}

async function countMetrics(sql, ctx) {
  const from = ctx.period.from;
  const to = ctx.period.to;
  const prevFrom = ctx.period.previousFrom;
  const prevTo = ctx.period.previousTo;
  const T = ctx.evaluatedAt;
  const [row] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE e.created_at >= ${from} AND e.created_at < ${to})::int AS new_leads,
      COUNT(*) FILTER (WHERE e.created_at >= ${prevFrom} AND e.created_at < ${prevTo})::int AS new_leads_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_stage_history h WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED'
          AND h.to_code = 'CONTACTED' AND h.entered_at >= ${from} AND h.entered_at < ${to}
      ))::int AS contacted,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_stage_history h WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED'
          AND h.to_code = 'CONTACTED' AND h.entered_at >= ${prevFrom} AND h.entered_at < ${prevTo}
      ))::int AS contacted_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_stage_history h WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED'
          AND h.to_code = 'QUALIFIED' AND h.entered_at >= ${from} AND h.entered_at < ${to}
      ))::int AS qualified,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_stage_history h WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED'
          AND h.to_code = 'QUALIFIED' AND h.entered_at >= ${prevFrom} AND h.entered_at < ${prevTo}
      ))::int AS qualified_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.created_at >= ${from} AND d.created_at < ${to}
      ))::int AS demo_scheduled,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.created_at >= ${prevFrom} AND d.created_at < ${prevTo}
      ))::int AS demo_scheduled_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.completed_at >= ${from} AND d.completed_at < ${to}
      ))::int AS demo_completed,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.completed_at >= ${prevFrom} AND d.completed_at < ${prevTo}
      ))::int AS demo_completed_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.cancelled_at >= ${from} AND d.cancelled_at < ${to}
      ))::int AS demo_cancelled,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.no_show_at >= ${from} AND d.no_show_at < ${to}
      ))::int AS demo_no_show,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_proposal_versions v JOIN crm_proposals p ON p.id = v.proposal_id
        WHERE p.enquiry_id = e.id AND v.sent_recorded_at >= ${from} AND v.sent_recorded_at < ${to}
      ))::int AS proposals_sent,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_proposal_versions v JOIN crm_proposals p ON p.id = v.proposal_id
        WHERE p.enquiry_id = e.id AND v.sent_recorded_at >= ${prevFrom} AND v.sent_recorded_at < ${prevTo}
      ))::int AS proposals_sent_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.started_at >= ${from} AND p.started_at < ${to}
      ))::int AS pilot_started,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'WON' AND c.closed_at >= ${from} AND c.closed_at < ${to}
      ))::int AS wins,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'WON' AND c.closed_at >= ${prevFrom} AND c.closed_at < ${prevTo}
      ))::int AS wins_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'LOST' AND c.closed_at >= ${from} AND c.closed_at < ${to}
      ))::int AS losses,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'LOST' AND c.closed_at >= ${prevFrom} AND c.closed_at < ${prevTo}
      ))::int AS losses_prev,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'DISQUALIFIED' AND c.closed_at >= ${from} AND c.closed_at < ${to}
      ))::int AS disqualified,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_accounts a WHERE a.id = e.account_id AND a.archived_at IS NOT NULL
      ))::int AS archived_account_enquiries
    FROM enquiries e
    WHERE ${enquiryBase(sql, ctx, { stock: false })}
  `;
  const [stock] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN')::int AS open_pipeline,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'NEW')::int AS stage_new,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'CONTACTED')::int AS stage_contacted,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'QUALIFIED')::int AS stage_qualified,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'DEMO')::int AS stage_demo,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'PROPOSAL')::int AS stage_proposal,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'NEGOTIATION')::int AS stage_negotiation,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code = 'PILOT')::int AS stage_pilot,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.pipeline_stage_code NOT IN ('NEW','CONTACTED','QUALIFIED','DEMO','PROPOSAL','NEGOTIATION','PILOT'))::int AS stage_unknown,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND EXISTS (
        SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.status = 'SCHEDULED' AND d.starts_at >= ${T}
      ))::int AS demos_upcoming,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND EXISTS (
        SELECT 1 FROM crm_pilots p WHERE p.enquiry_id = e.id AND p.status = 'ACTIVE'
      ))::int AS active_pilots,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (v.proposal_id) v.status, v.validity_date
          FROM crm_proposal_versions v
          JOIN crm_proposals p ON p.id = v.proposal_id
          WHERE p.enquiry_id = e.id AND v.status <> 'DRAFT'
          ORDER BY v.proposal_id, v.version_no DESC
        ) latest
        WHERE latest.status = 'SENT'
          AND (latest.validity_date IS NULL OR latest.validity_date >= (${T} AT TIME ZONE ${ctx.timezone})::date)
      ))::int AS active_proposals,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at >= ${T} AND t.due_at < ${ctx.period.nextLocalMidnight}`)})::int AS due_today,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at < ${T}`)})::int AS overdue,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at <= ${ctx.severeBefore}`)})::int AS severely_overdue,
      COUNT(*) FILTER (WHERE ${missingFollowup(sql, ctx)})::int AS no_followup,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND e.value_amount IS NULL)::int AS open_unvalued
    FROM enquiries e
    WHERE ${enquiryBase(sql, ctx, { stock: true })}
  `;
  const [events] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM crm_closures c
        JOIN enquiries e ON e.id = c.enquiry_id
        WHERE ${enquiryBase(sql, ctx, { stock: false })}
          AND c.outcome = 'WON' AND c.closed_at >= ${from} AND c.closed_at < ${to}) AS won_events,
      (SELECT COUNT(*)::int FROM crm_closures c
        JOIN enquiries e ON e.id = c.enquiry_id
        WHERE ${enquiryBase(sql, ctx, { stock: false })}
          AND c.outcome = 'LOST' AND c.closed_at >= ${from} AND c.closed_at < ${to}) AS lost_events,
      (SELECT COUNT(*)::int FROM crm_closures c
        JOIN enquiries e ON e.id = c.enquiry_id
        WHERE ${enquiryBase(sql, ctx, { stock: false })}
          AND c.outcome = 'WON' AND c.closed_at >= ${prevFrom} AND c.closed_at < ${prevTo}) AS won_events_prev,
      (SELECT COUNT(*)::int FROM crm_closures c
        JOIN enquiries e ON e.id = c.enquiry_id
        WHERE ${enquiryBase(sql, ctx, { stock: false })}
          AND c.outcome = 'LOST' AND c.closed_at >= ${prevFrom} AND c.closed_at < ${prevTo}) AS lost_events_prev,
      (SELECT COUNT(*)::int FROM crm_demos d
        JOIN enquiries e ON e.id = d.enquiry_id
        WHERE ${enquiryBase(sql, ctx, { stock: false })}
          AND d.status = 'COMPLETED' AND d.completed_at IS NULL) AS unknown_demo_completions
  `;
  const [cohort] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE NOT spam.excluded)::int AS denominator,
      COUNT(*) FILTER (WHERE NOT spam.excluded AND won.ever_won)::int AS numerator,
      COUNT(*) FILTER (WHERE spam.excluded)::int AS excluded_spam,
      COUNT(*) FILTER (WHERE NOT spam.excluded AND e.outcome = 'OPEN')::int AS still_open,
      COUNT(*) FILTER (WHERE NOT spam.excluded AND EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'LOST' AND c.closed_at <= ${T}
      ))::int AS ever_lost,
      COUNT(*) FILTER (WHERE NOT spam.excluded AND EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'DISQUALIFIED'
          AND c.reason_code IS DISTINCT FROM 'DUPLICATE' AND c.reason_code IS DISTINCT FROM 'SPAM'
      ))::int AS other_disqualified,
      COUNT(*) FILTER (WHERE e.outcome = 'LEGACY_UNKNOWN')::int AS legacy_unknown,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${T}::timestamptz - e.created_at)))
        FILTER (WHERE NOT spam.excluded) AS median_age_seconds
    FROM enquiries e
    JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM crm_closures c
        WHERE c.enquiry_id = e.id AND c.outcome = 'DISQUALIFIED' AND c.reason_code IN ('DUPLICATE', 'SPAM')
      ) AS excluded
    ) spam ON true
    JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM crm_closures c
        WHERE c.enquiry_id = e.id AND c.outcome = 'WON' AND c.closed_at <= ${T}
      ) AS ever_won
    ) won ON true
    WHERE ${enquiryBase(sql, ctx, { stock: false })}
      AND e.created_at >= ${from} AND e.created_at < ${to}
  `;
  const values = await sql`
    SELECT e.currency, COALESCE(SUM(e.value_amount), 0)::text AS amount, COUNT(*) FILTER (WHERE e.value_amount IS NULL)::int AS unvalued
    FROM enquiries e
    WHERE ${enquiryBase(sql, ctx, { stock: true })} AND e.outcome = 'OPEN'
    GROUP BY e.currency
    ORDER BY e.currency
  `;
  const wonValues = await sql`
    SELECT c.currency, COALESCE(SUM(c.value_amount), 0)::text AS amount, COUNT(*)::int AS episodes
    FROM crm_closures c
    JOIN enquiries e ON e.id = c.enquiry_id
    WHERE ${enquiryBase(sql, ctx, { stock: false })}
      AND c.outcome = 'WON' AND c.closed_at >= ${from} AND c.closed_at < ${to}
    GROUP BY c.currency
    ORDER BY c.currency
  `;
  return { events: row, stock, closureEvents: events, cohort, values, wonValues };
}

async function accountMetrics(sql, ctx) {
  const founder = ctx.founderId;
  const [row] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE a.created_at >= ${ctx.period.from} AND a.created_at < ${ctx.period.to})::int AS new_prospects,
      COUNT(*) FILTER (
        WHERE a.archived_at IS NULL AND a.account_type = 'PROSPECT'
          AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.account_id = a.id)
      )::int AS intake_backlog
    FROM crm_accounts a
    WHERE a.vertical = 'SCHOOL'
      AND (${founder}::uuid IS NULL OR a.owner_founder_id = ${founder})
      AND (${ctx.unassigned} = false OR a.owner_founder_id IS NULL)
      AND (${ctx.ownerId}::uuid IS NULL OR a.owner_founder_id = ${ctx.ownerId})
  `;
  const [contacts] = await sql`
    SELECT COUNT(DISTINCT c.id)::int AS contacts_on_file
    FROM crm_contacts c
    JOIN crm_accounts a ON a.id = c.account_id
    WHERE a.vertical = 'SCHOOL' AND a.archived_at IS NULL
      AND c.archived_at IS NULL AND c.contact_kind = 'PERSON'
      AND (${founder}::uuid IS NULL OR a.owner_founder_id = ${founder})
      AND EXISTS (
        SELECT 1 FROM crm_contact_methods m
        WHERE m.contact_id = c.id AND m.archived_at IS NULL AND NULLIF(btrim(m.normalized_value), '') IS NOT NULL
      )
  `;
  return { ...row, ...contacts };
}

function enquirySelect(sql, ctx, predicate, cursor) {
  return sql`
    SELECT e.id, e.name, e.organization, e.pipeline_stage_code, e.outcome, e.assigned_to,
           e.value_amount::text AS value_amount, e.currency, e.stage_entered_at, e.stage_time_quality,
           e.created_at, e.row_version, e.account_id, e.website_source, e.product_vertical,
           f.full_name AS owner_name
    FROM enquiries e
    LEFT JOIN founders f ON f.id = e.assigned_to
    WHERE ${enquiryBase(sql, ctx, { stock: stockPredicate(ctx.metric) })}
      AND ${predicate}
      AND (${cursor?.at || null}::timestamptz IS NULL OR (e.created_at, e.id) < (${cursor?.at || null}::timestamptz, ${cursor?.id || null}::uuid))
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${ctx.limit + 1}
  `;
}

async function listOpportunities(sql, ctx) {
  if (ctx.metric === 'new_prospects' || ctx.metric === 'intake_backlog') return listAccounts(sql, ctx);
  if (ctx.metric === 'decision_numerator' || ctx.metric === 'decision_denominator') return listDecisions(sql, ctx);
  if (ctx.metric === 'founder_attention') {
    throw new CrmError(400, 'Open founder attention from its own queue', 'BAD_METRIC');
  }
  const cursor = decodeCursor(ctx.cursor, ctx.filterHash);
  const predicate = metricPredicate(sql, ctx);
  const rows = await enquirySelect(sql, ctx, predicate, cursor ? { at: cursor.at, id: cursor.id } : null);
  const [count] = await sql`
    SELECT COUNT(*)::int AS total
    FROM enquiries e
    WHERE ${enquiryBase(sql, ctx, { stock: stockPredicate(ctx.metric) })}
      AND ${predicate}
  `;
  return pageEnquiries(rows, count.total, ctx);
}

function pageEnquiries(rows, total, ctx) {
  const pageRows = rows.slice(0, ctx.limit);
  const last = pageRows[pageRows.length - 1];
  const next = rows.length > ctx.limit && last
    ? { v: 1, h: ctx.filterHash, at: new Date(last.created_at).toISOString(), id: last.id }
    : null;
  return {
    rows: pageRows.map((row) => ({ ...row, entity_type: 'enquiry', entity_key: `enquiry:${row.id}` })),
    page: {
      limit: ctx.limit,
      next_cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
      total,
      evaluated_at: ctx.evaluatedAt,
    },
  };
}

async function listDecisions(sql, ctx) {
  const outcome = ctx.metric === 'decision_numerator' ? 'WON' : null;
  const cursor = decodeCursor(ctx.cursor, ctx.filterHash);
  const rows = await sql`
    SELECT c.id, c.enquiry_id, c.outcome, c.reason_code, c.closed_at, c.value_amount::text AS value_amount, c.currency,
           e.name, e.organization, e.created_at
    FROM crm_closures c
    JOIN enquiries e ON e.id = c.enquiry_id
    WHERE ${enquiryBase(sql, ctx, { stock: false })}
      AND c.outcome IN ('WON', 'LOST')
      AND c.closed_at >= ${ctx.period.from} AND c.closed_at < ${ctx.period.to}
      AND (${outcome}::text IS NULL OR c.outcome = ${outcome})
      AND (${cursor?.at || null}::timestamptz IS NULL OR (c.closed_at, c.id) < (${cursor?.at || null}::timestamptz, ${cursor?.id || null}::uuid))
    ORDER BY c.closed_at DESC, c.id DESC
    LIMIT ${ctx.limit + 1}
  `;
  const [count] = await sql`
    SELECT COUNT(*)::int AS total
    FROM crm_closures c
    JOIN enquiries e ON e.id = c.enquiry_id
    WHERE ${enquiryBase(sql, ctx, { stock: false })}
      AND c.outcome IN ('WON', 'LOST')
      AND c.closed_at >= ${ctx.period.from} AND c.closed_at < ${ctx.period.to}
      AND (${outcome}::text IS NULL OR c.outcome = ${outcome})
  `;
  const pageRows = rows.slice(0, ctx.limit);
  const last = pageRows[pageRows.length - 1];
  const next = rows.length > ctx.limit && last
    ? { v: 1, h: ctx.filterHash, at: new Date(last.closed_at).toISOString(), id: last.id }
    : null;
  return {
    rows: pageRows.map((row) => ({
      entity_type: 'closure',
      entity_key: `enquiry:${row.enquiry_id}`,
      id: row.enquiry_id,
      closure_id: row.id,
      name: row.name,
      organization: row.organization,
      outcome: row.outcome,
      reason_code: row.reason_code,
      closed_at: row.closed_at,
      value_amount: row.value_amount,
      currency: row.currency,
    })),
    page: {
      limit: ctx.limit,
      next_cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
      total: count.total,
      unit: 'closure_event',
      evaluated_at: ctx.evaluatedAt,
    },
  };
}

async function listAccounts(sql, ctx) {
  const founder = ctx.founderId;
  const backlog = ctx.metric === 'intake_backlog';
  const cursor = decodeCursor(ctx.cursor, ctx.filterHash);
  const rows = await sql`
    SELECT a.id, a.name, a.account_type, a.owner_founder_id, a.created_at, a.lifecycle_stage
    FROM crm_accounts a
    WHERE a.vertical = 'SCHOOL'
      AND (${founder}::uuid IS NULL OR a.owner_founder_id = ${founder})
      AND (${ctx.unassigned} = false OR a.owner_founder_id IS NULL)
      AND (${ctx.ownerId}::uuid IS NULL OR a.owner_founder_id = ${ctx.ownerId})
      AND (${backlog} = false OR (
        a.archived_at IS NULL AND a.account_type = 'PROSPECT'
        AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.account_id = a.id)
      ))
      AND (${backlog} = true OR (a.created_at >= ${ctx.period.from} AND a.created_at < ${ctx.period.to}))
      AND (${cursor?.at || null}::timestamptz IS NULL OR (a.created_at, a.id) < (${cursor?.at || null}::timestamptz, ${cursor?.id || null}::uuid))
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${ctx.limit + 1}
  `;
  const [count] = await sql`
    SELECT COUNT(*)::int AS total FROM crm_accounts a
    WHERE a.vertical = 'SCHOOL'
      AND (${founder}::uuid IS NULL OR a.owner_founder_id = ${founder})
      AND (${ctx.unassigned} = false OR a.owner_founder_id IS NULL)
      AND (${ctx.ownerId}::uuid IS NULL OR a.owner_founder_id = ${ctx.ownerId})
      AND (${backlog} = false OR (
        a.archived_at IS NULL AND a.account_type = 'PROSPECT'
        AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.account_id = a.id)
      ))
      AND (${backlog} = true OR (a.created_at >= ${ctx.period.from} AND a.created_at < ${ctx.period.to}))
  `;
  const pageRows = rows.slice(0, ctx.limit);
  const last = pageRows[pageRows.length - 1];
  const next = rows.length > ctx.limit && last
    ? { v: 1, h: ctx.filterHash, at: new Date(last.created_at).toISOString(), id: last.id }
    : null;
  return {
    rows: pageRows.map((row) => ({ ...row, entity_type: 'account', entity_key: `account:${row.id}` })),
    page: {
      limit: ctx.limit,
      next_cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
      total: count.total,
      unit: 'account',
      evaluated_at: ctx.evaluatedAt,
    },
  };
}

async function attentionRows(sql, ctx, { preview }) {
  const T = ctx.evaluatedAt;
  const limit = preview ? 10 : ctx.limit;
  const cursor = preview ? null : decodeCursor(ctx.cursor, ctx.filterHash);
  const rows = await sql`
    WITH facts AS (
      SELECT e.id, e.name, e.organization, e.created_at, e.assigned_to, e.pipeline_stage_code, e.outcome,
             e.value_amount, e.currency, e.stage_time_quality, e.stage_entered_at,
             f.is_active AS owner_active, f.auth_user_id,
             EXTRACT(EPOCH FROM (${T}::timestamptz - e.created_at)) AS age_seconds,
             CASE WHEN e.stage_time_quality = 'OBSERVED' THEN EXTRACT(EPOCH FROM (${T}::timestamptz - e.stage_entered_at)) ELSE NULL END AS stage_age,
             EXISTS (
               SELECT 1 FROM crm_tasks t
               JOIN founders assignee ON assignee.id = t.owner_founder_id AND assignee.is_active
               WHERE t.enquiry_id = e.id AND t.task_type IN ('FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING') AND t.status IN ('OPEN','IN_PROGRESS')
                 AND t.due_at <= ${ctx.severeBefore}
             ) AS severe,
             EXISTS (
               SELECT 1 FROM crm_tasks t
               JOIN founders assignee ON assignee.id = t.owner_founder_id AND assignee.is_active
               WHERE t.enquiry_id = e.id AND t.task_type IN ('FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING') AND t.status IN ('OPEN','IN_PROGRESS')
                 AND t.due_at < ${T} AND t.due_at > ${ctx.severeBefore}
             ) AS overdue,
             (
               SELECT MAX(p.completed_at) FROM crm_pilots p
               WHERE p.enquiry_id = e.id AND p.status = 'COMPLETED'
             ) AS pilot_completed_at,
             (
               SELECT MIN(p.planned_end_at) FROM crm_pilots p
               WHERE p.enquiry_id = e.id AND p.status = 'ACTIVE'
             ) AS pilot_end_at,
             (
               SELECT MAX(d.completed_at) FROM crm_demos d WHERE d.enquiry_id = e.id AND d.completed_at IS NOT NULL
             ) AS demo_completed_at,
             (
               SELECT MAX(v.sent_recorded_at)
               FROM crm_proposal_versions v
               JOIN crm_proposals p ON p.id = v.proposal_id
               WHERE p.enquiry_id = e.id AND v.sent_recorded_at IS NOT NULL
             ) AS proposal_sent_at,
             (
               SELECT MAX(a.occurred_at) FROM crm_activities a
               WHERE a.enquiry_id = e.id AND a.contact_outcome IN ('CONNECTED', 'RECEIVED') AND a.occurred_at <= ${T}
             ) AS last_success_at,
             (
               SELECT MAX(a.occurred_at) FROM crm_activities a
               WHERE a.enquiry_id = e.id AND a.contact_outcome = 'RECEIVED' AND a.direction = 'INBOUND' AND a.occurred_at <= ${T}
             ) AS last_response_at,
             ${missingFollowup(sql, ctx)} AS missing_next
      FROM enquiries e
      LEFT JOIN founders f ON f.id = e.assigned_to
      WHERE ${enquiryBase(sql, ctx, { stock: true })}
        AND e.outcome = 'OPEN'
    )
    SELECT id, name, organization, created_at, assigned_to, pipeline_stage_code, age_seconds, stage_age,
           severe, overdue, pilot_completed_at, pilot_end_at, demo_completed_at, proposal_sent_at,
           last_success_at, last_response_at, missing_next, value_amount::text AS value_amount, currency,
           stage_time_quality, owner_active, auth_user_id
    FROM facts
    ORDER BY created_at ASC, id ASC
  `;
  return { scanned: rows, limit, cursor };
}

async function aging(sql, ctx) {
  const T = ctx.evaluatedAt;
  const rows = await sql`
    SELECT
      CASE
        WHEN e.stage_time_quality <> 'OBSERVED' OR e.stage_entered_at IS NULL THEN 'unknown'
        WHEN floor(EXTRACT(EPOCH FROM (${T}::timestamptz - e.stage_entered_at)) / 86400) <= 2 THEN '0_2'
        WHEN floor(EXTRACT(EPOCH FROM (${T}::timestamptz - e.stage_entered_at)) / 86400) <= 7 THEN '3_7'
        WHEN floor(EXTRACT(EPOCH FROM (${T}::timestamptz - e.stage_entered_at)) / 86400) <= 14 THEN '8_14'
        WHEN floor(EXTRACT(EPOCH FROM (${T}::timestamptz - e.stage_entered_at)) / 86400) <= 30 THEN '15_30'
        ELSE '31_plus'
      END AS bucket,
      COUNT(*)::int AS count
    FROM enquiries e
    WHERE ${enquiryBase(sql, ctx, { stock: true })} AND e.outcome = 'OPEN'
    GROUP BY 1
    ORDER BY 1
  `;
  return rows;
}

async function funnel(sql, ctx) {
  const T = ctx.evaluatedAt;
  const from = ctx.period.from;
  const to = ctx.period.to;
  const [row] = await sql`
    WITH cohort AS (
      SELECT e.id, e.created_at, e.outcome
      FROM enquiries e
      WHERE ${enquiryBase(sql, ctx, { stock: false })}
        AND e.created_at >= ${from} AND e.created_at < ${to}
        AND NOT EXISTS (
          SELECT 1 FROM crm_closures c
          WHERE c.enquiry_id = e.id AND c.outcome = 'DISQUALIFIED' AND c.reason_code IN ('DUPLICATE', 'SPAM')
        )
    ),
    marks AS (
      SELECT c.id,
        c.created_at AS new_at,
        (SELECT MIN(h.entered_at) FROM crm_stage_history h
          WHERE h.enquiry_id = c.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED' AND h.to_code = 'CONTACTED' AND h.entered_at <= ${T}) AS contacted_at,
        (SELECT MIN(h.entered_at) FROM crm_stage_history h
          WHERE h.enquiry_id = c.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED' AND h.to_code = 'QUALIFIED' AND h.entered_at <= ${T}) AS qualified_at,
        (SELECT MIN(d.completed_at) FROM crm_demos d
          WHERE d.enquiry_id = c.id AND d.completed_at IS NOT NULL AND d.completed_at <= ${T}) AS demo_at,
        (SELECT MIN(v.sent_recorded_at) FROM crm_proposal_versions v
          JOIN crm_proposals p ON p.id = v.proposal_id
          WHERE p.enquiry_id = c.id AND v.sent_recorded_at IS NOT NULL AND v.sent_recorded_at <= ${T}) AS proposal_at,
        (SELECT MIN(p.started_at) FROM crm_pilots p
          WHERE p.enquiry_id = c.id AND p.started_at IS NOT NULL AND p.started_at <= ${T}) AS pilot_at,
        (SELECT MIN(cl.closed_at) FROM crm_closures cl
          WHERE cl.enquiry_id = c.id AND cl.outcome = 'WON' AND cl.closed_at <= ${T}) AS won_at
      FROM cohort c
    )
    SELECT
      COUNT(*)::int AS cohort_size,
      COUNT(*) FILTER (WHERE contacted_at IS NOT NULL)::int AS contacted,
      COUNT(*) FILTER (WHERE qualified_at IS NOT NULL)::int AS qualified,
      COUNT(*) FILTER (WHERE demo_at IS NOT NULL)::int AS demo_completed,
      COUNT(*) FILTER (WHERE proposal_at IS NOT NULL)::int AS proposal_sent,
      COUNT(*) FILTER (WHERE pilot_at IS NOT NULL)::int AS pilot_started,
      COUNT(*) FILTER (WHERE won_at IS NOT NULL)::int AS won,
      COUNT(*) FILTER (WHERE contacted_at IS NOT NULL AND qualified_at IS NOT NULL AND qualified_at >= contacted_at)::int AS contacted_to_qualified,
      COUNT(*) FILTER (WHERE qualified_at IS NOT NULL AND demo_at IS NOT NULL AND demo_at >= qualified_at)::int AS qualified_to_demo,
      COUNT(*) FILTER (WHERE demo_at IS NOT NULL AND proposal_at IS NOT NULL AND proposal_at >= demo_at)::int AS demo_to_proposal,
      COUNT(*) FILTER (WHERE proposal_at IS NOT NULL AND pilot_at IS NOT NULL AND pilot_at >= proposal_at)::int AS proposal_to_pilot,
      COUNT(*) FILTER (WHERE proposal_at IS NOT NULL AND won_at IS NOT NULL AND won_at >= proposal_at)::int AS proposal_to_won,
      COUNT(*) FILTER (WHERE pilot_at IS NOT NULL AND won_at IS NOT NULL AND won_at >= pilot_at)::int AS pilot_to_won,
      COUNT(*) FILTER (WHERE won_at IS NOT NULL AND demo_at IS NULL)::int AS won_without_demo,
      COUNT(*) FILTER (WHERE won_at IS NOT NULL AND pilot_at IS NULL)::int AS won_without_pilot
    FROM marks
  `;
  return row;
}

async function trends(sql, ctx) {
  const metric = ctx.metric || 'new_leads';
  const allowed = new Set(['new_leads', 'contacted', 'qualified', 'demo_completed', 'proposals_sent', 'wins', 'losses']);
  if (!allowed.has(metric)) throw new CrmError(400, 'This metric has no trend', 'BAD_METRIC');
  const [epoch] = await sql`SELECT capture_started_at FROM crm_capture_epochs WHERE id = 'sales_command_v1'`;
  const coverageStart = epoch?.capture_started_at ? new Date(epoch.capture_started_at) : ctx.period.from;
  const seriesStart = coverageStart > ctx.period.from ? coverageStart : ctx.period.from;
  const bucket = ctx.group === 'week' ? 'week' : 'day';
  const rows = await sql`
    WITH bounds AS (
      SELECT generate_series(
        date_trunc(${bucket}, ${seriesStart}::timestamptz AT TIME ZONE ${ctx.timezone}),
        date_trunc(${bucket}, (${ctx.period.to}::timestamptz - interval '1 microsecond') AT TIME ZONE ${ctx.timezone}),
        ${bucket === 'week' ? sql`interval '1 week'` : sql`interval '1 day'`}
      ) AS bucket_local
    )
    SELECT b.bucket_local, COUNT(DISTINCT e.id)::int AS enquiries
    FROM bounds b
    LEFT JOIN enquiries e ON ${enquiryBase(sql, ctx, { stock: false })}
      AND ${trendMatch(sql, ctx, metric, sql`b.bucket_local`)}
    GROUP BY b.bucket_local
    ORDER BY b.bucket_local
    LIMIT 400
  `;
  return { bucket, coverage_started_at: epoch?.capture_started_at || null, points: rows };
}

function trendMatch(sql, ctx, metric, bucketLocal) {
  const start = sql`(${bucketLocal} AT TIME ZONE ${ctx.timezone})`;
  const next = ctx.group === 'week'
    ? sql`((${bucketLocal} + interval '1 week') AT TIME ZONE ${ctx.timezone})`
    : sql`((${bucketLocal} + interval '1 day') AT TIME ZONE ${ctx.timezone})`;
  if (metric === 'new_leads') return sql`e.created_at >= ${start} AND e.created_at < ${next} AND e.created_at < ${ctx.period.to}`;
  if (metric === 'contacted' || metric === 'qualified') {
    const code = metric === 'contacted' ? 'CONTACTED' : 'QUALIFIED';
    return sql`EXISTS (
      SELECT 1 FROM crm_stage_history h
      WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED' AND h.to_code = ${code}
        AND h.entered_at >= ${start} AND h.entered_at < ${next} AND h.entered_at >= ${ctx.period.from} AND h.entered_at < ${ctx.period.to}
    )`;
  }
  if (metric === 'demo_completed') {
    return sql`EXISTS (
      SELECT 1 FROM crm_demos d WHERE d.enquiry_id = e.id AND d.completed_at >= ${start} AND d.completed_at < ${next}
        AND d.completed_at >= ${ctx.period.from} AND d.completed_at < ${ctx.period.to}
    )`;
  }
  if (metric === 'proposals_sent') {
    return sql`EXISTS (
      SELECT 1 FROM crm_proposal_versions v JOIN crm_proposals p ON p.id = v.proposal_id
      WHERE p.enquiry_id = e.id AND v.sent_recorded_at >= ${start} AND v.sent_recorded_at < ${next}
        AND v.sent_recorded_at >= ${ctx.period.from} AND v.sent_recorded_at < ${ctx.period.to}
    )`;
  }
  const outcome = metric === 'wins' ? 'WON' : 'LOST';
  return sql`EXISTS (
    SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = ${outcome}
      AND c.closed_at >= ${start} AND c.closed_at < ${next}
      AND c.closed_at >= ${ctx.period.from} AND c.closed_at < ${ctx.period.to}
  )`;
}

async function owners(sql, ctx) {
  if (ctx.scopeKind !== 'platform' && ctx.founderId == null) {
    throw new CrmError(403, 'Performance is limited to an authorized founder scope', 'SCOPE_DENIED');
  }
  const rows = await sql`
    SELECT e.assigned_to AS founder_id, COALESCE(f.full_name, 'Unassigned') AS name,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN')::int AS open_count,
      COUNT(*) FILTER (WHERE e.outcome = 'OPEN' AND ${eligible(sql, ctx, sql`t.due_at < ${ctx.evaluatedAt}`)})::int AS breach_count,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_stage_history h WHERE h.enquiry_id = e.id AND h.event_kind = 'STAGE' AND h.time_quality = 'OBSERVED'
          AND h.to_code = 'CONTACTED' AND h.entered_at >= ${ctx.period.from} AND h.entered_at < ${ctx.period.to}
      ))::int AS contacted,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'WON'
          AND c.closed_at >= ${ctx.period.from} AND c.closed_at < ${ctx.period.to}
      ))::int AS wins,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_closures c WHERE c.enquiry_id = e.id AND c.outcome = 'LOST'
          AND c.closed_at >= ${ctx.period.from} AND c.closed_at < ${ctx.period.to}
      ))::int AS losses
    FROM enquiries e
    LEFT JOIN founders f ON f.id = e.assigned_to
    WHERE ${enquiryBase(sql, ctx, { stock: false })}
    GROUP BY e.assigned_to, f.full_name
    ORDER BY open_count DESC, name ASC
    LIMIT 100
  `;
  return rows.map((row) => ({
    ...row,
    attribution: 'current_owner',
    decision_win_rate: (row.wins + row.losses) > 0 ? row.wins / (row.wins + row.losses) : null,
    decision_note: 'Wins and losses here are distinct enquiries in the period, not closure episodes. The decision rate on the summary uses episodes.',
  }));
}

async function attributionSnapshot(sql, ctx) {
  const from = ctx.period.from;
  const to = ctx.period.to;
  const founderId = ctx.founderId;
  const [conversions] = await sql`
    SELECT
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'ENQUIRY_CREATED')::int AS campaign_leads,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'DEMO_REQUESTED')::int AS demo_requests,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'DEMO_BOOKED')::int AS booked_demos,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'DEMO_COMPLETED')::int AS completed_demos,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'WON')::int AS wins,
      COUNT(DISTINCT v.enquiry_id) FILTER (WHERE v.kind = 'LOST')::int AS losses
    FROM crm_track_conversions v
    JOIN enquiries e ON e.id = v.enquiry_id
    WHERE v.converted_at >= ${from} AND v.converted_at < ${to}
      AND ${enquiryBase(sql, ctx, { stock: false })}
  `;
  const [opens] = await sql`
    SELECT
      COUNT(*)::int AS raw_opens,
      COUNT(*) FILTER (WHERE o.event_class = 'QUALIFIED' AND o.countable)::int AS qualified_opens,
      COUNT(*) FILTER (WHERE o.destination_class <> 'OWNED_SITE')::int AS external_opens
    FROM crm_track_opens o
    WHERE o.observed_at >= ${from} AND o.observed_at < ${to}
      AND (${founderId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM crm_track_links l WHERE l.id = o.link_id AND l.owner_founder_id = ${founderId}
      ))
      AND (${ctx.trackLinkId}::uuid IS NULL OR o.link_id = ${ctx.trackLinkId})
      AND (${ctx.campaignId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM crm_track_link_revisions r
        WHERE r.id = o.revision_id AND r.campaign_id = ${ctx.campaignId}
      ))
  `;
  return {
    schema_version: 1,
    model: ctx.attributionModel || 'first',
    time_basis: 'conversion event time for facts; open event time for opens; lead scope follows the existing owner filter',
    ...conversions,
    ...opens,
    external_conversion_coverage: opens.external_opens > 0 ? 'unavailable' : 'not_applicable',
    note: 'First and latest are alternate views of the same enquiries. Do not add them together. External destinations are unavailable, not zero.',
  };
}

module.exports = {
  countMetrics,
  accountMetrics,
  listOpportunities,
  attentionRows,
  aging,
  funnel,
  trends,
  owners,
  enquiryBase,
  metricPredicate,
  attributionSnapshot,
};
