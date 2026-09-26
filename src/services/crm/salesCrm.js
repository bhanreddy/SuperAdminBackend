const { CrmError } = require('./errors');
const { assertAccountAccess, assertCrmWrite, assertLeadAccess, assertPlatform } = require('./accessPolicy');
const { classifyUpload } = require('../../utils/uploadBytes');
const { assertActiveFounder } = require('./founderSync');
const { enqueueAutomationEvent } = require('../crmAutomation');
const {
  INTERACTION_TYPES,
  legacyStatusFor,
  parseCurrency,
  parseMoney,
  parseTimezone,
  requireVersion,
} = require('./helpers');

const STAGE_FROM_LEGACY = { NEW: 'NEW', CONTACTED: 'CONTACTED', QUALIFIED: 'QUALIFIED' };

async function lockLead(tx, id, expectedVersion) {
  const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${id} FOR UPDATE`;
  if (!lead) throw new CrmError(404, 'Enquiry not found', 'NOT_FOUND');
  if (Number(lead.row_version) !== Number(expectedVersion)) {
    throw new CrmError(409, 'The lead was updated by someone else. Refresh and retry.', 'VERSION_CONFLICT');
  }
  return lead;
}

async function audit(tx, actor, entityType, action, entityId, oldValue, newValue) {
  await tx`
    INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
    VALUES (${entityType}, ${action}, ${actor.id}, ${tx.json({
      entity_id: entityId,
      old: oldValue || null,
      new: newValue || null,
      source: 'sales_crm',
    })})
  `;
}

async function saveLead(tx, lead, patch) {
  const next = {
    pipeline_stage_code: patch.pipeline_stage_code !== undefined ? patch.pipeline_stage_code : lead.pipeline_stage_code,
    outcome: patch.outcome !== undefined ? patch.outcome : lead.outcome,
    outcome_review_required: patch.outcome_review_required !== undefined ? patch.outcome_review_required : lead.outcome_review_required,
    stage_entered_at: patch.stage_entered_at !== undefined ? patch.stage_entered_at : lead.stage_entered_at,
    currency: patch.currency !== undefined ? patch.currency : lead.currency,
    closed_at: patch.closed_at !== undefined ? patch.closed_at : lead.closed_at,
    value_amount: patch.value_amount !== undefined ? patch.value_amount : lead.value_amount,
    deal_value: patch.deal_value !== undefined ? patch.deal_value : lead.deal_value,
    next_action_task_id: patch.next_action_task_id !== undefined ? patch.next_action_task_id : lead.next_action_task_id,
    territory_id: patch.territory_id !== undefined ? patch.territory_id : lead.territory_id,
    acquisition_channel_id: patch.acquisition_channel_id !== undefined ? patch.acquisition_channel_id : lead.acquisition_channel_id,
    campaign_name: patch.campaign_name !== undefined ? patch.campaign_name : lead.campaign_name,
    referral_metadata: patch.referral_metadata !== undefined ? patch.referral_metadata : (lead.referral_metadata || {}),
    product_vertical: patch.product_vertical !== undefined ? patch.product_vertical : lead.product_vertical,
    intake_queue: patch.intake_queue !== undefined ? patch.intake_queue : lead.intake_queue,
    assigned_to: patch.assigned_to !== undefined ? patch.assigned_to : lead.assigned_to,
    status: patch.status !== undefined ? patch.status : lead.status,
    account_id: patch.account_id !== undefined ? patch.account_id : lead.account_id,
    converted_at: patch.converted_at !== undefined ? patch.converted_at : lead.converted_at,
    last_activity_at: patch.last_activity_at !== undefined ? patch.last_activity_at : lead.last_activity_at,
    stage_time_quality: patch.stage_time_quality !== undefined ? patch.stage_time_quality : lead.stage_time_quality,
  };
  const [updated] = await tx`
    UPDATE enquiries SET
      pipeline_stage_code = ${next.pipeline_stage_code},
      outcome = ${next.outcome},
      outcome_review_required = ${next.outcome_review_required},
      stage_entered_at = ${next.stage_entered_at},
      currency = ${next.currency},
      closed_at = ${next.closed_at},
      value_amount = ${next.value_amount},
      deal_value = ${next.deal_value},
      next_action_task_id = ${next.next_action_task_id},
      territory_id = ${next.territory_id},
      acquisition_channel_id = ${next.acquisition_channel_id},
      campaign_name = ${next.campaign_name},
      referral_metadata = ${tx.json(next.referral_metadata || {})},
      product_vertical = ${next.product_vertical},
      intake_queue = ${next.intake_queue},
      assigned_to = ${next.assigned_to},
      status = ${next.status},
      account_id = ${next.account_id},
      converted_at = ${next.converted_at},
      last_activity_at = ${next.last_activity_at},
      stage_time_quality = ${next.stage_time_quality || 'UNKNOWN'},
      row_version = row_version + 1,
      updated_at = now()
    WHERE id = ${lead.id} AND row_version = ${lead.row_version}
    RETURNING *
  `;
  if (!updated) throw new CrmError(409, 'The lead was updated by someone else. Refresh and retry.', 'VERSION_CONFLICT');
  return updated;
}

function scopeSql(scope) {
  if (scope.kind === 'platform') return { founderId: null };
  return { founderId: scope.founderId };
}

async function listLeads(crmSql, scope, query) {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const founderId = scopeSql(scope).founderId;
  let cursorTime = null;
  let cursorId = null;
  if (query.cursor) {
    const decoded = Buffer.from(String(query.cursor), 'base64url').toString('utf8');
    const split = decoded.indexOf('\n');
    if (split <= 0) throw new CrmError(400, 'Invalid cursor', 'BAD_CURSOR');
    cursorTime = decoded.slice(0, split);
    cursorId = decoded.slice(split + 1);
  }
  const search = String(query.q || '').trim();
  const like = search ? `%${search.slice(0, 120)}%` : null;
  const unassigned = query.unassigned === true || query.unassigned === 'true' || query.unassigned === '1' || query.owner === 'unassigned';
  const owner = query.owner && query.owner !== 'unassigned' ? query.owner : null;
  const rows = await crmSql`
    SELECT e.id, e.name, e.email, e.phone, e.organization, e.website_source, e.category,
           e.status, e.assigned_to, e.deal_value, e.value_amount, e.currency, e.message,
           e.pipeline_stage_code, e.outcome, e.outcome_review_required, e.stage_entered_at,
           e.row_version, e.territory_id, e.acquisition_channel_id, e.campaign_name,
           e.product_vertical, e.intake_queue, e.account_id, e.next_action_task_id,
           e.next_follow_up_at, e.last_activity_at, e.closed_at, e.created_at, e.updated_at,
           t.title AS next_action_title, t.due_at AS next_action_due_at, t.owner_founder_id AS next_action_assignee_id,
           f.full_name AS owner_name, ch.code AS channel_code, ter.code AS territory_code
    FROM enquiries e
    LEFT JOIN crm_tasks t ON t.id = e.next_action_task_id
    LEFT JOIN founders f ON f.id = e.assigned_to
    LEFT JOIN crm_acquisition_channels ch ON ch.id = e.acquisition_channel_id
    LEFT JOIN crm_territories ter ON ter.id = e.territory_id
    WHERE (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
      AND (${query.status || null}::text IS NULL OR e.status = ${query.status || null})
      AND (${query.stage || null}::text IS NULL OR e.pipeline_stage_code = ${query.stage || null})
      AND (${query.outcome || null}::text IS NULL OR e.outcome = ${query.outcome || null})
      AND (${owner}::uuid IS NULL OR e.assigned_to = ${owner})
      AND (${query.territory_id || null}::uuid IS NULL OR e.territory_id = ${query.territory_id || null})
      AND (${query.channel_id || null}::uuid IS NULL OR e.acquisition_channel_id = ${query.channel_id || null})
      AND (${query.source || null}::text IS NULL OR e.website_source = ${query.source || null})
      AND (${query.category || null}::text IS NULL OR e.category = ${query.category || null})
      AND (${unassigned} = false OR e.assigned_to IS NULL)
      AND (${like}::text IS NULL OR e.name ILIKE ${like} OR e.organization ILIKE ${like} OR e.email ILIKE ${like} OR e.phone ILIKE ${like} OR e.website_source ILIKE ${like})
      AND (${cursorTime}::timestamptz IS NULL OR (e.updated_at, e.id) < (${cursorTime}::timestamptz, ${cursorId}::uuid))
    ORDER BY e.updated_at DESC, e.id DESC
    LIMIT ${limit + 1}
  `;
  const pageRows = rows.slice(0, limit);
  const more = rows.length > limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = more && last
    ? Buffer.from(`${new Date(last.updated_at).toISOString()}\n${last.id}`).toString('base64url')
    : null;
  return {
    data: pageRows.map(presentLead),
    page: { limit, next_cursor: nextCursor },
  };
}

function presentLead(row) {
  return {
    ...row,
    source: row.website_source,
    notes: row.message,
    value: row.value_amount != null ? row.value_amount : row.deal_value,
  };
}

async function getLead(crmSql, scope, id) {
  const [lead] = await crmSql`
    SELECT e.*, t.title AS next_action_title, t.due_at AS next_action_due_at,
           t.owner_founder_id AS next_action_assignee_id, tf.full_name AS next_action_assignee_name,
           f.full_name AS owner_name, ch.code AS channel_code, ch.label AS channel_label,
           ter.code AS territory_code, ter.name AS territory_name
    FROM enquiries e
    LEFT JOIN crm_tasks t ON t.id = e.next_action_task_id
    LEFT JOIN founders tf ON tf.id = t.owner_founder_id
    LEFT JOIN founders f ON f.id = e.assigned_to
    LEFT JOIN crm_acquisition_channels ch ON ch.id = e.acquisition_channel_id
    LEFT JOIN crm_territories ter ON ter.id = e.territory_id
    WHERE e.id = ${id}
  `;
  assertLeadAccess(scope, lead);
  const [activities, tasks, demos, proposals, onboarding, closures, history] = await Promise.all([
    crmSql`SELECT id, activity_type, summary, result, visibility, occurred_at, recorded_at, actor_id FROM crm_activities WHERE enquiry_id = ${id} ORDER BY occurred_at DESC LIMIT 100`,
    crmSql`SELECT id, title, status, task_type, due_at, owner_founder_id, completed_at, row_version FROM crm_tasks WHERE enquiry_id = ${id} ORDER BY created_at DESC LIMIT 100`,
    crmSql`SELECT * FROM crm_demos WHERE enquiry_id = ${id} ORDER BY starts_at DESC LIMIT 50`,
    crmSql`
      SELECT p.id, p.proposal_number, p.currency, v.id AS version_id, v.version_no, v.amount, v.status,
             v.validity_date, v.delivery_state, v.sent_recorded_at, v.created_at
      FROM crm_proposals p
      JOIN crm_proposal_versions v ON v.proposal_id = p.id
      WHERE p.enquiry_id = ${id}
      ORDER BY p.created_at DESC, v.version_no DESC
    `,
    crmSql`SELECT id, status, cluster_id, target_school_id, failure_reason, attempt_count, steps, updated_at, idempotency_key FROM crm_onboarding_operations WHERE enquiry_id = ${id} ORDER BY created_at DESC LIMIT 5`,
    crmSql`SELECT id, outcome, reason_code, notes, value_amount, currency, closed_at, exception_reason, reopened_at, reopen_reason, created_at FROM crm_closures WHERE enquiry_id = ${id} ORDER BY created_at`,
    crmSql`SELECT from_code, to_code, entered_at, event_kind, time_quality, event_seq, actor_id FROM crm_stage_history WHERE enquiry_id = ${id} ORDER BY event_seq DESC LIMIT 50`,
  ]);
  const pilots = await crmSql`SELECT * FROM crm_pilots WHERE enquiry_id = ${id} ORDER BY created_at DESC LIMIT 20`;
  let accountVisibility = 'none';
  if (lead.account_id) {
    const [account] = await crmSql`SELECT * FROM crm_accounts WHERE id = ${lead.account_id}`;
    accountVisibility = scope.kind === 'platform' || account?.owner_founder_id === scope.founderId ? 'full' : 'restricted';
  }
  return {
    lead: presentLead(lead),
    activities,
    tasks,
    demos,
    proposals,
    onboarding,
    closures,
    history,
    pilots,
    account_visibility: accountVisibility,
    permissions: {
      write_sales: Boolean(scope.canWrite),
      reassign: scope.kind === 'platform',
    },
  };
}

async function hasOpenException(tx, enquiryId) {
  const [row] = await tx`
    SELECT id FROM crm_next_action_exceptions
    WHERE enquiry_id = ${enquiryId} AND expires_at > now()
    ORDER BY expires_at DESC LIMIT 1
  `;
  return Boolean(row);
}

async function insertTask(tx, actor, lead, input) {
  const title = String(input?.title || '').trim();
  if (title.length < 2 || title.length > 180) throw new CrmError(400, 'Task title is required', 'BAD_TASK');
  if (!input?.due_at) throw new CrmError(400, 'An actionable task needs a due time', 'DUE_REQUIRED');
  const due = new Date(input.due_at);
  if (Number.isNaN(due.getTime())) throw new CrmError(400, 'Invalid due time', 'BAD_DUE');
  const assignee = input.assignee_founder_id || input.owner_founder_id;
  await assertActiveFounder(tx, assignee);
  if (input.account_id && lead.account_id && input.account_id !== lead.account_id) {
    throw new CrmError(400, 'Task account does not match the lead', 'RELATION_MISMATCH');
  }
  const [task] = await tx`
    INSERT INTO crm_tasks (title, description, task_type, priority, owner_founder_id, account_id, enquiry_id, due_at, created_by)
    VALUES (
      ${title}, ${input.description || null}, ${input.task_type || 'FOLLOW_UP'}, ${input.priority || 'MEDIUM'},
      ${assignee}, ${lead.account_id || input.account_id || null}, ${lead.id}, ${due.toISOString()}, ${actor.id}
    )
    RETURNING *
  `;
  await tx`
    INSERT INTO crm_activities (
      activity_type, account_id, enquiry_id, task_id, actor_id, summary, visibility, result, contact_outcome, direction, details
    ) VALUES (
      'SYSTEM', ${task.account_id}, ${lead.id}, ${task.id}, ${actor.id}, ${`Task created: ${task.title}`}, 'SYSTEM', NULL,
      'NOT_APPLICABLE', 'INTERNAL', ${tx.json({ due_at: task.due_at, status: task.status })}
    )
  `;
  return task;
}

async function assignOwner(crmSql, scope, enquiryId, body) {
  assertPlatform(scope);
  const version = requireVersion(body.expected_version);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    await assertActiveFounder(tx, body.owner_founder_id);
    if (lead.territory_id) {
      const [member] = await tx`
        SELECT 1 FROM crm_territory_members
        WHERE territory_id = ${lead.territory_id} AND founder_id = ${body.owner_founder_id}
      `;
      if (!member) throw new CrmError(400, 'Owner is not a member of the lead territory', 'TERRITORY_OWNER_MISMATCH');
    }
    let nextActionId = lead.next_action_task_id;
    if (lead.outcome === 'OPEN' && !nextActionId && !(await hasOpenException(tx, lead.id))) {
      if (!body.next_action) throw new CrmError(400, 'Assigning an owner requires a next action', 'NEXT_ACTION_REQUIRED');
      const task = await insertTask(tx, scope.actor, lead, { ...body.next_action, assignee_founder_id: body.next_action.assignee_founder_id || body.owner_founder_id });
      nextActionId = task.id;
    }
    await tx`
      INSERT INTO crm_owner_history (enquiry_id, from_founder_id, to_founder_id, actor_id)
      VALUES (${lead.id}, ${lead.assigned_to}, ${body.owner_founder_id}, ${scope.actor.id})
    `;
    const updated = await saveLead(tx, lead, {
      assigned_to: body.owner_founder_id,
      next_action_task_id: nextActionId,
      intake_queue: null,
    });
    await audit(tx, scope.actor, 'enquiry', 'ASSIGN_OWNER', lead.id, { assigned_to: lead.assigned_to }, { assigned_to: updated.assigned_to });
    return presentLead(updated);
  });
}

async function applyStageMove(tx, scope, lead, target, options = {}) {
  if (lead.outcome !== 'OPEN') throw new CrmError(409, 'Closed leads cannot change stage', 'LEAD_CLOSED');
  const [stage] = await tx`SELECT * FROM crm_stage_definitions WHERE code = ${target} AND archived_at IS NULL`;
  if (!stage) throw new CrmError(400, 'Unknown or archived stage', 'BAD_STAGE');
  const [edge] = await tx`
    SELECT requires_reason FROM crm_stage_edges
    WHERE from_code = ${lead.pipeline_stage_code} AND to_code = ${target} AND archived_at IS NULL
  `;
  if (!edge) throw new CrmError(409, 'That stage transition is not allowed', 'STAGE_TRANSITION');
  if (edge.requires_reason && String(options.reason || '').trim().length < 3) {
    throw new CrmError(400, 'Moving backward from pilot requires a reason', 'STAGE_REASON_REQUIRED');
  }
  const requirements = stage.entry_requirements || {};
  if (requirements.requires_active_pilot) {
    const [pilot] = await tx`SELECT 1 FROM crm_pilots WHERE enquiry_id = ${lead.id} AND status = 'ACTIVE' LIMIT 1`;
    if (!pilot) throw new CrmError(400, 'Pilot stage requires an active pilot on this enquiry', 'STAGE_REQUIREMENT');
  }
  if (Array.isArray(requirements.demo_status_any) && requirements.demo_status_any.length) {
    const [demo] = await tx`
      SELECT 1 FROM crm_demos WHERE enquiry_id = ${lead.id} AND status = ANY(${requirements.demo_status_any}) LIMIT 1
    `;
    if (!demo) throw new CrmError(400, 'This stage requires a demo in the configured status', 'STAGE_REQUIREMENT');
  }
  if (Array.isArray(requirements.proposal_status_any) && requirements.proposal_status_any.length) {
    const [proposal] = await tx`
      SELECT 1 FROM crm_proposal_versions v
      JOIN crm_proposals p ON p.id = v.proposal_id
      WHERE p.enquiry_id = ${lead.id} AND v.status = ANY(${requirements.proposal_status_any})
      LIMIT 1
    `;
    if (!proposal) throw new CrmError(400, 'This stage requires a proposal in the configured status', 'STAGE_REQUIREMENT');
  }
  const [clock] = await tx`SELECT now() AS ts`;
  await tx`
    INSERT INTO crm_stage_history (
      enquiry_id, from_code, to_code, actor_id, entered_at, event_kind, time_quality, recorded_at
    ) VALUES (
      ${lead.id}, ${lead.pipeline_stage_code}, ${target}, ${scope.actor.id}, ${clock.ts}, 'STAGE', 'OBSERVED', ${clock.ts}
    )
  `;
  const updated = await saveLead(tx, lead, {
    pipeline_stage_code: target,
    stage_entered_at: clock.ts,
    stage_time_quality: 'OBSERVED',
    status: legacyStatusFor(target, lead.outcome, lead.status),
  });
  await audit(tx, scope.actor, 'enquiry', 'STAGE', lead.id, { stage: lead.pipeline_stage_code }, { stage: target, reason: options.reason || null });
  return updated;
}

async function moveStage(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const target = String(body.stage || '').trim().toUpperCase();
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    if (lead.pipeline_stage_code === target) return presentLead(lead);
    const updated = await applyStageMove(tx, scope, lead, target, { reason: body.reason });
    return presentLead(updated);
  });
}

async function logActivity(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const type = String(body.activity_type || '').trim().toUpperCase();
  if (!INTERACTION_TYPES.has(type)) throw new CrmError(400, 'Unsupported activity type', 'BAD_ACTIVITY');
  const summary = String(body.summary || '').trim();
  if (summary.length < 2 || summary.length > 2000) throw new CrmError(400, 'Summary is required', 'BAD_SUMMARY');
  const occurred = body.occurred_at ? new Date(body.occurred_at) : new Date();
  if (Number.isNaN(occurred.getTime())) throw new CrmError(400, 'Invalid activity time', 'BAD_TIME');
  if (occurred.getTime() > Date.now() + 2 * 60 * 1000) throw new CrmError(400, 'Activity time cannot be in the future', 'FUTURE_TIME');
  const outcomes = new Set(['CONNECTED', 'SENT', 'RECEIVED', 'NO_ANSWER', 'UNKNOWN', 'NOT_APPLICABLE']);
  const directions = new Set(['INBOUND', 'OUTBOUND', 'INTERNAL']);
  const contactOutcome = String(body.contact_outcome || (type === 'NOTE' ? 'NOT_APPLICABLE' : 'UNKNOWN')).toUpperCase();
  const direction = String(body.direction || (type === 'NOTE' ? 'INTERNAL' : 'OUTBOUND')).toUpperCase();
  if (!outcomes.has(contactOutcome) || !directions.has(direction)) throw new CrmError(400, 'Unsupported contact evidence', 'BAD_ACTIVITY');
  if (['DEMO_COMPLETED', 'PROPOSAL_SENT', 'PILOT_STARTED', 'PILOT_COMPLETED'].includes(type)) {
    throw new CrmError(400, 'Use the demo, proposal, or pilot command for that event', 'AUTHORITATIVE_EVENT');
  }
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    const visibility = type === 'CUSTOMER_MESSAGE' ? 'CUSTOMER_MESSAGE' : 'INTERNAL';
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, actor_id, summary, result, visibility, occurred_at, recorded_at,
        details, contact_outcome, direction
      ) VALUES (
        ${type}, ${lead.account_id}, ${lead.id}, ${scope.actor.id}, ${summary}, ${body.result || null},
        ${visibility}, ${occurred.toISOString()}, now(), ${tx.json({})}, ${contactOutcome}, ${direction}
      )
    `;
    let nextActionId = lead.next_action_task_id;
    if (body.follow_up) {
      const task = await insertTask(tx, scope.actor, lead, body.follow_up);
      nextActionId = task.id;
    }
    const previous = lead.last_activity_at ? new Date(lead.last_activity_at) : null;
    const movesActivity = type !== 'NOTE' && (!previous || occurred > previous);
    const updated = await saveLead(tx, lead, {
      last_activity_at: movesActivity ? occurred.toISOString() : lead.last_activity_at,
      next_action_task_id: nextActionId,
    });
    return presentLead(updated);
  });
}

