const express = require('express');
const sql = require('../../config/crmDb');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { requireCrmWrite } = require('../../middleware/crmAccess');
const { enqueueAutomationEvent } = require('../../services/crmAutomation');
const { resolveCrmScope, assertCrmWrite, assertPlatform, assertAccountAccess, assertLeadAccess } = require('../../services/crm/accessPolicy');
const { sendCrmError } = require('../../services/crm/errors');
const sales = require('../../services/crm/salesCrm');
const prospects = require('../../services/crm/prospects');
const { syncFounderDirectory, assertActiveFounder } = require('../../services/crm/founderSync');
const schoolSql = require('../../config/db');

const router = express.Router();
router.use(verifySuperAdminMiddleware);

function actorFounderId(req) {
  return req.superAdmin?.founderId || null;
}

// Non-super founders only see the tenants/leads they own. Full super admins
// bypass ownership filtering. A missing founder id is never unrestricted.
function scopeOwner(req) {
  const scope = resolveCrmScope(req.superAdmin);
  if (scope.kind === 'platform') return null;
  return scope.founderId;
}

async function audit(db, req, entityType, entityId, action, oldValue, newValue) {
  await db`
    INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
    VALUES (${entityType}, ${action}, ${req.superAdmin.id}, ${db.json({
      entity_id: entityId,
      old: oldValue ?? null,
      new: newValue ?? null,
      actor_email: req.superAdmin.email || null,
      source: 'superadmin_crm',
    })})
  `;
}

