const jwt = require('jsonwebtoken');
const sql = require('../config/db');
const { schoolSupabaseAdmin } = require('../config/supabase');

/**
 * Express middleware: verify Supabase JWT fully OFFLINE using the project's
 * JWT secret — zero network calls. Then confirm super_admin / founder role
 * via direct PostgreSQL query (also zero Supabase REST calls).
 *
 * This eliminates all ETIMEDOUT / FetchError issues caused by the Supabase
 * auth REST endpoint timing out under flaky network conditions.
 */

const JWT_SECRET = process.env.SCHOOL_SUPABASE_JWT_SECRET;

// Warn loudly at startup if the secret is missing
if (!JWT_SECRET) {
  console.warn(
    '\n⚠️  [verifySuperAdmin] SCHOOL_SUPABASE_JWT_SECRET is not set in .env!\n' +
    '   Get it from: Supabase Dashboard → Settings → API → JWT Secret\n' +
    '   Without it, token verification uses Supabase Auth and requires a network call.\n'
  );
}

/**
 * Decode/verify the JWT. If secret is configured, fully verifies the signature.
 * If not, asks Supabase Auth to verify the token. Never accept unsigned tokens.
 */
async function decodeToken(token) {
  if (JWT_SECRET) {
    // Full cryptographic verification — recommended for production
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  }
  const { data, error } = await schoolSupabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new Error(error?.message || 'Supabase rejected token');
  return {
    sub: data.user.id,
    email: data.user.email,
    ...(data.user.user_metadata || {}),
  };
}

const verifySuperAdminMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Malformed authorization header' });
    }

    // ── Step 1: Decode JWT locally (NO network call) ─────────────────────────
    let payload;
    try {
      payload = await decodeToken(token);
    } catch (jwtErr) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const userId = payload.sub;
    const userEmail = (payload.email || '').trim().toLowerCase();

    if (!userId) {
      return res.status(401).json({ error: 'Token missing user id' });
    }

    // ── Step 2: Role check via direct SQL (NO Supabase REST call) ────────────
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

    const isSuperAdminOK = superAdminRow && superAdminRow.is_active === true;
    const isFounderOK    = founderRow    && founderRow.is_active    === true;

    if (!isSuperAdminOK && !isFounderOK) {
      console.warn('[verify] 403 — user not found or deactivated. id:', userId, 'email:', userEmail);
      return res.status(403).json({ error: 'Access denied. Account is deactivated or not found.' });
    }

    const activeRow = superAdminRow || founderRow;
    req.superAdmin = {
      id: userId,
      email: activeRow.email || userEmail,
      fullName: activeRow.full_name || null,
      isSuperAdmin: Boolean(isSuperAdminOK),
      founderId: founderRow?.id || null,
      founderRole: founderRow?.role ? String(founderRow.role).toUpperCase() : null,
    };
    next();
  } catch (err) {
    console.error('[verifySuperAdmin] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { verifySuperAdminMiddleware };