async function createTask(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    const task = await insertTask(tx, scope.actor, lead, body);
    let updated = lead;
    if (body.set_as_next !== false && lead.outcome === 'OPEN') {
      updated = await saveLead(tx, lead, { next_action_task_id: task.id });
    }
    return { task, lead: presentLead(updated) };
  });
}

async function completeTask(crmSql, scope, enquiryId, taskId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    const [task] = await tx`SELECT * FROM crm_tasks WHERE id = ${taskId} FOR UPDATE`;
    if (!task || task.enquiry_id !== lead.id) throw new CrmError(404, 'Task not found', 'NOT_FOUND');
    if (!['OPEN', 'IN_PROGRESS'].includes(task.status)) throw new CrmError(409, 'Task is not open', 'TASK_CLOSED');
    const nextStatus = body.cancel ? 'CANCELLED' : 'COMPLETED';
    const isNext = lead.next_action_task_id === task.id;
    if (isNext && lead.outcome === 'OPEN' && !body.replacement && !body.exception) {
      throw new CrmError(400, 'Completing the next action requires a replacement action, closure, or an authorized exception', 'NEXT_ACTION_REQUIRED');
    }
    if (body.replacement && body.exception) {
      throw new CrmError(400, 'Provide either a replacement action or an exception', 'NEXT_ACTION_CONFLICT');
    }
    if (body.task_expected_version != null && Number(task.row_version) !== Number(body.task_expected_version)) {
      throw new CrmError(409, 'The task was updated by someone else. Refresh and retry.', 'VERSION_CONFLICT');
    }
    await tx`
      UPDATE crm_tasks SET
        status = ${nextStatus},
        completed_at = CASE WHEN ${nextStatus} = 'COMPLETED' THEN now() ELSE completed_at END,
        updated_at = now()
      WHERE id = ${task.id}
    `;
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, task_id, actor_id, summary, visibility, contact_outcome, direction, details
      ) VALUES (
        'SYSTEM', ${task.account_id}, ${lead.id}, ${task.id}, ${scope.actor.id}, ${`Task ${nextStatus.toLowerCase()}: ${task.title}`},
        'SYSTEM', 'NOT_APPLICABLE', 'INTERNAL',
        ${tx.json({ from_status: task.status, to_status: nextStatus, old_due_at: task.due_at })}
      )
    `;
    let nextActionId = isNext ? null : lead.next_action_task_id;
    if (body.replacement) {
      const replacement = await insertTask(tx, scope.actor, lead, body.replacement);
      nextActionId = replacement.id;
    }
    if (body.exception) {
      const reason = String(body.exception.reason || '').trim();
      const expires = new Date(body.exception.expires_at || '');
      if (reason.length < 3) throw new CrmError(400, 'Exception reason is required', 'EXCEPTION_REASON');
      if (!(expires > new Date())) throw new CrmError(400, 'Exception expiry must be in the future', 'EXCEPTION_EXPIRY');
      await tx`
        INSERT INTO crm_next_action_exceptions (enquiry_id, reason, expires_at, created_by)
        VALUES (${lead.id}, ${reason}, ${expires.toISOString()}, ${scope.actor.id})
      `;
      nextActionId = null;
    }
    const updated = await saveLead(tx, lead, { next_action_task_id: nextActionId });
    await audit(tx, scope.actor, 'crm_task', nextStatus, task.id, { status: task.status }, { status: nextStatus });
    return { lead: presentLead(updated) };
  });
}

async function assertReason(tx, outcome, code) {
  const [reason] = await tx`
    SELECT code FROM crm_outcome_reasons
    WHERE outcome = ${outcome} AND code = ${code} AND archived_at IS NULL
  `;
  if (!reason) throw new CrmError(400, 'Unknown or archived outcome reason', 'BAD_REASON');
}

async function resolveOpenWork(tx, lead) {
  await tx`
    UPDATE crm_tasks SET status = 'CANCELLED', updated_at = now()
    WHERE enquiry_id = ${lead.id} AND status IN ('OPEN', 'IN_PROGRESS')
  `;
  await tx`
    UPDATE crm_demos SET
      status = 'CANCELLED',
      cancelled_at = COALESCE(cancelled_at, now()),
      result = COALESCE(result, 'Cancelled because the lead was closed'),
      updated_at = now()
    WHERE enquiry_id = ${lead.id} AND status = 'SCHEDULED'
  `;
  const pilots = await tx`
    SELECT id, status FROM crm_pilots
    WHERE enquiry_id = ${lead.id} AND status IN ('PLANNED', 'ACTIVE')
    FOR UPDATE
  `;
  for (const pilot of pilots) {
    await tx`
      UPDATE crm_pilots SET
        status = 'CANCELLED',
        cancelled_at = now(),
        result = 'Cancelled because the lead was closed',
        updated_at = now()
      WHERE id = ${pilot.id}
    `;
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, pilot_id, actor_id, summary, visibility, contact_outcome, direction
      ) VALUES (
        'PILOT_CANCELLED', ${lead.account_id}, ${lead.id}, ${pilot.id}, NULL,
        'Pilot cancelled because the lead was closed', 'SYSTEM', 'NOT_APPLICABLE', 'INTERNAL'
      )
    `;
  }
}