router.get('/overview', async (req, res) => {
  try {
    const scope = scopeOwner(req);
    const [pipeline, accounts, taskSummary] = await Promise.all([
      sql`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(deal_value), 0) AS value FROM enquiries
          WHERE (${scope}::uuid IS NULL OR assigned_to = ${scope}) GROUP BY status ORDER BY status`,
      sql`SELECT lifecycle_stage, COUNT(*)::int AS count FROM crm_accounts
          WHERE (${scope}::uuid IS NULL OR owner_founder_id = ${scope}) GROUP BY lifecycle_stage ORDER BY lifecycle_stage`,
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS'))::int AS open,
          COUNT(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS') AND due_at < now())::int AS overdue,
          COUNT(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS') AND due_at::date = current_date)::int AS due_today
        FROM crm_tasks
        WHERE (${scope}::uuid IS NULL OR owner_founder_id = ${scope})
      `,
    ]);
    // Scoped founders own their leads directly, so "unassigned" is only
    // meaningful for full super admins triaging the shared inbox.
    const [unassigned] = scope
      ? [{ count: 0 }]
      : await sql`SELECT COUNT(*)::int AS count FROM enquiries WHERE assigned_to IS NULL AND status NOT IN ('CLOSED','REJECTED')`;
    return sendResponse(res, 200, { pipeline, accounts, tasks: taskSummary[0], unassigned: unassigned.count });
  } catch (err) {
    console.error('CRM overview failed:', err);
    return res.status(500).json({ error: 'Failed to load CRM overview' });
  }
});

router.get('/accounts', async (req, res) => {
  try {
    const { lifecycle, search } = req.query;
    // A scoped founder is locked to their own tenants regardless of the owner
    // query param; full super admins may filter by any owner they pass.
    const owner = scopeOwner(req) || req.query.owner;
    const rows = await sql`
      SELECT a.*, f.full_name AS owner_name,
        COUNT(DISTINCT c.id)::int AS contact_count,
        COUNT(DISTINCT t.id) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS'))::int AS open_task_count
      FROM crm_accounts a
      LEFT JOIN founders f ON f.id = a.owner_founder_id
      LEFT JOIN crm_contacts c ON c.account_id = a.id
      LEFT JOIN crm_tasks t ON t.account_id = a.id
      WHERE (${lifecycle || null}::text IS NULL OR a.lifecycle_stage = ${lifecycle || null})
        AND (${owner || null}::uuid IS NULL OR a.owner_founder_id = ${owner || null})
        AND (${search || null}::text IS NULL OR a.name ILIKE ${search ? `%${search}%` : null} OR a.email ILIKE ${search ? `%${search}%` : null})
      GROUP BY a.id, f.full_name
      ORDER BY a.updated_at DESC
      LIMIT 200
    `;
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('CRM accounts failed:', err);
    return res.status(500).json({ error: 'Failed to list CRM accounts' });
  }
});

router.post('/accounts', requireCrmWrite, async (req, res) => {
  try {
    const { name, account_type, vertical, lifecycle_stage, owner_founder_id, email, phone, website, tags } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'name is required' });
    const row = await prospects.createLegacyAccount(sql, resolveCrmScope(req.superAdmin), req.body || {});
    return sendResponse(res, 201, row);
  } catch (err) {
    return sendCrmError(res, err, { route: 'accounts.create' });
  }
});

router.get('/accounts/:id', async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    const [account] = await sql`SELECT a.*, f.full_name AS owner_name FROM crm_accounts a LEFT JOIN founders f ON f.id = a.owner_founder_id WHERE a.id = ${req.params.id}`;
    try { assertAccountAccess(scope, account); } catch (err) { return sendCrmError(res, err); }
    const founderId = scope.kind === 'platform' ? null : scope.founderId;
    const [contacts, enquiries, tasks, activities] = await Promise.all([
      sql`SELECT * FROM crm_contacts WHERE account_id = ${account.id} ORDER BY is_primary DESC, created_at`,
      sql`
        SELECT id, name, organization, status, outcome, pipeline_stage_code, assigned_to, row_version, created_at
        FROM enquiries
        WHERE account_id = ${account.id}
          AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
        ORDER BY updated_at DESC
        LIMIT 50
      `,
      sql`
        SELECT t.id, t.title, t.status, t.task_type, t.due_at, t.owner_founder_id, t.enquiry_id, t.account_id, f.full_name AS owner_name
        FROM crm_tasks t
        LEFT JOIN founders f ON f.id = t.owner_founder_id
        WHERE t.account_id = ${account.id}
          AND (
            t.enquiry_id IS NULL
            OR EXISTS (
              SELECT 1 FROM enquiries e
              WHERE e.id = t.enquiry_id AND (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
            )
          )
        ORDER BY t.status, t.due_at NULLS LAST
        LIMIT 100
      `,
      sql`
        SELECT id, activity_type, summary, occurred_at, enquiry_id
        FROM crm_activities
        WHERE account_id = ${account.id}
          AND (
            enquiry_id IS NULL
            OR EXISTS (
              SELECT 1 FROM enquiries e
              WHERE e.id = crm_activities.enquiry_id AND (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
            )
          )
        ORDER BY occurred_at DESC
        LIMIT 100
      `,
    ]);
    return sendResponse(res, 200, { account, contacts, enquiries, tasks, activities });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load CRM account' });
  }
});

// Update a CRM account: reassign its owner (tenant → superAdmin) and/or link
// it to the provisioned tenant record once the Add form is submitted.
router.patch('/accounts/:id', requireCrmWrite, async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    assertCrmWrite(scope);
    const row = await sales.updateAccount(sql, scope, req.params.id, req.body || {});
    return sendResponse(res, 200, row);
  } catch (err) {
    return sendCrmError(res, err, { account_id: req.params.id });
  }
});

router.post('/accounts/:id/contacts', requireCrmWrite, async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    assertCrmWrite(scope);
    const row = await sales.createContact(sql, scope, req.params.id, req.body || {});
    return sendResponse(res, 201, row);
  } catch (err) {
    return sendCrmError(res, err, { account_id: req.params.id });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const { status, due } = req.query;
    const scope = resolveCrmScope(req.superAdmin);
    const founderId = scope.kind === 'platform' ? null : scope.founderId;
    const assignee = scope.kind === 'platform' ? (req.query.owner || null) : null;
    let dueFilter = sql``;
    if (due === 'OVERDUE') dueFilter = sql`AND t.due_at < now()`;
    if (due === 'TODAY') dueFilter = sql`AND t.due_at::date = current_date`;
    const rows = await sql`
      SELECT t.*, f.full_name AS owner_name, a.name AS account_name, e.name AS enquiry_name
      FROM crm_tasks t
      LEFT JOIN founders f ON f.id = t.owner_founder_id
      LEFT JOIN crm_accounts a ON a.id = t.account_id
      LEFT JOIN enquiries e ON e.id = t.enquiry_id
      WHERE (${status || null}::text IS NULL OR t.status = ${status || null})
        AND (${assignee || null}::uuid IS NULL OR t.owner_founder_id = ${assignee || null})
        AND (
          ${founderId}::uuid IS NULL
          OR (
            t.enquiry_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM enquiries e2 WHERE e2.id = t.enquiry_id AND e2.assigned_to = ${founderId}
            )
          )
          OR (
            t.enquiry_id IS NULL AND EXISTS (
              SELECT 1 FROM crm_accounts a2 WHERE a2.id = t.account_id AND a2.owner_founder_id = ${founderId}
            )
          )
        )
        ${dueFilter}
      ORDER BY t.due_at NULLS LAST, t.created_at DESC
      LIMIT 300
    `;
    return sendResponse(res, 200, rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list CRM tasks' });
  }
});

router.post('/tasks', requireCrmWrite, async (req, res) => {
  try {
    const { title, description, task_type, priority, owner_founder_id, account_id, enquiry_id, due_at } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ error: 'title is required' });
    if (!account_id && !enquiry_id) return res.status(400).json({ error: 'account_id or enquiry_id is required' });
    if (!due_at || !owner_founder_id) return res.status(400).json({ error: 'An actionable task needs an assignee and a due time', code: 'TASK_REQUIRED' });
    const scope = resolveCrmScope(req.superAdmin);
    if (enquiry_id) {
      const [lead] = await sql`SELECT * FROM enquiries WHERE id = ${enquiry_id}`;
      assertLeadAccess(scope, lead);
    }
    if (account_id) {
      const [account] = await sql`SELECT * FROM crm_accounts WHERE id = ${account_id}`;
      assertAccountAccess(scope, account);
    }
    await assertActiveFounder(sql, owner_founder_id);
    const row = await sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO crm_tasks (title, description, task_type, priority, owner_founder_id, account_id, enquiry_id, due_at, created_by)
        VALUES (${String(title).trim()}, ${description || null}, ${task_type || 'FOLLOW_UP'}, ${priority || 'MEDIUM'},
          ${owner_founder_id || actorFounderId(req)}, ${account_id || null}, ${enquiry_id || null}, ${due_at || null}, ${req.superAdmin.id})
        RETURNING *
      `;
      await tx`INSERT INTO crm_activities (activity_type, account_id, enquiry_id, task_id, actor_id, summary, details) VALUES ('TASK_CREATED', ${created.account_id}, ${created.enquiry_id}, ${created.id}, ${req.superAdmin.id}, ${`Task created: ${created.title}`}, ${tx.json({ priority: created.priority, due_at: created.due_at })})`;
      await audit(tx, req, 'crm_task', created.id, 'CREATE', null, created);
      return created;
    });
    return sendResponse(res, 201, row);
  } catch (err) {
    return sendCrmError(res, err);
  }
});

router.patch('/tasks/:id', requireCrmWrite, async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    assertCrmWrite(scope);
    const [existing] = await sql`SELECT * FROM crm_tasks WHERE id = ${req.params.id}`;
    if (!existing) return res.status(404).json({ error: 'CRM task not found' });
    if (existing.enquiry_id) {
      const [lead] = await sql`SELECT * FROM enquiries WHERE id = ${existing.enquiry_id}`;
      try { assertLeadAccess(scope, lead); } catch (err) { return sendCrmError(res, err); }
      if (['COMPLETED', 'CANCELLED'].includes(req.body?.status) && lead?.next_action_task_id === existing.id && lead.outcome === 'OPEN') {
        return res.status(400).json({ error: 'Completing the next action requires a replacement action, closure, or an authorized exception', code: 'NEXT_ACTION_REQUIRED' });
      }
    } else if (scope.kind !== 'platform' && existing.account_id) {
      const [account] = await sql`SELECT * FROM crm_accounts WHERE id = ${existing.account_id}`;
      try { assertAccountAccess(scope, account); } catch (err) { return sendCrmError(res, err); }
    }
    const { status, priority, owner_founder_id, due_at, title, description } = req.body || {};
    const row = await sql.begin(async (tx) => {
      const [old] = await tx`SELECT * FROM crm_tasks WHERE id = ${req.params.id} FOR UPDATE`;
      if (!old) return null;
      const [updated] = await tx`
        UPDATE crm_tasks SET
          status = COALESCE(${status || null}, status),
          priority = COALESCE(${priority || null}, priority),
          owner_founder_id = CASE WHEN ${owner_founder_id !== undefined} THEN ${owner_founder_id || null} ELSE owner_founder_id END,
          due_at = CASE WHEN ${due_at !== undefined} THEN ${due_at || null} ELSE due_at END,
          title = COALESCE(${title || null}, title),
          description = CASE WHEN ${description !== undefined} THEN ${description || null} ELSE description END,
          completed_at = CASE WHEN ${status || null} = 'COMPLETED' THEN now() WHEN ${status || null} IS NOT NULL THEN NULL ELSE completed_at END,
          updated_at = now()
        WHERE id = ${req.params.id} RETURNING *
      `;
      await audit(tx, req, 'crm_task', updated.id, 'UPDATE', old, updated);
      return updated;
    });
    if (!row) return res.status(404).json({ error: 'CRM task not found' });
    return sendResponse(res, 200, row);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to update CRM task' });
  }
});

router.post('/enquiries/:id/convert', requireCrmWrite, async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    assertCrmWrite(scope);
    const result = await sales.convertLead(sql, scope, req.params.id, req.body || {});
    return sendResponse(res, 200, result);
  } catch (err) {
    return sendCrmError(res, err, { enquiry_id: req.params.id });
  }
});

