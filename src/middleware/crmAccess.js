function requireCrmWrite(req, res, next) {
  const actor = req.superAdmin;
  if (actor?.isSuperAdmin || actor?.founderRole === 'FOUNDER') return next();
  return res.status(403).json({ error: 'CRM write access requires Founder or Super Admin role' });
}

function requireFinanceApproval(req, res, next) {
  const actor = req.superAdmin;
  if (actor?.isSuperAdmin || actor?.founderRole === 'APPROVER') return next();
  return res.status(403).json({ error: 'Approval access requires Approver or Super Admin role' });
}

module.exports = { requireCrmWrite, requireFinanceApproval };
