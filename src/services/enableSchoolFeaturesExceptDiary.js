const { FEATURE_REGISTRY, STUDENT_ROLE } = require('../config/featureRegistry');

/** Owner-requested rollout only; never call during normal startup. */
async function enableAllSchoolsExceptDiary(db, { includeDiary = false } = {}) {
  const portalKeys = FEATURE_REGISTRY.filter(f => f.toggleable).map(f => f.key);
  return db.begin(async tx => {
    const schools = await tx`SELECT id FROM schools ORDER BY id FOR UPDATE`;
    const ids = schools.map(s => s.id);
    const targets = tx.json(ids);
    const keys = tx.json(portalKeys);
    const modules = await tx`SELECT key FROM public.features WHERE key <> 'dashboard' ORDER BY key`;
    if (!modules.some(f => f.key === 'diary') || !portalKeys.includes('topbar.diary')) {
      throw new Error('Smart Diary keys missing from feature catalogs');
    }
    await tx`INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
      SELECT 'school_feature_policy', ${includeDiary ? 'ENABLE_ALL' : 'ENABLE_ALL_EXCEPT_DIARY'}, NULL,
        jsonb_build_object('school_id', s.id, 'source', 'explicit_user_request',
          'previous_school_overrides', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'feature_key', o.feature_key, 'enabled', o.enabled, 'reason', o.reason,
            'expires_at', o.expires_at, 'updated_by', o.updated_by))
            FROM public.school_feature_overrides o WHERE o.school_id = s.id), '[]'::jsonb),
          'previous_portal_flags', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'role', f.role, 'feature_key', f.feature_key, 'enabled', f.enabled, 'updated_by', f.updated_by))
            FROM school_feature_flags f WHERE f.school_id = s.id), '[]'::jsonb))
      FROM schools s WHERE s.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))`;
    await tx`INSERT INTO public.school_feature_overrides
      (school_id, feature_key, enabled, reason, expires_at, updated_by)
      SELECT s.id, f.key, (${includeDiary} OR f.key <> 'diary'),
        ${includeDiary ? 'Owner request: enable all including Smart Diary' : 'Owner request: enable all except Smart Diary'}, NULL, NULL
      FROM schools s CROSS JOIN public.features f
      WHERE s.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))
        AND f.key <> 'dashboard'
      ON CONFLICT (school_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled,
        reason = EXCLUDED.reason, expires_at = NULL, updated_by = NULL, updated_at = now()`;
    // Restore registered flags for any existing role, including historical nonstudent rows.
    await tx`UPDATE school_feature_flags SET enabled = (${includeDiary} OR feature_key <> 'topbar.diary'),
      updated_by = NULL, updated_at = now()
      WHERE school_id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))
        AND feature_key IN (SELECT value FROM jsonb_array_elements_text(${keys}::jsonb))`;
    await tx`INSERT INTO school_feature_flags (school_id, role, feature_key, enabled, updated_by, updated_at)
      SELECT s.id, ${STUDENT_ROLE}, k.value, (${includeDiary} OR k.value <> 'topbar.diary'), NULL, now()
      FROM schools s CROSS JOIN jsonb_array_elements_text(${keys}::jsonb) k(value)
      WHERE s.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))
      ON CONFLICT (school_id, role, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled,
        updated_by = NULL, updated_at = now()`;
    const [invalid] = await tx`SELECT
      (SELECT count(*)::int FROM schools s CROSS JOIN public.features f
        LEFT JOIN public.school_feature_overrides o ON o.school_id = s.id AND o.feature_key = f.key
        WHERE s.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))
          AND f.key <> 'dashboard'
          AND (o.enabled IS DISTINCT FROM (${includeDiary} OR f.key <> 'diary') OR o.expires_at IS NOT NULL)) AS modules,
      (SELECT count(*)::int FROM schools s CROSS JOIN jsonb_array_elements_text(${keys}::jsonb) k(value)
        LEFT JOIN school_feature_flags f ON f.school_id = s.id AND f.role = ${STUDENT_ROLE} AND f.feature_key = k.value
        WHERE s.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))
          AND f.enabled IS DISTINCT FROM (${includeDiary} OR k.value <> 'topbar.diary')) AS portal,
      (SELECT count(*)::int FROM school_feature_flags f
        WHERE f.school_id IN (SELECT value::bigint FROM jsonb_array_elements_text(${targets}::jsonb))
          AND f.feature_key IN (SELECT value FROM jsonb_array_elements_text(${keys}::jsonb))
          AND f.enabled IS DISTINCT FROM (${includeDiary} OR f.feature_key <> 'topbar.diary')) AS other_roles`;
    if (invalid.modules || invalid.portal || invalid.other_roles) throw new Error('Feature rollout verification failed');
    return { schools: ids.length, enabled_modules_per_school: modules.length - (includeDiary ? 0 : 1),
      enabled_portal_features_per_school: portalKeys.length - (includeDiary ? 0 : 1),
      disabled: includeDiary ? [] : ['diary', 'topbar.diary'], invalid };
  });
}
const enableAllSchools = db => enableAllSchoolsExceptDiary(db, { includeDiary: true });
module.exports = { enableAllSchoolsExceptDiary, enableAllSchools };
