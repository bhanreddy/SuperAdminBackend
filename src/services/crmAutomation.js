const sql = require('../config/crmDb');

async function enqueueAutomationEvent(db, triggerEvent, entityType, entityId, payload = {}) {
  const rules = await db`SELECT id FROM crm_automation_rules WHERE trigger_event = ${triggerEvent} AND is_enabled = true`;
  const eventKey = `${triggerEvent}:${entityId}`;
  for (const rule of rules) {
    await db`
      INSERT INTO crm_automation_runs (rule_id, event_key, entity_type, entity_id, payload)
      VALUES (${rule.id}, ${eventKey}, ${entityType}, ${entityId}, ${db.json(payload)})
      ON CONFLICT (rule_id, event_key) DO NOTHING
    `;
  }
}

function conditionsMatch(conditions, payload) {
  return Object.entries(conditions || {}).every(([key, expected]) => payload?.[key] === expected);
}

async function executeAction(tx, run, action) {
  if (action.type !== 'CREATE_TASK') throw new Error(`Unsupported CRM automation action: ${action.type}`);
  const dueMinutes = Number(action.due_in_minutes || 0);
  const dueAt = dueMinutes > 0 ? new Date(Date.now() + dueMinutes * 60_000).toISOString() : null;
  const accountId = run.payload?.account_id || (run.entity_type === 'crm_account' ? run.entity_id : null);
  const enquiryId = run.payload?.enquiry_id || (run.entity_type === 'enquiry' ? run.entity_id : null);
  if (!accountId && !enquiryId) throw new Error('Automation task requires account_id or enquiry_id');

  const [task] = await tx`
    INSERT INTO crm_tasks
      (title, description, task_type, priority, owner_founder_id, account_id, enquiry_id, due_at, automation_rule_id, metadata)
    VALUES
      (${action.title || 'CRM follow-up'}, ${action.description || null}, ${action.task_type || 'FOLLOW_UP'},
       ${action.priority || 'MEDIUM'}, ${run.payload?.owner_founder_id || null}, ${accountId}, ${enquiryId},
       ${dueAt}, ${run.rule_id}, ${tx.json({ automation_run_id: run.id })})
    RETURNING *
  `;
  await tx`
    INSERT INTO crm_activities (activity_type, account_id, enquiry_id, task_id, summary, details)
    VALUES ('AUTOMATION', ${accountId}, ${enquiryId}, ${task.id}, ${`Automation created task: ${task.title}`}, ${tx.json({ run_id: run.id, rule_id: run.rule_id })})
  `;
}

async function processOneRun() {
  return sql.begin(async (tx) => {
    const [run] = await tx`
      SELECT r.*, rule.conditions, rule.actions
      FROM crm_automation_runs r
      JOIN crm_automation_rules rule ON rule.id = r.rule_id AND rule.is_enabled = true
      WHERE r.status IN ('PENDING','FAILED') AND r.available_at <= now() AND r.attempt_count < 5
      ORDER BY r.available_at, r.created_at
      FOR UPDATE OF r SKIP LOCKED
      LIMIT 1
    `;
    if (!run) return false;
    await tx`UPDATE crm_automation_runs SET status = 'RUNNING', started_at = now(), attempt_count = attempt_count + 1 WHERE id = ${run.id}`;
    try {
      if (!conditionsMatch(run.conditions, run.payload)) {
        await tx`UPDATE crm_automation_runs SET status = 'SKIPPED', finished_at = now() WHERE id = ${run.id}`;
        return true;
      }
      // The savepoint guarantees all actions for a rule are atomic. A failed
      // later action cannot leave earlier tasks behind and duplicate them on retry.
      await tx.savepoint(async (sp) => {
        for (const action of run.actions || []) await executeAction(sp, run, action);
      });
      await tx`UPDATE crm_automation_runs SET status = 'SUCCEEDED', finished_at = now(), error = NULL WHERE id = ${run.id}`;
    } catch (err) {
      await tx`
        UPDATE crm_automation_runs
        SET status = 'FAILED', error = ${String(err.message || err)}, available_at = now() + (attempt_count * interval '1 minute')
        WHERE id = ${run.id}
      `;
    }
    return true;
  });
}

let timer = null;
async function tick() {
  try {
    const [exists] = await sql`SELECT to_regclass('public.crm_automation_runs') AS name`;
    if (!exists.name) return;
    for (let i = 0; i < 20; i += 1) if (!(await processOneRun())) break;
  } catch (err) {
    console.error('[crm-automation] worker tick failed:', err.message);
  }
}

function startCrmAutomationWorker() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 15_000);
  timer.unref?.();
}

module.exports = { enqueueAutomationEvent, startCrmAutomationWorker, processOneRun };
