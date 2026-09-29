const jwt = require('jsonwebtoken');
const sql = require('../config/db');
const config = require('../config/env');
const { schoolSupabaseAdmin } = require('../config/supabase');
const { ROLES, getEffectivePermissions } = require('../config/rbac');

function getJwtSecret() {
  return (
    process.env.SUPERADMIN_JWT_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SCHOOL_SUPABASE_JWT_SECRET ||
    config.schoolSupabase.jwtSecret ||
    config.schoolSupabase.serviceRoleKey
  );
}
const JWT_SECRET = getJwtSecret();
const JWT_ISSUER = 'nexsyrus-superadmin';
const JWT_AUDIENCE = 'nexsyrus-superadmin-app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Verify an internal access JWT, or validate a legacy Supabase session. */
async function decodeToken(token) {
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return { ...payload, tokenSource: 'internal' };
  } catch {
    try {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
      return { ...payload, tokenSource: 'supabase' };
    } catch {
      // fall through to remote Supabase verification
    }
    const { data, error } = await schoolSupabaseAdmin.auth.getUser(token);
    if (!error && data?.user) {
      return {
        sub: data.user.id,
        email: data.user.email,
        ...(data.user.user_metadata || {}),
        tokenSource: 'supabase',
      };
    }
    throw new Error('Invalid or expired token');
  }
}

async function loadSchoolScope(userId, isFounder) {
  if (isFounder) return [];
  const rows = await sql`
    WITH RECURSIVE reports AS (
      SELECT id FROM internal_users WHERE id = ${userId}
      UNION ALL
      SELECT u.id
      FROM internal_users u
      JOIN reports r ON u.manager_id = r.id
      WHERE u.status = 'ACTIVE'
    )
    SELECT DISTINCT school_id
    FROM internal_user_schools
    WHERE user_id IN (SELECT id FROM reports)
  `;
  return rows.map((row) => Number(row.school_id)).filter(Number.isInteger);
}

/**
 * Authenticate from a server-validated token, then reload account status, role,
 * permission overrides and school scope from the database on every request.
 */
