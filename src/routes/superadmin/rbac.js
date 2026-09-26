const express = require('express');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { requirePlatformAdmin } = require('../../middleware/crmAccess');
const { sendResponse } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');
const sql = require('../../config/db');

const router = express.Router();

// Platform super admins only. Founder console tokens must not change school authorization.
router.use(verifySuperAdminMiddleware);
router.use(requirePlatformAdmin);

/**
 * GET /api/super-admin/rbac/pilot-status
 * Operational visibility into RBAC V2 Pilot for School 1.
 */
router.get('/pilot-status', asyncHandler(async (req, res) => {
  const [config] = await sql`
    SELECT * FROM public.rbac_pilot_config WHERE school_id = 1 LIMIT 1;
  `;

  const [assignmentStats] = await sql`
    SELECT 
      count(*) FILTER (WHERE school_id = 1) as school_1_assignments,
      count(*) FILTER (WHERE school_id != 1) as non_pilot_assignments
    FROM public.rbac_user_role_assignments;
  `;

  const [auditStats] = await sql`
    SELECT 
      count(*) FILTER (WHERE action = 'SHADOW_MATCH') as shadow_matches,
      count(*) FILTER (WHERE action = 'SHADOW_MISMATCH') as shadow_mismatches,
      count(*) FILTER (WHERE action = 'AUTHORIZATION_ALLOWED') as enforced_allows,
      count(*) FILTER (WHERE action = 'AUTHORIZATION_DENIED') as enforced_denies,
      count(*) FILTER (WHERE action = 'CROSS_TENANT_DENIED') as cross_tenant_denies
    FROM public.rbac_audit_logs
    WHERE school_id = 1;
  `;

  return sendResponse(res, 200, {
    success: true,
    pilot: {
      authorized_pilot_school_id: 1,
      school_name: 'Default School',
      mode: config?.mode || 'SHADOW',
      enforce_school_1: Boolean(config?.enforce_school_1),
      activated_at: config?.activated_at,
      zero_blast_radius_status: Number(assignmentStats?.non_pilot_assignments || 0) === 0 ? 'VERIFIED_ZERO_BLAST' : 'ALERT_CONTAMINATED',
    },
    metrics: {
      school_1_assignments: Number(assignmentStats?.school_1_assignments || 0),
      non_pilot_assignments: Number(assignmentStats?.non_pilot_assignments || 0),
      shadow_matches: Number(auditStats?.shadow_matches || 0),
      shadow_mismatches: Number(auditStats?.shadow_mismatches || 0),
      enforced_allows: Number(auditStats?.enforced_allows || 0),
      enforced_denies: Number(auditStats?.enforced_denies || 0),
      cross_tenant_denies: Number(auditStats?.cross_tenant_denies || 0),
    },
  });
}));

/**
 * GET /api/super-admin/rbac/roles
 * Lists all canonical RBAC V2 roles.
 */
router.get('/roles', asyncHandler(async (req, res) => {
  const roles = await sql`
    SELECT id, code, name, category, description, is_system, is_active
    FROM public.rbac_roles
    ORDER BY category, code;
  `;
  return sendResponse(res, 200, { success: true, data: roles });
}));

/**
 * GET /api/super-admin/rbac/permissions
 * Lists all atomic domain permissions.
 */
router.get('/permissions', asyncHandler(async (req, res) => {
  const permissions = await sql`
    SELECT id, code, domain, resource, action, risk_level, description
    FROM public.rbac_permissions
    ORDER BY domain, resource, action;
  `;
  return sendResponse(res, 200, { success: true, data: permissions });
}));

/**
 * GET /api/super-admin/rbac/assignments
 * Lists active role assignments for School 1.
 */
router.get('/assignments', asyncHandler(async (req, res) => {
  const assignments = await sql`
    SELECT 
      ura.id,
      ura.user_id,
      ura.school_id,
      ura.scope_type,
      ura.scope_id,
      ura.status,
      ura.valid_from,
      ura.valid_until,
      r.code as role_code,
      r.name as role_name,
      r.category as role_category
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
    WHERE ura.school_id = 1
    ORDER BY r.code, ura.created_at;
  `;
  return sendResponse(res, 200, { success: true, count: assignments.length, data: assignments });
}));