async function closeLead(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const outcome = String(body.outcome || '').toUpperCase();
  if (!['WON', 'LOST', 'DISQUALIFIED'].includes(outcome)) throw new CrmError(400, 'Outcome must be WON, LOST, or DISQUALIFIED', 'BAD_OUTCOME');
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    if (lead.outcome !== 'OPEN') throw new CrmError(409, 'Lead is already closed', 'ALREADY_CLOSED');
    const closedAt = body.closed_at ? new Date(body.closed_at) : new Date();
    if (Number.isNaN(closedAt.getTime())) throw new CrmError(400, 'Invalid close date', 'BAD_TIME');
    let value = lead.value_amount;
    let currency = lead.currency || 'INR';
    let proposalVersionId = null;
    let exceptionReason = null;
    if (outcome === 'WON') {
      value = parseMoney(body.value_amount != null ? body.value_amount : lead.value_amount);
      currency = parseCurrency(body.currency || lead.currency);
      if (value == null) throw new CrmError(400, 'A won deal needs a confirmed value', 'VALUE_REQUIRED');
      const [accepted] = await tx`
        SELECT v.id FROM crm_proposal_versions v
        JOIN crm_proposals p ON p.id = v.proposal_id
        WHERE p.enquiry_id = ${lead.id} AND v.status = 'ACCEPTED'
        ORDER BY v.version_no DESC LIMIT 1
      `;
      if (accepted) proposalVersionId = accepted.id;
      else if (body.exception_reason) {
        if (scope.kind !== 'platform') throw new CrmError(403, 'A won exception requires Super Admin', 'EXCEPTION_FORBIDDEN');
        await assertReason(tx, 'WON_EXCEPTION', body.exception_reason);
        exceptionReason = body.exception_reason;
      } else {
        throw new CrmError(400, 'Winning a deal requires an accepted proposal or an authorized exception', 'ACCEPTANCE_REQUIRED');
      }
    } else {
      await assertReason(tx, outcome, body.reason_code);
    }
    await tx`
      INSERT INTO crm_closures (enquiry_id, outcome, reason_code, notes, value_amount, currency, closed_at, proposal_version_id, exception_reason, actor_id)
      VALUES (
        ${lead.id}, ${outcome}, ${body.reason_code || null}, ${body.notes || null}, ${value}, ${currency},
        ${closedAt.toISOString()}, ${proposalVersionId}, ${exceptionReason}, ${scope.actor.id}
      )
    `;
    const [closure] = await tx`
      SELECT id FROM crm_closures WHERE enquiry_id = ${lead.id} ORDER BY created_at DESC LIMIT 1
    `;
    const updated = await saveLead(tx, lead, {
      outcome,
      outcome_review_required: false,
      closed_at: closedAt.toISOString(),
      value_amount: value,
      deal_value: value,
      currency,
      status: legacyStatusFor(lead.pipeline_stage_code, outcome, lead.status),
      next_action_task_id: null,
    });
    await resolveOpenWork(tx, lead);
    if (outcome === 'WON' || outcome === 'LOST') {
      const { recordStaffConversion } = require('./trackingAttribution');
      await recordStaffConversion(tx, {
        enquiryId: lead.id,
        kind: outcome,
        sourceType: 'closure',
        sourceId: closure.id,
        closureId: closure.id,
        at: closedAt.toISOString(),
      });
    }
    await audit(tx, scope.actor, 'enquiry', 'CLOSE', lead.id, { outcome: lead.outcome }, { outcome });
    return presentLead(updated);
  });
}

