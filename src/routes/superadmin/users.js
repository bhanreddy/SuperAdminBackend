const express = require('express');
const sql = require('../../config/db');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireAnyPermission } = require('../../middleware/rbac');
const {
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLES,
  normalizeRole,
  getEffectivePermissions,
  canManageRole,
} = require('../../config/rbac');
const { hashPassword } = require('../../utils/passwords');
const { logAudit } = require('../../services/auditLogger');
const { revokeAllUserSessions } = require('../../services/sessionService');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(authenticateUser);

function canReadTarget(actor, target) {
  return Boolean(
    actor.isFounder ||
    actor.permissions.includes(PERMISSIONS.USERS_MANAGE) ||
    target.id === actor.id ||
    target.manager_id === actor.id
  );
}

function isKnownRole(role) {
  return Object.values(ROLES).includes(normalizeRole(role));
}

function isRootRole(role) {
  const norm = normalizeRole(role);
  return norm === ROLES.FOUNDER || norm === ROLES.SUPER_ADMIN;
}

async function wouldCreateReportingCycle(userId, candidateManagerId) {
  if (!userId || !candidateManagerId) return false;
  if (String(userId).toLowerCase() === String(candidateManagerId).toLowerCase()) return true;
  try {
    const rows = await sql`
      WITH RECURSIVE upstream AS (
        SELECT id, manager_id FROM internal_users WHERE id = ${candidateManagerId}
        UNION ALL
        SELECT u.id, u.manager_id
        FROM internal_users u
        JOIN upstream up ON u.id = up.manager_id
      )
      SELECT id FROM upstream WHERE id = ${userId} LIMIT 1
    `;
    return rows.length > 0;
  } catch (err) {
    console.error('[wouldCreateReportingCycle] Error:', err);
    return false;
  }
}

