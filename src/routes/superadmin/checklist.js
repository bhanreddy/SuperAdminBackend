const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireAnyPermission, requireSchoolAccess } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');
const { logAudit } = require('../../services/auditLogger');

const router = express.Router();
router.use(authenticateUser);
router.param('id', (req, res, next, id) => {
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    return res.status(400).json({ error: 'Invalid school id' });
  }
  return next();
});

const DEFAULT_TASKS = [
  ['contract_setup', 'Contract & School Profile Confirmed', 'CONTRACT_AND_SETUP'],
  ['dns_portal', 'Portal Domain & DNS Configured', 'CONTRACT_AND_SETUP'],
  ['student_data', 'Student Master Data Uploaded', 'DATA_INGESTION'],
  ['staff_data', 'Staff Master Data Uploaded', 'DATA_INGESTION'],
  ['fees_transport', 'Fees & Transport Data Validated', 'DATA_INGESTION'],
  ['hardware_ready', 'RFID, GPS & Hardware Readiness Verified', 'HARDWARE_AND_INFRA'],
  ['android_build', 'Android APK Build Verified', 'APP_BUILD'],
  ['ios_web_build', 'iOS / Web Release Links Verified', 'APP_BUILD'],
  ['staff_training', 'School Staff Training Completed', 'TRAINING_AND_GO_LIVE'],
  ['launch_ready', 'Production Launch Sign-off', 'TRAINING_AND_GO_LIVE'],
];

async function seedDefaults(schoolId) {
  for (let index = 0; index < DEFAULT_TASKS.length; index += 1) {
    const [taskKey, title, category] = DEFAULT_TASKS[index];
    await sql`
      INSERT INTO school_onboarding_checklists (
        school_id, task_key, title, category, status
      ) VALUES (${schoolId}, ${taskKey}, ${title}, ${category}, 'NOT_STARTED')
      ON CONFLICT (school_id, task_key) DO NOTHING
    `;
  }
}

async function checklistPayload(schoolId, seedIfEmpty = false) {
  let items = await sql`
    SELECT c.id, c.school_id, c.task_key, c.task_key AS task_code, c.title,
           c.category, c.status, c.blocker_reason, c.notes,
           c.assigned_to, c.supervising_manager_id, c.due_date, c.priority,
           c.instructions, c.next_action, c.completion_outcome, c.evidence_url,
           c.escalated_at, c.escalation_reason, c.escalated_to,
           c.completed_by, c.completed_at, c.created_at, c.updated_at,
           ROW_NUMBER() OVER (ORDER BY c.created_at, c.task_key)::int AS sort_order,
           u_comp.full_name AS completed_by_name,
           u_ass.full_name AS assigned_to_name,
           u_ass.employee_id AS assigned_to_employee_id,
           u_mgr.full_name AS supervising_manager_name
    FROM school_onboarding_checklists c
    LEFT JOIN internal_users u_comp ON c.completed_by = u_comp.id
    LEFT JOIN internal_users u_ass ON c.assigned_to = u_ass.id
    LEFT JOIN internal_users u_mgr ON c.supervising_manager_id = u_mgr.id
    WHERE c.school_id = ${schoolId}
    ORDER BY c.created_at, c.task_key
  `;
  if (!items.length && seedIfEmpty) {
    await seedDefaults(schoolId);
    items = await sql`
      SELECT c.id, c.school_id, c.task_key, c.task_key AS task_code, c.title,
             c.category, c.status, c.blocker_reason, c.notes,
             c.assigned_to, c.supervising_manager_id, c.due_date, c.priority,
             c.instructions, c.next_action, c.completion_outcome, c.evidence_url,
             c.escalated_at, c.escalation_reason, c.escalated_to,
             c.completed_by, c.completed_at, c.created_at, c.updated_at,
             ROW_NUMBER() OVER (ORDER BY c.created_at, c.task_key)::int AS sort_order,
             u_comp.full_name AS completed_by_name,
             u_ass.full_name AS assigned_to_name,
             u_ass.employee_id AS assigned_to_employee_id,
             u_mgr.full_name AS supervising_manager_name
      FROM school_onboarding_checklists c
      LEFT JOIN internal_users u_comp ON c.completed_by = u_comp.id
      LEFT JOIN internal_users u_ass ON c.assigned_to = u_ass.id
      LEFT JOIN internal_users u_mgr ON c.supervising_manager_id = u_mgr.id
      WHERE c.school_id = ${schoolId}
      ORDER BY c.created_at, c.task_key
    `;
  }
  const completed = items.filter((item) => item.status === 'COMPLETED').length;
  return {
    schoolId,
    items,
    progress: {
      total: items.length,
      completed,
      percentage: items.length ? Math.round((completed / items.length) * 100) : 0,
    },
  };
}

