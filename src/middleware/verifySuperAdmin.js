const jwt = require('jsonwebtoken');
const sql = require('../config/db');

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
    '   Without it, token verification falls back to a fast decode (no signature check).\n'
  );
}

/**
 * Decode/verify the JWT. If secret is configured, fully verifies the signature.
 * If not, does a fast payload-only decode (still checks expiry via the `exp` claim).
 */
function decodeToken(token) {
  if (JWT_SECRET) {
    // Full cryptographic verification — recommended for production
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  }
  // Fallback: decode without signature check but still guard expiry
  const payload = jwt.decode(token);
  if (!payload) throw new Error('Invalid token: cannot decode');
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  console.warn('[verifySuperAdmin] JWT signature NOT verified — set SCHOOL_SUPABASE_JWT_SECRET to enable it.');
  return payload;
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
      payload = decodeToken(token);
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
      SELECT id, is_active, email
      FROM super_admins
      WHERE id = ${userId}
         OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${userEmail || '__missing__'})
      LIMIT 1
    `;

    const [founderRow] = await sql`
      SELECT id, user_id, is_active, email
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
    req.superAdmin = { id: userId, email: activeRow.email || userEmail };
    next();
  } catch (err) {
    console.error('[verifySuperAdmin] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { verifySuperAdminMiddleware };
