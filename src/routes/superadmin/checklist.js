const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireSchoolAccess } = require('../../middleware/rbac');
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
           c.completed_by, c.completed_at, c.created_at, c.updated_at,
           ROW_NUMBER() OVER (ORDER BY c.created_at, c.task_key)::int AS sort_order,
           u.full_name AS completed_by_name
    FROM school_onboarding_checklists c
    LEFT JOIN internal_users u ON c.completed_by = u.id
    WHERE c.school_id = ${schoolId}
    ORDER BY c.created_at, c.task_key
  `;
  if (!items.length && seedIfEmpty) {
    await seedDefaults(schoolId);
    items = await sql`
      SELECT c.id, c.school_id, c.task_key, c.task_key AS task_code, c.title,
             c.category, c.status, c.blocker_reason, c.notes,
             c.completed_by, c.completed_at, c.created_at, c.updated_at,
             ROW_NUMBER() OVER (ORDER BY c.created_at, c.task_key)::int AS sort_order,
             u.full_name AS completed_by_name
      FROM school_onboarding_checklists c
      LEFT JOIN internal_users u ON c.completed_by = u.id
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

async function updateChecklistItem(req, res, lookupById) {
  try {
    const schoolId = Number(req.params.id);
    const { status, blocker_reason, notes } = req.body;
    const normStatus = String(status || '').toUpperCase();
    const validStatuses = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'NOT_APPLICABLE'];
    if (!validStatuses.includes(normStatus)) return res.status(400).json({ error: 'Invalid checklist status' });
    if (normStatus === 'BLOCKED' && !String(blocker_reason || '').trim()) {
      return res.status(400).json({ error: 'blocker_reason is required when status is BLOCKED' });
    }

    const lookup = lookupById
      ? sql`id = ${req.params.itemId}`
      : sql`task_key = ${req.params.taskKey}`;
    const [existing] = await sql`
      SELECT id, task_key, notes FROM school_onboarding_checklists
      WHERE school_id = ${schoolId} AND ${lookup}
      LIMIT 1
    `;
    if (!existing) return res.status(404).json({ error: 'Checklist item not found' });

    const [updated] = await sql`
      UPDATE school_onboarding_checklists
      SET status = ${normStatus},
          blocker_reason = ${normStatus === 'BLOCKED' ? String(blocker_reason).trim() : null},
          notes = ${notes !== undefined ? String(notes).trim() || null : existing.notes},
          completed_by = ${normStatus === 'COMPLETED' ? req.user.id : null},
          completed_at = ${normStatus === 'COMPLETED' ? new Date().toISOString() : null},
          updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `;

    await logAudit({
      userId: req.user.id,
      action: 'CHECKLIST_TASK_UPDATED',
      entity: 'ONBOARDING',
      entityId: existing.id,
      details: { schoolId, taskKey: existing.task_key, status: normStatus },
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
