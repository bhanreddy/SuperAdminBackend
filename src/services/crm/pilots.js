const { CrmError } = require('./errors');
const { assertCrmWrite, assertLeadAccess } = require('./accessPolicy');
const { requireVersion, stableHash } = require('./helpers');
const { applyStageMove, lockLead } = require('./salesCrm');

function requireKey(body) {
  const key = String(body.idempotency_key || '').trim();
  if (key.length < 8 || key.length > 200) throw new CrmError(400, 'idempotency_key is required', 'IDEMPOTENCY_KEY');
  return key;
}

async function replayOrStart(tx, scope, command, entityId, key, hash) {
  const receiptScope = `${scope.actor.id}:${command}:${entityId}`;
  const [existing] = await tx`
    SELECT response, request_hash, status_code FROM crm_command_receipts
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

function parseRange(body) {
  const start = body.planned_start_at ? new Date(body.planned_start_at) : null;
  const end = body.planned_end_at ? new Date(body.planned_end_at) : null;
  if (start && Number.isNaN(start.getTime())) throw new CrmError(400, 'Invalid planned start', 'BAD_TIME');
  if (end && Number.isNaN(end.getTime())) throw new CrmError(400, 'Invalid planned end', 'BAD_TIME');
  if (start && end && !(end > start)) throw new CrmError(400, 'Planned end must be after the planned start', 'BAD_TIME_RANGE');
  return { start, end };
}

async function createPilot(crmSql, scope, enquiryId, body) {
  assertCrmWrite(scope);
  const version = requireVersion(body.expected_version);
  const key = requireKey(body);
  const hash = stableHash({ enquiryId, ...body, actor: scope.actor.id });
  return crmSql.begin(async (tx) => {
    const [visible] = await tx`SELECT * FROM enquiries WHERE id = ${enquiryId}`;
    assertLeadAccess(scope, visible);
    const started = await replayOrStart(tx, scope, 'pilot.create', enquiryId, key, hash);
    if (started.replay) return started.replay;
    const lead = await lockLead(tx, enquiryId, version);
    if (lead.outcome !== 'OPEN') throw new CrmError(409, 'Closed leads cannot start a pilot', 'LEAD_CLOSED');
    const range = parseRange(body);
    const objective = String(body.objective || '').trim();
    if (objective.length < 3) throw new CrmError(400, 'A pilot objective is required', 'BAD_PILOT');
    const [pilot] = await tx`
      INSERT INTO crm_pilots (
        enquiry_id, status, planned_start_at, planned_end_at, objective, success_criteria, created_by
      ) VALUES (
        ${lead.id}, 'PLANNED', ${range.start ? range.start.toISOString() : null}, ${range.end ? range.end.toISOString() : null},
        ${objective}, ${body.success_criteria || null}, ${scope.actor.id}
      )
      RETURNING *
    `;
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, pilot_id, actor_id, summary, visibility, contact_outcome, direction
      ) VALUES (
        'PILOT_PLANNED', ${lead.account_id}, ${lead.id}, ${pilot.id}, ${scope.actor.id}, ${objective},
        'INTERNAL', 'NOT_APPLICABLE', 'INTERNAL'
      )
    `;
    const response = { pilot, lead_version: lead.row_version };
    await storeReceipt(tx, started.receiptScope, key, hash, response);
    return response;
  });
}