router.get('/automation-rules', async (req, res) => {
  try {
    assertPlatform(resolveCrmScope(req.superAdmin));
    return sendResponse(res, 200, await sql`SELECT * FROM crm_automation_rules ORDER BY created_at DESC`);
  } catch (err) {
    return sendCrmError(res, err);
  }
});

router.post('/automation-rules', requireCrmWrite, async (req, res) => {
  try {
    assertPlatform(resolveCrmScope(req.superAdmin));
  } catch (err) {
    return sendCrmError(res, err);
  }
  try {
    const { name, trigger_event, conditions, actions, is_enabled } = req.body || {};
    if (!name || !trigger_event || !Array.isArray(actions)) return res.status(400).json({ error: 'name, trigger_event, and actions[] are required' });
    const [row] = await sql`
      INSERT INTO crm_automation_rules (name, trigger_event, conditions, actions, is_enabled, created_by)
      VALUES (${name}, ${trigger_event}, ${sql.json(conditions || {})}, ${sql.json(actions)}, ${is_enabled !== false}, ${req.superAdmin.id})
      RETURNING *
    `;
    await audit(sql, req, 'crm_automation_rule', row.id, 'CREATE', null, row);
    return sendResponse(res, 201, row);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to create automation rule' });
  }
});

require('./crmSalesRoutes').mountSalesRoutes(router);
require('./crmSalesCommandRoutes').mountSalesCommandRoutes(router);
require('./crmProspectRoutes').mountProspectRoutes(router);
require('./crmImportRoutes').mountImportRoutes(router);
require('./crmTrackingRoutes').mountTrackingRoutes(router);
require('./crmFeedbackRoutes').mountFeedbackRoutes(router);

module.exports = router;
