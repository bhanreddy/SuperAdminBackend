function requireCrmWrite(req, res, next) {
  const actor = req.superAdmin;
  if (actor?.isSuperAdmin || actor?.founderRole === 'FOUNDER') return next();
  return res.status(403).json({ error: 'CRM write access requires Founder or Super Admin role' });
}

function requirePlatformAdmin(req, res, next) {
  if (req.superAdmin?.isSuperAdmin === true) return next();
  return res.status(403).json({ error: 'This action requires Super Admin', code: 'PLATFORM_REQUIRED' });
}

function requireOrgSettings(req, res, next) {
  const actor = req.superAdmin;
  if (actor?.isSuperAdmin === true || actor?.founderRole === 'APPROVER') return next();
  return res.status(403).json({ error: 'Organization settings require Approver or Super Admin', code: 'SETTINGS_DENIED' });
}

function requireFinanceApproval(req, res, next) {
  const actor = req.superAdmin;
  if (actor?.isSuperAdmin || actor?.founderRole === 'APPROVER') return next();
  return res.status(403).json({ error: 'Approval access requires Approver or Super Admin role' });
}

module.exports = { requireCrmWrite, requireFinanceApproval, requirePlatformAdmin, requireOrgSettings };
