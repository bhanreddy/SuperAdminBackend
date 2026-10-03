const test=require('node:test');
const assert=require('node:assert/strict');
const postgres=require('postgres');
const {PGlite}=require('@electric-sql/pglite');
const {PGLiteSocketServer}=require('@electric-sql/pglite-socket');
const {gzipSync}=require('zlib');
const crypto=require('crypto');
process.env.SCHOOL_LIBRARY_ROOT='';
const {ensureSchoolConfigurationSchema,resetSchemaForTests,seedDraftFromSchool,requestPackage}=require('../../src/services/schoolConfiguration');
const {storedLibrary}=require('../../src/services/schoolLibrary');
const {memoryStorage,tick}=require('../../src/services/schoolPackageWorker');

test('stored folders are cluster-scoped, immutable per revision, and worker-ready without local disk',async()=>{
  resetSchemaForTests();
  const db=new PGlite();
  const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:8});
  await server.start();
  const sql=postgres(`postgres://postgres:postgres@127.0.0.1:${server.server.address().port}/postgres`,{ssl:false,max:4,prepare:false});
  try {
    await ensureSchoolConfigurationSchema(sql);
    await seedDraftFromSchool(sql,{clusterId:'cluster_a',school:{id:17,name:'GHS',code:'GHSM'}});
    const bytes=gzipSync(Buffer.from(JSON.stringify({folder:'GHS File',files:[{path:'constants/school.ts',body:Buffer.from('original source').toString('base64')}]})));
    const sha=crypto.createHash('sha256').update(bytes).digest('hex');
    await sql`INSERT INTO school_folder_sources(cluster_id,school_id,folder,storage_path,sha256,file_count) VALUES ('cluster_a',17,'GHS File','source-1',${sha},1)`;
    assert.equal(await storedLibrary(sql,'cluster_b',17),null);
    await sql`INSERT INTO school_folder_sources(cluster_id,school_id,folder,storage_path,sha256,file_count) VALUES ('*',0,'Default File','template',${sha},1)`;
    assert.equal((await storedLibrary(sql,'cluster_b',17)).mode,'template');
    assert.equal((await storedLibrary(sql,'cluster_a',17)).mode,'exact');
    const cluster={school_backend_url:'https://a.example',school_supabase_url:'https://a.supabase.co',school_anon_key:'anon'};
    const request=key=>requestPackage(sql,{clusterId:'cluster_a',schoolId:17,idempotencyKey:key,cluster,assetPresence:{}});
    const first=await request('request-one');
    const same=await request('request-two');
    assert.equal(first.job.id,same.job.id);
    await sql`UPDATE school_folder_sources SET storage_path='source-2',sha256='new-hash' WHERE cluster_id='cluster_a' AND school_id=17`;
    const second=await request('request-three');
    assert.equal(second.job.revision,2);
    process.env.SCHOOL_PUBLIC_API_URL='https://next.example/api/v1';
    try {
      const changedApi=await request('request-four');
      assert.equal(changedApi.job.revision,3);
    } finally {delete process.env.SCHOOL_PUBLIC_API_URL;}
    const [revision]=await sql`SELECT folder_source FROM school_config_revisions WHERE revision=1`;
    assert.equal(revision.folder_source.storage_path,'source-1');
    const storage=memoryStorage();
    await storage.put('source-1',bytes);
    await tick(sql,storage);
    const [artifact]=await sql`SELECT * FROM school_package_artifacts WHERE revision=1`;
    assert.equal(artifact.file_name,'GHS File.zip');
    assert.ok(await storage.get(artifact.storage_path));
  }finally{await sql.end();await server.stop();await db.close();}
});
