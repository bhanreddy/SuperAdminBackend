const postgres = require('postgres');
const config = require('./env');

// Keep backend health/auth available when CRM configuration is missing, but
// never fall back to the school database. CRM calls will fail clearly instead
// of leaking data across database boundaries.
function resolveCrmDatabaseUrl() {
  if (!config.crmDatabaseUrl) return 'postgres://missing:missing@127.0.0.1:1/missing';
  const crmUrl = new URL(config.crmDatabaseUrl);
  const directMatch = crmUrl.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (!directMatch) return crmUrl.toString();

  // Supabase direct DB hosts are IPv6-only for many projects and may return
  // ENOTFOUND on IPv4-only networks. Reuse the known-good regional pooler host
  // from the School DB connection while retaining the dedicated CRM credentials.
  const schoolUrl = new URL(config.schoolDatabaseUrl);
  if (!schoolUrl.hostname.includes('.pooler.supabase.com')) return crmUrl.toString();
  crmUrl.hostname = schoolUrl.hostname;
  crmUrl.port = '6543';
  crmUrl.username = `postgres.${directMatch[1]}`;
  return crmUrl.toString();
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

const crmSql = postgres(resolveCrmDatabaseUrl(), postgresOptions(resolveCrmDatabaseUrl()));

module.exports = crmSql;
