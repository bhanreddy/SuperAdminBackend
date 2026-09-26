const { CrmError } = require('./errors');

/**
 * Copy founder identity labels into the CRM shadow directory.
 * Authentication stays in the School database. Auth user ids and founder ids
 * remain different columns; passwords and tokens are never selected.
 */
async function syncFounderDirectory(schoolSql, crmSql) {
  if (!schoolSql || !crmSql) throw new CrmError(500, 'Founder sync is not configured', 'SYNC_UNAVAILABLE');
  const [userColumn] = await schoolSql`
    SELECT 1 AS present FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'founders' AND column_name = 'user_id'
  `;
  const rows = userColumn
    ? await schoolSql`SELECT id, full_name, email, is_active, user_id FROM founders`
    : await schoolSql`SELECT id, full_name, email, is_active, NULL::uuid AS user_id FROM founders`;
  const ids = [];
  for (const row of rows) {
    ids.push(row.id);
    await crmSql`
      INSERT INTO founders (id, full_name, email, is_active, auth_user_id)
      VALUES (${row.id}, ${row.full_name || null}, ${row.email || null}, ${row.is_active !== false}, ${row.user_id || null})
      ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        is_active = EXCLUDED.is_active,
        auth_user_id = EXCLUDED.auth_user_id
    `;
  }
  if (ids.length === 0) {
    await crmSql`UPDATE founders SET is_active = false WHERE is_active = true`;
  } else {
    await crmSql`UPDATE founders SET is_active = false WHERE NOT (id = ANY(${ids}::uuid[]))`;
  }
  return { synced: ids.length };
}

async function assertActiveFounder(crmSql, founderId) {
  if (!founderId) throw new CrmError(400, 'An active owner is required', 'OWNER_REQUIRED');
  const [row] = await crmSql`
    SELECT id, is_active FROM founders WHERE id = ${founderId}
  `;
  if (!row || row.is_active !== true) {
    throw new CrmError(400, 'Owner must be an active founder', 'OWNER_INACTIVE');
  }
  return row;
}

module.exports = { syncFounderDirectory, assertActiveFounder };