// GET /api/super-admin/users
// List internal team members with assigned schools count, manager details
router.get('/', requireAnyPermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_READ_TEAM), async (req, res) => {
  try {
    const { role, status, search, manager_id } = req.query;

    let rows = await sql`
      SELECT 
        u.id, u.employee_id, u.full_name, u.email, u.phone, u.role, u.job_title, u.status,
        u.territory, u.manager_id, u.last_login, u.created_at, u.updated_at,
        m.full_name AS manager_name,
        m.employee_id AS manager_employee_id,
        COALESCE(
          (SELECT json_agg(s.school_id) FROM internal_user_schools s WHERE s.user_id = u.id),
          '[]'::json
        ) AS assigned_school_ids,
        COALESCE(
          (SELECT COUNT(*)::int FROM internal_user_schools s WHERE s.user_id = u.id),
          0
        ) AS assigned_schools_count,
        COALESCE(
          (SELECT COUNT(*)::int FROM internal_users r WHERE r.manager_id = u.id AND r.status = 'ACTIVE'),
          0
        ) AS direct_reports_count
      FROM internal_users u
      LEFT JOIN internal_users m ON u.manager_id = m.id
      WHERE (1=1)
        ${!req.user.isFounder && !req.user.permissions.includes(PERMISSIONS.USERS_MANAGE)
          ? sql`AND (u.manager_id = ${req.user.id} OR u.id = ${req.user.id})`
          : sql``}
        ${role ? sql`AND u.role = ${normalizeRole(role)}` : sql``}
        ${status ? sql`AND u.status = ${String(status).toUpperCase()}` : sql``}
        ${manager_id ? sql`AND u.manager_id = ${manager_id}` : sql``}
        ${search ? sql`AND (
          LOWER(u.full_name) LIKE ${'%' + String(search).toLowerCase() + '%'} OR
          LOWER(u.email) LIKE ${'%' + String(search).toLowerCase() + '%'} OR
          UPPER(u.employee_id) LIKE ${'%' + String(search).toUpperCase() + '%'} OR
          LOWER(COALESCE(u.job_title, '')) LIKE ${'%' + String(search).toLowerCase() + '%'}
        )` : sql``}
      ORDER BY u.created_at DESC
    `;

    return sendResponse(res, 200, { success: true, data: rows });
  } catch (err) {
    console.error('Error fetching users:', err);
    return res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// GET /api/super-admin/users/hierarchy
// Returns reporting structure: Founders -> Managers -> Executives, direct Founder executives, and unassigned/legacy
router.get('/hierarchy', requireAnyPermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_READ_TEAM), async (req, res) => {
  try {
    const users = await sql`
      SELECT 
        u.id, u.employee_id, u.full_name, u.email, u.phone, u.role, u.job_title,
        u.manager_id, u.status, u.territory,
        m.full_name AS manager_name,
        COALESCE(
          (SELECT COUNT(*)::int FROM internal_user_schools s WHERE s.user_id = u.id),
          0
        ) AS assigned_schools_count,
        COALESCE(
          (SELECT COUNT(*)::int FROM internal_users r WHERE r.manager_id = u.id AND r.status = 'ACTIVE'),
          0
        ) AS direct_reports_count
      FROM internal_users u
      LEFT JOIN internal_users m ON u.manager_id = m.id
      WHERE ${req.user.isFounder || req.user.permissions.includes(PERMISSIONS.USERS_MANAGE)
        ? sql`TRUE`
        : sql`u.id = ${req.user.id} OR u.manager_id = ${req.user.id}`}
      ORDER BY u.role ASC, u.full_name ASC
    `;

    const founders = users.filter((u) => isRootRole(u.role));
    const founderIds = new Set(founders.map((f) => f.id));
    const managers = users.filter((u) => u.role.endsWith('_MANAGER'));

    const managerTrees = managers.map((mgr) => {
      const subordinates = users.filter((e) => e.manager_id === mgr.id);
      return {
        manager: mgr,
        executives: subordinates,
      };
    });

    const directExecutives = users.filter((u) => !isRootRole(u.role) && !u.role.endsWith('_MANAGER') && founderIds.has(u.manager_id));
    const activeUserIds = new Set(users.map((u) => u.id));
    const unassignedExecutives = users.filter((u) => !isRootRole(u.role) && (!u.manager_id || !activeUserIds.has(u.manager_id)));

    return sendResponse(res, 200, {
      success: true,
      data: {
        founders,
        hierarchy: managerTrees,
        directExecutives,
        unassignedExecutives,
        legacyUnmanagedCount: unassignedExecutives.length,
      },
    });
  } catch (err) {
    console.error('Error fetching hierarchy:', err);
    return res.status(500).json({ error: 'Failed to fetch hierarchy' });
  }
});

router.get('/permissions/catalog', requirePermission(PERMISSIONS.USERS_MANAGE), async (_req, res) => {
  return sendResponse(res, 200, { success: true, data: ALL_PERMISSIONS });
});

router.get('/:id/permissions', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const [target] = await sql`SELECT id, role FROM internal_users WHERE id = ${req.params.id} LIMIT 1`;
    if (!target) return res.status(404).json({ error: 'User not found' });
    const overrides = await sql`
      SELECT permission, effect, changed_at
      FROM internal_user_permission_overrides
      WHERE user_id = ${target.id}
      ORDER BY permission
    `;
    return sendResponse(res, 200, {
      success: true,
      data: {
        role: target.role,
        overrides,
        effectivePermissions: getEffectivePermissions(target.role, overrides),
      },
    });
  } catch (err) {
    console.error('Error fetching permission overrides:', err);
    return res.status(500).json({ error: 'Failed to fetch permission overrides' });
  }
});

router.put('/:id/permissions', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user id' });
    const overrides = Array.isArray(req.body.overrides) ? req.body.overrides : null;
    if (!overrides) return res.status(400).json({ error: 'overrides must be an array' });
    if (overrides.some((item) =>
      !item || !ALL_PERMISSIONS.includes(item.permission) || !['GRANT', 'DENY'].includes(String(item.effect).toUpperCase())
    )) {
      return res.status(400).json({ error: 'One or more permission overrides are invalid' });
    }

    const [target] = await sql`SELECT id, employee_id, role FROM internal_users WHERE id = ${req.params.id} LIMIT 1`;
    if (!target) return res.status(404).json({ error: 'User not found' });
    if ([ROLES.FOUNDER, ROLES.SUPER_ADMIN].includes(target.role)) {
      return res.status(400).json({ error: 'Founder permissions cannot be restricted' });
    }

    await sql.begin(async (tx) => {
      await tx`DELETE FROM internal_user_permission_overrides WHERE user_id = ${target.id}`;
      for (const item of overrides) {
        await tx`
          INSERT INTO internal_user_permission_overrides (
            user_id, permission, effect, changed_by
          ) VALUES (
            ${target.id}, ${item.permission}, ${String(item.effect).toUpperCase()}, ${req.user.id}
          )
        `;
      }
    });

    const saved = await sql`
      SELECT permission, effect, changed_at
      FROM internal_user_permission_overrides
      WHERE user_id = ${target.id}
      ORDER BY permission
    `;
    await logAudit({
      userId: req.user.id,
      action: 'PERMISSION_CHANGED',
      entity: 'USER',
      entityId: target.id,
      details: { targetEmployeeId: target.employee_id, overrides: saved },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return sendResponse(res, 200, {
      success: true,
      data: { overrides: saved, effectivePermissions: getEffectivePermissions(target.role, saved) },
    });
  } catch (err) {
    console.error('Error updating permission overrides:', err);
    return res.status(500).json({ error: 'Failed to update permission overrides' });
  }
});