async function reopenLead(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const reason = String(body.reason || '').trim();
  if (reason.length < 3) throw new CrmError(400, 'A reopen reason is required', 'REOPEN_REASON');
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    if (lead.outcome === 'OPEN') throw new CrmError(409, 'Lead is already open', 'ALREADY_OPEN');
    const task = await insertTask(tx, scope.actor, lead, body.next_action || {});
    await tx`
      UPDATE crm_closures SET reopened_at = now(), reopen_reason = ${reason}
      WHERE id = (
        SELECT id FROM crm_closures WHERE enquiry_id = ${lead.id} ORDER BY created_at DESC LIMIT 1
      )
    `;
    const [clock] = await tx`SELECT now() AS ts`;
    await tx`
      INSERT INTO crm_stage_history (
        enquiry_id, from_code, to_code, actor_id, entered_at, event_kind, time_quality, recorded_at
      ) VALUES (
        ${lead.id}, ${lead.pipeline_stage_code}, ${lead.pipeline_stage_code}, ${scope.actor.id},
        ${clock.ts}, 'REOPEN', 'OBSERVED', ${clock.ts}
      )
    `;
    const updated = await saveLead(tx, lead, {
      outcome: 'OPEN',
      closed_at: null,
      next_action_task_id: task.id,
      stage_entered_at: clock.ts,
      stage_time_quality: 'OBSERVED',
      status: legacyStatusFor(lead.pipeline_stage_code, 'OPEN', lead.status),
    });
    await audit(tx, scope.actor, 'enquiry', 'REOPEN', lead.id, { outcome: lead.outcome }, { outcome: 'OPEN', reason });
    return presentLead(updated);
  });
}

