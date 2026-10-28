// Owner-authorized, repeatable promotion. Preserves the CA's existing password.
const sql = require('../src/config/db');
async function appoint(email) {
  if (!email) throw new Error('Usage: node scripts/appoint-lead-ca.js <CA-email>');
  return sql.begin(async tx => {
    const [user] = await tx`SELECT id,role,status FROM public.internal_users WHERE lower(trim(email))=${email.trim().toLowerCase()} FOR UPDATE`;
    if (!user || !['CA','CA_LEAD'].includes(user.role) || user.status !== 'ACTIVE') throw new Error('An active CA account is required');
    const promoted = user.role !== 'CA_LEAD';
    await tx`UPDATE public.internal_users SET role='CA_LEAD',manager_id=NULL,job_title='Lead Chartered Accountant',books_company_scoped=true,token_version=token_version+${promoted ? 1 : 0},updated_at=now() WHERE id=${user.id}`;
    await tx`DELETE FROM public.internal_user_permission_overrides WHERE user_id=${user.id}`;
    await tx`DELETE FROM public.books_company_access WHERE user_id=${user.id}`;
    if (promoted) await tx`UPDATE public.internal_user_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${user.id}`;
    const team = await tx`UPDATE public.internal_users SET manager_id=${user.id},token_version=token_version+1,books_company_scoped=true,updated_at=now() WHERE role='CA' AND manager_id IS DISTINCT FROM ${user.id} RETURNING id`;
    for (const member of team) {
      await tx`UPDATE public.internal_user_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${member.id}`;
      await tx`INSERT INTO public.books_access_events(target_user_id,actor_id,action,details) VALUES(${member.id},NULL,'lead_assigned',${tx.json({lead_id:user.id,source:'owner_authorized_provisioning'})})`;
    }
    await tx`INSERT INTO public.books_access_events(target_user_id,actor_id,action,details) VALUES(${user.id},NULL,'lead_ca_appointed',${tx.json({companies:['nexsyrus','nexmaxx'],authority:'full_accounting_and_ca_team_management',team_assigned:team.length,source:'owner_authorized_provisioning'})})`;
    return { email, role: 'CA_LEAD', companies: ['Nexsyrus','Nexmaxx'], team_assigned: team.length, password_preserved: true };
  });
}
if (require.main === module) appoint(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>sql.end());
module.exports={appoint};
