const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const {PGlite} = require('@electric-sql/pglite');
const {PGLiteSocketServer} = require('@electric-sql/pglite-socket');
const request = require('supertest');
const express = require('express');
let db,server,sql,app,founderToken,staffToken,topic;
const founder=crypto.randomUUID(),staff=crypto.randomUUID();
const secret='learning-library-test-secret';
const migration=fs.readFileSync(path.join(__dirname,'../../src/db/migrations/25_learning_content_library.sql'),'utf8');
function document(status='draft') {
  const subtopic=crypto.randomUUID();
  return { title:'Fractions',definition:'Parts of a whole',subject:'Mathematics',grade:'6',language:'en',status,tags:['fractions'],metadata:{future:{module:'lms'}},
    subtopics:[{id:subtopic,title:'Equivalent fractions',definition:'Fractions with equal values'}],
    questions:['example','activity','exercise','long_answer'].map(kind=>({id:crypto.randomUUID(),subtopic_id:subtopic,kind,question:`${kind} question`,answer:'Model answer',explanation:'Steps',difficulty:'medium',marks:2,bloom_level:'apply'})),images:[] };
}
const save=(body,key=crypto.randomUUID(),id)=>request(app)[id?'put':'post'](`/content${id?'/'+id:''}`).set('Authorization',`Bearer ${founderToken}`).set('Idempotency-Key',key).send(body);
test.before(async()=>{
  db=new PGlite();server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:10});await server.start();
  Object.assign(process.env,{SCHOOL_DATABASE_URL:`postgres://postgres:postgres@127.0.0.1:${server.server.address().port}/postgres`,SCHOOL_SUPABASE_URL:'http://127.0.0.1:9',SCHOOL_SUPABASE_ANON_KEY:'test',SCHOOL_SUPABASE_SERVICE_ROLE_KEY:'test',SCHOOL_SUPABASE_JWT_SECRET:secret,SUPERADMIN_JWT_SECRET:secret});
  // PGlite has one Postgres session; serialize connections while exercising
  // concurrent HTTP submissions and their revision/idempotency semantics.
  sql=require('postgres')(process.env.SCHOOL_DATABASE_URL,{ssl:false,max:1,onnotice:()=>{}});
  const dbModule=require.resolve('../../src/config/db');
  require.cache[dbModule]={id:dbModule,filename:dbModule,loaded:true,exports:sql};
  await sql.unsafe(`
    CREATE TABLE content_assets(id uuid PRIMARY KEY,school_id integer,asset_type text,status text,metadata jsonb);
    CREATE TABLE super_admins(id uuid PRIMARY KEY,is_active boolean,email text,full_name text);
    CREATE TABLE founders(id uuid PRIMARY KEY,user_id uuid,is_active boolean,email text,full_name text,role text);
    CREATE TABLE internal_users(id uuid PRIMARY KEY,auth_user_id uuid,employee_id text,full_name text,email text,phone text,role text,status text,manager_id uuid,territory text,token_version integer);
    CREATE TABLE internal_user_permission_overrides(user_id uuid,permission text,effect text);
    CREATE TABLE internal_user_schools(user_id uuid,school_id integer);
  `);
  await sql`INSERT INTO super_admins VALUES(${founder},true,'founder@test.local','Founder')`;
  await sql`INSERT INTO internal_users(id,auth_user_id,full_name,email,role,status) VALUES(${staff},${staff},'Staff','staff@test.local','SALES_EXECUTIVE','ACTIVE')`;
  const connection=await sql.reserve();
  try{await connection.unsafe(migration);await connection.unsafe(migration);}finally{connection.release();}
  const {errorHandler}=require('../../src/middleware/errorHandler');
  app=express();app.use(express.json());app.use('/content',require('../../src/routes/superadmin/learningContent'));app.use(errorHandler);
  founderToken=jwt.sign({sub:founder,email:'founder@test.local'},secret);
  staffToken=jwt.sign({sub:staff,email:'staff@test.local'},secret);
});
test.after(async()=>{await sql?.end();await server?.stop();await db?.close();});
test('all library routes require SuperAdmin, including image and history endpoints',async()=>{
  for(const route of ['/content','/content/schema',`/content/${crypto.randomUUID()}/revisions`,`/content/images/${crypto.randomUUID()}`]){
    assert.equal((await request(app).get(route)).status,401);
    assert.equal((await request(app).get(route).set('Authorization',`Bearer ${staffToken}`)).status,403);
  }
  assert.equal((await request(app).post('/content/images/sign-upload').set('Authorization',`Bearer ${staffToken}`).send({})).status,403);
  const schema=await request(app).get('/content/schema').set('Authorization',`Bearer ${founderToken}`);
  assert.equal(schema.body.ready,true);
});
test('persists hierarchy and all question categories and retries exactly once',async()=>{
  const body=document('ready'),key=crypto.randomUUID();
  const res=await save(body,key);assert.equal(res.status,201,JSON.stringify(res.body));topic=res.body;
  assert.equal(topic.questions.length,4);assert.equal(topic.subtopics.length,1);assert.equal(topic.questions[0].marks,2);
  assert.deepEqual(topic.metadata,{future:{module:'lms'}});
  const again=await save(body,key);assert.equal(again.body.id,topic.id);assert.equal(again.body.revision,1);
  assert.equal((await save({...body,title:'Different'},key)).status,409);
  const [{count}]=await sql`SELECT count(*)::int AS count FROM learning_content_topics`;assert.equal(count,1);
});
test('rejects incomplete ready content, invalid cross-topic links and unknown fields',async()=>{
  const missing=document('ready');missing.questions[0].answer='';assert.equal((await save(missing)).status,422);
  const wrong=document();wrong.questions[0].subtopic_id=crypto.randomUUID();assert.equal((await save(wrong)).status,422);
  assert.equal((await save({...document(),school_id:17})).status,422);
  const empty=document();empty.subtopics[0].title='';assert.equal((await save(empty)).status,422);
  const marks=document();marks.questions[0].marks=-1;assert.equal((await save(marks)).status,422);
  marks.questions[0].marks=null;assert.equal((await save(marks)).status,422);
  const image=document();image.images=[{id:crypto.randomUUID(),asset_id:crypto.randomUUID(),alt_text:'Unknown'}];assert.equal((await save(image)).status,422);
});
test('conflicting concurrent editors cannot overwrite content and revision snapshots are immutable',async()=>{
  const first=document();first.title='Editor one';first.expected_revision=1;
  const second={...first,title:'Editor two'};
  const results=await Promise.all([save(first,crypto.randomUUID(),topic.id),save(second,crypto.randomUUID(),topic.id)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(results.find(r=>r.status===200).body.revision,2);
  const history=await request(app).get(`/content/${topic.id}/revisions`).set('Authorization',`Bearer ${founderToken}`);
  assert.deepEqual(history.body.data.map(r=>r.revision),[2,1]);
  const snapshot=await request(app).get(`/content/${topic.id}/revisions/1`).set('Authorization',`Bearer ${founderToken}`);
  assert.equal(snapshot.body.document.title,'Fractions');
  await assert.rejects(()=>sql`UPDATE learning_content_revisions SET actor_id='changed' WHERE topic_id=${topic.id}`,/append-only/);
});
test('same save submitted concurrently creates one topic',async()=>{
  const body=document(),key=crypto.randomUUID();
  const results=await Promise.all([save(body,key),save(body,key)]);
  assert.equal(results[0].status,201,JSON.stringify(results[0].body));assert.equal(results[1].status,201,JSON.stringify(results[1].body));
  assert.equal(results[0].body.id,results[1].body.id);
});
test('paging, filters, invalid cursors and archive visibility',async()=>{
  await save({...document(),title:'Archived topic',status:'archived'});
  const get=query=>request(app).get('/content').query(query).set('Authorization',`Bearer ${founderToken}`);
  const page=await get({limit:1});assert.equal(page.body.data.length,1);assert.ok(page.body.next_cursor);
  const next=await get({limit:1,cursor:page.body.next_cursor});assert.notEqual(next.body.data[0].id,page.body.data[0].id);
  const filtered=await get({status:'archived',subject:'Mathematics',grade:'6'});assert.equal(filtered.body.data.length,1);
  assert.equal((await get({cursor:'bad'})).status,422);assert.equal((await get({limit:100000})).status,422);
});
