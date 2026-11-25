const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const express=require('express');

test('question-bank proxy enforces capabilities, forwards multipart/token/receipts and preserves conflicts',async()=>{
  const middlewarePath=require.resolve('../src/middleware/rbac');
  const clientPath=require.resolve('../src/services/curriculumAuthoringClient');
  const calls=[];
  require.cache[middlewarePath]={id:middlewarePath,filename:middlewarePath,loaded:true,exports:{
    authenticateUser:(req,res,next)=>req.headers.authorization?next():res.status(401).end(),
    requirePermission:permission=>(req,res,next)=>req.get('x-test-permission')===permission?next():res.status(403).end(),
  }};
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{questionBank:async(method,path,options)=>{
    calls.push({method,path,options});
    if(method==='PUT')throw Object.assign(new Error('Stale revision'),{statusCode:409,code:'STALE_REVISION',current:{revision:2},details:{field:'base'}});
    return {success:true,data:{id:'00000000-0000-4000-8000-000000000001'}};
  }}};
  const app=express();app.use(express.json());app.use('/question-bank',require('../src/routes/superadmin/questionBank'));
  await request(app).get('/question-bank/questions').expect(401);
  await request(app).get('/question-bank/questions').set('authorization','Bearer workforce').expect(403);
  assert.equal(calls.length,0);
  await request(app).post('/question-bank/imports/preview')
    .set('authorization','Bearer workforce').set('x-test-permission','curriculum.questions.import').set('Idempotency-Key','preview-key')
    .field('destination',JSON.stringify({chapterId:'chapter'})).attach('bundle',Buffer.from('test bytes'),'bundle.zip')
    .expect(201).expect('cache-control','private, no-store');
  const preview=calls[0];assert.equal(preview.options.authorization,'Bearer workforce');assert.equal(preview.options.idempotencyKey,'preview-key');
  assert.match(preview.options.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(preview.options.multipart.get('bundle').name,'bundle.zip');
  assert.equal(await preview.options.multipart.get('bundle').text(),'test bytes');
  assert.deepEqual(JSON.parse(preview.options.multipart.get('destination')),{chapterId:'chapter'});
  await request(app).post('/question-bank/imports/00000000-0000-4000-8000-000000000001/commit')
    .set('authorization','Bearer workforce').set('x-test-permission','curriculum.questions.import').send({acceptUpdates:false}).expect(202);
  await request(app).put('/question-bank/questions/00000000-0000-4000-8000-000000000001')
    .set('authorization','Bearer workforce').set('x-test-permission','curriculum.questions.author').send({base:{revision:1}})
    .expect(409).expect(({body})=>{assert.equal(body.code,'STALE_REVISION');assert.equal(body.current.revision,2);});
  await request(app).get('/question-bank/imports/00000000-0000-4000-8000-000000000001/report')
    .set('authorization','Bearer workforce').set('x-test-permission','curriculum.questions.import')
    .expect(200).expect('content-disposition',/attachment/);
});

test('authoring client allowlists paths and carries authorization, request ID and conflict tokens',async()=>{
  const clientPath=require.resolve('../src/services/curriculumAuthoringClient');
  delete require.cache[clientPath];
  const client=require(clientPath),oldFetch=global.fetch,oldBase=process.env.SCHOOL_CURRICULUM_API_URL;
  process.env.SCHOOL_CURRICULUM_API_URL='http://127.0.0.1:1/api/v1';
  const calls=[];
  global.fetch=async(url,options)=>{calls.push({url,options});return {ok:false,status:409,json:async()=>({error:'Stale',code:'REVISION_CONFLICT',details:{field:'base'},current:{revision:3,checksum:'current'}})};};
  try{
    await assert.rejects(()=>client.questionBank('GET','/../../questions',{authorization:'Bearer test'}),e=>e.statusCode===422);
    await assert.rejects(()=>client.questionBank('GET','/questions',{}),e=>e.statusCode===401);
    assert.equal(calls.length,0);
    await assert.rejects(()=>client.questionBank('PUT','/questions/00000000-0000-4000-8000-000000000001',{
      authorization:'Bearer test',body:{base:{revision:2}},idempotencyKey:'save-key',requestId:'request-id',
    }),e=>e.statusCode===409&&e.current.revision===3&&e.details.field==='base');
    assert.equal(calls[0].url,'http://127.0.0.1:1/api/v1/curriculum/authoring/question-bank/questions/00000000-0000-4000-8000-000000000001');
    assert.equal(calls[0].options.headers.authorization,'Bearer test');
    assert.equal(calls[0].options.headers['Idempotency-Key'],'save-key');
    assert.equal(calls[0].options.headers['x-request-id'],'request-id');
    assert.deepEqual(JSON.parse(calls[0].options.body),{base:{revision:2}});
  }finally{global.fetch=oldFetch;if(oldBase===undefined)delete process.env.SCHOOL_CURRICULUM_API_URL;else process.env.SCHOOL_CURRICULUM_API_URL=oldBase;}
});