async function convertLead(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const vertical = String(body.vertical || 'OTHER').toUpperCase();
  return crmSql.begin(async (tx) => {
    const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${enquiryId} FOR UPDATE`;
    if (!lead) throw new CrmError(404, 'Enquiry not found', 'NOT_FOUND');
    assertLeadAccess(scope, lead);
    if (vertical === 'SCHOOL' && lead.outcome !== 'WON') {
      throw new CrmError(409, 'School conversion requires a won outcome', 'WON_REQUIRED');
    }
    if (lead.account_id) {
      const [existing] = await tx`SELECT * FROM crm_accounts WHERE id = ${lead.account_id}`;
      return { accountId: lead.account_id, existing: true, lifecycle_stage: existing?.lifecycle_stage || null };
    }
    let owner = lead.assigned_to || null;
    if (owner) {
      const [active] = await tx`SELECT id FROM founders WHERE id = ${owner} AND is_active = true`;
      if (!active) owner = null;
    }
    const [account] = await tx`
      INSERT INTO crm_accounts (name, account_type, lifecycle_stage, vertical, owner_founder_id, email, phone, created_by)
      VALUES (
        ${lead.organization || lead.name || 'Unnamed account'}, 'CUSTOMER', 'ONBOARDING', ${vertical},
        ${owner}, ${lead.email}, ${lead.phone}, ${scope.actor.id}
      )
      RETURNING *
    `;
    if (owner) {
      await tx`
        INSERT INTO crm_owner_history (account_id, enquiry_id, from_founder_id, to_founder_id, actor_id)
        VALUES (${account.id}, ${lead.id}, NULL, ${owner}, ${scope.actor.id})
      `;
    }
    const status = vertical === 'SCHOOL'
      ? legacyStatusFor(lead.pipeline_stage_code, lead.outcome, lead.status)
      : 'CLOSED';
    await saveLead(tx, lead, {
      account_id: account.id,
      product_vertical: vertical,
      status,
      converted_at: new Date().toISOString(),
    });
    await tx`
      INSERT INTO crm_activities (activity_type, account_id, enquiry_id, actor_id, summary, visibility)
      VALUES ('SYSTEM', ${account.id}, ${lead.id}, ${scope.actor.id}, 'Lead linked to a customer account', 'SYSTEM')
    `;
    await audit(tx, scope.actor, 'enquiry', 'CONVERT', lead.id, null, { account_id: account.id, lifecycle_stage: 'ONBOARDING' });
    await enqueueAutomationEvent(tx, 'enquiry.converted', 'enquiry', lead.id, {
      account_id: account.id,
      enquiry_id: lead.id,
      owner_founder_id: account.owner_founder_id,
      occurrence_id: account.id,
    });
    return { accountId: account.id, existing: false, lifecycle_stage: 'ONBOARDING' };
  });
}

async function applyLegacyPatch(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  if (body.assigned_to !== undefined && scope.kind !== 'platform') {
    throw new CrmError(403, 'Only a Super Admin can reassign a lead', 'ASSIGN_FORBIDDEN');
  }
  if (body.status === 'CLOSED' || body.status === 'REJECTED') {
    throw new CrmError(400, 'Use the close command with an outcome and reason. Historical closed rows are not relabeled automatically.', 'USE_CLOSE_COMMAND');
  }
  if (body.notes !== undefined) {
    return logActivity(crmSql, scope, enquiryId, {
      expected_version: body.expected_version,
      activity_type: 'NOTE',
      summary: String(body.notes || '').slice(0, 2000) || 'Note',
    });
  }
  if (body.assigned_to) {
    return assignOwner(crmSql, scope, enquiryId, {
      expected_version: body.expected_version,
      owner_founder_id: body.assigned_to,
      next_action: body.next_action,
    });
  }
  if (body.status && STAGE_FROM_LEGACY[body.status]) {
    return moveStage(crmSql, scope, enquiryId, { expected_version: body.expected_version, stage: STAGE_FROM_LEGACY[body.status] });
  }
  if (body.deal_value !== undefined) {
    const version = requireVersion(body.expected_version);
    const amount = body.deal_value == null ? null : parseMoney(body.deal_value);
    return crmSql.begin(async (tx) => {
      const lead = await lockLead(tx, enquiryId, version);
      assertLeadAccess(scope, lead);
      const updated = await saveLead(tx, lead, { value_amount: amount, deal_value: amount });
      return presentLead(updated);
    });
  }
  throw new CrmError(400, 'No supported fields to update', 'EMPTY_PATCH');
}

async function correctSource(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    const [channel] = await tx`
      SELECT id FROM crm_acquisition_channels WHERE code = ${String(body.channel_code || '').toUpperCase()} AND archived_at IS NULL
    `;
    if (!channel) throw new CrmError(400, 'Unknown or archived source channel', 'BAD_CHANNEL');
    const updated = await saveLead(tx, lead, {
      acquisition_channel_id: channel.id,
      campaign_name: body.campaign_name !== undefined ? body.campaign_name : lead.campaign_name,
      referral_metadata: body.referral !== undefined ? body.referral : lead.referral_metadata,
    });
    await audit(tx, scope.actor, 'enquiry', 'SOURCE_CORRECTION', lead.id, {
      channel: lead.acquisition_channel_id,
      website_source: lead.website_source,
    }, {
      channel: channel.id,
      website_source: lead.website_source,
    });
    return presentLead(updated);
  });
}

async function setTerritory(crmSql, scope, enquiryId, body) {
  assertPlatform(scope);
  const version = requireVersion(body.expected_version);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    const [territory] = await tx`SELECT id FROM crm_territories WHERE id = ${body.territory_id} AND archived_at IS NULL`;
    if (!territory) throw new CrmError(400, 'Unknown or archived territory', 'BAD_TERRITORY');
    if (lead.assigned_to) {
      const [member] = await tx`
        SELECT 1 FROM crm_territory_members WHERE territory_id = ${territory.id} AND founder_id = ${lead.assigned_to}
      `;
      if (!member) throw new CrmError(400, 'Current owner is not a member of that territory', 'TERRITORY_OWNER_MISMATCH');
    }
    const updated = await saveLead(tx, lead, { territory_id: territory.id });
    await audit(tx, scope.actor, 'enquiry', 'TERRITORY', lead.id, { territory_id: lead.territory_id }, { territory_id: territory.id });
    return presentLead(updated);
  });
}

async function scheduleDemo(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const starts = new Date(body.starts_at || '');
  const ends = new Date(body.ends_at || '');
  if (!(starts < ends)) throw new CrmError(400, 'Demo end must be after the start', 'BAD_TIME_RANGE');
  const timezone = parseTimezone(body.timezone);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    if (body.host_founder_id) await assertActiveFounder(tx, body.host_founder_id);
    const [demo] = await tx`
      INSERT INTO crm_demos (enquiry_id, account_id, starts_at, ends_at, timezone, host_founder_id, attendees, location, meeting_url, agenda, created_by)
      VALUES (
        ${lead.id}, ${lead.account_id}, ${starts.toISOString()}, ${ends.toISOString()}, ${timezone},
        ${body.host_founder_id || null}, ${tx.json(Array.isArray(body.attendees) ? body.attendees : [])},
        ${body.location || null}, ${body.meeting_url || null}, ${body.agenda || null}, ${scope.actor.id}
      )
      RETURNING *
    `;
    const { recordStaffConversion } = require('./trackingAttribution');
    await recordStaffConversion(tx, {
      enquiryId: lead.id,
      kind: 'DEMO_BOOKED',
      sourceType: 'demo',
      sourceId: demo.id,
      demoId: demo.id,
    });
    await saveLead(tx, lead, {});
    return demo;
  });
}

async function rescheduleDemo(crmSql, scope, demoId, body) {
  assertCrmWrite(scope);
  const starts = new Date(body.starts_at || '');
  const ends = new Date(body.ends_at || '');
  if (!(starts < ends)) throw new CrmError(400, 'Demo end must be after the start', 'BAD_TIME_RANGE');
  return crmSql.begin(async (tx) => {
    const [located] = await tx`SELECT enquiry_id FROM crm_demos WHERE id = ${demoId}`;
    if (!located) throw new CrmError(404, 'Demo not found', 'NOT_FOUND');
    const lead = await lockLead(tx, located.enquiry_id, requireVersion(body.expected_version));
    const [demo] = await tx`SELECT * FROM crm_demos WHERE id = ${demoId} FOR UPDATE`;
    assertLeadAccess(scope, lead);
    if (!demo || demo.enquiry_id !== lead.id) throw new CrmError(404, 'Demo not found', 'NOT_FOUND');
    if (demo.status !== 'SCHEDULED') throw new CrmError(409, 'Only a scheduled demo can be rescheduled', 'DEMO_NOT_SCHEDULED');
    await tx`
      INSERT INTO crm_demo_reschedules (demo_id, old_starts_at, old_ends_at, new_starts_at, new_ends_at, reason, actor_id)
      VALUES (${demo.id}, ${demo.starts_at}, ${demo.ends_at}, ${starts.toISOString()}, ${ends.toISOString()}, ${body.reason || null}, ${scope.actor.id})
    `;
    const [updated] = await tx`
      UPDATE crm_demos SET starts_at = ${starts.toISOString()}, ends_at = ${ends.toISOString()}, timezone = ${parseTimezone(body.timezone || demo.timezone)}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${demo.id} RETURNING *
    `;
    await saveLead(tx, lead, {});
    return updated;
  });
}

async function finishDemo(crmSql, scope, demoId, body) {
  assertCrmWrite(scope);
  const status = String(body.status || '').toUpperCase();
  if (!['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(status)) throw new CrmError(400, 'Unsupported demo result', 'BAD_DEMO_STATUS');
  const occurred = body.occurred_at ? new Date(body.occurred_at) : new Date();
  if (Number.isNaN(occurred.getTime()) || occurred.getTime() > Date.now() + 2 * 60 * 1000) {
    throw new CrmError(400, 'Demo result time is invalid', 'BAD_TIME');
  }
  return crmSql.begin(async (tx) => {
    const [located] = await tx`SELECT enquiry_id FROM crm_demos WHERE id = ${demoId}`;
    if (!located) throw new CrmError(404, 'Demo not found', 'NOT_FOUND');
    const lead = await lockLead(tx, located.enquiry_id, requireVersion(body.expected_version));
    const [demo] = await tx`SELECT * FROM crm_demos WHERE id = ${demoId} FOR UPDATE`;
    assertLeadAccess(scope, lead);
    if (!demo || demo.enquiry_id !== lead.id) throw new CrmError(404, 'Demo not found', 'NOT_FOUND');
    if (demo.status !== 'SCHEDULED') throw new CrmError(409, 'Demo is already finished', 'DEMO_FINISHED');
    const [updated] = await tx`
      UPDATE crm_demos SET
        status = ${status},
        result = ${body.result || null},
        completed_at = CASE WHEN ${status} = 'COMPLETED' THEN ${occurred.toISOString()}::timestamptz ELSE completed_at END,
        cancelled_at = CASE WHEN ${status} = 'CANCELLED' THEN ${occurred.toISOString()}::timestamptz ELSE cancelled_at END,
        no_show_at = CASE WHEN ${status} = 'NO_SHOW' THEN ${occurred.toISOString()}::timestamptz ELSE no_show_at END,
        updated_at = now()
      WHERE id = ${demo.id}
      RETURNING *
    `;
    const contactOutcome = status === 'COMPLETED' ? 'CONNECTED' : status === 'NO_SHOW' ? 'NO_ANSWER' : 'NOT_APPLICABLE';
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, demo_id, actor_id, summary, result, visibility,
        occurred_at, recorded_at, contact_outcome, direction
      ) VALUES (
        'DEMO', ${lead.account_id}, ${lead.id}, ${demo.id}, ${scope.actor.id}, ${body.result || `Demo ${status.toLowerCase()}`},
        ${status}, 'INTERNAL', ${occurred.toISOString()}, now(), ${contactOutcome}, 'OUTBOUND'
      )
    `;
    if (status === 'COMPLETED') {
      const { recordStaffConversion } = require('./trackingAttribution');
      await recordStaffConversion(tx, {
        enquiryId: lead.id,
        kind: 'DEMO_COMPLETED',
        sourceType: 'demo_completed',
        sourceId: demo.id,
        demoId: demo.id,
        at: occurred.toISOString(),
      });
    }
    const previous = lead.last_activity_at ? new Date(lead.last_activity_at) : null;
    const next = await saveLead(tx, lead, {
      last_activity_at: !previous || occurred > previous ? occurred.toISOString() : lead.last_activity_at,
    });
    return { demo: updated, lead: presentLead(next) };
  });
}

