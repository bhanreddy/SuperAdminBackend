const { strictSchoolName, looseSchoolName, normalizePhone, normalizeEmail, normalizeLocation, NORMALIZATION_VERSION } = require('./normalization');
const { stableHash } = require('./helpers');

const SETTING_KEYS = ['school_name', 'school_address', 'school_phone', 'school_email', 'school_principal', 'school_board'];

function freshnessMs(hours) {
  return Math.max(1, Number(hours) || 24) * 60 * 60 * 1000;
}

function isFresh(refresh, hours, now = Date.now()) {
  if (!refresh || refresh.status !== 'OK' || !refresh.last_success_at) return false;
  return now - new Date(refresh.last_success_at).getTime() <= freshnessMs(hours);
}

async function coverage(crmSql, clusterIds, hours) {
  const refreshes = clusterIds.length
    ? await crmSql`SELECT * FROM crm_directory_refreshes WHERE cluster_id = ANY(${clusterIds})`
    : [];
  const byId = new Map(refreshes.map((row) => [row.cluster_id, row]));
  const clusters = clusterIds.map((id) => {
    const row = byId.get(id);
    return {
      cluster_id: id,
      status: row?.status || 'FAILED',
      fresh: isFresh(row, hours),
      last_success_at: row?.last_success_at || null,
      school_count: row?.school_count || 0,
    };
  });
  return {
    complete: clusterIds.length > 0 && clusters.every((row) => row.fresh),
    clusters,
    checked_at: new Date().toISOString(),
  };
}

function projectSchool(clusterId, school, settings = {}) {
  const name = settings.school_name || school.name || '';
  const phone = settings.school_phone ? normalizePhone(settings.school_phone, 'IN') : null;
  const email = settings.school_email ? normalizeEmail(settings.school_email) : null;
  const location = normalizeLocation({ address: settings.school_address, country: 'IN' });
  const fingerprint = stableHash({
    name,
    code: school.code || null,
    phone: phone?.ok ? phone.normalized : null,
    email: email?.ok ? email.normalized : null,
    address: settings.school_address || null,
    onboarding: school.onboarding_status || null,
    active: school.is_active !== false,
  });
  return {
    cluster_id: clusterId,
    school_id: String(school.id),
    school_code: school.code || null,
    name,
    school_name_normalized: strictSchoolName(name),
    school_name_loose: looseSchoolName(name),
    address_raw: settings.school_address || school.address || null,
    country_code: 'IN',
    location_key: location.location_key,
    state_normalized: location.state_normalized,
    phones: phone?.ok ? [phone.normalized] : [],
    emails: email?.ok ? [email.normalized] : [],
    correlation_key: school.crm_correlation_key || null,
    is_active: school.is_active !== false,
    onboarding_status: school.onboarding_status || null,
    source_fingerprint: fingerprint,
    normalization_version: NORMALIZATION_VERSION,
    completeness: {
      name: Boolean(name),
      phone: Boolean(phone?.ok),
      email: Boolean(email?.ok),
      address: Boolean(settings.school_address || school.address),
      board: Boolean(settings.school_board),
    },
  };
}

async function upsertProjection(crmSql, row) {
  await crmSql`
    INSERT INTO crm_school_customer_directory (
      cluster_id, school_id, school_code, name, school_name_normalized, school_name_loose,
      address_raw, country_code, state_normalized, location_key, phones, emails, correlation_key,
      is_active, onboarding_status, source_fingerprint, normalization_version, last_verified_at,
      last_refresh_status, completeness
    ) VALUES (
      ${row.cluster_id}, ${row.school_id}, ${row.school_code}, ${row.name}, ${row.school_name_normalized || ''},
      ${row.school_name_loose || ''}, ${row.address_raw}, ${row.country_code}, ${row.state_normalized},
      ${row.location_key}, ${row.phones}, ${row.emails}, ${row.correlation_key}, ${row.is_active},
      ${row.onboarding_status}, ${row.source_fingerprint}, ${row.normalization_version}, now(), 'OK',
      ${crmSql.json(row.completeness)}
    )
    ON CONFLICT (cluster_id, school_id) DO UPDATE SET
      school_code = EXCLUDED.school_code,
      name = EXCLUDED.name,
      school_name_normalized = EXCLUDED.school_name_normalized,
      school_name_loose = EXCLUDED.school_name_loose,
      address_raw = EXCLUDED.address_raw,
      phones = EXCLUDED.phones,
      emails = EXCLUDED.emails,
      correlation_key = EXCLUDED.correlation_key,
      is_active = EXCLUDED.is_active,
      onboarding_status = EXCLUDED.onboarding_status,
      source_fingerprint = EXCLUDED.source_fingerprint,
      last_verified_at = now(),
      last_refresh_status = 'OK',
      completeness = EXCLUDED.completeness,
      updated_at = now()
  `;
}

