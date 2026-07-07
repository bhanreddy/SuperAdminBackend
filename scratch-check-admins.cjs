const sql = require('./src/config/db');
(async () => {
  try {
    const sa = await sql`SELECT id, email, full_name, is_active FROM super_admins`;
    console.log('super_admins count:', sa.length);
    console.table(sa.map(r=>({id:String(r.id).slice(0,8), email:r.email, name:r.full_name, active:r.is_active})));
    const f = await sql`SELECT user_id, email, full_name, is_active, created_at FROM founders`;
    console.log('founders count:', f.length);
    console.table(f.map(r=>({user_id: r.user_id?String(r.user_id).slice(0,8):null, email:r.email, name:r.full_name, active:r.is_active})));
    // Simulate the union query
    const merged = await sql`
      SELECT * FROM (
        SELECT sa.id, sa.email, sa.full_name, sa.is_active, sa.created_at, false AS is_founder FROM super_admins sa
        UNION ALL
        SELECT f.user_id AS id, COALESCE(NULLIF(TRIM(f.email),''),'') AS email, COALESCE(NULLIF(TRIM(f.full_name),''),'Founder') AS full_name, f.is_active, f.created_at, true AS is_founder
        FROM founders f WHERE f.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM super_admins sa2 WHERE sa2.id = f.user_id)
      ) merged ORDER BY merged.created_at ASC`;
    console.log('MERGED (what /admins returns) count:', merged.length);
    console.table(merged.map(r=>({email:r.email, name:r.full_name, founder:r.is_founder, active:r.is_active})));
  } catch(e) { console.error('ERR', e.message); } finally { process.exit(0); }
})();
