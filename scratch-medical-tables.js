const { medicalSupabase } = require('./src/config/supabase');

async function testTables() {
    console.log("Checking medical_profile table...");
    const { data: mData, error: mErr } = await medicalSupabase.from('medical_profile').select('id').limit(1);
    console.log("medical_profile:", mData ? "EXISTS" : mErr.message);

    console.log("\nChecking clinics table...");
    const { data: cData, error: cErr } = await medicalSupabase.from('clinics').select('id').limit(1);
    console.log("clinics:", cData ? "EXISTS" : cErr.message);

    process.exit(0);
}

testTables();
