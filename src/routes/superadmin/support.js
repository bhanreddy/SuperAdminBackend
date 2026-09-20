const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireAnyPermission } = require('../../middleware/rbac');
const { PERMISSIONS, ROLES, canManageRole } = require('../../config/rbac');
const { logAudit } = require('../../services/auditLogger');

const router = express.Router();
router.use(authenticateUser);

function hasSchoolAccess(user, schoolId) {
  return Boolean(
    user.isFounder ||
    user.permissions.includes(PERMISSIONS.SCHOOLS_READ_ALL) ||
    user.assignedSchoolIds.includes(Number(schoolId))
  );
}

function canSeeTicket(user, ticket) {
  if (!hasSchoolAccess(user, ticket.school_id)) return false;
  if (user.isFounder || user.permissions.includes(PERMISSIONS.SCHOOLS_READ_ALL)) return true;
  if (user.permissions.includes(PERMISSIONS.COMPLAINTS_MANAGE)) return true;
  return ticket.assigned_to === user.id || ticket.raised_by === user.id;
}

async function getTicket(id) {
  const [ticket] = await sql`
    SELECT c.id, c.school_id, c.ticket_no, c.ticket_no AS ticket_number,
           c.title, c.description, c.category,
           UPPER(c.priority::text) AS priority,
           UPPER(c.status::text) AS status,
           c.resolution, c.resolved_at, c.created_at, c.updated_at,
           c.raised_by, c.assigned_to,
           s.name AS school_name, s.code AS school_code,
           creator.full_name AS created_by_name,
           assignee.full_name AS assigned_to_name
    FROM complaints c
    LEFT JOIN schools s ON c.school_id = s.id
    LEFT JOIN internal_users creator ON c.raised_by = creator.id
    LEFT JOIN internal_users assignee ON c.assigned_to = assignee.id
    WHERE c.id = ${id} AND c.deleted_at IS NULL
    LIMIT 1
  `;
  return ticket;
}

async function validateAssignee(actor, assigneeId, schoolId) {
  const [target] = await sql`
    SELECT u.id, u.role, u.manager_id,
           EXISTS (
             SELECT 1 FROM internal_user_schools ius
             WHERE ius.user_id = u.id AND ius.school_id = ${Number(schoolId)}
           ) AS has_school_access
    FROM internal_users u
    WHERE u.id = ${assigneeId} AND u.status = 'ACTIVE'
    LIMIT 1
  `;
  if (!target || ![ROLES.SUPPORT_EXECUTIVE, ROLES.TECHNICAL_SUPPORT].includes(target.role)) {
    return { error: 'Assignee must be an active Support Executive or Technical Support user' };
  }
  if (!actor.isFounder && (target.manager_id !== actor.id || !canManageRole(actor.role, target.role))) {
    return { error: 'Assignee must be a support team member who reports to you' };
  }
  if (!target.has_school_access) {
    return { error: 'Assignee is not authorized for this school' };
  }
  return { target };
}

