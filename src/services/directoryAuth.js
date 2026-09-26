const MISSING_EMAIL = '__missing__';

function normalizeEmail(email) {
  const norm = String(email || '').trim().toLowerCase();
  return norm || MISSING_EMAIL;
}

/**
 * Request authorization binds only to the token subject.
 * An email match can identify an unbound founder invite. It cannot select a
 * row already linked to a different user, and an inactive link does not fall
 * through to another row that happens to share the email.
 */
async function resolveRequestActor(sql, userId, email) {
  const norm = normalizeEmail(email);
  const [superAdmin] = await sql`
    SELECT id, is_active, email, full_name
    FROM super_admins
    WHERE id = ${userId} AND is_active = true
    LIMIT 1
  `;

  const boundFounders = await sql`
    SELECT id, user_id, is_active, email, full_name, role
    FROM founders
    WHERE user_id = ${userId}
  `;
  let founder = null;
  if (boundFounders.length) {
    const active = boundFounders.filter((row) => row.is_active === true);
    founder = active.length === 1 ? active[0] : null;
  } else if (norm !== MISSING_EMAIL) {
    const unbound = await sql`
      SELECT id, user_id, is_active, email, full_name, role
      FROM founders
      WHERE user_id IS NULL
        AND is_active = true
        AND email IS NOT NULL
        AND LOWER(TRIM(email)) = ${norm}
    `;
    founder = unbound.length === 1 ? unbound[0] : null;
  }

  return { superAdmin: superAdmin || null, founder };
}

/**
 * First sign-in may claim a super-admin invite whose id is still a placeholder.
 * last_login is set in the same update so a second account cannot retarget it.
 */
async function claimUnusedSuperAdminByEmail(sql, userId, email) {
  const norm = normalizeEmail(email);
  if (norm === MISSING_EMAIL) return null;
  try {
    const matches = await sql`
      SELECT id
      FROM super_admins
      WHERE is_active = true
        AND last_login IS NULL
        AND email IS NOT NULL
        AND LOWER(TRIM(email)) = ${norm}
    `;
    if (matches.length !== 1) return null;
    const [updated] = await sql`
      UPDATE super_admins
      SET id = ${userId}, last_login = now()
      WHERE id = ${matches[0].id}
        AND is_active = true
        AND last_login IS NULL
      RETURNING id, is_active, email, full_name
    `;
    return updated || null;
  } catch (err) {
    console.error('[directoryAuth] unused super admin bind refused:', err.message);
    return null;
  }
}

async function claimUnboundFounder(sql, founderId, userId) {
  const [updated] = await sql`
    UPDATE founders
    SET user_id = ${userId}
    WHERE id = ${founderId}
      AND user_id IS NULL
      AND is_active = true
    RETURNING id, user_id, is_active, email, full_name, role
  `;
  return updated || null;
}

module.exports = {
  normalizeEmail,
  resolveRequestActor,
  claimUnusedSuperAdminByEmail,
  claimUnboundFounder,
};
