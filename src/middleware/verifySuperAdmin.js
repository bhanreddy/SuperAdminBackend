const { authenticateUser } = require('./rbac');

/**
 * Backward-compatible founder-only guard for legacy SuperAdmin routes.
 * New multi-role routes use authenticateUser + requirePermission directly.
 */
function verifySuperAdminMiddleware(req, res, next) {
  return authenticateUser(req, res, () => {
    if (!req.user?.isFounder) {
      return res.status(403).json({ error: 'Founder / Super Admin access required' });
    }
    return next();
  });
}

module.exports = { verifySuperAdminMiddleware };