router.get('/tickets', requirePermission(PERMISSIONS.COMPLAINTS_READ), async (req, res) => {
  try {
    const { school_id, status, priority, category, assigned_to } = req.query;
    const unrestricted = req.user.isFounder || req.user.permissions.includes(PERMISSIONS.SCHOOLS_READ_ALL);
    const manager = req.user.permissions.includes(PERMISSIONS.COMPLAINTS_MANAGE);
    const assignedIds = req.user.assignedSchoolIds.length ? req.user.assignedSchoolIds : [-1];

    const rows = await sql`
      SELECT c.id, c.school_id, c.ticket_no, c.ticket_no AS ticket_number,
             c.title, c.description, c.category,
             UPPER(c.priority::text) AS priority,
             UPPER(c.status::text) AS status,
             c.resolution, c.resolved_at, c.created_at, c.updated_at,
             c.raised_by, c.assigned_to,
             s.name AS school_name, s.code AS school_code,
             creator.full_name AS created_by_name,
             assignee.full_name AS assigned_to_name
      FROM complaints c
      LEFT JOIN schools s ON c.school_id = s.id
      LEFT JOIN internal_users creator ON c.raised_by = creator.id
      LEFT JOIN internal_users assignee ON c.assigned_to = assignee.id
      WHERE c.deleted_at IS NULL
        ${unrestricted ? sql`` : sql`AND c.school_id IN ${sql(assignedIds)}`}
        ${unrestricted || manager ? sql`` : sql`AND (c.assigned_to = ${req.user.id} OR c.raised_by = ${req.user.id})`}
        ${school_id ? sql`AND c.school_id = ${Number(school_id)}` : sql``}
        ${status ? sql`AND c.status::text = ${String(status).toLowerCase()}` : sql``}
        ${priority ? sql`AND c.priority::text = ${String(priority).toLowerCase()}` : sql``}
        ${category ? sql`AND c.category = ${String(category)}` : sql``}
        ${assigned_to ? sql`AND c.assigned_to = ${String(assigned_to)}` : sql``}
      ORDER BY c.created_at DESC
      LIMIT 200
    `;
    return sendResponse(res, 200, { success: true, data: rows });
  } catch (err) {
    console.error('Error fetching complaints:', err);
    return res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

router.get('/tickets/:id', requirePermission(PERMISSIONS.COMPLAINTS_READ), async (req, res) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied to this ticket' });
    const notes = await sql`
      SELECT n.id, n.note, n.is_internal, n.created_at, n.author_name,
             u.role AS author_role
      FROM support_ticket_notes n
      LEFT JOIN internal_users u ON n.author_id = u.id
      WHERE n.ticket_id = ${ticket.id}
      ORDER BY n.created_at
    `;
    return sendResponse(res, 200, { success: true, data: { ...ticket, notes } });
  } catch (err) {
    console.error('Error fetching ticket:', err);
    return res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

router.post('/tickets', requirePermission(PERMISSIONS.COMPLAINTS_CREATE), async (req, res) => {
  try {
    const { school_id, title, description, category = 'SOFTWARE_BUG', priority = 'MEDIUM', assigned_to } = req.body;
    const schoolId = Number(school_id);
    if (!Number.isInteger(schoolId) || schoolId <= 0) return res.status(400).json({ error: 'Valid school_id is required' });
    if (!hasSchoolAccess(req.user, schoolId)) return res.status(403).json({ error: 'Access denied to this school' });
    if (!String(title || '').trim() || !String(description || '').trim()) {
      return res.status(400).json({ error: 'Title and description are required' });
    }
    const normPriority = String(priority).toUpperCase();
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(normPriority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }

    let assigneeId = assigned_to || null;
    if (req.user.role === ROLES.SUPPORT_EXECUTIVE || req.user.role === ROLES.TECHNICAL_SUPPORT) {
      assigneeId = req.user.id;
    }
    if (assigneeId && !req.user.permissions.includes(PERMISSIONS.COMPLAINTS_MANAGE) && assigneeId !== req.user.id) {
      return res.status(403).json({ error: 'Only complaint managers can assign another user' });
    }
    if (assigneeId && assigneeId !== req.user.id) {
      const validation = await validateAssignee(req.user, assigneeId, schoolId);
      if (validation.error) return res.status(400).json({ error: validation.error });
    }

    const [created] = await sql`
      INSERT INTO complaints (
        school_id, title, description, category, priority, status,
        raised_by, assigned_to
      ) VALUES (
        ${schoolId}, ${String(title).trim()}, ${String(description).trim()},
        ${String(category)}, ${normPriority.toLowerCase()}, 'open',
        ${req.user.id}, ${assigneeId}
      )
      RETURNING id
    `;
    const ticket = await getTicket(created.id);
    await logAudit({
      userId: req.user.id,
      action: 'COMPLAINT_CREATED',
      entity: 'COMPLAINT',
      entityId: created.id,
      details: { schoolId, priority: normPriority, category },
      schoolId,
    });
    return sendResponse(res, 201, { success: true, data: ticket });
  } catch (err) {
    console.error('Error creating complaint:', err);
    return res.status(500).json({ error: 'Failed to create ticket' });
  }
});

router.patch(
  '/tickets/:id',
  requireAnyPermission(PERMISSIONS.COMPLAINTS_MANAGE, PERMISSIONS.COMPLAINTS_UPDATE_ASSIGNED),
  async (req, res) => {
    try {
      const existing = await getTicket(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Ticket not found' });
      if (!canSeeTicket(req.user, existing)) return res.status(403).json({ error: 'Access denied to this ticket' });

      const isManager = req.user.isFounder || req.user.permissions.includes(PERMISSIONS.COMPLAINTS_MANAGE);
      const { status, priority, assigned_to, resolution } = req.body;
      if (!isManager && (priority !== undefined || assigned_to !== undefined)) {
        return res.status(403).json({ error: 'Only complaint managers can change priority or assignment' });
      }

      let nextAssignee = existing.assigned_to;
      if (assigned_to !== undefined) {
        if (assigned_to) {
          const validation = await validateAssignee(req.user, assigned_to, existing.school_id);
          if (validation.error) return res.status(400).json({ error: validation.error });
        }
        nextAssignee = assigned_to || null;
      }

      const normStatus = status ? String(status).toLowerCase() : null;
      const normPriority = priority ? String(priority).toLowerCase() : null;
      if (normStatus && !['open', 'in_progress', 'waiting_on_client', 'escalated', 'reopened', 'resolved', 'closed'].includes(normStatus)) {
        return res.status(400).json({ error: 'Invalid ticket status' });
      }
      if (normPriority && !['low', 'medium', 'high', 'critical'].includes(normPriority)) {
        return res.status(400).json({ error: 'Invalid ticket priority' });
      }

      const resolved = normStatus === 'resolved' || normStatus === 'closed';
      await sql`
        UPDATE complaints
        SET status = COALESCE(${normStatus}, status),
            priority = COALESCE(${normPriority}, priority),
            assigned_to = ${nextAssignee},
            resolution = ${resolution !== undefined ? String(resolution).trim() || null : existing.resolution},
            resolved_by = ${resolved ? req.user.id : null},
            resolved_at = ${resolved ? new Date().toISOString() : null},
            updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      const updated = await getTicket(existing.id);
      await logAudit({
        userId: req.user.id,
        action: 'TICKET_UPDATED',
        entity: 'COMPLAINT',
        entityId: existing.id,
        details: { previousStatus: existing.status, status: updated.status, priority: updated.priority, assignedTo: nextAssignee },
        schoolId: existing.school_id,
      });
      return sendResponse(res, 200, { success: true, data: updated });
    } catch (err) {
      console.error('Error updating ticket:', err);
      return res.status(500).json({ error: 'Failed to update ticket' });
    }
  },
);

router.get('/tickets/:id/notes', requirePermission(PERMISSIONS.COMPLAINTS_READ), async (req, res) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied to this ticket' });
    const notes = await sql`
      SELECT n.*, u.role AS author_role
      FROM support_ticket_notes n
      LEFT JOIN internal_users u ON n.author_id = u.id
      WHERE n.ticket_id = ${ticket.id}
      ORDER BY n.created_at
    `;
    return sendResponse(res, 200, { success: true, data: notes });
  } catch (err) {
    console.error('Error fetching ticket notes:', err);
    return res.status(500).json({ error: 'Failed to fetch ticket notes' });
  }
});

router.post('/tickets/:id/notes', requirePermission(PERMISSIONS.COMPLAINTS_READ), async (req, res) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied to this ticket' });
    const note = String(req.body.note || '').trim();
    if (note.length < 2) return res.status(400).json({ error: 'Note cannot be empty' });
    const [created] = await sql`
      INSERT INTO support_ticket_notes (ticket_id, author_id, author_name, note, is_internal)
      VALUES (${ticket.id}, ${req.user.id}, ${req.user.fullName}, ${note}, ${Boolean(req.body.is_internal)})
      RETURNING *
    `;
    return sendResponse(res, 201, { success: true, data: created });
  } catch (err) {
    console.error('Error adding ticket note:', err);
    return res.status(500).json({ error: 'Failed to add note' });
  }
});

module.exports = router;