async function nextProposalNumber(tx) {
  const year = new Date().getUTCFullYear();
  const [row] = await tx`
    INSERT INTO crm_proposal_counters (year, last_value) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last_value = crm_proposal_counters.last_value + 1
    RETURNING last_value
  `;
  return `P-${year}-${String(row.last_value).padStart(4, '0')}`;
}

async function createProposal(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const amount = parseMoney(body.amount);
  if (amount == null) throw new CrmError(400, 'Proposal amount is required', 'VALUE_REQUIRED');
  const currency = parseCurrency(body.currency);
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    const number = await nextProposalNumber(tx);
    const [proposal] = await tx`
      INSERT INTO crm_proposals (enquiry_id, account_id, proposal_number, currency, created_by)
      VALUES (${lead.id}, ${lead.account_id}, ${number}, ${currency}, ${scope.actor.id})
      RETURNING *
    `;
    const [proposalVersion] = await tx`
      INSERT INTO crm_proposal_versions (proposal_id, version_no, amount, currency, status, validity_date, notes, created_by)
      VALUES (${proposal.id}, 1, ${amount}, ${currency}, 'DRAFT', ${body.validity_date || null}, ${body.notes || null}, ${scope.actor.id})
      RETURNING *
    `;
    const updated = await saveLead(tx, lead, {});
    return { proposal, version: proposalVersion, lead: presentLead(updated) };
  });
}

async function reviseProposal(crmSql, scope, proposalId, body) {
  assertCrmWrite(scope);
  const amount = parseMoney(body.amount);
  if (amount == null) throw new CrmError(400, 'Proposal amount is required', 'VALUE_REQUIRED');
  return crmSql.begin(async (tx) => {
    const [proposal] = await tx`SELECT * FROM crm_proposals WHERE id = ${proposalId} FOR UPDATE`;
    if (!proposal) throw new CrmError(404, 'Proposal not found', 'NOT_FOUND');
    const lead = await lockLead(tx, proposal.enquiry_id, requireVersion(body.expected_version));
    assertLeadAccess(scope, lead);
    const [latest] = await tx`SELECT * FROM crm_proposal_versions WHERE proposal_id = ${proposal.id} ORDER BY version_no DESC LIMIT 1`;
    if (latest?.status === 'DRAFT') throw new CrmError(409, 'Edit the current draft instead of revising it', 'DRAFT_EXISTS');
    const currency = parseCurrency(body.currency || proposal.currency);
    const [created] = await tx`
      INSERT INTO crm_proposal_versions (proposal_id, version_no, amount, currency, status, validity_date, notes, created_by)
      VALUES (${proposal.id}, ${(latest?.version_no || 0) + 1}, ${amount}, ${currency}, 'DRAFT', ${body.validity_date || null}, ${body.notes || null}, ${scope.actor.id})
      RETURNING *
    `;
    await saveLead(tx, lead, {});
    return created;
  });
}

