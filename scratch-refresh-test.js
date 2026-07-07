const http = require('http');

const data = JSON.stringify({ email: 'test@test.com', password: 'test' });
const options = {
  hostname: '127.0.0.1',
  port: 4000,
  path: '/api/super-admin/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', d => { body += d; });
  res.on('end', () => {
    console.log(`LOGIN STATUS: ${res.statusCode}`);
    if(res.statusCode !== 200) {
        console.log(`BODY: ${body}`);
        return;
    }
    const session = JSON.parse(body).session;
    console.log(`Got refresh token!`);
    
    // Now refresh token
    const refreshData = JSON.stringify({ refresh_token: session.refresh_token });
    const refreshOpts = {
      hostname: '127.0.0.1',
      port: 4000,
      path: '/api/super-admin/auth/refresh',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': refreshData.length
      }
    };
    const req2 = http.request(refreshOpts, (res2) => {
      let body2 = '';
      res2.on('data', d => { body2 += d; });
      res2.on('end', () => {
         console.log(`REFRESH STATUS: ${res2.statusCode}`);
         const newSession = JSON.parse(body2);
         
         // Now hit a verify route
         const verifyOpts = {
            hostname: '127.0.0.1',
            port: 4000,
            path: '/api/super-admin/verify',
            method: 'GET',
            headers: {
               'Authorization': `Bearer ${newSession.access_token}`
            }
         };
         const req3 = http.request(verifyOpts, (res3) => {
            let body3 = '';
            res3.on('data', d => { body3 += d; });
            res3.on('end', () => {
                console.log(`VERIFY STATUS: ${res3.statusCode}`);
                console.log(`VERIFY BODY: ${body3}`);
            });
         });
         req3.end();
      });
    });
    req2.write(refreshData);
    req2.end();
  });
});
req.on('error', (e) => console.error(e));
req.write(data);
req.end();
