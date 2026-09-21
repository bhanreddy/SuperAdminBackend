const express = require('express');
const sql = require('../../config/db');
const { schoolSupabase, schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser } = require('../../middleware/rbac');
const { ROLES, getEffectivePermissions } = require('../../config/rbac');
const { verifyPassword, hashPassword } = require('../../utils/passwords');
const { logAudit } = require('../../services/auditLogger');
const {
  createSession,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
} = require('../../services/sessionService');
const { allocateFounderEmployeeId } = require('../../services/founderSync');

const router = express.Router();

function normalizeInput(val) {
  if (!val || typeof val !== 'string') return '';
  return val.trim();
}

// POST /api/super-admin/auth/login
router.post('/login', async (req, res) => {
  try {
    const rawIdentifier = req.body.identifier || req.body.email;
    const password = req.body.password;

    if (!rawIdentifier || !password) {
      return res.status(400).json({ error: 'Email, phone, or employee ID and password are required' });
    }

    const identifier = normalizeInput(rawIdentifier);
    const identifierLower = identifier.toLowerCase();
    const identifierUpper = identifier.toUpperCase();

    // 1. Look up user in internal_users
    const [internalUser] = await sql`
      SELECT id, auth_user_id, employee_id, full_name, email, phone, password_hash,
             role, manager_id, territory, status, token_version
      FROM internal_users
      WHERE LOWER(TRIM(email)) = ${identifierLower}
         OR phone = ${identifier}
         OR UPPER(TRIM(employee_id)) = ${identifierUpper}
      LIMIT 1
    `;

    let user = internalUser;
    let verifiedAuthUserId = internalUser?.auth_user_id || null;

    // 2. Fallback to super_admins or founders if not yet in internal_users
    if (!user) {
      const [sa] = await sql`
        SELECT id, email, full_name, is_active FROM super_admins
        WHERE LOWER(TRIM(email)) = ${identifierLower}
        LIMIT 1
      `;
      const [founder] = sa ? [] : await sql`
        SELECT user_id AS id, email, full_name, is_active
        FROM founders
        WHERE LOWER(TRIM(email)) = ${identifierLower}
        LIMIT 1
      `;
      const legacyFounder = sa || founder;
      if (legacyFounder) {
        const founderEmpId = await allocateFounderEmployeeId(legacyFounder.email);
        user = {
          id: legacyFounder.id,
          auth_user_id: legacyFounder.id,
          employee_id: founderEmpId,
          full_name: legacyFounder.full_name || 'Super Admin',
          email: legacyFounder.email,
          role: ROLES.FOUNDER,
          status: legacyFounder.is_active ? 'ACTIVE' : 'INACTIVE',
          password_hash: null,
          manager_id: null,
          territory: 'Global',
          token_version: 0,
        };
      }
    }

    if (!user) {
      await logAudit({
        action: 'FAILED_LOGIN',
        entity: 'AUTH',
        details: { identifier, reason: 'User not found' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Status check: deactivated accounts lose access immediately
    if (user.status !== 'ACTIVE') {
      await logAudit({
        userId: user.id,
        action: 'FAILED_LOGIN',
        entity: 'AUTH',
        details: { identifier, reason: `Account status is ${user.status}` },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(403).json({
        error: `Access denied. Account is ${user.status.toLowerCase()}. Please contact administrator.`,
      });
    }

    // Verify credentials
    let passwordValid = false;

    // Check hashed password in database if present
    if (user.password_hash) {
      passwordValid = verifyPassword(password, user.password_hash);
    }

    // Fallback or secondary check with Supabase Auth
    if (!passwordValid && user.email) {
      try {
        const { data: sbData, error: sbErr } = await schoolSupabase.auth.signInWithPassword({
          email: user.email,
          password,
        });
        if (!sbErr && sbData?.user) {
          passwordValid = true;
          verifiedAuthUserId = sbData.user.id;
          // Update password hash locally for offline resilience
          const newHash = hashPassword(password);
          if (internalUser) {
            await sql`
              UPDATE internal_users
              SET password_hash = ${newHash}, auth_user_id = ${sbData.user.id}
              WHERE id = ${user.id}
            `;
          }
        }
      } catch {
        // Supabase check failed
      }
    }

    if (!passwordValid) {
      await logAudit({
        userId: user.id,
        action: 'FAILED_LOGIN',
        entity: 'AUTH',
        details: { identifier, reason: 'Incorrect password' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Promote a verified legacy founder into the unified internal directory so
    // all subsequent sessions use the same RBAC and revocation architecture.
    if (!internalUser) {
      const localHash = hashPassword(password);
      const targetEmpId = user.employee_id || (await allocateFounderEmployeeId(user.email));
      [user] = await sql`
        INSERT INTO internal_users (
          id, auth_user_id, employee_id, full_name, email, password_hash,
          role, territory, status
        ) VALUES (
          ${user.id}, ${verifiedAuthUserId || user.id}, ${targetEmpId}, ${user.full_name},
          ${String(user.email).toLowerCase()}, ${localHash}, 'FOUNDER', 'Global', 'ACTIVE'
        )
        ON CONFLICT (email) DO UPDATE SET
          auth_user_id = COALESCE(internal_users.auth_user_id, EXCLUDED.auth_user_id),
          password_hash = EXCLUDED.password_hash,
          role = 'FOUNDER',
          status = 'ACTIVE',
          updated_at = NOW()
        RETURNING id, auth_user_id, employee_id, full_name, email, phone,
                  role, manager_id, territory, status, token_version
      `;
    }

    // Fetch assigned schools
    const schoolRows = await sql`
      WITH RECURSIVE reports AS (
        SELECT id FROM internal_users WHERE id = ${user.id}
        UNION ALL
        SELECT u.id FROM internal_users u JOIN reports r ON u.manager_id = r.id
        WHERE u.status = 'ACTIVE'
      )
      SELECT DISTINCT school_id FROM internal_user_schools
      WHERE user_id IN (SELECT id FROM reports)
    `;
    const assignedSchoolIds = schoolRows.map((r) => Number(r.school_id));

    // Update last_login
    await sql`UPDATE internal_users SET last_login = NOW() WHERE id = ${user.id}`;

    const session = await createSession(user, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Record login audit log
    await logAudit({
      userId: user.id,
      action: 'LOGIN',
      entity: 'AUTH',
      entityId: user.id,
      details: {
        role: user.role,
        employeeId: user.employee_id,
        assignedSchools: assignedSchoolIds,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const isFounder = user.role === ROLES.FOUNDER || user.role === ROLES.SUPER_ADMIN;
    const overrides = await sql`
      SELECT permission, effect FROM internal_user_permission_overrides WHERE user_id = ${user.id}
    `;
    const permissions = getEffectivePermissions(user.role, overrides);

    return sendResponse(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        fullName: user.full_name,
        employee_id: user.employee_id,
        employeeId: user.employee_id,
        phone: user.phone,
        role: user.role,
        status: user.status,
        manager_id: user.manager_id,
        territory: user.territory,
      },
      session,
      role: user.role,
      permissions,
      assignedSchools: assignedSchoolIds,
      isSuperAdmin: isFounder,
      admin: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_active: true,
      },
      founder: isFounder ? {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_active: true,
      } : null,
    });
  } catch (err) {
    console.error('[login] Error:', err);
    return res.status(500).json({ error: 'Internal server error during login' });
  }
});

// GET /api/super-admin/auth/me
router.get('/me', authenticateUser, async (req, res) => {
  try {
    return sendResponse(res, 200, {
      user: req.user,
      role: req.user.role,
      permissions: req.user.permissions,
      assignedSchools: req.user.assignedSchoolIds,
      isSuperAdmin: req.user.isFounder,
      admin: {
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.fullName,
        role: req.user.role,
        is_active: true,
      },
      founder: req.user.isFounder ? {
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.fullName,
        role: req.user.role,
        is_active: true,
      } : null,
    });
  } catch (err) {
    console.error('Error in /auth/me:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /api/super-admin/auth/logout
router.post('/logout', authenticateUser, async (req, res) => {
  try {
    await revokeSession(req.user.sessionId, req.user.id);
    await logAudit({
      userId: req.user.id,
      action: 'LOGOUT',
      entity: 'AUTH',
      entityId: req.user.id,
      details: { role: req.user.role, employeeId: req.user.employeeId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendResponse(res, 200, { success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('Error in /auth/logout:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

// POST /api/super-admin/auth/change-password
router.post('/change-password', authenticateUser, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const newHash = hashPassword(newPassword);
    await sql`
      UPDATE internal_users
      SET password_hash = ${newHash}, updated_at = NOW()
      WHERE id = ${req.user.id}
    `;

    // Also update Supabase auth user if exists
    try {
      await schoolSupabaseAdmin.auth.admin.updateUserById(req.user.authUserId || req.user.id, { password: newPassword });
    } catch {
      // ignore
    }

    await logAudit({
      userId: req.user.id,
      action: 'PASSWORD_RESET',
      entity: 'USER',
      entityId: req.user.id,
      details: { selfReset: true },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await revokeAllUserSessions(req.user.id);

    return sendResponse(res, 200, { success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Error changing password:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

// POST /api/super-admin/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }

    const session = await rotateSession(refresh_token, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!session) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return sendResponse(res, 200, session);
  } catch (err) {
    console.error('Error refreshing session:', err);
    return res.status(500).json({ error: 'Failed to refresh session' });
  }
});

module.exports = router;