async function authenticateUser(req, res, next) {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ error: 'A valid Bearer token is required' });

    let payload;
    try {
      payload = await decodeToken(match[1]);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const userId = UUID_RE.test(String(payload.sub || '')) ? payload.sub : ZERO_UUID;
    const userEmail = String(payload.email || '').trim().toLowerCase();
    if (userId === ZERO_UUID && !userEmail) {
      return res.status(401).json({ error: 'Token is missing a valid user identity' });
    }

    let userRow = null;
    try {
      [userRow] = await sql`
        SELECT id, auth_user_id, employee_id, full_name, email, phone, role, status,
               manager_id, territory, token_version
        FROM internal_users
        WHERE id = ${userId}
           OR auth_user_id = ${userId}
           OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${userEmail || '__missing__'})
        LIMIT 1
      `;
    } catch {
      userRow = null;
    }

    if (userRow) {
      if (userRow.status !== 'ACTIVE') {
        return res.status(401).json({
          error: `Access denied. Account is ${String(userRow.status).toLowerCase()}. Please contact an administrator.`,
        });
      }

      if (payload.tokenSource === 'internal') {
        if (!UUID_RE.test(String(payload.sid || ''))) {
          return res.status(401).json({ error: 'Session is no longer valid' });
        }
        if (Number(payload.tv) !== Number(userRow.token_version || 0)) {
          return res.status(401).json({ error: 'Session was invalidated. Please sign in again.' });
        }
        const [session] = await sql`
          SELECT id
          FROM internal_user_sessions
          WHERE id = ${payload.sid}
            AND user_id = ${userRow.id}
            AND revoked_at IS NULL
            AND expires_at > NOW()
          LIMIT 1
        `;
        if (!session) return res.status(401).json({ error: 'Session is no longer valid' });
      }

      const normRole = String(userRow.role).toUpperCase();
      const isFounder = normRole === ROLES.FOUNDER || normRole === ROLES.SUPER_ADMIN;
      const overrides = await sql`
        SELECT permission, effect
        FROM internal_user_permission_overrides
        WHERE user_id = ${userRow.id}
      `;
      const permissions = getEffectivePermissions(normRole, overrides);
      const assignedSchoolIds = await loadSchoolScope(userRow.id, isFounder);

      req.user = {
        id: userRow.id,
        authUserId: userRow.auth_user_id,
        employeeId: userRow.employee_id,
        fullName: userRow.full_name,
        email: userRow.email,
        phone: userRow.phone,
        role: normRole,
        status: userRow.status,
        managerId: userRow.manager_id,
        territory: userRow.territory,
        permissions,
        assignedSchoolIds,
        isFounder,
        sessionId: payload.tokenSource === 'internal' ? payload.sid : null,
        tokenSource: payload.tokenSource,
      };
      req.superAdmin = {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        isSuperAdmin: isFounder,
        founderRole: isFounder ? 'FOUNDER' : null,
        role: normRole,
      };
      return next();
    }

    // Backward compatibility for founders who have not yet been synced into
    // internal_users. These sessions are still validated by Supabase.
    if (payload.tokenSource !== 'supabase') {
      return res.status(403).json({ error: 'Account not found' });
    }

    const [superAdminRow] = await sql`
      SELECT id, is_active, email, full_name
      FROM super_admins
      WHERE id = ${userId}
         OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${userEmail || '__missing__'})
      LIMIT 1
    `;
    const [founderRow] = await sql`
      SELECT id, user_id, is_active, email, full_name, role
      FROM founders
      WHERE user_id = ${userId}
         OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${userEmail || '__missing__'})
      LIMIT 1
    `;
    const activeRow = superAdminRow?.is_active ? superAdminRow : founderRow?.is_active ? founderRow : null;
    if (!activeRow) return res.status(403).json({ error: 'Account is inactive or not authorized' });

    const derivedEmployeeId =
      activeRow.employee_id ||
      (activeRow.email && activeRow.email.match(/(?:25e|founder[_-]?)(\d+)/i)
        ? `FOUNDER-${String(activeRow.email.match(/(?:25e|founder[_-]?)(\d+)/i)[1].slice(-3)).padStart(3, '0')}`
        : 'FOUNDER-001');

    req.user = {
      id: activeRow.user_id || activeRow.id || userId,
      employeeId: derivedEmployeeId,
      fullName: activeRow.full_name || 'Founder',
      email: activeRow.email || userEmail,
      role: ROLES.FOUNDER,
      status: 'ACTIVE',
      permissions: getEffectivePermissions(ROLES.FOUNDER),
      assignedSchoolIds: [],
      isFounder: true,
      sessionId: null,
      tokenSource: 'supabase',
    };
    const isPlatformAdmin = Boolean(superAdminRow?.is_active);
    req.superAdmin = {
      id: activeRow.user_id || activeRow.id || userId,
      email: activeRow.email || userEmail,
      fullName: activeRow.full_name || 'Founder',
      isSuperAdmin: isPlatformAdmin,
      founderRole: founderRow?.role || (isPlatformAdmin ? null : 'FOUNDER'),
      founderId: founderRow?.id || null,
      role: isPlatformAdmin ? ROLES.SUPER_ADMIN : (founderRow?.role || ROLES.FOUNDER),
    };
    return next();
  } catch (err) {
    console.error('[authenticateUser] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal authentication error' });
  }
}

function requirePermission(permission) {
  return requireAnyPermission(permission);
}

function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized: No active session' });
    if (req.user.isFounder || permissions.some((permission) => req.user.permissions.includes(permission))) {
      return next();
    }
    return res.status(403).json({
      error: `Permission denied. Requires one of: ${permissions.join(', ')}`,
      requiredPermissions: permissions,
      userRole: req.user.role,
    });
  };
}

function requireSchoolAccess(paramName = 'id') {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized: No active session' });
    if (req.user.isFounder || req.user.permissions.includes('schools.read.all')) return next();

    const rawId = req.params[paramName] ?? req.body?.school_id ?? req.query?.school_id;
    const targetSchoolId = Number(rawId);
    if (!Number.isInteger(targetSchoolId) || targetSchoolId <= 0) {
      return res.status(400).json({ error: 'Invalid or missing school id' });
    }
    if (req.user.assignedSchoolIds.includes(targetSchoolId)) return next();

    return res.status(403).json({
      error: `Access denied to School ID ${targetSchoolId}`,
      schoolId: targetSchoolId,
      userRole: req.user.role,
    });
  };
}

module.exports = {
  authenticateUser,
  requirePermission,
  requireAnyPermission,
  requireSchoolAccess,
  JWT_SECRET,
  JWT_ISSUER,
  JWT_AUDIENCE,
};
