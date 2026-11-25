require('dotenv').config({ quiet: true });
const postgres = require('postgres');
const { enableAllSchools } = require('../src/services/enableSchoolFeaturesExceptDiary');
if (!process.argv.includes('--apply')) {
  console.error('Explicit execution required: node scripts/enable-all-school-features.cjs --apply');
  process.exit(1);
}
const db = postgres(process.env.SCHOOL_DATABASE_URL, {
  ssl: { rejectUnauthorized: false }, max: 1, prepare: false, connect_timeout: 10,
  connection: { statement_timeout: 30000 },
});
enableAllSchools(db).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(JSON.stringify({ error: error.code || error.name })); process.exitCode = 1; })
  .finally(() => db.end());
