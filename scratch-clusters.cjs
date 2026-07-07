const jwt = require('jsonwebtoken');
const sql = require('./src/config/db');
(async () => {
  const [sa] = await sql`SELECT id, email FROM super_admins LIMIT 1`;
  const token = jwt.sign({ sub: sa.id, email: sa.email, role:'authenticated', aud:'authenticated', exp: Math.floor(Date.now()/1000)+3600 }, 'x', {algorithm:'HS256'});
  for (const path of ['/api/super-admin/clusters','/api/super-admin/dashboard/stats']) {
    const r = await fetch('http://localhost:4000'+path, { headers:{Authorization:`Bearer ${token}`}});
    console.log(path, '->', r.status, (await r.text()).slice(0,400));
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(0);});