async function markRefresh(crmSql, clusterId, patch) {
  await crmSql`
    INSERT INTO crm_directory_refreshes (cluster_id, status, last_success_at, last_attempt_at, error, school_count)
    VALUES (
      ${clusterId}, ${patch.status}, ${patch.status === 'OK' ? new Date().toISOString() : null}, now(),
      ${patch.error || null}, ${patch.school_count || 0}
    )
    ON CONFLICT (cluster_id) DO UPDATE SET
      status = EXCLUDED.status,
      last_success_at = CASE WHEN EXCLUDED.status = 'OK' THEN now() ELSE crm_directory_refreshes.last_success_at END,
      last_attempt_at = now(),
      error = EXCLUDED.error,
      school_count = CASE WHEN EXCLUDED.status = 'OK' THEN EXCLUDED.school_count ELSE crm_directory_refreshes.school_count END
  `;
}

async function refreshClusters(crmSql, { clusters, readCluster, freshnessHours = 24 }) {
  const results = [];
  for (const clusterId of clusters) {
    try {
      const schools = await readCluster(clusterId);
      for (const school of schools || []) {
        await upsertProjection(crmSql, projectSchool(clusterId, school, school.settings || {}));
      }
      await markRefresh(crmSql, clusterId, { status: 'OK', school_count: (schools || []).length });
      results.push({ cluster_id: clusterId, status: 'OK', school_count: (schools || []).length });
    } catch (err) {
      await markRefresh(crmSql, clusterId, { status: 'FAILED', error: 'cluster_unreachable' });
      results.push({ cluster_id: clusterId, status: 'FAILED' });
    }
  }
  return coverage(crmSql, clusters, freshnessHours);
}

async function listActiveClusterIds(schoolSql) {
  const rows = await schoolSql`SELECT cluster_id FROM clusters WHERE status = 'active' ORDER BY cluster_id`;
  return rows.map((row) => row.cluster_id);
}

async function readLiveCluster(clusterId) {
  const { getClusterServiceClient } = require('../../utils/clusterClient');
  const client = await getClusterServiceClient(clusterId, 'school');
  const schools = [];
  const pageSize = 200;
  for (let from = 0; schools.length < 5000; from += pageSize) {
    const { data, error } = await client.from('schools').select('id,name,code,address,onboarding_status,is_active,crm_correlation_key').range(from, from + pageSize - 1);
    if (error) throw error;
    schools.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  const settingsBySchool = new Map();
  for (let index = 0; index < schools.length; index += 100) {
    const slice = schools.slice(index, index + 100);
    const { data, error } = await client.from('school_settings').select('school_id,key,value').in('school_id', slice.map((row) => row.id)).in('key', SETTING_KEYS);
    if (error) throw error;
    for (const row of data || []) {
      const bag = settingsBySchool.get(String(row.school_id)) || {};
      bag[row.key] = row.value;
      settingsBySchool.set(String(row.school_id), bag);
    }
  }
  return schools.map((school) => ({ ...school, settings: settingsBySchool.get(String(school.id)) || {} }));
}

async function refreshLiveDirectory(crmSql, schoolSql, freshnessHours) {
  const clusters = await listActiveClusterIds(schoolSql);
  return refreshClusters(crmSql, { clusters, readCluster: readLiveCluster, freshnessHours });
}

module.exports = {
  SETTING_KEYS,
  isFresh,
  coverage,
  projectSchool,
  upsertProjection,
  markRefresh,
  refreshClusters,
  listActiveClusterIds,
  readLiveCluster,
  refreshLiveDirectory,
};