// GET /api/super-admin/users/:id
router.get('/:id', requireAnyPermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_READ_TEAM), async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid user id' });
    const [user] = await sql`
      SELECT 
        u.id, u.employee_id, u.full_name, u.email, u.phone, u.role, u.job_title, u.status,
        u.territory, u.manager_id, u.last_login, u.created_at, u.updated_at,
        m.full_name AS manager_name,
        m.employee_id AS manager_employee_id,
        COALESCE(
          (SELECT json_agg(s.school_id) FROM internal_user_schools s WHERE s.user_id = u.id),
          '[]'::json
        ) AS assigned_school_ids
      FROM internal_users u
      LEFT JOIN internal_users m ON u.manager_id = m.id
      WHERE u.id = ${id}
      LIMIT 1
    `;

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!canReadTarget(req.user, user)) return res.status(403).json({ error: 'User is outside your team scope' });

    return sendResponse(res, 200, { success: true, data: user });
  } catch (err) {
    console.error('Error fetching user:', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// GET /api/super-admin/users/:id/impact
// Returns impact of deactivating or reassigning a user: direct reports, assigned schools, open tasks, supervised tasks
router.get('/:id/impact', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid user id' });

    const [user] = await sql`
      SELECT id, employee_id, full_name, role, status FROM internal_users WHERE id = ${id} LIMIT 1
    `;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const directReports = await sql`
      SELECT id, employee_id, full_name, role, status FROM internal_users
      WHERE manager_id = ${id} AND status = 'ACTIVE'
      ORDER BY full_name ASC
    `;

    const assignedSchools = await sql`
      SELECT s.school_id, sc.name AS school_name, sc.city, s.assigned_at
      FROM internal_user_schools s
      LEFT JOIN schools sc ON sc.id = s.school_id
      WHERE s.user_id = ${id}
      ORDER BY s.assigned_at DESC
    `;

    const openTasks = await sql`
      SELECT id, school_id, item_text, status, priority, due_date, instructions
      FROM school_onboarding_checklists
      WHERE assigned_to = ${id} AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')
      ORDER BY due_date ASC NULLS LAST, created_at DESC
    `;

    const supervisedTasks = await sql`
      SELECT id, school_id, item_text, status, priority, due_date, assigned_to
      FROM school_onboarding_checklists
      WHERE supervising_manager_id = ${id} AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')
      ORDER BY due_date ASC NULLS LAST, created_at DESC
    `;

    const hasActiveWork = directReports.length > 0 || assignedSchools.length > 0 || openTasks.length > 0 || supervisedTasks.length > 0;

    return sendResponse(res, 200, {
      success: true,
      data: {
        user,
        directReports,
        assignedSchools,
        openTasks,
        supervisedTasks,
        hasActiveWork,
        counts: {
          directReports: directReports.length,
          assignedSchools: assignedSchools.length,
          openTasks: openTasks.length,
          supervisedTasks: supervisedTasks.length,
        }
      }
    });
  } catch (err) {
    console.error('Error fetching user impact:', err);
    return res.status(500).json({ error: 'Failed to fetch user impact' });
  }
});

