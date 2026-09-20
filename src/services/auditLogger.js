const sql = require('../config/db');

/**
 * Record an audit log entry in the PostgreSQL audit_logs table.
 * 
 * @param {Object} entry
 * @param {string} [entry.userId]
 * @param {string} entry.action (e.g. 'LOGIN', 'FAILED_LOGIN', 'LOGOUT', 'PASSWORD_RESET', 'USER_CREATED', 'USER_DISABLED', 'ROLE_CHANGED', 'SCHOOL_ASSIGNED')
 * @param {string} entry.entity (e.g. 'AUTH', 'USER', 'SCHOOL', 'CONFIG', 'BUILD')
 * @param {string} [entry.entityId]
 * @param {Object} [entry.details]
 * @param {string} [entry.ipAddress]
 * @param {string} [entry.userAgent]
 * @param {number} [entry.schoolId]
 */
async function logAudit({
  userId = null,
  action,
  entity,
  entityId = null,
  details = {},
  ipAddress = null,
  userAgent = null,
  schoolId = null,
}) {
  try {
    await sql`
      INSERT INTO audit_logs (
        user_id, action, entity, entity_id, details, ip_address, user_agent, school_id, created_at
      ) VALUES (
        ${userId},
        ${action},
        ${entity},
        ${entityId ? String(entityId) : null},
        ${sql.json(details || {})},
        ${ipAddress},
        ${userAgent},
        ${schoolId ? Number(schoolId) : null},
        NOW()
      )
    `;
  } catch (err) {
    console.error('[auditLogger] Failed to write audit log:', err.message);
  }
}

module.exports = { logAudit };
