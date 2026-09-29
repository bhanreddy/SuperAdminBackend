const postgres = require('postgres');
const config = require('./env');

// Direct Postgres connection to the school database — used by all routes that
// perform raw SQL queries on school tables (students, staff, schools,
// permissions, roles, founders, expenses, collections, enquiries, etc.)
function postgresOptions(connectionString) {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
  const pooler = /pooler\.supabase\.com|:6543\b/.test(connectionString);
  return {
    ssl: local ? false : { rejectUnauthorized: false },
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    max: 8,
    // Transaction-mode pooler (port 6543) does not keep named prepared statements.
    prepare: pooler ? false : undefined,
  };
}

let currentUrl = null;
let currentClient = null;

function getSql() {
  const url = process.env.SCHOOL_DATABASE_URL || config.schoolDatabaseUrl;
  if (!currentClient || currentUrl !== url) {
    currentUrl = url;
    currentClient = postgres(url, postgresOptions(url));
  }
  return currentClient;
}

const sql = (strings, ...values) => getSql()(strings, ...values);

module.exports = new Proxy(sql, {
  get(target, prop) {
    const client = getSql();
    const val = client[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
  apply(target, thisArg, argArray) {
    return getSql()(...argArray);
  },
});