/**
 * GET /api/super-admin/rbac/audit-logs
 * Paginated forensic audit logs for School 1 pilot.
 */
router.get('/audit-logs', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const offset = Number(req.query.offset || 0);

  const logs = await sql`
    SELECT 
      id,
      actor_id,
      school_id,
      action,
      permission_code,
      resource_type,
      resource_id,
      decision,
      reason,
      legacy_decision,
      rbac_v2_decision,
      request_id,
      created_at
    FROM public.rbac_audit_logs
    WHERE school_id = 1
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset};
  `;

  return sendResponse(res, 200, { success: true, data: logs });
}));

/**
 * POST /api/super-admin/rbac/kill-switch
 * EMERGENCY ROLLBACK: Reverts School 1 from ENFORCED back to SHADOW mode in < 5 seconds.
 */
router.post('/kill-switch', asyncHandler(async (req, res) => {
  const { reason } = req.body || {};

  await sql`
    UPDATE public.rbac_pilot_config
    SET 
      mode = 'SHADOW',
      enforce_school_1 = false,
      notes = ${`Kill Switch activated: ${reason || 'Operator invoked rollback'}`},
      updated_at = now()
    WHERE school_id = 1;
  `;

  // Log critical action
  await sql`
    INSERT INTO public.rbac_audit_logs (
      school_id, action, decision, reason, metadata
    ) VALUES (
      1, 'KILL_SWITCH_ACTIVATED', 'ALLOW',
      ${reason || 'Operator invoked rollback via control plane'},
      ${sql.json({ initiated_by: req.superAdmin?.id || 'SUPER_ADMIN' })}
    );
  `;

  return sendResponse(res, 200, {
    success: true,
    message: 'KILL SWITCH ENGAGED: School 1 reverted to SHADOW mode. Legacy authorization restored.',
    pilot_status: { mode: 'SHADOW', enforce_school_1: false },
  });
}));

/**
 * POST /api/super-admin/rbac/enforce
 * Switches School 1 into ENFORCED mode.
 * STRICT PILOT CONSTRAINT: Cannot enforce for any school except school_id = 1!
 */
router.post('/enforce', asyncHandler(async (req, res) => {
  const { targetSchoolId = 1, confirmation } = req.body || {};

  if (Number(targetSchoolId) !== 1) {
    return sendResponse(res, 403, {
      error: 'CRITICAL PILOT VIOLATION: RBAC V2 can ONLY be piloted for School ID 1. Expansion forbidden.',
      code: 'PILOT_EXPANSION_FORBIDDEN',
    });
  }

  if (confirmation !== 'ENFORCE_SCHOOL_1') {
    return sendResponse(res, 400, {
      error: 'Explicit confirmation required. Send confirmation: "ENFORCE_SCHOOL_1"',
    });
  }

  await sql`
    UPDATE public.rbac_pilot_config
    SET 
      mode = 'ENFORCED',
      enforce_school_1 = true,
      activated_at = now(),
      activated_by = ${req.superAdmin?.id || 'SUPER_ADMIN'},
      notes = 'RBAC V2 actively enforced for School 1 pilot',
      updated_at = now()
    WHERE school_id = 1;
  `;

  await sql`
    INSERT INTO public.rbac_audit_logs (
      school_id, action, decision, reason, metadata
    ) VALUES (
      1, 'PILOT_ENFORCEMENT_ENABLED', 'ALLOW',
      'RBAC V2 enforcement enabled for School 1 pilot',
      ${sql.json({ initiated_by: req.superAdmin?.id || 'SUPER_ADMIN' })}
    );
  `;

  return sendResponse(res, 200, {
    success: true,
    message: 'RBAC V2 ENFORCED for School ID 1. Non-pilot schools remain 100% on legacy authorization.',
    pilot_status: { mode: 'ENFORCED', enforce_school_1: true },
  });
}));

module.exports = router;