// POST /api/super-admin/users/:id/deactivate
// Deactivate an employee with explicit reassignment of direct reports, schools, and open tasks
router.post('/:id/deactivate', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid user id' });

    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    const [user] = await sql`SELECT * FROM internal_users WHERE id = ${id} LIMIT 1`;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status === 'INACTIVE') {
      return res.status(400).json({ error: 'User is already inactive' });
    }

    // Guard: last active founder
    if (isRootRole(user.role)) {
      const [founderCheck] = await sql`
        SELECT COUNT(*)::int AS count FROM internal_users
        WHERE status = 'ACTIVE' AND role IN (${ROLES.FOUNDER}, ${ROLES.SUPER_ADMIN}) AND id <> ${id}
      `;
      if (!founderCheck.count) {
        return res.status(400).json({ error: 'Cannot remove access from the last active Founder' });
      }
    }

    const {
      reassign_reports_to,
      reassign_schools_to,
      reassign_tasks_to,
      reassign_supervision_to,
      reason = 'Employee deactivation',
    } = req.body;

    // Check responsibilities that would be orphaned
    const directReports = await sql`
      SELECT id, role, full_name FROM internal_users WHERE manager_id = ${id} AND status = 'ACTIVE'
    `;
    const assignedSchools = await sql`
      SELECT school_id FROM internal_user_schools WHERE user_id = ${id}
    `;
    const openTasks = await sql`
      SELECT id FROM school_onboarding_checklists WHERE assigned_to = ${id} AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')
    `;
    const supervisedTasks = await sql`
      SELECT id FROM school_onboarding_checklists WHERE supervising_manager_id = ${id} AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')
    `;

    // Validation: Require explicit transfer decisions if work/reports exist
    if (directReports.length > 0 && !reassign_reports_to) {
      return res.status(400).json({
        error: `Cannot deactivate: user has ${directReports.length} direct report(s). Specify reassign_reports_to to transfer team management.`,
        pendingResponsibilities: { directReports: directReports.length }
      });
    }

    if (assignedSchools.length > 0 && !reassign_schools_to) {
      return res.status(400).json({
        error: `Cannot deactivate: user is assigned to ${assignedSchools.length} school(s). Specify reassign_schools_to to transfer school assignments.`,
        pendingResponsibilities: { assignedSchools: assignedSchools.length }
      });
    }

    if (openTasks.length > 0 && !reassign_tasks_to) {
      return res.status(400).json({
        error: `Cannot deactivate: user has ${openTasks.length} open work item(s). Specify reassign_tasks_to to transfer accountability.`,
        pendingResponsibilities: { openTasks: openTasks.length }
      });
    }

    if (supervisedTasks.length > 0 && !reassign_supervision_to) {
      return res.status(400).json({
        error: `Cannot deactivate: user is supervising ${supervisedTasks.length} open work item(s). Specify reassign_supervision_to to transfer supervision.`,
        pendingResponsibilities: { supervisedTasks: supervisedTasks.length }
      });
    }

    // Validate target managers / employees if provided
    let newReportsManager = null;
    if (reassign_reports_to) {
      if (!UUID_RE.test(reassign_reports_to) || reassign_reports_to === id) {
        return res.status(400).json({ error: 'Invalid reassign_reports_to target' });
      }
      [newReportsManager] = await sql`SELECT id, role, status, full_name FROM internal_users WHERE id = ${reassign_reports_to} LIMIT 1`;
      if (!newReportsManager || newReportsManager.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Target manager for direct reports is not active' });
      }
      for (const rep of directReports) {
        if (!canManageRole(newReportsManager.role, rep.role)) {
          return res.status(400).json({
            error: `Target manager (${newReportsManager.full_name}, ${newReportsManager.role}) cannot manage direct report (${rep.full_name}, ${rep.role})`
          });
        }
      }
    }

    if (reassign_schools_to) {
      if (!UUID_RE.test(reassign_schools_to) || reassign_schools_to === id) {
        return res.status(400).json({ error: 'Invalid reassign_schools_to target' });
      }
      const [newSchoolAssignee] = await sql`SELECT id, role, status FROM internal_users WHERE id = ${reassign_schools_to} LIMIT 1`;
      if (!newSchoolAssignee || newSchoolAssignee.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Target employee for school reassignment is not active' });
      }
    }

    if (reassign_tasks_to) {
      if (!UUID_RE.test(reassign_tasks_to) || reassign_tasks_to === id) {
        return res.status(400).json({ error: 'Invalid reassign_tasks_to target' });
      }
      const [newTaskAssignee] = await sql`SELECT id, role, status FROM internal_users WHERE id = ${reassign_tasks_to} LIMIT 1`;
      if (!newTaskAssignee || newTaskAssignee.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Target employee for task reassignment is not active' });
      }
    }

    if (reassign_supervision_to) {
      if (!UUID_RE.test(reassign_supervision_to) || reassign_supervision_to === id) {
        return res.status(400).json({ error: 'Invalid reassign_supervision_to target' });
      }
      const [newSupervisor] = await sql`SELECT id, role, status FROM internal_users WHERE id = ${reassign_supervision_to} LIMIT 1`;
      if (!newSupervisor || newSupervisor.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Target supervisor is not active' });
      }
    }

    // Execute atomic deactivation transaction
    await sql.begin(async (tx) => {
      // 1. Reassign direct reports
      if (directReports.length > 0 && reassign_reports_to) {
        await tx`
          UPDATE internal_users
          SET manager_id = ${reassign_reports_to}, updated_at = NOW()
          WHERE manager_id = ${id} AND status = 'ACTIVE'
        `;
      }

      // 2. Reassign schools
      if (assignedSchools.length > 0 && reassign_schools_to) {
        for (const s of assignedSchools) {
          await tx`
            INSERT INTO internal_user_schools (user_id, school_id, assigned_by)
            VALUES (${reassign_schools_to}, ${s.school_id}, ${req.user.id})
            ON CONFLICT DO NOTHING
          `;
        }
        await tx`DELETE FROM internal_user_schools WHERE user_id = ${id}`;
      }

      // 3. Reassign open tasks
      if (openTasks.length > 0 && reassign_tasks_to) {
        await tx`
          UPDATE school_onboarding_checklists
          SET assigned_to = ${reassign_tasks_to}, updated_at = NOW()
          WHERE assigned_to = ${id} AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')
        `;
      }

      // 4. Reassign supervised tasks
      if (supervisedTasks.length > 0 && reassign_supervision_to) {
        await tx`
          UPDATE school_onboarding_checklists
          SET supervising_manager_id = ${reassign_supervision_to}, updated_at = NOW()
          WHERE supervising_manager_id = ${id} AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')
        `;
      }

      // 5. Deactivate user and increment token_version to immediately invalidate sessions
      await tx`
        UPDATE internal_users
        SET status = 'INACTIVE', token_version = token_version + 1, updated_at = NOW()
        WHERE id = ${id}
      `;
    });

    // Invalidate sessions
    await revokeAllUserSessions(id);

    // Audit log
    await logAudit({
      userId: req.user.id,
      action: 'USER_DEACTIVATED_WITH_REASSIGNMENT',
      entity: 'USER',
      entityId: id,
      details: {
        deactivatedEmployeeId: user.employee_id,
        reason,
        transferredReportsCount: directReports.length,
        transferredReportsTo: reassign_reports_to || null,
        transferredSchoolsCount: assignedSchools.length,
        transferredSchoolsTo: reassign_schools_to || null,
        transferredTasksCount: openTasks.length,
        transferredTasksTo: reassign_tasks_to || null,
        transferredSupervisionCount: supervisedTasks.length,
        transferredSupervisionTo: reassign_supervision_to || null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendResponse(res, 200, {
      success: true,
      message: 'User deactivated and responsibilities successfully transferred',
      transfers: {
        directReports: directReports.length,
        assignedSchools: assignedSchools.length,
        openTasks: openTasks.length,
        supervisedTasks: supervisedTasks.length,
      }
    });
  } catch (err) {
    console.error('Error deactivating user:', err);
    return res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// POST /api/super-admin/users
// Create new team account (Full Name, Employee ID, Phone, Email, Password, Role, Job Title, Manager, Territory, Status)
router.post('/', requirePermission(PERMISSIONS.USERS_CREATE), async (req, res) => {
  try {
    const {
      full_name,
      employee_id,
      phone,
      email,
      password,
      role,
      job_title,
      manager_id,
      territory,
      status = 'ACTIVE',
      assigned_schools = [],
    } = req.body;

    if (!full_name || full_name.trim().length < 2) {
      return res.status(400).json({ error: 'Full name must be at least 2 characters' });
    }
    if (!employee_id || employee_id.trim().length < 2) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    const normEmail = email.trim().toLowerCase();
    const normEmployeeId = employee_id.trim().toUpperCase();
    const normRole = normalizeRole(role);
    if (!isKnownRole(normRole)) return res.status(400).json({ error: 'Unknown role' });

    // Enforce reporting manager for active non-root employees
    if (status === 'ACTIVE' && !isRootRole(normRole)) {
      if (!manager_id) {
        return res.status(400).json({ error: 'Active non-root employees must have a reporting manager' });
      }
    }

    if (manager_id) {
      if (!UUID_RE.test(manager_id)) return res.status(400).json({ error: 'Invalid manager id' });
      const [manager] = await sql`SELECT id, role, status FROM internal_users WHERE id = ${manager_id} LIMIT 1`;
      if (!manager || manager.status !== 'ACTIVE' || !canManageRole(manager.role, normRole)) {
        return res.status(400).json({ error: 'Manager role is not valid for the selected user role' });
      }
    }
    const validStatus = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'INVITED'].includes(status)
      ? status
      : 'ACTIVE';

    // Check duplicate
    const [existing] = await sql`
      SELECT id, email, employee_id FROM internal_users
      WHERE LOWER(email) = ${normEmail} OR UPPER(employee_id) = ${normEmployeeId}
      LIMIT 1
    `;
    if (existing) {
      if (existing.email.toLowerCase() === normEmail) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      return res.status(409).json({ error: 'An account with this employee ID already exists' });
    }

    const pwdHash = hashPassword(password);

    // Create Supabase Auth user if available
    let authUserId = null;
    try {
      const { data: authData, error: authErr } = await schoolSupabaseAdmin.auth.admin.createUser({
        email: normEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name, employee_id: normEmployeeId, role: normRole, job_title: job_title || null },
      });
      if (!authErr && authData?.user) {
        authUserId = authData.user.id;
      }
    } catch (e) {
      console.warn('[users.create] Supabase auth user create notice:', e.message);
    }

    const [newUser] = await sql`
      INSERT INTO internal_users (
        auth_user_id, full_name, employee_id, email, phone, password_hash,
        role, job_title, manager_id, territory, status, created_by
      ) VALUES (
        ${authUserId}, ${full_name.trim()}, ${normEmployeeId}, ${normEmail},
        ${phone || null}, ${pwdHash}, ${normRole}, ${job_title?.trim() || null}, ${manager_id || null},
        ${territory || null}, ${validStatus}, ${req.user.id}
      )
      RETURNING id, employee_id, full_name, email, phone, role, job_title, manager_id, territory, status, created_at
    `;

    // Assign initial schools if provided
    if (Array.isArray(assigned_schools) && assigned_schools.length > 0) {
      for (const sId of assigned_schools) {
        await sql`
          INSERT INTO internal_user_schools (user_id, school_id, assigned_by)
          VALUES (${newUser.id}, ${Number(sId)}, ${req.user.id})
          ON CONFLICT DO NOTHING
        `;
      }
    }

    await logAudit({
      userId: req.user.id,
      action: 'USER_CREATED',
      entity: 'USER',
      entityId: newUser.id,
      details: {
        createdUserId: newUser.id,
        employeeId: newUser.employee_id,
        role: newUser.role,
        jobTitle: newUser.job_title,
        managerId: newUser.manager_id,
        assignedSchools: assigned_schools,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendResponse(res, 201, { success: true, data: newUser });
  } catch (err) {
    console.error('Error creating user:', err);
    return res.status(500).json({ error: 'Failed to create user account' });
  }
});

// PATCH /api/super-admin/users/:id
// Edit user details, change role, manager, territory, job_title, or disable/reactivate status
router.patch('/:id', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid user id' });
    const { full_name, phone, role, job_title, manager_id, territory, status } = req.body;

    const [existing] = await sql`SELECT * FROM internal_users WHERE id = ${id} LIMIT 1`;
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Guard: Prevent disabling own account
    if (id === req.user.id && status && status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    // Guard: Prevent changing own role or manager
    if (id === req.user.id && role !== undefined && normalizeRole(role) !== existing.role) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    if (id === req.user.id && manager_id !== undefined && manager_id !== existing.manager_id) {
      return res.status(400).json({ error: 'Cannot change your own reporting manager' });
    }

    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name.trim();
    if (phone !== undefined) updates.phone = phone;
    if (role !== undefined) updates.role = normalizeRole(role);
    if (role !== undefined && !isKnownRole(updates.role)) {
      return res.status(400).json({ error: 'Unknown role' });
    }
    if (job_title !== undefined) updates.job_title = job_title ? job_title.trim() : null;
    if (manager_id !== undefined) updates.manager_id = manager_id || null;
    if (territory !== undefined) updates.territory = territory || null;
    if (status !== undefined) {
      const normStatus = String(status).toUpperCase();
      if (!['ACTIVE', 'INACTIVE', 'SUSPENDED', 'INVITED'].includes(normStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.status = normStatus;
    }

    const updatedFullName = updates.full_name !== undefined ? updates.full_name : existing.full_name;
    const updatedPhone = updates.phone !== undefined ? updates.phone : existing.phone;
    const updatedRole = updates.role !== undefined ? updates.role : existing.role;
    const updatedJobTitle = updates.job_title !== undefined ? updates.job_title : existing.job_title;
    const updatedManagerId = updates.manager_id !== undefined ? updates.manager_id : existing.manager_id;
    const updatedTerritory = updates.territory !== undefined ? updates.territory : existing.territory;
    const updatedStatus = updates.status !== undefined ? updates.status : existing.status;

    // Enforce reporting manager for active non-root employees
    if (updatedStatus === 'ACTIVE' && !isRootRole(updatedRole)) {
      if (!updatedManagerId) {
        return res.status(400).json({ error: 'Active non-root employees must have a reporting manager' });
      }
    }

    if (updatedManagerId) {
      if (!UUID_RE.test(updatedManagerId) || updatedManagerId === id) {
        return res.status(400).json({ error: 'Invalid manager id: cannot be self or malformed' });
      }
      const isCycle = await wouldCreateReportingCycle(id, updatedManagerId);
      if (isCycle) {
        return res.status(400).json({ error: 'Invalid reporting hierarchy: would create a circular reporting loop or self-reporting' });
      }
      const [manager] = await sql`SELECT id, role, status FROM internal_users WHERE id = ${updatedManagerId} LIMIT 1`;
      if (!manager || manager.status !== 'ACTIVE' || !canManageRole(manager.role, updatedRole)) {
        return res.status(400).json({ error: 'Manager role is not valid for the selected user role' });
      }
    }

    // Role change revalidation: check existing direct reports can still be supervised by new role
    if (updates.role && updates.role !== existing.role) {
      const directReports = await sql`
        SELECT id, employee_id, full_name, role FROM internal_users
        WHERE manager_id = ${id} AND status = 'ACTIVE'
      `;
      for (const rep of directReports) {
        if (!canManageRole(updatedRole, rep.role)) {
          return res.status(400).json({
            error: `Cannot change role: user currently manages ${rep.full_name} (${rep.role}), which cannot be managed by ${updatedRole}. Reassign direct reports first.`
          });
        }
      }
    }

    // Guard: Protection against disabling or demoting the last active platform administrator
    const removesFounderAccess =
      isRootRole(existing.role) &&
      (!['ACTIVE'].includes(updatedStatus) || !isRootRole(updatedRole));
    if (removesFounderAccess) {
      const [row] = await sql`
        SELECT COUNT(*)::int AS count FROM internal_users
        WHERE status = 'ACTIVE' AND role IN (${ROLES.FOUNDER}, ${ROLES.SUPER_ADMIN}) AND id <> ${id}
      `;
      if (!row.count) return res.status(400).json({ error: 'Cannot remove access from the last active Founder' });
    }

    // Should invalidate token session if security critical field changed
    const needsTokenBump = updates.status || updates.role || updates.manager_id;

    const [updated] = await sql`
      UPDATE internal_users
      SET
        full_name = ${updatedFullName},
        phone = ${updatedPhone},
        role = ${updatedRole},
        job_title = ${updatedJobTitle},
        manager_id = ${updatedManagerId},
        territory = ${updatedTerritory},
        status = ${updatedStatus},
        token_version = ${needsTokenBump ? sql`token_version + 1` : sql`token_version`},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, employee_id, full_name, email, phone, role, job_title, manager_id, territory, status, updated_at
    `;

    // Audit log
    let auditAction = 'USER_UPDATED';
    if (updates.status && updates.status !== existing.status) {
      auditAction = updates.status === 'ACTIVE' ? 'USER_REACTIVATED' : 'USER_DISABLED';
    } else if (updates.role && updates.role !== existing.role) {
      auditAction = 'USER_ROLE_CHANGED';
    } else if (updates.manager_id && updates.manager_id !== existing.manager_id) {
      auditAction = 'USER_MANAGER_REASSIGNED';
    }

    await logAudit({
      userId: req.user.id,
      action: auditAction,
      entity: 'USER',
      entityId: id,
      details: {
        targetEmployeeId: existing.employee_id,
        previousState: { role: existing.role, status: existing.status, manager_id: existing.manager_id },
        newState: updates,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (needsTokenBump) await revokeAllUserSessions(id);
    return sendResponse(res, 200, { success: true, data: updated });
  } catch (err) {
    console.error('Error updating user:', err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/super-admin/users/:id/reset-password
router.post('/:id/reset-password', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;

    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const [user] = await sql`SELECT id, auth_user_id, employee_id, email FROM internal_users WHERE id = ${id} LIMIT 1`;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newHash = hashPassword(new_password);
    await sql`
      UPDATE internal_users
      SET password_hash = ${newHash}, updated_at = NOW()
      WHERE id = ${id}
    `;

    try {
      await schoolSupabaseAdmin.auth.admin.updateUserById(user.auth_user_id || id, { password: new_password });
    } catch {
      // ignore
    }

    await logAudit({
      userId: req.user.id,
      action: 'PASSWORD_RESET',
      entity: 'USER',
      entityId: id,
      details: { targetEmployeeId: user.employee_id, resetByAdmin: true },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await revokeAllUserSessions(id);

    return sendResponse(res, 200, { success: true, message: 'Password has been reset successfully' });
  } catch (err) {
    console.error('Error resetting password:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/super-admin/users/:id/schools
// Get assigned schools for a user
router.get('/:id/schools', requireAnyPermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_READ_TEAM), async (req, res) => {
  try {
    const { id } = req.params;
    const [target] = await sql`SELECT id, manager_id FROM internal_users WHERE id = ${id} LIMIT 1`;
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!canReadTarget(req.user, target)) return res.status(403).json({ error: 'User is outside your team scope' });
    const rows = await sql`
      SELECT s.school_id, s.assigned_at, s.assigned_by, u.full_name AS assigned_by_name
      FROM internal_user_schools s
      LEFT JOIN internal_users u ON s.assigned_by = u.id
      WHERE s.user_id = ${id}
      ORDER BY s.assigned_at DESC
    `;
    return sendResponse(res, 200, { success: true, data: rows });
  } catch (err) {
    console.error('Error fetching user schools:', err);
    return res.status(500).json({ error: 'Failed to fetch assigned schools' });
  }
});

// POST /api/super-admin/users/:id/schools
// Assign or update schools for a user (Requires schools.assign or Founder)
router.post('/:id/schools', requirePermission(PERMISSIONS.SCHOOLS_ASSIGN), async (req, res) => {
  try {
    const { id } = req.params;
    const { school_ids = [] } = req.body;

    const [targetUser] = await sql`
      SELECT id, employee_id, full_name, role, manager_id FROM internal_users WHERE id = ${id} LIMIT 1
    `;
    if (!targetUser) return res.status(404).json({ error: 'Target user not found' });
    if (!req.user.isFounder && (
      targetUser.manager_id !== req.user.id || !canManageRole(req.user.role, targetUser.role)
    )) {
      return res.status(403).json({ error: 'You can assign schools only to executives who report to you' });
    }

    // Fetch existing assigned schools
    const oldRows = await sql`
      SELECT school_id FROM internal_user_schools WHERE user_id = ${id}
    `;
    const oldIds = oldRows.map((r) => Number(r.school_id));
    const newIds = [...new Set(school_ids.map((s) => Number(s)))];
    if (newIds.some((idValue) => !Number.isInteger(idValue) || idValue <= 0)) {
      return res.status(400).json({ error: 'school_ids must contain valid positive integers' });
    }
    if (!req.user.isFounder && newIds.some((idValue) => !req.user.assignedSchoolIds.includes(idValue))) {
      return res.status(403).json({ error: 'Cannot assign a school outside your own portfolio' });
    }

    // Delete removed schools
    const removed = oldIds.filter((x) => !newIds.includes(x));
    if (removed.length > 0) {
      await sql`
        DELETE FROM internal_user_schools
        WHERE user_id = ${id} AND school_id IN ${sql(removed)}
      `;
    }

    // Insert added schools
    const added = newIds.filter((x) => !oldIds.includes(x));
    for (const addId of added) {
      await sql`
        INSERT INTO internal_user_schools (user_id, school_id, assigned_by)
        VALUES (${id}, ${addId}, ${req.user.id})
        ON CONFLICT DO NOTHING
      `;
    }

    // Audit log the assignment change
    await logAudit({
      userId: req.user.id,
      action: 'SCHOOL_ASSIGNMENT_CHANGED',
      entity: 'SCHOOL',
      details: {
        actorRole: req.user.role,
        actorEmployeeId: req.user.employeeId,
        targetUser: targetUser.full_name,
        targetEmployeeId: targetUser.employee_id,
        targetRole: targetUser.role,
        assignedSchoolIds: newIds,
        added,
        removed,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendResponse(res, 200, {
      success: true,
      message: 'School assignments updated',
      assignedSchoolIds: newIds,
    });
  } catch (err) {
    console.error('Error assigning schools:', err);
    return res.status(500).json({ error: 'Failed to update school assignments' });
  }
});

module.exports = router;
