const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');
const { logAudit } = require('../../services/auditLogger');

const router = express.Router();
router.use(authenticateUser);

// GET /api/super-admin/requirements
router.get('/', requirePermission(PERMISSIONS.REQUIREMENTS_READ), async (req, res) => {
  try {
    const { school_id, status, priority, category } = req.query;

    // Filter by assigned schools if not Founder
    const isUnrestricted = req.user.isFounder || req.user.permissions.includes('schools.read.all');
    const assignedIds = req.user.assignedSchoolIds || [];

    let rows = await sql`
      SELECT 
        r.id, r.school_id, r.title, r.description, r.category, r.priority, r.status,
        r.notes, r.feasibility_status, r.resolution_notes, r.created_at, r.updated_at,
        s.name AS school_name, s.code AS school_code,
        u.full_name AS raised_by_name, u.full_name AS submitted_by_name,
        u.employee_id AS raised_by_employee_id,
        a.full_name AS assigned_to_name
      FROM school_requirements r
      LEFT JOIN schools s ON r.school_id = s.id
      LEFT JOIN internal_users u ON r.raised_by = u.id
      LEFT JOIN internal_users a ON r.assigned_to = a.id
      WHERE (1=1)
        ${!isUnrestricted ? sql`AND r.school_id IN ${sql(assignedIds.length > 0 ? assignedIds : [-1])}` : sql``}
        ${school_id ? sql`AND r.school_id = ${Number(school_id)}` : sql``}
        ${status ? sql`AND r.status = ${String(status).toUpperCase()}` : sql``}
        ${priority ? sql`AND r.priority = ${String(priority).toUpperCase()}` : sql``}
        ${category ? sql`AND r.category = ${String(category).toUpperCase()}` : sql``}
      ORDER BY r.created_at DESC
    `;

    return sendResponse(res, 200, { success: true, data: rows });
  } catch (err) {
    console.error('Error fetching requirements:', err);
    return res.status(500).json({ error: 'Failed to fetch requirements' });
  }
});

// POST /api/super-admin/requirements
router.post('/', requirePermission(PERMISSIONS.REQUIREMENTS_CREATE), async (req, res) => {
  try {
    const { school_id, title, description, category = 'CUSTOM_APP', priority = 'MEDIUM', notes } = req.body;

    if (!school_id) return res.status(400).json({ error: 'school_id is required' });
    if (!title || title.trim().length < 3) return res.status(400).json({ error: 'Title is required' });

    const targetSchoolId = Number(school_id);
    const normCategory = String(category).toUpperCase();
    const normPriority = String(priority).toUpperCase();
    const validCategories = ['PAYMENT', 'CUSTOM_APP', 'TRANSPORT', 'ATTENDANCE', 'ACADEMIC', 'REPORTS', 'FEATURE', 'CUSTOMIZATION', 'INTEGRATION', 'DATA', 'HARDWARE', 'OTHER'];
    if (!validCategories.includes(normCategory)) return res.status(400).json({ error: 'Invalid requirement category' });
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(normPriority)) return res.status(400).json({ error: 'Invalid priority' });
    const isUnrestricted = req.user.isFounder || req.user.permissions.includes('schools.read.all');

    if (!isUnrestricted && !req.user.assignedSchoolIds.includes(targetSchoolId)) {
      return res.status(403).json({
        error: `Access denied. You cannot raise requirements for School ID ${targetSchoolId} as it is not assigned to you.`,
      });
    }

    const [newReq] = await sql`
      INSERT INTO school_requirements (
        school_id, title, description, category, priority, status, raised_by, notes
      ) VALUES (
        ${targetSchoolId}, ${title.trim()}, ${description || null},
        ${normCategory}, ${normPriority},
        'OPEN', ${req.user.id}, ${notes || null}
      )
      RETURNING *
    `;

    await logAudit({
      userId: req.user.id,
      action: 'REQUIREMENT_CREATED',
      entity: 'REQUIREMENT',
      entityId: newReq.id,
      details: { title, schoolId: targetSchoolId, priority, category },
      schoolId: targetSchoolId,
    });

    return sendResponse(res, 201, { success: true, data: newReq });
  } catch (err) {
    console.error('Error creating requirement:', err);
    return res.status(500).json({ error: 'Failed to create requirement' });
  }
});

// PATCH /api/super-admin/requirements/:id
router.patch('/:id', requirePermission(PERMISSIONS.REQUIREMENTS_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority, notes, assigned_to, feasibility_status, resolution_notes } = req.body;

    const [existing] = await sql`SELECT * FROM school_requirements WHERE id = ${id} LIMIT 1`;
    if (!existing) return res.status(404).json({ error: 'Requirement not found' });
    const isUnrestricted = req.user.isFounder || req.user.permissions.includes(PERMISSIONS.SCHOOLS_READ_ALL);
    if (!isUnrestricted && !req.user.assignedSchoolIds.includes(Number(existing.school_id))) {
      return res.status(403).json({ error: 'Access denied to this requirement school' });
    }

    const normStatus = status ? String(status).toUpperCase() : null;
    const normPriority = priority ? String(priority).toUpperCase() : null;
    const normFeasibility = feasibility_status ? String(feasibility_status).toUpperCase() : null;
    if (normStatus && !['OPEN', 'UNDER_REVIEW', 'IN_DEVELOPMENT', 'DEPLOYED', 'REJECTED'].includes(normStatus)) {
      return res.status(400).json({ error: 'Invalid requirement status' });
    }
    if (normPriority && !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(normPriority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }
    if (normFeasibility && !['FEASIBLE', 'NEEDS_REVIEW', 'NOT_FEASIBLE'].includes(normFeasibility)) {
      return res.status(400).json({ error: 'Invalid feasibility status' });
    }

    const [updated] = await sql`
      UPDATE school_requirements
      SET
        status = COALESCE(${normStatus}, status),
        priority = COALESCE(${normPriority}, priority),
        notes = COALESCE(${notes}, notes),
        assigned_to = COALESCE(${assigned_to}, assigned_to),
        feasibility_status = COALESCE(${normFeasibility}, feasibility_status),
        resolution_notes = COALESCE(${resolution_notes}, resolution_notes),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    await logAudit({
      userId: req.user.id,
      action: 'REQUIREMENT_UPDATED',
      entity: 'REQUIREMENT',
      entityId: id,
      details: { previousStatus: existing.status, newStatus: updated.status, schoolId: existing.school_id },
      schoolId: existing.school_id,
    });

    return sendResponse(res, 200, { success: true, data: updated });
  } catch (err) {
    console.error('Error updating requirement:', err);
    return res.status(500).json({ error: 'Failed to update requirement' });
  }
});

module.exports = router;