const PROPOSAL_EDGES = {
  DRAFT: ['SENT', 'WITHDRAWN'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'],
};

async function transitionProposal(crmSql, scope, versionId, body) {
  assertCrmWrite(scope);
  const target = String(body.status || '').toUpperCase();
  return crmSql.begin(async (tx) => {
    const [located] = await tx`
      SELECT v.id, p.enquiry_id FROM crm_proposal_versions v
      JOIN crm_proposals p ON p.id = v.proposal_id
      WHERE v.id = ${versionId}
    `;
    if (!located) throw new CrmError(404, 'Proposal version not found', 'NOT_FOUND');
    const lead = await lockLead(tx, located.enquiry_id, requireVersion(body.expected_version));
    const [current] = await tx`SELECT * FROM crm_proposal_versions WHERE id = ${versionId} FOR UPDATE`;
    assertLeadAccess(scope, lead);
    if (!current) throw new CrmError(404, 'Proposal version not found', 'NOT_FOUND');
    const allowed = PROPOSAL_EDGES[current.status] || [];
    if (!allowed.includes(target)) throw new CrmError(409, 'That proposal transition is not allowed', 'PROPOSAL_TRANSITION');
    const delivery = target === 'SENT' ? 'RECORDED_SENT' : current.delivery_state;
    const occurred = body.occurred_at ? new Date(body.occurred_at) : new Date();
    if (Number.isNaN(occurred.getTime()) || occurred.getTime() > Date.now() + 2 * 60 * 1000) {
      throw new CrmError(400, 'Proposal event time is invalid', 'BAD_TIME');
    }
    const [updated] = await tx`
      UPDATE crm_proposal_versions SET
        status = ${target},
        delivery_state = ${delivery},
        sent_recorded_at = CASE WHEN ${target} = 'SENT' THEN ${occurred.toISOString()}::timestamptz ELSE sent_recorded_at END
      WHERE id = ${current.id}
      RETURNING *
    `;
    const inbound = target === 'ACCEPTED' || target === 'REJECTED';
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, proposal_version_id, actor_id, summary, result, visibility,
        occurred_at, contact_outcome, direction
      ) VALUES (
        ${target === 'SENT' ? 'PROPOSAL_SENT' : 'PROPOSAL_RESPONSE'}, ${lead.account_id}, ${lead.id}, ${current.id},
        ${scope.actor.id}, ${`Proposal ${target.toLowerCase()}`}, ${target}, 'INTERNAL', ${occurred.toISOString()},
        ${inbound ? 'RECEIVED' : target === 'SENT' ? 'SENT' : 'NOT_APPLICABLE'},
        ${inbound ? 'INBOUND' : 'OUTBOUND'}
      )
    `;
    await saveLead(tx, lead, {});
    return updated;
  });
}

async function attachDocument(crmSql, scope, versionId, body) {
  assertCrmWrite(scope);
  const filename = String(body.filename || '').trim();
  const content = Buffer.from(String(body.content_base64 || ''), 'base64');
  if (!filename || filename.length > 180 || /[\r\n"]/.test(filename)) throw new CrmError(400, 'Filename is required', 'BAD_FILE');
  if (!content.length || content.length > 1_500_000) throw new CrmError(400, 'Document must be under 1.5 MB', 'BAD_FILE');
  const classified = classifyUpload(content, body.content_type || '');
  if (!classified.ok) throw new CrmError(400, classified.error, 'BAD_FILE');
  return crmSql.begin(async (tx) => {
    const [current] = await tx`
      SELECT v.*, p.enquiry_id FROM crm_proposal_versions v
      JOIN crm_proposals p ON p.id = v.proposal_id
      WHERE v.id = ${versionId}
    `;
    if (!current) throw new CrmError(404, 'Proposal version not found', 'NOT_FOUND');
    const lead = await lockLead(tx, current.enquiry_id, requireVersion(body.expected_version));
    assertLeadAccess(scope, lead);
    if (body.enquiry_id && body.enquiry_id !== lead.id) throw new CrmError(400, 'Document cannot be attached to a different lead', 'CROSS_LEAD_DOCUMENT');
    const [doc] = await tx`
      INSERT INTO crm_private_documents (proposal_version_id, enquiry_id, filename, content_type, byte_size, body, created_by)
      VALUES (${current.id}, ${lead.id}, ${filename}, ${classified.mime}, ${content.length}, ${content}, ${scope.actor.id})
      RETURNING id, filename, content_type, byte_size, enquiry_id, proposal_version_id, created_at
    `;
    await saveLead(tx, lead, {});
    return doc;
  });
}

async function readDocument(crmSql, scope, documentId) {
  const [doc] = await crmSql`SELECT * FROM crm_private_documents WHERE id = ${documentId}`;
  if (!doc) throw new CrmError(404, 'Document not found', 'NOT_FOUND');
  const [lead] = await crmSql`SELECT * FROM enquiries WHERE id = ${doc.enquiry_id}`;
  assertLeadAccess(scope, lead);
  return doc;
}

async function updateAccount(crmSql, scope, accountId, body) {
  assertCrmWrite(scope);
  if (body.owner_founder_id !== undefined) assertPlatform(scope);
  return crmSql.begin(async (tx) => {
    const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${accountId} FOR UPDATE`;
    assertAccountAccess(scope, account);
    if (body.lifecycle_stage === 'ACTIVE' && (account.vertical === 'SCHOOL' || body.vertical === 'SCHOOL')) {
      throw new CrmError(409, 'A school account becomes ACTIVE only after live onboarding readiness', 'ACTIVATION_RULE');
    }
    let owner = account.owner_founder_id;
    if (body.owner_founder_id !== undefined && body.owner_founder_id !== account.owner_founder_id) {
      if (body.owner_founder_id) await assertActiveFounder(tx, body.owner_founder_id);
      owner = body.owner_founder_id || null;
      await tx`
        INSERT INTO crm_owner_history (account_id, from_founder_id, to_founder_id, actor_id)
        VALUES (${account.id}, ${account.owner_founder_id}, ${owner}, ${scope.actor.id})
      `;
    }
    let externalId = account.external_client_id;
    let clusterId = account.cluster_id;
    if (body.external_client_id !== undefined || body.cluster_id !== undefined) {
      externalId = body.external_client_id !== undefined ? body.external_client_id : account.external_client_id;
      clusterId = body.cluster_id !== undefined ? body.cluster_id : account.cluster_id;
      if (externalId && !clusterId) throw new CrmError(400, 'A tenant link requires cluster_id', 'CLUSTER_REQUIRED');
      if (account.external_client_id && (account.external_client_id !== externalId || account.cluster_id !== clusterId)) {
        throw new CrmError(409, 'This account is already linked to a tenant', 'DUPLICATE_TENANT_LINK');
      }
    }
    const lifecycle = body.lifecycle_stage || account.lifecycle_stage;
    const [updated] = await tx`
      UPDATE crm_accounts SET
        owner_founder_id = ${owner},
        external_client_id = ${externalId},
        cluster_id = ${clusterId},
        lifecycle_stage = ${lifecycle},
        updated_at = now()
      WHERE id = ${account.id}
      RETURNING *
    `;
    await audit(tx, scope.actor, 'crm_account', 'UPDATE', account.id, { lifecycle: account.lifecycle_stage }, { lifecycle });
    return updated;
  });
}

async function createContact(crmSql, scope, accountId, body) {
  const contact = require('./contactService');
  return contact.createContact(crmSql, scope, accountId, body, { type: 'manual' });
}

