const postgres = require('postgres');
const config = require('./env');

// Keep backend health/auth available when CRM configuration is missing, but
// never fall back to the school database. CRM calls will fail clearly instead
// of leaking data across database boundaries.
function resolveCrmDatabaseUrl() {
  const raw = process.env.CRM_DATABASE_URL || config.crmDatabaseUrl;
  if (!raw) return 'postgres://missing:missing@127.0.0.1:1/missing';
  try {
    const crmUrl = new URL(raw);
    const directMatch = crmUrl.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (!directMatch) return crmUrl.toString();

    const schoolRaw = process.env.SCHOOL_DATABASE_URL || config.schoolDatabaseUrl;
    const schoolUrl = new URL(schoolRaw);
    if (!schoolUrl.hostname.includes('.pooler.supabase.com')) return crmUrl.toString();
    crmUrl.hostname = schoolUrl.hostname;
    crmUrl.port = '6543';
    crmUrl.username = `postgres.${directMatch[1]}`;
    return crmUrl.toString();
  } catch {
    return raw;
  }
}

function postgresOptions(connectionString) {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
  const pooler = /pooler\.supabase\.com|:6543\b/.test(connectionString);
  return {
    ssl: local ? false : { rejectUnauthorized: false },
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    max: 8,
    prepare: pooler ? false : undefined,
  };
}

let currentCrmUrl = null;
let currentCrmClient = null;

function getCrmSql() {
  const url = resolveCrmDatabaseUrl();
  if (!currentCrmClient || currentCrmUrl !== url) {
    currentCrmUrl = url;
    currentCrmClient = postgres(url, postgresOptions(url));
  }
  return currentCrmClient;
}

const crmSql = (strings, ...values) => getCrmSql()(strings, ...values);

module.exports = new Proxy(crmSql, {
  get(target, prop) {
    const client = getCrmSql();
    const val = client[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
  apply(target, thisArg, argArray) {
    return getCrmSql()(...argArray);
  },
});