async function sendChecklist(req, res) {
  try {
    const data = await checklistPayload(Number(req.params.id), false);
    return sendResponse(res, 200, { success: true, data });
  } catch (err) {
    console.error('Error fetching checklist:', err);
    return res.status(500).json({ error: 'Failed to fetch checklist' });
  }
}

router.get(
  '/:id',
  requirePermission(PERMISSIONS.CHECKLIST_READ),
  requireSchoolAccess('id'),
  sendChecklist,
);
router.get(
  '/:id/checklist',
  requirePermission(PERMISSIONS.CHECKLIST_READ),
  requireSchoolAccess('id'),
  sendChecklist,
);

router.post(
  ['/:id/init', '/:id/checklist/init'],
  requirePermission(PERMISSIONS.CHECKLIST_UPDATE),
  requireSchoolAccess('id'),
  async (req, res) => {
    try {
      await seedDefaults(Number(req.params.id));
      return sendResponse(res, 200, { success: true, data: await checklistPayload(Number(req.params.id), false) });
    } catch (err) {
      console.error('Error initializing checklist:', err);
      return res.status(500).json({ error: 'Failed to initialize checklist' });
    }
  },
);

// POST /api/super-admin/checklist/:id/items/:itemId/delegate
// Delegate a work item / checklist task to an employee with due date, priority, and instructions
router.post(
  ['/:id/items/:itemId/delegate', '/:id/checklist/:itemId/delegate'],
  requireAnyPermission(PERMISSIONS.CHECKLIST_DELEGATE, PERMISSIONS.USERS_MANAGE),
  requireSchoolAccess('id'),
  async (req, res) => {
    try {
      const schoolId = Number(req.params.id);
      const itemId = Number(req.params.itemId);
      const { assigned_to, supervising_manager_id, due_date, priority = 'MEDIUM', instructions } = req.body;

      if (!assigned_to) {
        return res.status(400).json({ error: 'assigned_to employee id is required' });
      }

      const [assignee] = await sql`
        SELECT id, employee_id, full_name, role, status, manager_id FROM internal_users WHERE id = ${assigned_to} LIMIT 1
      `;
      if (!assignee || assignee.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Assigned employee is not active' });
      }

      // Authorization: Non-founders can only delegate to direct reports or self
      if (!req.user.isFounder && !req.user.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        if (assignee.manager_id !== req.user.id && assignee.id !== req.user.id) {
          return res.status(403).json({ error: 'You can only delegate tasks to employees in your reporting team' });
        }
      }

      const normPriority = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(String(priority).toUpperCase())
        ? String(priority).toUpperCase()
        : 'MEDIUM';

      const supervisorId = supervising_manager_id || (req.user.isFounder ? null : req.user.id);

      const [updated] = await sql`
        UPDATE school_onboarding_checklists
        SET
          assigned_to = ${assignee.id},
          supervising_manager_id = ${supervisorId},
          due_date = ${due_date ? new Date(due_date).toISOString() : null},
          priority = ${normPriority},
          instructions = ${instructions ? String(instructions).trim() : null},
          updated_at = NOW()
        WHERE school_id = ${schoolId} AND id = ${itemId}
        RETURNING *
      `;

      if (!updated) {
        return res.status(404).json({ error: 'Checklist item not found' });
      }

      await logAudit({
        userId: req.user.id,
        action: 'CHECKLIST_TASK_DELEGATED',
        entity: 'ONBOARDING',
        entityId: updated.id,
        details: {
          schoolId,
          itemId: updated.id,
          taskKey: updated.task_key,
          assignedTo: assignee.id,
          assignedToName: assignee.full_name,
          supervisingManagerId: supervisorId,
          dueDate: due_date,
          priority: normPriority,
          instructions,
        },
        schoolId,
      });

      return sendResponse(res, 200, { success: true, data: updated });
    } catch (err) {
      console.error('Error delegating checklist item:', err);
      return res.status(500).json({ error: 'Failed to delegate checklist item' });
    }
  }
);