async function listWork(crmSql, scope, query) {
  const tz = parseTimezone(query.timezone);
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  const ownerFilter = scope.kind === 'platform' && query.owner && query.owner !== 'unassigned' ? query.owner : founderId;
  const [overdue, today, upcoming, missing, expired, intake] = await Promise.all([
    crmSql`
      SELECT t.id, t.title, t.due_at, t.owner_founder_id, t.enquiry_id, e.name AS enquiry_name
      FROM crm_tasks t JOIN enquiries e ON e.id = t.enquiry_id
      WHERE t.status IN ('OPEN','IN_PROGRESS') AND e.outcome = 'OPEN' AND t.due_at < now()
        AND t.task_type IN ('FOLLOW_UP','CALL','EMAIL','MEETING')
        AND (${ownerFilter}::uuid IS NULL OR e.assigned_to = ${ownerFilter})
      ORDER BY t.due_at LIMIT 100
    `,
    crmSql`
      SELECT t.id, t.title, t.due_at, t.owner_founder_id, t.enquiry_id, e.name AS enquiry_name
      FROM crm_tasks t JOIN enquiries e ON e.id = t.enquiry_id
      WHERE t.status IN ('OPEN','IN_PROGRESS') AND e.outcome = 'OPEN' AND t.due_at >= now()
        AND t.task_type IN ('FOLLOW_UP','CALL','EMAIL','MEETING')
        AND (t.due_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
        AND (${ownerFilter}::uuid IS NULL OR e.assigned_to = ${ownerFilter})
      ORDER BY t.due_at LIMIT 100
    `,
    crmSql`
      SELECT t.id, t.title, t.due_at, t.owner_founder_id, t.enquiry_id, e.name AS enquiry_name
      FROM crm_tasks t JOIN enquiries e ON e.id = t.enquiry_id
      WHERE t.status IN ('OPEN','IN_PROGRESS') AND e.outcome = 'OPEN'
        AND t.task_type IN ('FOLLOW_UP','CALL','EMAIL','MEETING')
        AND (t.due_at AT TIME ZONE ${tz})::date > (now() AT TIME ZONE ${tz})::date
        AND (${ownerFilter}::uuid IS NULL OR e.assigned_to = ${ownerFilter})
      ORDER BY t.due_at LIMIT 100
    `,
    crmSql`
      SELECT e.id, e.name, e.assigned_to, e.pipeline_stage_code
      FROM enquiries e
      WHERE e.outcome = 'OPEN' AND e.assigned_to IS NOT NULL AND e.next_action_task_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM crm_next_action_exceptions x WHERE x.enquiry_id = e.id AND x.expires_at > now())
        AND (${ownerFilter}::uuid IS NULL OR e.assigned_to = ${ownerFilter})
      ORDER BY e.updated_at DESC LIMIT 100
    `,
    crmSql`
      SELECT e.id, e.name, x.reason, x.expires_at
      FROM crm_next_action_exceptions x
      JOIN enquiries e ON e.id = x.enquiry_id
      WHERE e.outcome = 'OPEN' AND e.next_action_task_id IS NULL AND x.expires_at <= now()
        AND (${ownerFilter}::uuid IS NULL OR e.assigned_to = ${ownerFilter})
      ORDER BY x.expires_at DESC LIMIT 100
    `,
    crmSql`
      SELECT t.id, t.title, t.due_at, t.account_id, a.name AS account_name
      FROM crm_tasks t
      JOIN crm_accounts a ON a.id = t.account_id
      WHERE t.enquiry_id IS NULL AND t.status IN ('OPEN','IN_PROGRESS')
        AND a.archived_at IS NULL AND a.vertical = 'SCHOOL'
        AND (${ownerFilter}::uuid IS NULL OR a.owner_founder_id = ${ownerFilter})
      ORDER BY t.due_at NULLS LAST LIMIT 100
    `,
  ]);
  return { timezone: tz, overdue, today, upcoming, missing_action: missing, expired_exceptions: expired, intake_tasks: intake };
}

async function reopenTask(crmSql, scope, enquiryId, taskId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const taskVersion = requireVersion(body.task_expected_version);
  const reason = String(body.reason || '').trim();
  if (reason.length < 3) throw new CrmError(400, 'A reopen reason is required', 'REOPEN_REASON');
  const due = new Date(body.due_at || '');
  if (Number.isNaN(due.getTime())) throw new CrmError(400, 'Invalid due time', 'BAD_DUE');
  return crmSql.begin(async (tx) => {
    const lead = await lockLead(tx, enquiryId, version);
    assertLeadAccess(scope, lead);
    if (lead.outcome !== 'OPEN') throw new CrmError(409, 'Closed leads cannot reopen a task', 'LEAD_CLOSED');
    const [task] = await tx`SELECT * FROM crm_tasks WHERE id = ${taskId} FOR UPDATE`;
    if (!task || task.enquiry_id !== lead.id) throw new CrmError(404, 'Task not found', 'NOT_FOUND');
    if (Number(task.row_version) !== taskVersion) throw new CrmError(409, 'The task was updated by someone else. Refresh and retry.', 'VERSION_CONFLICT');
    if (!['COMPLETED', 'CANCELLED'].includes(task.status)) throw new CrmError(409, 'Only a finished task can be reopened', 'TASK_OPEN');
    await assertActiveFounder(tx, body.assignee_founder_id);
    const [updatedTask] = await tx`
      UPDATE crm_tasks SET
        status = 'OPEN',
        due_at = ${due.toISOString()},
        owner_founder_id = ${body.assignee_founder_id},
        completed_at = NULL,
        updated_at = now()
      WHERE id = ${task.id}
      RETURNING *
    `;
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, task_id, actor_id, summary, visibility, contact_outcome, direction, details
      ) VALUES (
        'SYSTEM', ${lead.account_id}, ${lead.id}, ${task.id}, ${scope.actor.id}, ${`Task reopened: ${reason}`},
        'SYSTEM', 'NOT_APPLICABLE', 'INTERNAL',
        ${tx.json({ from_status: task.status, to_status: 'OPEN', old_due_at: task.due_at, new_due_at: due.toISOString(), completed_at: task.completed_at, reason })}
      )
    `;
    const updated = await saveLead(tx, lead, { next_action_task_id: body.set_as_next === false ? lead.next_action_task_id : updatedTask.id });
    return { task: updatedTask, lead: presentLead(updated) };
  });
}

async function resolveReview(crmSql, scope, reviewId, body) {
  assertCrmWrite(scope);
  const note = String(body.resolution_note || '').trim();
  if (note.length < 3) throw new CrmError(400, 'A review note is required', 'REVIEW_NOTE');
  return crmSql.begin(async (tx) => {
    const [review] = await tx`SELECT * FROM crm_review_queue WHERE id = ${reviewId} FOR UPDATE`;
    if (!review || review.status !== 'OPEN') throw new CrmError(404, 'Review not found', 'NOT_FOUND');
    if (review.enquiry_id) {
      const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${review.enquiry_id}`;
      assertLeadAccess(scope, lead);
    } else if (review.account_id) {
      const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${review.account_id}`;
      assertAccountAccess(scope, account);
    } else if (scope.kind !== 'platform') {
      throw new CrmError(404, 'Review not found', 'NOT_FOUND');
    }
    const [updated] = await tx`
      UPDATE crm_review_queue SET
        status = 'RESOLVED',
        resolved_at = now(),
        reviewed_by = ${scope.actor.id},
        resolution_note = ${note},
        rule_version = 1
      WHERE id = ${review.id}
      RETURNING id, status, enquiry_id, account_id, closure_id, reason, resolved_at, resolution_note
    `;
    if (review.enquiry_id) {
      await tx`
        INSERT INTO crm_activities (
          activity_type, enquiry_id, actor_id, summary, visibility, contact_outcome, direction, details
        ) VALUES (
          'REVIEW', ${review.enquiry_id}, ${scope.actor.id}, ${note}, 'INTERNAL', 'NOT_APPLICABLE', 'INTERNAL',
          ${tx.json({ review_id: review.id, closure_id: review.closure_id, reason: review.reason })}
        )
      `;
    }
    return updated;
  });
}

module.exports = {
  listLeads,
  getLead,
  assignOwner,
  moveStage,
  logActivity,
  createTask,
  completeTask,
  closeLead,
  reopenLead,
  convertLead,
  applyLegacyPatch,
  correctSource,
  setTerritory,
  scheduleDemo,
  rescheduleDemo,
  finishDemo,
  createProposal,
  reviseProposal,
  transitionProposal,
  attachDocument,
  readDocument,
  updateAccount,
  createContact,
  listWork,
  presentLead,
  applyStageMove,
  reopenTask,
  resolveReview,
  lockLead,
};
