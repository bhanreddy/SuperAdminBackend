const express = require('express');
const sql = require('../../config/db');
const { sendResponse, sendError } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireSchoolAccess } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');
const { getFeature, resolveCatalog, STUDENT_ROLE } = require('../../config/featureRegistry');

const router = express.Router();

/** Load override rows for a school as { feature_key: enabled }. */
async function loadOverrides(schoolId) {
  const rows = await sql`
    SELECT feature_key, enabled
    FROM school_feature_flags
    WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE}
  `;
  return rows.reduce((acc, r) => {
    acc[r.feature_key] = r.enabled;
    return acc;
  }, {});
}

/**
 * Write-permission gate: super_admins can always write; founders can write only
 * when role = 'FOUNDER'. APPROVER founders are read-only. Returns null if
 * allowed, or an { status, error } object to reject with.
 */
async function checkCanWrite(actorId, actorEmail) {
  const email = (actorEmail || '').trim().toLowerCase();

  const [superAdmin] = await sql`
    SELECT id FROM super_admins
    WHERE (id = ${actorId} OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${email || '__missing__'}))
      AND is_active = true
    LIMIT 1
  `;
  if (superAdmin) return null;

  const [founder] = await sql`
    SELECT role FROM founders
    WHERE (user_id = ${actorId} OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${email || '__missing__'}))
      AND is_active = true
    LIMIT 1
  `;
  if (founder && String(founder.role).toUpperCase() === 'FOUNDER') return null;

  return { status: 403, error: 'Only a Founder can change feature flags (Approver is read-only)' };
}

/**
 * GET /api/super-admin/schools/:schoolId/features
 * Full catalog + effective state + default/overridden source for one school.
 * schoolId is admin-scoped (from the URL, under super-admin auth) — not a student JWT.
 */
router.get('/:schoolId/features', authenticateUser, requirePermission(PERMISSIONS.CONFIGS_READ), requireSchoolAccess('schoolId'), async (req, res) => {
  try {
    const schoolId = Number(req.params.schoolId);
    if (!Number.isInteger(schoolId) || schoolId <= 0) {
      return sendError(res, 400, 'Invalid schoolId');
    }

    const [school] = await sql`SELECT id FROM schools WHERE id = ${schoolId} LIMIT 1`;
    if (!school) return sendError(res, 404, 'School not found');

    const overrides = await loadOverrides(schoolId);
    return sendResponse(res, 200, { school_id: schoolId, features: resolveCatalog(overrides) });
  } catch (err) {
    console.error('Error loading school features:', err);
    return sendError(res, 500, 'Failed to load school features');
  }
});

/**
 * PUT /api/super-admin/schools/:schoolId/features/:featureKey
 * Body: { enabled: boolean }. Validates key, rejects non-toggleable keys,
 * writes an audit record (old -> new) BEFORE upserting the override row.
 */
router.put('/:schoolId/features/:featureKey', authenticateUser, requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('schoolId'), async (req, res) => {
  try {
    const schoolId = Number(req.params.schoolId);
    const { featureKey } = req.params;
    const { enabled } = req.body || {};

    if (!Number.isInteger(schoolId) || schoolId <= 0) {
      return sendError(res, 400, 'Invalid schoolId');
    }
    if (typeof enabled !== 'boolean') {
      return sendError(res, 400, 'enabled boolean is required in request body');
    }

    const feature = getFeature(featureKey);
    if (!feature) return sendError(res, 400, `Unknown feature key: ${featureKey}`);
    if (feature.toggleable === false) {
      return sendError(res, 400, `Feature ${featureKey} is core and cannot be toggled`);
    }

    // Role gate: Founder-only write.
    const denied = await checkCanWrite(req.superAdmin.id, req.superAdmin.email);
    if (denied) return sendError(res, denied.status, denied.error);

    const [school] = await sql`SELECT id FROM schools WHERE id = ${schoolId} LIMIT 1`;
    if (!school) return sendError(res, 404, 'School not found');

    // Resolve the current effective value (override row or registry default) for old->new.
    const [existing] = await sql`
      SELECT enabled FROM school_feature_flags
      WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE} AND feature_key = ${featureKey}
      LIMIT 1
    `;
    const oldValue = existing ? existing.enabled : feature.default_enabled;

    // ── AUDIT BEFORE MUTATE ──────────────────────────────────────────────────
    await sql`
      INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
      VALUES (
        'school_feature_flag',
        'UPDATE',
        ${req.superAdmin.id},
        ${sql.json({
          school_id: schoolId,
          role: STUDENT_ROLE,
          feature_key: featureKey,
          old: oldValue,
          new: enabled,
          actor_email: req.superAdmin.email || null,
        })}
      )
    `;

    // ── UPSERT OVERRIDE ──────────────────────────────────────────────────────
    await sql`
      INSERT INTO school_feature_flags (school_id, role, feature_key, enabled, updated_by, updated_at)
      VALUES (${schoolId}, ${STUDENT_ROLE}, ${featureKey}, ${enabled}, ${req.superAdmin.id}, now())
      ON CONFLICT (school_id, role, feature_key)
      DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
    `;

    return sendResponse(res, 200, {
      school_id: schoolId,
      feature_key: featureKey,
      enabled,
      source: 'overridden',
    });
  } catch (err) {
    console.error('Error updating school feature flag:', err);
    return sendError(res, 500, 'Failed to update feature flag');
  }
});

/**
 * DELETE /api/super-admin/schools/:schoolId/features/:featureKey
 * Reset a flag to its registry default by removing the override row.
 * Audits (old effective -> registry default) BEFORE the delete.
 */
router.delete('/:schoolId/features/:featureKey', authenticateUser, requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('schoolId'), async (req, res) => {
  try {
    const schoolId = Number(req.params.schoolId);
    const { featureKey } = req.params;

    if (!Number.isInteger(schoolId) || schoolId <= 0) {
      return sendError(res, 400, 'Invalid schoolId');
    }

    const feature = getFeature(featureKey);
    if (!feature) return sendError(res, 400, `Unknown feature key: ${featureKey}`);

    // Role gate: Founder-only write.
    const denied = await checkCanWrite(req.superAdmin.id, req.superAdmin.email);
    if (denied) return sendError(res, denied.status, denied.error);

    const [existing] = await sql`
      SELECT enabled FROM school_feature_flags
      WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE} AND feature_key = ${featureKey}
      LIMIT 1
    `;
    if (!existing) {
      // Already on default — nothing to reset.
      return sendResponse(res, 200, {
        school_id: schoolId,
        feature_key: featureKey,
        enabled: feature.default_enabled,
        source: 'default',
      });
    }

    // ── AUDIT BEFORE MUTATE ──────────────────────────────────────────────────
    await sql`
      INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
      VALUES (
        'school_feature_flag',
        'RESET',
        ${req.superAdmin.id},
        ${sql.json({
          school_id: schoolId,
          role: STUDENT_ROLE,
          feature_key: featureKey,
          old: existing.enabled,
          new: feature.default_enabled,
          actor_email: req.superAdmin.email || null,
        })}
      )
    `;

    await sql`
      DELETE FROM school_feature_flags
      WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE} AND feature_key = ${featureKey}
    `;

    return sendResponse(res, 200, {
      school_id: schoolId,
      feature_key: featureKey,
      enabled: feature.default_enabled,
      source: 'default',
    });
  } catch (err) {
    console.error('Error resetting school feature flag:', err);
    return sendError(res, 500, 'Failed to reset feature flag');
  }
});

module.exports = router;
