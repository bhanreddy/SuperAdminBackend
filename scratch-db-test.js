const db = require('./src/config/db');
const { schoolSupabaseAdmin } = require('./src/config/supabase');

async function test() {
    const userId = "984f8a31-a135-465f-ab88-211e1157b341";
    const userEmail = "25e001.nexsyrus@gmail.com";

    console.log("1. Raw SQL query:");
    try {
        const rows = await db`SELECT id, is_active, email, full_name FROM super_admins WHERE id = ${userId} OR email = ${userEmail}`;
        console.log("SQL Result:", rows);
    } catch (e) { console.error(e); }

    console.log("\n2. SupabaseAdmin OR query (id.eq / email.ilike):");
    try {
        const { data, error } = await schoolSupabaseAdmin
          .from('super_admins')
          .select('id, is_active, email')
          .or(`id.eq.${userId},email.ilike.${userEmail}`)
          .limit(1)
          .maybeSingle();
        console.log("SupabaseResult:", data);
        console.log("SupabaseError:", error);
    } catch (e) { console.error(e); }
    
    process.exit(0);
}
test();
