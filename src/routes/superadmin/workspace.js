const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser } = require('../../middleware/rbac');
const { ROLES, normalizeRole, PERMISSIONS } = require('../../config/rbac');

const router = express.Router();
router.use(authenticateUser);

function isRootRole(role) {
  const norm = normalizeRole(role);
  return norm === ROLES.FOUNDER || norm === ROLES.SUPER_ADMIN;
}

// GET /api/super-admin/workspace/summary
// Role-appropriate summary for landing screens (Executive, Manager, Founder)
router.get('/summary', async (req, res) => {
  try {
    const userRole = normalizeRole(req.user.role);
    const userId = req.user.id;
    const isFounder = req.user.isFounder || isRootRole(userRole);
    const isManager = userRole.endsWith('_MANAGER');

    // 1. Founder Workspace View
    if (isFounder) {
      const [stats] = await sql`
        SELECT 
          (SELECT COUNT(*)::int FROM schools WHERE is_active = TRUE) AS active_schools_count,
          (SELECT COUNT(*)::int FROM internal_users WHERE status = 'ACTIVE') AS active_employees_count,
          (SELECT COUNT(*)::int FROM school_onboarding_checklists WHERE status IN ('NOT_STARTED', 'IN_PROGRESS')) AS open_tasks_count,
          (SELECT COUNT(*)::int FROM school_onboarding_checklists WHERE status = 'BLOCKED') AS blocked_tasks_count,
          (SELECT COUNT(*)::int FROM school_onboarding_checklists WHERE due_date < NOW() AND status NOT IN ('COMPLETED', 'NOT_APPLICABLE')) AS overdue_tasks_count,
          (SELECT COUNT(*)::int FROM school_onboarding_checklists WHERE assigned_to IS NULL AND status NOT IN ('COMPLETED', 'NOT_APPLICABLE')) AS unassigned_tasks_count
      `;

      // Exceptions needing decision: blocked items and escalated items
      const exceptions = await sql`
        SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.status,
               c.blocker_reason, c.next_action, c.priority, c.due_date, c.escalated_at, c.escalation_reason,
               u_ass.full_name AS assigned_to_name,
               u_mgr.full_name AS supervising_manager_name
        FROM school_onboarding_checklists c
        LEFT JOIN schools sc ON sc.id = c.school_id
        LEFT JOIN internal_users u_ass ON c.assigned_to = u_ass.id
        LEFT JOIN internal_users u_mgr ON c.supervising_manager_id = u_mgr.id
        WHERE c.status = 'BLOCKED' OR c.escalated_at IS NOT NULL
        ORDER BY c.priority = 'URGENT' DESC, c.priority = 'HIGH' DESC, c.escalated_at DESC NULLS LAST
        LIMIT 20
      `;

      // Work without accountable owner
      const unassignedWork = await sql`
        SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.category, c.status, c.priority, c.due_date
        FROM school_onboarding_checklists c
        LEFT JOIN schools sc ON sc.id = c.school_id
        WHERE c.assigned_to IS NULL AND c.status NOT IN ('COMPLETED', 'NOT_APPLICABLE')
        ORDER BY c.due_date ASC NULLS LAST, c.created_at DESC
        LIMIT 20
      `;

      // Operational progress by manager/team
      const teamProgress = await sql`
        SELECT 
          m.id AS manager_id, m.full_name AS manager_name, m.role AS manager_role,
          COUNT(DISTINCT r.id)::int AS direct_reports_count,
          COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'COMPLETED')::int AS completed_tasks_count,
          COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('NOT_STARTED', 'IN_PROGRESS'))::int AS open_tasks_count,
          COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'BLOCKED')::int AS blocked_tasks_count
        FROM internal_users m
        LEFT JOIN internal_users r ON r.manager_id = m.id AND r.status = 'ACTIVE'
        LEFT JOIN school_onboarding_checklists c ON c.assigned_to = r.id OR c.supervising_manager_id = m.id
        WHERE m.role LIKE '%_MANAGER' AND m.status = 'ACTIVE'
        GROUP BY m.id, m.full_name, m.role
        ORDER BY m.full_name ASC
      `;

      return sendResponse(res, 200, {
        success: true,
        data: {
          role: userRole,
          workspaceType: 'FOUNDER',
          overview: stats,
          exceptions,
          unassignedWork,
          teamProgress,
        },
      });
    }

    // 2. Manager Workspace View
    if (isManager) {
      // Find direct reports
      const directReports = await sql`
        SELECT u.id, u.employee_id, u.full_name, u.role, u.status, u.territory,
               COALESCE((SELECT COUNT(*)::int FROM internal_user_schools s WHERE s.user_id = u.id), 0) AS assigned_schools_count,
               COALESCE((SELECT COUNT(*)::int FROM school_onboarding_checklists c WHERE c.assigned_to = u.id AND c.status IN ('NOT_STARTED', 'IN_PROGRESS')), 0) AS open_tasks_count,
               COALESCE((SELECT COUNT(*)::int FROM school_onboarding_checklists c WHERE c.assigned_to = u.id AND c.status = 'BLOCKED'), 0) AS blocked_tasks_count,
               COALESCE((SELECT COUNT(*)::int FROM school_onboarding_checklists c WHERE c.assigned_to = u.id AND c.due_date < NOW() AND c.status NOT IN ('COMPLETED', 'NOT_APPLICABLE')), 0) AS overdue_tasks_count
        FROM internal_users u
        WHERE u.manager_id = ${userId} AND u.status = 'ACTIVE'
        ORDER BY u.full_name ASC
      `;

      const reportIds = directReports.map((r) => r.id);
      const teamUserIds = [userId, ...reportIds];

      // Blockers requiring manager review
      const blockers = await sql`
        SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.status,
               c.blocker_reason, c.next_action, c.priority, c.due_date, c.escalated_at,
               u_ass.full_name AS assigned_to_name, u_ass.employee_id AS assigned_to_employee_id
        FROM school_onboarding_checklists c
        LEFT JOIN schools sc ON sc.id = c.school_id
        LEFT JOIN internal_users u_ass ON c.assigned_to = u_ass.id
        WHERE (c.supervising_manager_id = ${userId} OR c.assigned_to IN ${sql(teamUserIds)})
          AND c.status = 'BLOCKED'
        ORDER BY c.priority = 'URGENT' DESC, c.priority = 'HIGH' DESC, c.updated_at DESC
        LIMIT 20
      `;

      // Overdue work in manager's portfolio
      const overdueWork = await sql`
        SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.status, c.priority, c.due_date,
               u_ass.full_name AS assigned_to_name
        FROM school_onboarding_checklists c
        LEFT JOIN schools sc ON sc.id = c.school_id
        LEFT JOIN internal_users u_ass ON c.assigned_to = u_ass.id
        WHERE (c.supervising_manager_id = ${userId} OR c.assigned_to IN ${sql(teamUserIds)})
          AND c.due_date < NOW()
          AND c.status NOT IN ('COMPLETED', 'NOT_APPLICABLE')
        ORDER BY c.due_date ASC
        LIMIT 20
      `;

      // Unassigned work across team's assigned schools
      const assignedSchoolIds = req.user.assignedSchoolIds || [];
      let unassignedWork = [];
      if (assignedSchoolIds.length > 0) {
        unassignedWork = await sql`
          SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.priority, c.due_date
          FROM school_onboarding_checklists c
          LEFT JOIN schools sc ON sc.id = c.school_id
          WHERE c.school_id IN ${sql(assignedSchoolIds)}
            AND c.assigned_to IS NULL
            AND c.status NOT IN ('COMPLETED', 'NOT_APPLICABLE')
          ORDER BY c.created_at DESC
          LIMIT 20
        `;
      }

      return sendResponse(res, 200, {
        success: true,
        data: {
          role: userRole,
          workspaceType: 'MANAGER',
          teamWorkload: directReports,
          blockersRequiringReview: blockers,
          overdueWork,
          unassignedWork,
          counts: {
            directReportsCount: directReports.length,
            blockersCount: blockers.length,
            overdueCount: overdueWork.length,
            unassignedCount: unassignedWork.length,
          }
        },
      });
    }

    // 3. Executive Workspace View (Sales Executive, Implementation Executive, Support Executive, etc.)
    const mySchools = await sql`
      SELECT s.school_id, sc.name, sc.code, sc.address, sc.contact_name, sc.contact_phone, sc.is_active
      FROM internal_user_schools s
      LEFT JOIN schools sc ON sc.id = s.school_id
      WHERE s.user_id = ${userId}
      ORDER BY sc.name ASC
    `;

    const myWorkToday = await sql`
      SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.category, c.status,
             c.priority, c.due_date, c.instructions, c.next_action
      FROM school_onboarding_checklists c
      LEFT JOIN schools sc ON sc.id = c.school_id
      WHERE c.assigned_to = ${userId}
        AND c.status IN ('NOT_STARTED', 'IN_PROGRESS')
        AND (c.due_date::date <= CURRENT_DATE OR c.due_date IS NULL)
      ORDER BY c.priority = 'URGENT' DESC, c.priority = 'HIGH' DESC, c.due_date ASC NULLS LAST
      LIMIT 30
    `;

    const overdueWork = await sql`
      SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.status, c.priority, c.due_date, c.instructions
      FROM school_onboarding_checklists c
      LEFT JOIN schools sc ON sc.id = c.school_id
      WHERE c.assigned_to = ${userId}
        AND c.due_date < NOW()
        AND c.status NOT IN ('COMPLETED', 'NOT_APPLICABLE')
      ORDER BY c.due_date ASC
      LIMIT 20
    `;

    const blockedWork = await sql`
      SELECT c.id, c.school_id, sc.name AS school_name, c.task_key, c.title, c.status, c.blocker_reason, c.next_action, c.priority, c.due_date
      FROM school_onboarding_checklists c
      LEFT JOIN schools sc ON sc.id = c.school_id
      WHERE c.assigned_to = ${userId}
        AND c.status = 'BLOCKED'
      ORDER BY c.updated_at DESC
      LIMIT 20
    `;

    const [supervisorRow] = await sql`
      SELECT m.id, m.full_name, m.role, m.email, m.phone
      FROM internal_users u
      LEFT JOIN internal_users m ON u.manager_id = m.id
      WHERE u.id = ${userId}
      LIMIT 1
    `;

    return sendResponse(res, 200, {
      success: true,
      data: {
        role: userRole,
        workspaceType: 'EXECUTIVE',
        supervisor: supervisorRow?.id ? supervisorRow : null,
        myWorkToday,
        overdueWork,
        blockedWork,
        assignedSchools: mySchools,
        counts: {
          myWorkTodayCount: myWorkToday.length,
          overdueCount: overdueWork.length,
          blockedCount: blockedWork.length,
          assignedSchoolsCount: mySchools.length,
        },
      },
    });
  } catch (err) {
    console.error('Error fetching workspace summary:', err);
    return res.status(500).json({ error: 'Failed to fetch workspace summary' });
  }
});

module.exports = router;
