const postgres = require('postgres');
const config = require('./env');

// Direct Postgres connection to the school database — used by all routes that
// perform raw SQL queries on school tables (students, staff, schools,
// permissions, roles, founders, expenses, collections, enquiries, etc.)
const sql = postgres(config.schoolDatabaseUrl, {
  ssl: { rejectUnauthorized: false },
  idle_timeout: 20,
  max_lifetime: 60 * 30,
});

module.exports = sql;
