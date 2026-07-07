const jwt = require('jsonwebtoken');
const sql = require('./src/config/db');
(async () => {
  const [sa] = await sql`SELECT id, email FROM super_admins LIMIT 1`;
  const token = jwt.sign(
    { sub: sa.id, email: sa.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 },
    'dummy-secret', { algorithm: 'HS256' }
  );
  const res = await fetch('http://localhost:4000/api/super-admin/admins', { headers: { Authorization: `Bearer ${token}` } });
  console.log('GET /admins STATUS:', res.status);
  console.log('BODY:', (await res.text()).slice(0, 600));
  process.exit(0);
})().catch(e=>{console.error('ERR', e.message); process.exit(0);});
