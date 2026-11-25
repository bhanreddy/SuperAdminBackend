const express = require('express');
const sql = require('../../config/db');
const { sendResponse, sendError } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireSchoolAccess } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');

const router = express.Router();

// Identity, account status and roles have already been verified by authenticateUser.
// Do not re-resolve workforce accounts against the legacy founders directory.
function checkCanWrite(actor) {
  const role = String(actor?.role || '').toUpperCase();
  if (['FOUNDER', 'SUPER_ADMIN'].includes(role) && actor?.founderRole !== 'APPROVER') return null;
  return { status: 403, error: 'Only a Founder or Superadmin can change school features' };
}

// Every operation uses the same authenticated, school-scoped permission chain.
const schoolFeatures = require('../../services/schoolFeatures');
const read = [authenticateUser, requirePermission(PERMISSIONS.CONFIGS_READ), requireSchoolAccess('schoolId')];
const write = [authenticateUser, requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('schoolId')];
const validSchoolId = req => Number.isSafeInteger(Number(req.params.schoolId)) && Number(req.params.schoolId) > 0;

router.use('/:schoolId/features', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (!validSchoolId(req)) return sendError(res, 400, 'Invalid schoolId');
  next();
});
router.get('/:schoolId/features', ...read, async (req, res) => {
  try {
    const schoolId = Number(req.params.schoolId);
    const [school] = await sql`SELECT id, name, code FROM schools WHERE id = ${schoolId} LIMIT 1`;
    if (!school) return sendError(res, 404, 'School not found');
    return sendResponse(res, 200, { school_id: schoolId, school, features: await schoolFeatures.catalog(schoolId) });
  } catch (err) {
    console.error('Error loading school features:', err);
    return sendError(res, 500, 'Failed to load school features');
  }
});
async function mutate(req, res, reset = false) {
  try {
    if (!reset && typeof req.body?.enabled !== 'boolean') return sendError(res, 400, 'enabled boolean is required');
    const denied = checkCanWrite(req.superAdmin);
    if (denied) return sendError(res, denied.status, denied.error);
    const schoolId = Number(req.params.schoolId);
    const features = await schoolFeatures.change(schoolId, req.params.featureKey ? [req.params.featureKey] : null,
      req.body?.enabled, req.superAdmin, reset);
    const key = req.params.featureKey;
    const feature = key && (features.find(f => f.key === key) || features.find(f => f.key === schoolFeatures.PORTAL_MODULES[key]));
    return sendResponse(res, 200, { school_id: schoolId, features,
      ...(feature ? { feature_key: key, enabled: feature.enabled, source: feature.source } : {}) });
  } catch (err) {
    console.error('Error updating school features:', err);
    return sendError(res, err.statusCode || 500, err.statusCode ? err.message : 'Failed to update school features');
  }
}
router.put('/:schoolId/features', ...write, (req, res) => mutate(req, res));
router.put('/:schoolId/features/:featureKey', ...write, (req, res) => mutate(req, res));
router.delete('/:schoolId/features/:featureKey', ...write, (req, res) => mutate(req, res, true));
module.exports = router;
