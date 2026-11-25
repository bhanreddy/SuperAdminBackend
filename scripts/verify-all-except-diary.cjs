require('dotenv').config({ quiet: true });
const { FEATURE_REGISTRY, STUDENT_ROLE } = require('../src/config/featureRegistry');
const base = process.env.SCHOOL_SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
const key = process.env.SCHOOL_SUPABASE_SERVICE_ROLE_KEY;
const includeDiary = process.argv.includes('--include-diary');
async function read(table, query) {
  const response = await fetch(base + table + '?' + query, {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'count=exact', Range: '0-9999' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error('HTTP_' + response.status);
  const rows = await response.json();
  const total = Number(response.headers.get('content-range')?.split('/')[1]);
  if (!Number.isInteger(total) || total !== rows.length) throw Error('Incomplete verification read');
  return rows;
}
(async () => {
  const [schools, modules, overrides, flags, audits] = await Promise.all([
    read('schools', 'select=id'),
    read('features', 'select=key'),
    read('school_feature_overrides', 'select=school_id,feature_key,enabled,expires_at'),
    read('school_feature_flags', 'select=school_id,role,feature_key,enabled'),
    read('activity_logs', 'select=metadata->school_id&action=eq.' + (includeDiary ? 'ENABLE_ALL' : 'ENABLE_ALL_EXCEPT_DIARY')),
  ]);
  const portal = FEATURE_REGISTRY.filter(f => f.toggleable).map(f => f.key);
  const optional = modules.filter(f => f.key !== 'dashboard');
  const failures = [];
  for (const school of schools) {
    for (const module of optional) {
      const row = overrides.find(r => r.school_id === school.id && r.feature_key === module.key);
      if (!row || row.enabled !== (includeDiary || module.key !== 'diary') || row.expires_at !== null) failures.push({ school_id: school.id, key: module.key });
    }
    for (const key of portal) {
      const row = flags.find(r => r.school_id === school.id && r.role === STUDENT_ROLE && r.feature_key === key);
      if (!row || row.enabled !== (includeDiary || key !== 'topbar.diary')) failures.push({ school_id: school.id, key });
    }
    if (!audits.some(a => a.school_id === school.id)) failures.push({ school_id: school.id, key: 'audit' });
  }
  for (const flag of flags) {
    if (portal.includes(flag.feature_key) && flag.enabled !== (includeDiary || flag.feature_key !== 'topbar.diary')) failures.push({ school_id: flag.school_id, key: flag.feature_key, role: flag.role });
  }
  console.log(JSON.stringify({ schools: schools.length, enabled_modules_per_school: optional.length - (includeDiary ? 0 : 1),
    enabled_portal_features_per_school: portal.length - (includeDiary ? 0 : 1), smart_diary_enabled: includeDiary, smart_diary_verified_schools: schools.filter(s =>
      overrides.some(r => r.school_id === s.id && r.feature_key === 'diary' && r.enabled === includeDiary) &&
      flags.some(r => r.school_id === s.id && r.role === STUDENT_ROLE && r.feature_key === 'topbar.diary' && r.enabled === includeDiary)).length,
    failures }));
  if (!schools.length || failures.length) process.exitCode = 1;
})().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
