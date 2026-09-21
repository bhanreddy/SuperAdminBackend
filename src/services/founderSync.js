const sql = require('../config/db');
const { ROLES } = require('../config/rbac');

/**
 * Dynamically allocates a unique employee ID for a founder/super-admin.
 * Follows the pattern 'FOUNDER-XXX'. If the email has a number (e.g. 25e002 -> 002),
 * attempts to assign 'FOUNDER-002' if not taken. Otherwise assigns the lowest unused
 * sequential number starting from 1.
 */
async function allocateFounderEmployeeId(email, sqlClient = sql) {
  const existingRows = await sqlClient`
    SELECT employee_id FROM internal_users
  `;
  const existingSet = new Set(
    existingRows.map((r) => String(r.employee_id || '').trim().toUpperCase())
  );

  const normEmail = String(email || '').toLowerCase().trim();
  const numMatch = normEmail.match(/(?:25e|founder[_-]?)(\d+)/i) || normEmail.match(/(\d+)/);
  if (numMatch) {
    const num = parseInt(numMatch[1].slice(-3), 10) || parseInt(numMatch[1], 10);
    if (num > 0) {
      const candidate = `FOUNDER-${String(num).padStart(3, '0')}`;
      if (!existingSet.has(candidate)) {
        return candidate;
      }
    }
  }

  let counter = 1;
  while (existingSet.has(`FOUNDER-${String(counter).padStart(3, '0')}`)) {
    counter++;
  }
  return `FOUNDER-${String(counter).padStart(3, '0')}`;
}

/**
 * Syncs any legacy super_admins or founders into the internal_users directory
 * so that unified sessions, RBAC, and credentials work seamlessly without collisions.
 */
async function syncLegacyFounders(sqlClient = sql) {
  try {
    const superAdmins = await sqlClient`
      SELECT id, email, full_name, is_active FROM super_admins
    `;
    const founders = await sqlClient`
      SELECT user_id AS id, email, full_name, is_active FROM founders WHERE user_id IS NOT NULL
    `;

    const allAdmins = [...superAdmins, ...founders];

    for (const admin of allAdmins) {
      if (!admin.email) continue;
      const normEmail = String(admin.email).toLowerCase().trim();

      const [existing] = await sqlClient`
        SELECT id, employee_id FROM internal_users
        WHERE LOWER(TRIM(email)) = ${normEmail}
           OR id = ${admin.id}
        LIMIT 1
      `;

      if (!existing) {
        const empId = await allocateFounderEmployeeId(normEmail, sqlClient);
        await sqlClient`
          INSERT INTO internal_users (
            id, auth_user_id, employee_id, full_name, email,
            role, territory, status
          ) VALUES (
            ${admin.id}, ${admin.id}, ${empId}, ${admin.full_name || 'Super Admin'},
            ${normEmail}, ${ROLES.FOUNDER}, 'Global',
            ${admin.is_active ? 'ACTIVE' : 'INACTIVE'}
          )
          ON CONFLICT (email) DO NOTHING
        `;
        console.log(`[founderSync] Synced legacy admin ${normEmail} as ${empId}`);
      }
    }
  } catch (err) {
    console.error('[founderSync] Sync notice:', err.message);
  }
}

module.exports = {
  allocateFounderEmployeeId,
  syncLegacyFounders,
};
