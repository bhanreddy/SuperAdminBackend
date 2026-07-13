const express = require('express');
const sql = require('../../config/crmDb');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { requireCrmWrite } = require('../../middleware/crmAccess');
const { enqueueAutomationEvent } = require('../../services/crmAutomation');

const router = express.Router();
router.use(verifySuperAdminMiddleware);

function actorFounderId(req) {
  return req.superAdmin?.founderId || null;
}

// Non-super founders only see the tenants/leads they own. Full super admins
// (isSuperAdmin) return null here and bypass all ownership filtering.
function scopeOwner(req) {
  if (req.superAdmin?.isSuperAdmin) return null;
  return req.superAdmin?.founderId || null;
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
    const row = await sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO crm_accounts
          (name, account_type, vertical, lifecycle_stage, owner_founder_id, email, phone, website, tags, created_by)
        VALUES
          (${String(name).trim()}, ${account_type || 'PROSPECT'}, ${vertical || 'OTHER'}, ${lifecycle_stage || 'LEAD'},
           ${owner_founder_id || actorFounderId(req)}, ${email || null}, ${phone || null}, ${website || null},
           ${Array.isArray(tags) ? tags : []}, ${req.superAdmin.id})
        RETURNING *
      `;
      await audit(tx, req, 'crm_account', created.id, 'CREATE', null, created);
      await enqueueAutomationEvent(tx, 'account.created', 'crm_account', created.id, {
        account_id: created.id, owner_founder_id: created.owner_founder_id,
      });
      return created;
    });
    return sendResponse(res, 201, row);
  } catch (err) {
    console.error('CRM account create failed:', err);
    return res.status(400).json({ error: err.message || 'Failed to create CRM account' });
  }
});

router.get('/accounts/:id', async (req, res) => {
  try {
    const [account] = await sql`SELECT a.*, f.full_name AS owner_name FROM crm_accounts a LEFT JOIN founders f ON f.id = a.owner_founder_id WHERE a.id = ${req.params.id}`;
    if (!account) return res.status(404).json({ error: 'CRM account not found' });
    const [contacts, enquiries, tasks, activities] = await Promise.all([
      sql`SELECT * FROM crm_contacts WHERE account_id = ${account.id} ORDER BY is_primary DESC, created_at`,
      sql`SELECT * FROM enquiries WHERE account_id = ${account.id} ORDER BY updated_at DESC`,
      sql`SELECT t.*, f.full_name AS owner_name FROM crm_tasks t LEFT JOIN founders f ON f.id = t.owner_founder_id WHERE t.account_id = ${account.id} ORDER BY t.status, t.due_at NULLS LAST`,
      sql`SELECT * FROM crm_activities WHERE account_id = ${account.id} ORDER BY occurred_at DESC LIMIT 100`,
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
    const { owner_founder_id, external_client_id, cluster_id, lifecycle_stage } = req.body || {};
    // Reassigning ownership is a super-admin-only action; a scoped founder must
    // not hand tenants to themselves or others.
    if (owner_founder_id !== undefined && !req.superAdmin?.isSuperAdmin) {
      return res.status(403).json({ error: 'Only a Super Admin can reassign tenant ownership' });
    }
    const VALID_STAGES = ['LEAD', 'QUALIFIED', 'ONBOARDING', 'ACTIVE', 'AT_RISK', 'CHURNED'];
    if (lifecycle_stage !== undefined && lifecycle_stage !== null && !VALID_STAGES.includes(lifecycle_stage)) {
      return res.status(400).json({ error: 'Invalid lifecycle_stage' });
    }
    const row = await sql.begin(async (tx) => {
      const [old] = await tx`SELECT * FROM crm_accounts WHERE id = ${req.params.id} FOR UPDATE`;
      if (!old) return null;
      const [updated] = await tx`
        UPDATE crm_accounts SET
          owner_founder_id = CASE WHEN ${owner_founder_id !== undefined} THEN ${owner_founder_id || null} ELSE owner_founder_id END,
          external_client_id = CASE WHEN ${external_client_id !== undefined} THEN ${external_client_id || null} ELSE external_client_id END,
          cluster_id = CASE WHEN ${cluster_id !== undefined} THEN ${cluster_id || null} ELSE cluster_id END,
          lifecycle_stage = COALESCE(${lifecycle_stage || null}, lifecycle_stage),
          updated_at = now()
        WHERE id = ${req.params.id} RETURNING *
      `;
      await audit(tx, req, 'crm_account', updated.id, 'UPDATE', old, updated);
      if (owner_founder_id !== undefined && old.owner_founder_id !== updated.owner_founder_id) {
        await tx`INSERT INTO crm_activities (activity_type, account_id, actor_id, summary, details)
          VALUES ('OWNER_CHANGED', ${updated.id}, ${req.superAdmin.id}, ${`Tenant reassigned to owner ${updated.owner_founder_id || 'unassigned'}`}, ${tx.json({ from: old.owner_founder_id, to: updated.owner_founder_id })})`;
      }
      return updated;
    });
    if (!row) return res.status(404).json({ error: 'CRM account not found' });
    return sendResponse(res, 200, row);
  } catch (err) {
    console.error('CRM account update failed:', err);
    return res.status(400).json({ error: err.message || 'Failed to update CRM account' });
  }
});

router.post('/accounts/:id/contacts', requireCrmWrite, async (req, res) => {
  try {
    const { full_name, role_title, email, phone, is_primary, preferred_channel } = req.body || {};
    if (!String(full_name || '').trim()) return res.status(400).json({ error: 'full_name is required' });
    const row = await sql.begin(async (tx) => {
      if (is_primary) await tx`UPDATE crm_contacts SET is_primary = false WHERE account_id = ${req.params.id}`;
      const [created] = await tx`
        INSERT INTO crm_contacts (account_id, full_name, role_title, email, phone, is_primary, preferred_channel)
        VALUES (${req.params.id}, ${String(full_name).trim()}, ${role_title || null}, ${email || null}, ${phone || null}, ${Boolean(is_primary)}, ${preferred_channel || null})
        RETURNING *
      `;
      await audit(tx, req, 'crm_contact', created.id, 'CREATE', null, created);
      return created;
    });
    return sendResponse(res, 201, row);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to create CRM contact' });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const { status, due } = req.query;
    const owner = scopeOwner(req) || req.query.owner;
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
        AND (${owner || null}::uuid IS NULL OR t.owner_founder_id = ${owner || null})
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
    return res.status(400).json({ error: err.message || 'Failed to create CRM task' });
  }
});

router.patch('/tasks/:id', requireCrmWrite, async (req, res) => {
  try {
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
    const result = await sql.begin(async (tx) => {
      const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${req.params.id} FOR UPDATE`;
      if (!lead) return null;
      if (lead.account_id) return { accountId: lead.account_id, existing: true };
      const [account] = await tx`
        INSERT INTO crm_accounts (name, account_type, lifecycle_stage, vertical, owner_founder_id, email, phone, created_by)
        VALUES (${lead.name || 'Unnamed account'}, 'CUSTOMER', 'ONBOARDING', ${req.body?.vertical || 'OTHER'}, ${lead.assigned_to || actorFounderId(req)}, ${lead.email}, ${lead.phone}, ${req.superAdmin.id})
        RETURNING *
      `;
      await tx`UPDATE enquiries SET account_id = ${account.id}, status = 'CLOSED', converted_at = now(), updated_at = now() WHERE id = ${lead.id}`;
      await tx`INSERT INTO crm_activities (activity_type, account_id, enquiry_id, actor_id, summary) VALUES ('LEAD_CONVERTED', ${account.id}, ${lead.id}, ${req.superAdmin.id}, 'Lead converted to customer account')`;
      await audit(tx, req, 'enquiry', lead.id, 'CONVERT', lead, { account_id: account.id, status: 'CLOSED' });
      await enqueueAutomationEvent(tx, 'enquiry.converted', 'enquiry', lead.id, {
        account_id: account.id, enquiry_id: lead.id, owner_founder_id: account.owner_founder_id,
      });
      return { accountId: account.id, existing: false };
    });
    if (!result) return res.status(404).json({ error: 'Enquiry not found' });
    return sendResponse(res, 200, result);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to convert enquiry' });
  }
});

router.get('/automation-rules', async (_req, res) => {
  try {
    return sendResponse(res, 200, await sql`SELECT * FROM crm_automation_rules ORDER BY created_at DESC`);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list automation rules' });
  }
});

router.post('/automation-rules', requireCrmWrite, async (req, res) => {
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

module.exports = router;
