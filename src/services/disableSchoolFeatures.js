const { FEATURE_REGISTRY, STUDENT_ROLE } = require('../config/featureRegistry');

/** Explicit, auditable rollout reset. Normal startup must never call this. */
async function disableAllSchools(db) {
  return db.begin(async tx => {
    const schools = await tx`SELECT id FROM schools ORDER BY id FOR UPDATE`;
    const modules = await tx`SELECT key FROM public.features WHERE key <> 'dashboard' ORDER BY key`;
    const portalKeys = FEATURE_REGISTRY.filter(f => f.toggleable).map(f => f.key);
    for (const school of schools) {
      const overrides = await tx`SELECT feature_key, enabled, reason, expires_at, updated_by
        FROM public.school_feature_overrides WHERE school_id = ${school.id}`;
      const flags = await tx`SELECT role, feature_key, enabled, updated_by
        FROM school_feature_flags WHERE school_id = ${school.id}`;
      // The same transaction retains the exact previous configuration for investigation/restoration.
      await tx`INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
        VALUES ('school_feature_policy', 'DISABLE_ALL', NULL,
          ${tx.json({ school_id: school.id, source: 'explicit_user_request',
            previous_school_overrides: overrides, previous_portal_flags: flags,
            modules_disabled: modules.length, portal_features_disabled: portalKeys.length })})`;
      await tx`INSERT INTO public.school_feature_overrides (school_id, feature_key, enabled, reason, expires_at, updated_by)
        SELECT ${school.id}, key, false, 'All optional features disabled at owner request', NULL, NULL
        FROM public.features WHERE key <> 'dashboard'
        ON CONFLICT (school_id, feature_key) DO UPDATE SET enabled = false, expires_at = NULL,
          reason = EXCLUDED.reason, updated_by = NULL, updated_at = now()`;
      // Include historical/unknown overrides so no old enable survives this operation.
      await tx`UPDATE public.school_feature_overrides SET enabled = false, expires_at = NULL, updated_at = now()
        WHERE school_id = ${school.id} AND feature_key <> 'dashboard'`;
      await tx`UPDATE school_feature_flags SET enabled = false, updated_at = now()
        WHERE school_id = ${school.id} AND feature_key <> 'nav.home'`;
      await tx`INSERT INTO school_feature_flags (school_id, role, feature_key, enabled, updated_by, updated_at)
        SELECT ${school.id}, ${STUDENT_ROLE}, value, false, NULL, now()
        FROM jsonb_array_elements_text(${tx.json(portalKeys)}::jsonb)
        ON CONFLICT (school_id, role, feature_key) DO UPDATE SET enabled = false, updated_by = NULL, updated_at = now()`;

    }
    const [remaining] = await tx`SELECT
      (SELECT count(*)::int FROM public.school_feature_overrides WHERE feature_key <> 'dashboard' AND enabled = true) AS modules,
      (SELECT count(*)::int FROM school_feature_flags WHERE feature_key <> 'nav.home' AND enabled = true) AS portal`;
    if (remaining.modules || remaining.portal) throw new Error('Disable-all verification failed');
    return { schools: schools.length, modules_per_school: modules.length,
      portal_features_per_school: portalKeys.length, remaining_enabled: remaining };
  });
}
module.exports = { disableAllSchools };
