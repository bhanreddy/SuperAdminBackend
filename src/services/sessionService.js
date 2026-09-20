const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sql = require('../config/db');
const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } = require('../middleware/rbac');

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user, sessionId) {
  return jwt.sign(
    {
      sub: user.id,
      sid: sessionId,
      tv: Number(user.token_version || 0),
      email: user.email,
      role: user.role,
      employee_id: user.employee_id,
      full_name: user.full_name,
    },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

async function createSession(user, { ipAddress = null, userAgent = null } = {}) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const [session] = await sql`
    INSERT INTO internal_user_sessions (
      user_id, refresh_token_hash, expires_at, created_ip, user_agent
    ) VALUES (
      ${user.id}, ${hashRefreshToken(refreshToken)},
      NOW() + (${REFRESH_TOKEN_TTL_SECONDS} * INTERVAL '1 second'),
      ${ipAddress}, ${userAgent}
    )
    RETURNING id, expires_at
  `;

  return {
    access_token: signAccessToken(user, session.id),
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_expires_at: session.expires_at,
  };
}

async function rotateSession(refreshToken, { ipAddress = null, userAgent = null } = {}) {
  const refreshHash = hashRefreshToken(refreshToken);
  const [current] = await sql`
    SELECT s.id, s.user_id, u.email, u.full_name, u.employee_id, u.role,
           u.status, u.token_version
    FROM internal_user_sessions s
    JOIN internal_users u ON u.id = s.user_id
    WHERE s.refresh_token_hash = ${refreshHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
    LIMIT 1
  `;
  if (!current || current.status !== 'ACTIVE') return null;

  const nextRefreshToken = crypto.randomBytes(48).toString('base64url');
  const [updated] = await sql`
    UPDATE internal_user_sessions
    SET refresh_token_hash = ${hashRefreshToken(nextRefreshToken)},
        last_used_at = NOW(),
        created_ip = COALESCE(${ipAddress}, created_ip),
        user_agent = COALESCE(${userAgent}, user_agent)
    WHERE id = ${current.id}
      AND refresh_token_hash = ${refreshHash}
      AND revoked_at IS NULL
    RETURNING id, expires_at
  `;
  if (!updated) return null;

  return {
    access_token: signAccessToken(current, updated.id),
    refresh_token: nextRefreshToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_expires_at: updated.expires_at,
  };
}

async function revokeSession(sessionId, userId) {
  if (!sessionId) return;
  await sql`
    UPDATE internal_user_sessions
    SET revoked_at = COALESCE(revoked_at, NOW())
    WHERE id = ${sessionId} AND user_id = ${userId}
  `;
}

async function revokeAllUserSessions(userId) {
  await sql`
    UPDATE internal_user_sessions
    SET revoked_at = COALESCE(revoked_at, NOW())
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  createSession,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
};
