const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const request = require('supertest');
let db, service, app;
const actor = { id: '11111111-1111-4111-8111-111111111111', email: 'root@example.test', role: 'SUPER_ADMIN' };
function tag(client) {
  const sql = async (strings, ...values) => (await client.query(strings.reduce((s, part, i) => s + (i ? '$' + i : '') + part, ''), values)).rows;
  sql.json = value => JSON.stringify(value);
  sql.begin = cb => db.transaction(tx => cb(tag(tx)));
  return sql;
}
function mock(path, exports) {
  const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports };
}
test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE schools(id integer PRIMARY KEY,name text default 'Test School',code text default 'TEST');
    INSERT INTO schools VALUES (1),(2);
    CREATE TABLE features(key text PRIMARY KEY,name text,description text,category text,is_active boolean default true,is_maintenance boolean default false);
    INSERT INTO features(key,name,category) VALUES ('diary','Diary','academics'),('curriculum_v2','Curriculum','academics'),('dashboard','Dashboard','core');
    CREATE TABLE school_feature_overrides(school_id integer,feature_key text,enabled boolean,reason text,expires_at timestamptz,updated_by uuid,updated_at timestamptz default now(),UNIQUE(school_id,feature_key));
    CREATE TABLE school_feature_flags(school_id integer,role text,feature_key text,enabled boolean,updated_by uuid,updated_at timestamptz,UNIQUE(school_id,role,feature_key));
    CREATE TABLE activity_logs(entity_type text,action text,actor_id uuid,metadata jsonb);
    CREATE TABLE super_admins(id uuid,email text,is_active boolean); INSERT INTO super_admins VALUES ('${actor.id}','${actor.email}',true);
    CREATE TABLE founders(user_id uuid,email text,is_active boolean,role text); INSERT INTO founders VALUES ('22222222-2222-4222-8222-222222222222','approver@example.test',true,'APPROVER');`);
  mock('../src/config/db', tag(db));
  mock('../src/middleware/rbac', {
    authenticateUser(req,res,next) { if (!req.get('authorization')) return res.sendStatus(401); req.superAdmin = req.get('x-approver') ? { id: '22222222-2222-4222-8222-222222222222', email: 'approver@example.test', role: 'APPROVER' } : actor; next(); },
    requirePermission: () => (req,res,next) => req.get('x-read-only') && req.method !== 'GET' ? res.sendStatus(403) : next(),
    requireSchoolAccess: () => (req,res,next) => req.params.schoolId === '9' ? res.sendStatus(403) : next(),
  });
  service = require('../src/services/schoolFeatures');
  app = express(); app.use(express.json()); app.use('/schools', require('../src/routes/superadmin/features'));
});
test.after(async () => { await db.close(); });
test('school module disable, enable and reset isolate tenants and synchronize old diary key', async () => {
  await service.change(1, ['diary'], false, actor);
  assert.equal((await service.catalog(1)).find(f=>f.key==='diary').enabled,false);
  assert.equal((await service.catalog(2)).find(f=>f.key==='diary').enabled,false);
  assert.equal((await db.query("SELECT enabled FROM school_feature_flags WHERE school_id=1 AND feature_key='topbar.diary'")).rows[0].enabled,false);
  await service.change(1,['diary'],true,actor);
  assert.equal((await service.catalog(1)).find(f=>f.key==='diary').enabled,true);
  await service.change(1,['diary'],undefined,actor,true);
  assert.equal((await service.catalog(1)).find(f=>f.key==='diary').source,'default');
  assert.equal((await db.query('SELECT * FROM school_feature_overrides WHERE school_id=1')).rows.length,0);
});
test('bulk disable preserves core navigation; rejected keys and audit errors roll back writes', async () => {
  await service.change(1,null,false,actor);
  const features=await service.catalog(1);
  assert.ok(features.filter(f=>f.toggleable).every(f=>!f.enabled));
  assert.ok(features.filter(f=>!f.toggleable).every(f=>f.enabled));
  await assert.rejects(service.change(1,['diary','typo'],true,actor), /Unknown feature/);
  await assert.rejects(service.change(1,['dashboard'],false,actor), /Core navigation/);
  await db.exec("ALTER TABLE activity_logs ADD CONSTRAINT fail_audit CHECK (action <> 'UPDATE') NOT VALID");
  await assert.rejects(service.change(1,['diary'],true,actor));
  assert.equal((await service.catalog(1)).find(f=>f.key==='diary').enabled,false);
  await db.exec('ALTER TABLE activity_logs DROP CONSTRAINT fail_audit');
});
test('API requires auth, permissions and school scope; validates payload and returns full saved catalog',async()=>{
  await request(app).get('/schools/1/features').expect(401);
  await request(app).get('/schools/9/features').set('authorization','test').expect(403);
  await request(app).put('/schools/1/features/diary').set('authorization','test').set('x-read-only','true').send({enabled:true}).expect(403);
  await request(app).put('/schools/1/features/diary').set('authorization','test').set('x-approver','true').send({enabled:true}).expect(403);
  await request(app).put('/schools/1/features/diary').set('authorization','test').send({enabled:'false'}).expect(400);
  await request(app).put('/schools/3/features/diary').set('authorization','test').send({enabled:false}).expect(404);
  const res=await request(app).put('/schools/1/features/diary').set('authorization','test').send({enabled:true}).expect(200).expect('cache-control','private, no-store');
  assert.equal(res.body.enabled,true); assert.ok(Array.isArray(res.body.features));
  const audit=(await db.query("SELECT metadata FROM activity_logs WHERE metadata->>'feature_key'='diary' ORDER BY ctid DESC LIMIT 1")).rows[0].metadata;
  assert.equal(audit.school_id,1);assert.equal(audit.new,true);
});

test('default-off policy applies to new schools, expired grants, reset, and child portal settings', async()=>{
  await db.exec("INSERT INTO schools(id) VALUES(4)");
  let features=await service.catalog(4);
  assert.ok(features.filter(f=>f.toggleable).every(f=>f.enabled===false));
  assert.ok(features.filter(f=>!f.toggleable).every(f=>f.enabled===true));
  await service.change(4,['diary'],true,actor);
  assert.equal((await service.catalog(4)).find(f=>f.key==='topbar.diary').enabled,true);
  await service.change(4,['diary'],false,actor);
  await service.change(4,['topbar.diary'],true,actor);
  let portal=(await service.catalog(4)).find(f=>f.key==='topbar.diary');
  assert.equal(portal.enabled,false);assert.equal(portal.blocked_by,'diary');assert.equal(portal.configured_enabled,true);
  await service.change(4,['diary'],true,actor);
  await db.exec("UPDATE school_feature_overrides SET expires_at=now()-interval '1 hour' WHERE school_id=4 AND feature_key='diary'");
  assert.equal((await service.catalog(4)).find(f=>f.key==='diary').enabled,false);
  await service.change(4,['diary'],true,actor);
  await service.change(4,['diary'],undefined,actor,true);
  assert.equal((await service.catalog(4)).find(f=>f.key==='diary').enabled,false);
});
test('disable-all updates every school, retains previous states, and rolls back completely on audit failure',async()=>{
  const {disableAllSchools}=require('../src/services/disableSchoolFeatures');
  const sql=tag(db);
  await service.change(2,['diary'],true,actor);
  await db.exec("ALTER TABLE activity_logs ADD CONSTRAINT reject_reset CHECK (action <> 'DISABLE_ALL') NOT VALID");
  await assert.rejects(disableAllSchools(sql));
  assert.equal((await service.catalog(2)).find(f=>f.key==='diary').enabled,true);
  await db.exec('ALTER TABLE activity_logs DROP CONSTRAINT reject_reset');
  const result=await disableAllSchools(sql);
  assert.equal(result.schools,3);assert.deepEqual(result.remaining_enabled,{modules:0,portal:0});
  for (const id of [1,2,4]) assert.ok((await service.catalog(id)).filter(f=>f.toggleable).every(f=>!f.enabled));
  const rows=(await db.query("SELECT metadata FROM activity_logs WHERE action='DISABLE_ALL' AND metadata->>'school_id'='2'")).rows;
  assert.equal(rows.length,1);assert.ok(rows[0].metadata.previous_school_overrides.some(f=>f.feature_key==='diary'&&f.enabled===true));
});

test('enable-all-except-diary restores all schools and portal roles atomically while keeping diary off',async()=>{
  const {enableAllSchoolsExceptDiary}=require('../src/services/enableSchoolFeaturesExceptDiary');
  const sql=tag(db);
  await db.exec(`INSERT INTO school_feature_flags(school_id,role,feature_key,enabled) VALUES
    (2,'teacher','topbar.diary',true),(2,'teacher','quick.profile',false);
    UPDATE school_feature_overrides SET expires_at=now()-interval '1 hour' WHERE feature_key='curriculum_v2';
    ALTER TABLE activity_logs ADD CONSTRAINT reject_enable CHECK (action <> 'ENABLE_ALL_EXCEPT_DIARY') NOT VALID`);
  await assert.rejects(enableAllSchoolsExceptDiary(sql));
  assert.equal((await service.catalog(2)).find(f=>f.key==='curriculum_v2').enabled,false);
  await db.exec('ALTER TABLE activity_logs DROP CONSTRAINT reject_enable');
  const result=await enableAllSchoolsExceptDiary(sql);
  assert.equal(result.schools,3);
  assert.deepEqual(result.invalid,{modules:0,portal:0,other_roles:0});
  for(const id of [1,2,4]) {
    const features=await service.catalog(id);
    assert.ok(features.every(f=>f.enabled===!['diary','topbar.diary'].includes(f.key)));
  }
  const teacher=(await db.query("SELECT feature_key,enabled FROM school_feature_flags WHERE school_id=2 AND role='teacher' ORDER BY feature_key")).rows;
  assert.deepEqual(teacher,[{feature_key:'quick.profile',enabled:true},{feature_key:'topbar.diary',enabled:false}]);
  const audits=(await db.query("SELECT metadata FROM activity_logs WHERE action='ENABLE_ALL_EXCEPT_DIARY'")).rows;
  assert.equal(audits.length,3);
  assert.ok(audits.find(a=>a.metadata.school_id===2).metadata.previous_portal_flags.some(f=>f.feature_key==='topbar.diary'&&f.enabled===true));
});

test('enable-all includes Smart Diary for every school and existing portal role with audit rollback',async()=>{
  const {enableAllSchools}=require('../src/services/enableSchoolFeaturesExceptDiary');
  await db.exec("ALTER TABLE activity_logs ADD CONSTRAINT reject_all CHECK (action <> 'ENABLE_ALL') NOT VALID");
  await assert.rejects(enableAllSchools(tag(db)));
  assert.equal((await service.catalog(2)).find(f=>f.key==='diary').enabled,false);
  await db.exec('ALTER TABLE activity_logs DROP CONSTRAINT reject_all');
  const result=await enableAllSchools(tag(db));
  assert.deepEqual(result.disabled,[]);
  assert.deepEqual(result.invalid,{modules:0,portal:0,other_roles:0});
  for(const id of [1,2,4]) assert.ok((await service.catalog(id)).every(f=>f.enabled));
  assert.ok((await db.query("SELECT enabled FROM school_feature_flags WHERE role='teacher'")).rows.every(f=>f.enabled));
  assert.equal((await db.query("SELECT metadata FROM activity_logs WHERE action='ENABLE_ALL'")).rows.length,3);
});
