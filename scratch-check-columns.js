const sql = require('./src/config/db');

async function run() {
  try {
    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'schools'
    `;
    console.log("Columns of 'schools' table:");
    console.log(columns.map(c => `${c.column_name}: ${c.data_type}`).join('\n'));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
