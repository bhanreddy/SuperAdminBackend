const test=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
test('media gateway forwards the existing JWT and idempotency key, preserves vector bytes, and never duplicates /api/v1',async()=>{
 const authPath=require.resolve('../src/middleware/verifySuperAdmin');const saved=require.cache[authPath];require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{verifySuperAdminMiddleware:(req,res,next)=>req.get('Authorization')?next():res.sendStatus(401)}};
 const oldFetch=global.fetch,oldBase=process.env.SCHOOL_CURRICULUM_API_URL,calls=[];
 global.fetch=async(url,options)=>{calls.push({url,options});return new Response('<svg>vector-test</svg>',{headers:{'Content-Type':'image/svg+xml'}});};
 try{
  const app=express();app.use(express.json());app.use('/media',require('../src/routes/superadmin/media'));
  assert.equal((await request(app).get('/media')).status,401);
  process.env.SCHOOL_CURRICULUM_API_URL='https://canonical.test/api/v1';const artifact=await request(app).get('/media/qr/qr-id/artifact?format=svg').set('Authorization','Bearer test-workforce');assert.equal(artifact.status,200);assert.equal(Buffer.isBuffer(artifact.body)?artifact.body.toString():artifact.text,'<svg>vector-test</svg>');assert.equal(artifact.headers['cache-control'],'private, no-store');assert.equal(calls[0].url,'https://canonical.test/api/v1/curriculum/authoring/media/qr/qr-id/artifact?format=svg');assert.equal(calls[0].options.headers.authorization,'Bearer test-workforce');
  process.env.SCHOOL_CURRICULUM_API_URL='https://canonical.test';await request(app).post('/media').set('Authorization','Bearer test-workforce').set('Idempotency-Key','stable-key-1').send({title:'Numbers'});assert.equal(calls[1].url,'https://canonical.test/api/v1/curriculum/authoring/media/');assert.equal(calls[1].options.headers['idempotency-key'],'stable-key-1');assert.equal(JSON.parse(calls[1].options.body).title,'Numbers');
  global.fetch=async()=>{throw Error('private credentials must not appear in errors');};const failed=await request(app).get('/media').set('Authorization','Bearer test-workforce');assert.equal(failed.status,502);assert.equal(failed.body.code,'MEDIA_UNREACHABLE');assert(!failed.text.includes('credentials'));
 }finally{global.fetch=oldFetch;if(oldBase===undefined)delete process.env.SCHOOL_CURRICULUM_API_URL;else process.env.SCHOOL_CURRICULUM_API_URL=oldBase;if(saved)require.cache[authPath]=saved;else delete require.cache[authPath];}
});
