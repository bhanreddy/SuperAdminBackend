require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('../config/db');
const { seedSprintDataIfNeeded } = require('../services/sprintSeed');

async function run() {
  console.log('🚀 Running 11-Day Sprint Command Center migration...');
  try {
    const migrationSql = fs.readFileSync(
      path.join(__dirname, 'migrations', '14_sprint_command_center.sql'),
      'utf8'
    );

    // Execute DDL
    console.log('Creating sprint_days, sprint_tasks, and sprint_activity_logs tables...');
    await sql.unsafe(migrationSql);
    console.log('Tables created or verified.');

    // Seed data
    console.log('Seeding 11 days and 100 deliverables...');
    await seedSprintDataIfNeeded(sql);

    // Verify counts
    const [{ count: dayCount }] = await sql`SELECT count(*)::int AS count FROM sprint_days`;
    const [{ count: taskCount }] = await sql`SELECT count(*)::int AS count FROM sprint_tasks`;

    console.log(`\n🎉 Verification success!`);
    console.log(`   sprint_days count:  ${dayCount} (Expected: 11)`);
    console.log(`   sprint_tasks count: ${taskCount} (Expected: 100)`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

run();
