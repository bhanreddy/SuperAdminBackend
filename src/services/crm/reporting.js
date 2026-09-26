/**
 * Pipeline figures come from the CRM database.
 * Win/loss denominators are definitive WON + LOST + DISQUALIFIED closures in the
 * closed_at window. LEGACY_UNKNOWN is excluded from both sides of that ratio.
 * Values are never added across currencies. Proposal totals are not revenue.
 */
async function salesReport(crmSql, scope, query) {
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  const from = query.from || '2000-01-01';
  const to = query.to || '2999-01-01';
  const optional = async (query) => {
    try {
      return await query;
    } catch (err) {
      if (err && (err.code === '42703' || err.code === '42P01')) return [];
      throw err;
    }
  };
  const [stageAging, outcomes, pipeline, demos, proposals, sources] = await Promise.all([
    optional(crmSql`
      SELECT pipeline_stage_code AS stage, COUNT(*)::int AS open_leads,
             ROUND(AVG(EXTRACT(EPOCH FROM (now() - stage_entered_at)) / 86400)::numeric, 1) AS average_age_days
      FROM enquiries
      WHERE outcome = 'OPEN' AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
      GROUP BY pipeline_stage_code
      ORDER BY pipeline_stage_code
    `),
    optional(crmSql`
      SELECT outcome, currency, COUNT(*)::int AS count, COALESCE(SUM(value_amount), 0) AS value
      FROM enquiries
      WHERE outcome IN ('WON', 'LOST', 'DISQUALIFIED')
        AND closed_at >= ${from}::timestamptz AND closed_at < ${to}::timestamptz
        AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
      GROUP BY outcome, currency
      ORDER BY outcome, currency
    `),
    optional(crmSql`
      SELECT currency, COUNT(*)::int AS open_leads, COALESCE(SUM(value_amount), 0) AS open_value
      FROM enquiries
      WHERE outcome = 'OPEN' AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
      GROUP BY currency
      ORDER BY currency
    `),
    optional(crmSql`
      SELECT d.status, COUNT(*)::int AS count
      FROM crm_demos d
      JOIN enquiries e ON e.id = d.enquiry_id
      WHERE (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
      GROUP BY d.status
      ORDER BY d.status
    `),
    optional(crmSql`
      SELECT v.status, v.currency, COUNT(*)::int AS count, COALESCE(SUM(v.amount), 0) AS amount
      FROM crm_proposal_versions v
      JOIN crm_proposals p ON p.id = v.proposal_id
      JOIN enquiries e ON e.id = p.enquiry_id
      WHERE (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
      GROUP BY v.status, v.currency
      ORDER BY v.status, v.currency
    `),
    optional(crmSql`
      SELECT COALESCE(ch.code, 'UNSET') AS channel,
             COUNT(*)::int AS created,
             COUNT(*) FILTER (WHERE e.outcome = 'WON')::int AS won
      FROM enquiries e
      LEFT JOIN crm_acquisition_channels ch ON ch.id = e.acquisition_channel_id
      WHERE e.created_at >= ${from}::timestamptz AND e.created_at < ${to}::timestamptz
        AND (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
      GROUP BY ch.code
      ORDER BY ch.code NULLS LAST
    `),
  ]);
  let legacy = { count: 0 };
  try {
    const [row] = await crmSql`
      SELECT COUNT(*)::int AS count FROM enquiries
      WHERE outcome = 'LEGACY_UNKNOWN' AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
    `;
    legacy = row || legacy;
  } catch (err) {
    if (!err || (err.code !== '42703' && err.code !== '42P01')) throw err;
  }
  const definitive = outcomes.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const won = outcomes.filter((row) => row.outcome === 'WON').reduce((sum, row) => sum + Number(row.count || 0), 0);
  return {
    basis: {
      timezone_note: 'Report dates are inclusive-exclusive UTC bounds supplied by the caller.',
      win_loss_denominator: 'WON + LOST + DISQUALIFIED with closed_at in range. LEGACY_UNKNOWN is excluded.',
      source_denominator: 'Enquiries created in range. Wins are outcome WON only.',
      revenue: 'Proposal amounts are commercial offers, not collected payments.',
    },
    stage_aging: stageAging,
    outcomes_by_currency: outcomes,
    open_pipeline_by_currency: pipeline,
    win_rate: definitive ? Number((won / definitive).toFixed(4)) : null,
    legacy_unknown_excluded: legacy.count,
    demo_outcomes: demos,
    proposal_amounts_by_currency: proposals,
    source_conversion: sources.map((row) => ({
      ...row,
      rate: row.created ? Number((row.won / row.created).toFixed(4)) : null,
    })),
  };
}

module.exports = { salesReport };
