const sql = require('./src/config/db');

async function check() {
  try {
    const schools = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'schools'`;
    console.log("Schools table:", schools.length > 0);
    
    const medical = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'medical_profile'`;
    console.log("Medical Profile table:", medical.length > 0);
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
check();
