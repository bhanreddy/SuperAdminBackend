const jwt = require('jsonwebtoken');
const sql = require('../../config/db');
const config = require('../../config/env');
const { authenticateUser } = require('../../middleware/rbac');
const {
  createConnectService,
  ConnectError,
} = require('../../services/connect/service');
const { createConnectRouter } = require('../../services/connect/router');
const {
  createConnectExtensions,
} = require('../../services/connect/extensions');
const { supabaseConnectStorage } = require('../../services/connect/files');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const service = createConnectService(sql);

module.exports = createConnectRouter({
  service,
  authenticate: authenticateUser,
  extensions: createConnectExtensions(
    service,
    supabaseConnectStorage(schoolSupabaseAdmin),
  ),
  async realtimeSession(user, context) {
    if (
      !config.schoolSupabase.jwtSecret ||
      !user.sessionId ||
      user.tokenSource !== 'internal'
    ) {
      throw new ConnectError(
        'Live updates are unavailable. Ask a company administrator to review Connect setup.',
        503,
      );
    }
    const [employee] =
      await sql`SELECT u.token_version FROM internal_users u JOIN internal_user_sessions s ON s.user_id=u.id
      WHERE u.id=${user.id} AND u.status='ACTIVE' AND s.id=${user.sessionId} AND s.revoked_at IS NULL AND s.expires_at>now()`;
    if (!employee) throw new ConnectError('Session is no longer active', 401);
    const token = jwt.sign(
      {
        sub: user.id,
        role: 'collaboration_realtime',
        aud: 'authenticated',
        purpose: 'nexsyrus-connect',
        sid: user.sessionId,
        tv: String(employee.token_version),
        organization_id: context.organization.id,
      },
      config.schoolSupabase.jwtSecret,
      { algorithm: 'HS256', expiresIn: 120 },
    );
    return {
      url: config.schoolSupabase.url,
      anon_key: config.schoolSupabase.anonKey,
      token,
      expires_in: 120,
    };
  },
});