async function transitionPilot(crmSql, scope, pilotId, body) {
  assertCrmWrite(scope);
  const action = String(body.action || '').toUpperCase();
  if (!['START', 'COMPLETE', 'CANCEL'].includes(action)) throw new CrmError(400, 'Unsupported pilot action', 'BAD_PILOT');
  const key = requireKey(body);
  const hash = stableHash({ pilotId, ...body, actor: scope.actor.id });
  const occurred = body.occurred_at ? new Date(body.occurred_at) : new Date();
  if (Number.isNaN(occurred.getTime()) || occurred.getTime() > Date.now() + 2 * 60 * 1000) {
    throw new CrmError(400, 'Pilot event time is invalid', 'BAD_TIME');
  }
  return crmSql.begin(async (tx) => {
    const [located] = await tx`SELECT enquiry_id FROM crm_pilots WHERE id = ${pilotId}`;
    if (!located) throw new CrmError(404, 'Pilot not found', 'NOT_FOUND');
    const [visible] = await tx`SELECT * FROM enquiries WHERE id = ${located.enquiry_id}`;
    assertLeadAccess(scope, visible);
    const started = await replayOrStart(tx, scope, 'pilot.transition', pilotId, key, hash);
    if (started.replay) return started.replay;
    const lead = await lockLead(tx, located.enquiry_id, requireVersion(body.expected_version));
    const [pilot] = await tx`SELECT * FROM crm_pilots WHERE id = ${pilotId} FOR UPDATE`;
    if (!pilot || pilot.enquiry_id !== lead.id) throw new CrmError(404, 'Pilot not found', 'NOT_FOUND');
    if (Number(pilot.row_version) !== requireVersion(body.pilot_expected_version)) {
      throw new CrmError(409, 'The pilot was updated by someone else. Refresh and retry.', 'VERSION_CONFLICT');
    }
    let nextStatus = pilot.status;
    if (action === 'START') {
      if (pilot.status !== 'PLANNED') throw new CrmError(409, 'Only a planned pilot can start', 'PILOT_STATE');
      nextStatus = 'ACTIVE';
    } else if (action === 'COMPLETE') {
      if (pilot.status !== 'ACTIVE') throw new CrmError(409, 'Only an active pilot can be completed', 'PILOT_STATE');
      nextStatus = 'COMPLETED';
    } else {
      if (!['PLANNED', 'ACTIVE'].includes(pilot.status)) throw new CrmError(409, 'That pilot cannot be cancelled', 'PILOT_STATE');
      nextStatus = 'CANCELLED';
    }
    const [updatedPilot] = await tx`
      UPDATE crm_pilots SET
        status = ${nextStatus},
        started_at = CASE WHEN ${action} = 'START' THEN ${occurred.toISOString()}::timestamptz ELSE started_at END,
        completed_at = CASE WHEN ${action} = 'COMPLETE' THEN ${occurred.toISOString()}::timestamptz ELSE completed_at END,
        cancelled_at = CASE WHEN ${action} = 'CANCEL' THEN ${occurred.toISOString()}::timestamptz ELSE cancelled_at END,
        result = COALESCE(${body.result || null}, result),
        decision_notes = COALESCE(${body.decision_notes || null}, decision_notes),
        row_version = row_version + 1,
        updated_at = now()
      WHERE id = ${pilot.id}
      RETURNING *
    `;
    await tx`
      INSERT INTO crm_activities (
        activity_type, account_id, enquiry_id, pilot_id, actor_id, summary, visibility, occurred_at,
        contact_outcome, direction
      ) VALUES (
        ${`PILOT_${action}`}, ${lead.account_id}, ${lead.id}, ${pilot.id}, ${scope.actor.id},
        ${body.result || `Pilot ${action.toLowerCase()}`}, 'INTERNAL', ${occurred.toISOString()},
        ${action === 'COMPLETE' ? 'CONNECTED' : 'NOT_APPLICABLE'}, 'INTERNAL'
      )
    `;
    let nextLead = lead;
    if (action === 'START' && lead.pipeline_stage_code !== 'PILOT') {
      nextLead = await applyStageMove(tx, scope, lead, 'PILOT', {});
    } else {
      await tx`UPDATE enquiries SET updated_at = now() WHERE id = ${lead.id}`;
    }
    const response = { pilot: updatedPilot, lead: { id: nextLead.id, row_version: nextLead.row_version, pipeline_stage_code: nextLead.pipeline_stage_code, outcome: nextLead.outcome } };
    await storeReceipt(tx, started.receiptScope, key, hash, response);
    return response;
  });
}

async function patchPilot(crmSql, scope, pilotId, body) {
  assertCrmWrite(scope);
  const range = parseRange(body);
  return crmSql.begin(async (tx) => {
    const [located] = await tx`SELECT enquiry_id FROM crm_pilots WHERE id = ${pilotId}`;
    if (!located) throw new CrmError(404, 'Pilot not found', 'NOT_FOUND');
    const lead = await lockLead(tx, located.enquiry_id, requireVersion(body.expected_version));
    assertLeadAccess(scope, lead);
    const [pilot] = await tx`SELECT * FROM crm_pilots WHERE id = ${pilotId} FOR UPDATE`;
    if (!pilot || Number(pilot.row_version) !== requireVersion(body.pilot_expected_version)) {
      throw new CrmError(409, 'The pilot was updated by someone else. Refresh and retry.', 'VERSION_CONFLICT');
    }
    if (!['PLANNED', 'ACTIVE'].includes(pilot.status)) throw new CrmError(409, 'Completed pilot actuals cannot be rewritten', 'PILOT_FROZEN');
    const [updated] = await tx`
      UPDATE crm_pilots SET
        planned_start_at = COALESCE(${range.start ? range.start.toISOString() : null}, planned_start_at),
        planned_end_at = COALESCE(${range.end ? range.end.toISOString() : null}, planned_end_at),
        objective = COALESCE(${body.objective || null}, objective),
        success_criteria = COALESCE(${body.success_criteria || null}, success_criteria),
        row_version = row_version + 1,
        updated_at = now()
      WHERE id = ${pilot.id}
      RETURNING *
    `;
    return { pilot: updated };
  });
}

module.exports = { createPilot, transitionPilot, patchPilot };
