const sql = require('../config/db');
const { FEATURE_REGISTRY, STUDENT_ROLE } = require('../config/featureRegistry');

// Stable portal keys retained for older SchoolIMS clients.
const PORTAL_MODULES = {
  'topbar.diary': 'diary', 'topbar.lms': 'lms', 'nav.time_table': 'timetable',
  'nav.fees': 'fees', 'nav.results': 'examinations', 'nav.calendar': 'academic_calendar',
  'home.todays_snapshot': 'attendance',
};

async function catalog(schoolId, db = sql) {
  const [modules, flags] = await Promise.all([
    db`SELECT f.key, f.name, f.description, f.category, f.is_active, f.is_maintenance,
              o.enabled AS override_enabled, o.expires_at
       FROM public.features f LEFT JOIN public.school_feature_overrides o
         ON o.feature_key = f.key AND o.school_id = ${schoolId}
       ORDER BY f.category, f.name`,
    db`SELECT feature_key, enabled FROM school_feature_flags
       WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE}`,
  ]);
  const overrides = Object.fromEntries(flags.map(r => [r.feature_key, r.enabled]));
  const moduleKeys = new Set(modules.map(f => f.key));
  const resolved = [
    ...modules.map(f => {
      const overridden = f.override_enabled !== null && (!f.expires_at || new Date(f.expires_at) > new Date());
      return { key: f.key, label: f.key === 'diary' ? 'Smart Diary' : f.name,
        description: f.description, group: 'modules', category: f.category, scope: 'school',
        default_enabled: f.key === 'dashboard', enabled: f.key === 'dashboard' || (overridden ? f.override_enabled : false),
        source: overridden ? 'overridden' : 'default', data_bearing: true, toggleable: f.key !== 'dashboard',
        available: f.is_active && !f.is_maintenance };
    }),
    ...FEATURE_REGISTRY.filter(f => !moduleKeys.has(f.key)).map(f => ({ ...f,
      scope: 'portal', enabled: Object.hasOwn(overrides, f.key) ? overrides[f.key] : f.default_enabled,
      source: Object.hasOwn(overrides, f.key) ? 'overridden' : 'default',
    })),
  ];
  const byKey = new Map(resolved.map(f => [f.key, f]));
  return resolved.map(f => {
    const parent = byKey.get(PORTAL_MODULES[f.key]);
    return parent && !parent.enabled ? { ...f, enabled: false, configured_enabled: f.enabled, blocked_by: parent.key, parent_key: parent.key }
      : { ...f, parent_key: parent?.key };
  });
}

async function change(schoolId, keys, enabled, actor, reset = false) {
  return sql.begin(async db => {
    // Serialize configuration changes for one school, including audit and resets.
    const [school] = await db`SELECT id FROM schools WHERE id = ${schoolId} FOR UPDATE`;
    if (!school) throw Object.assign(new Error('School not found'), { statusCode: 404 });
    const features = await catalog(schoolId, db);
    const selected = keys === null ? features.filter(f => f.toggleable) : keys.map(key => {
      const canonical = PORTAL_MODULES[key] || key;
      const feature = features.find(f => f.key === key) || features.find(f => f.key === canonical);
      if (!feature) throw Object.assign(new Error(`Unknown feature key: ${key}`), { statusCode: 400 });
      if (!feature.toggleable) throw Object.assign(new Error('Core navigation cannot be disabled'), { statusCode: 400 });
      return feature;
    });
    for (const feature of selected) {
      if (feature.scope === 'school') {
        if (reset) {
          await db`DELETE FROM public.school_feature_overrides WHERE school_id = ${schoolId} AND feature_key = ${feature.key}`;
        } else {
          await db`INSERT INTO public.school_feature_overrides (school_id, feature_key, enabled, reason, expires_at, updated_by)
            VALUES (${schoolId}, ${feature.key}, ${enabled}, 'Superadmin school feature control', NULL, ${actor.id})
            ON CONFLICT (school_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled,
              expires_at = NULL, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        }
      }
      const portalKeys = feature.scope === 'portal' ? [feature.key]
        : Object.keys(PORTAL_MODULES).filter(key => PORTAL_MODULES[key] === feature.key);
      for (const key of portalKeys) {
        if (reset) {
          await db`DELETE FROM school_feature_flags WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE} AND feature_key = ${key}`;
        } else {
          await db`INSERT INTO school_feature_flags (school_id, role, feature_key, enabled, updated_by, updated_at)
            VALUES (${schoolId}, ${STUDENT_ROLE}, ${key}, ${enabled}, ${actor.id}, now())
            ON CONFLICT (school_id, role, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled,
              updated_by = EXCLUDED.updated_by, updated_at = now()`;
        }
      }
      await db`INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
        VALUES ('school_feature_flag', ${reset ? 'RESET' : 'UPDATE'}, ${actor.id},
          ${db.json({ school_id: schoolId, feature_key: feature.key, scope: feature.scope,
            old: feature.configured_enabled ?? feature.enabled, new: reset ? feature.default_enabled : enabled, actor_email: actor.email || null })})`;
    }
    return catalog(schoolId, db);
  });
}
module.exports = { catalog, change, PORTAL_MODULES };
