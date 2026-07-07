const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.SCHOOL_DATABASE_URL,
});

async function check() {
  await client.connect();

  try {
    await client.query(`DELETE FROM schools WHERE id = 4;`);
    console.log("Deleted successfully!");
  } catch (err) {
    console.error("PG Error:", err);
  }

  await client.end();
}

check().catch(console.error);