async function updateChecklistItem(req, res, lookupById) {
  try {
    const schoolId = Number(req.params.id);
    const {
      status,
      blocker_reason,
      next_action,
      completion_outcome,
      notes,
      evidence_url,
    } = req.body;
    const normStatus = String(status || '').toUpperCase();
    const validStatuses = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'NOT_APPLICABLE'];
    if (!validStatuses.includes(normStatus)) return res.status(400).json({ error: 'Invalid checklist status' });
    if (normStatus === 'BLOCKED' && !String(blocker_reason || '').trim()) {
      return res.status(400).json({ error: 'blocker_reason is required when marking status as BLOCKED' });
    }

    const lookup = lookupById
      ? sql`id = ${req.params.itemId}`
      : sql`task_key = ${req.params.taskKey}`;
    const [existing] = await sql`
      SELECT id, task_key, notes, next_action, completion_outcome, evidence_url, supervising_manager_id
      FROM school_onboarding_checklists
      WHERE school_id = ${schoolId} AND ${lookup}
      LIMIT 1
    `;
    if (!existing) return res.status(404).json({ error: 'Checklist item not found' });

    const isCompleting = normStatus === 'COMPLETED';
    const isBlocking = normStatus === 'BLOCKED';

    const [updated] = await sql`
      UPDATE school_onboarding_checklists
      SET status = ${normStatus},
          blocker_reason = ${isBlocking ? String(blocker_reason).trim() : null},
          next_action = ${next_action !== undefined ? String(next_action).trim() || null : existing.next_action},
          completion_outcome = ${completion_outcome !== undefined ? String(completion_outcome).trim() || null : existing.completion_outcome},
          notes = ${notes !== undefined ? String(notes).trim() || null : existing.notes},
          evidence_url = ${evidence_url !== undefined ? String(evidence_url).trim() || null : existing.evidence_url},
          escalated_at = ${isBlocking ? sql`NOW()` : null},
          escalation_reason = ${isBlocking ? String(blocker_reason).trim() : null},
          escalated_to = ${isBlocking ? existing.supervising_manager_id : null},
          completed_by = ${isCompleting ? req.user.id : null},
          completed_at = ${isCompleting ? sql`NOW()` : null},
          updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `;

    // Audit log Workflow B
    await logAudit({
      userId: req.user.id,
      action: isBlocking ? 'CHECKLIST_TASK_BLOCKED' : isCompleting ? 'CHECKLIST_TASK_COMPLETED' : 'CHECKLIST_TASK_UPDATED',
      entity: 'ONBOARDING',
      entityId: existing.id,
      details: {
        schoolId,
        taskKey: existing.task_key,
        status: normStatus,
        blockerReason: isBlocking ? blocker_reason : null,
        nextAction: next_action || null,
        completionOutcome: completion_outcome || null,
      },
      schoolId,
    });
    return sendResponse(res, 200, { success: true, data: updated });
  } catch (err) {
    console.error('Error updating checklist item:', err);
    return res.status(500).json({ error: 'Failed to update checklist item' });
  }
}

router.patch(
  '/:id/items/:itemId',
  requirePermission(PERMISSIONS.CHECKLIST_UPDATE),
  requireSchoolAccess('id'),
  (req, res) => updateChecklistItem(req, res, true),
);
router.patch(
  '/:id/checklist/:taskKey',
  requirePermission(PERMISSIONS.CHECKLIST_UPDATE),
  requireSchoolAccess('id'),
  (req, res) => updateChecklistItem(req, res, false),
);

module.exports = router;
