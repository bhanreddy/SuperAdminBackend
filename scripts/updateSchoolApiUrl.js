/* Refresh the SSD library and its stored copies after changing the public API URL. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { schoolPublicApiUrl } = require('../src/config/schoolPublicApi');
const { catalog, patchFolderApi, encodeFolder } = require('../src/services/schoolLibrary');
const digest = body => crypto.createHash('sha256').update(body).digest('hex');

async function main() {
  const sql = require('../src/config/db');
  const { supabaseStorage } = require('../src/services/schoolPackageWorker');
  const { ensureSchoolConfigurationSchema } = require('../src/services/schoolConfiguration');
  try {
    const apiUrl = schoolPublicApiUrl();
    const entries = catalog();
    if (!entries.length) throw new Error('No school folders found. Set SCHOOL_LIBRARY_ROOT or connect the SSD.');
    const clusters = await sql`SELECT cluster_id, school_supabase_url, school_backend_url FROM clusters`;
    const schools = await sql`SELECT id, cluster_id, backend_url FROM schools`;
    const sources = await sql`SELECT * FROM school_folder_sources`;
    const changes = [];
    for (const entry of entries) {
      const cluster = clusters.find(c => c.school_supabase_url === entry.supabaseUrl);
      if (!cluster || !schools.some(s => s.id === entry.schoolId && s.cluster_id === cluster.cluster_id)) throw new Error(`Unmatched school: ${entry.folder}`);
      entry.clusterId = cluster.cluster_id;
      const names = ['.env', 'env', 'eas.json'].filter(name => fs.existsSync(path.join(entry.dirPath, name)));
      if (!names.some(name => name === '.env' || name === 'env')) {
        const eas = JSON.parse(fs.readFileSync(path.join(entry.dirPath, 'eas.json'), 'utf8'));
        const profile = Object.values(eas.build || {}).find(p => Number(p.env?.EXPO_PUBLIC_SCHOOL_ID) === entry.schoolId);
        if (!profile) throw new Error(`Cannot reconstruct environment for ${entry.folder}`);
        const env = {...profile.env, EXPO_PUBLIC_API_URL:apiUrl};
        for (const key of ['EXPO_PUBLIC_SCHOOL_ID','EXPO_PUBLIC_SCHOOL_CODE','EXPO_PUBLIC_SUPABASE_URL','EXPO_PUBLIC_SUPABASE_ANON_KEY']) if (!env[key]) throw new Error(`Missing ${key} in ${entry.folder}`);
        changes.push({file:path.join(entry.dirPath,'.env'), body:Buffer.from(Object.entries(env).filter(([k])=>k.startsWith('EXPO_PUBLIC_')).map(([k,v])=>`${k}=${JSON.stringify(String(v))}`).join('\n')+'\n')});
      }
      for (const name of names) {
        const file=path.join(entry.dirPath,name), body=fs.readFileSync(file);
        const updated=patchFolderApi([{rel:name,body}],apiUrl)[0].body;
        if (!body.equals(updated)) changes.push({file,body:updated});
      }
    }
    console.log(JSON.stringify({apiUrl,folders:entries.length,changedFiles:changes.map(c=>c.file)},null,2));
    if (!process.argv.includes('--apply')) return;
    const backupDir=path.join(__dirname,'../.school-library-backups',`api-url-${Date.now()}`);
    fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(backupDir,'database.json'),JSON.stringify({clusters,schools,sources},null,2),{mode:0o600});
    for (let i=0;i<changes.length;i++) {
      const c=changes[i];
      if(fs.existsSync(c.file))fs.copyFileSync(c.file,path.join(backupDir,`${i}.original`));
      fs.writeFileSync(c.file,c.body);
    }
    fs.writeFileSync(path.join(backupDir,'files.json'),JSON.stringify(changes.map((c,i)=>({file:c.file,backup:`${i}.original`})),null,2),{mode:0o600});
    const storage=supabaseStorage(), imported=[];
    for(const entry of entries){
      const encoded=encodeFolder(entry);
      const storagePath=`${entry.clusterId}/library/${encoded.sha256}.json.gz`;
      await storage.put(storagePath,encoded.body,'application/gzip');
      if(digest(await storage.get(storagePath) || '')!==encoded.sha256)throw new Error(`Stored copy failed verification: ${entry.folder}`);
      imported.push({entry,encoded,storagePath});
      console.log(`Verified refreshed source: ${entry.folder}`);
    }
    await ensureSchoolConfigurationSchema(sql);
    await sql.begin(async tx=>{
      const clusterIds=[...new Set(entries.map(e=>e.clusterId))];
      await tx`UPDATE clusters SET school_backend_url=${apiUrl} WHERE cluster_id IN ${tx(clusterIds)}`;
      await tx`UPDATE schools SET backend_url=${apiUrl} WHERE cluster_id IN ${tx(clusterIds)}`;
      for(const {entry,encoded,storagePath} of imported){
        const ids=entry.isTemplate?[0,entry.schoolId]:[entry.schoolId];
        await tx`UPDATE school_folder_sources SET storage_path=${storagePath},sha256=${encoded.sha256},file_count=${encoded.fileCount},imported_at=NOW()
          WHERE (cluster_id=${entry.clusterId} AND school_id IN ${tx(ids)}) OR (${entry.isTemplate} AND cluster_id='*' AND school_id=0)`;
      }
    });
    console.log(`Updated ${changes.length} files and ${entries.length} stored school folders. Backup: ${backupDir}`);
  } finally { await sql.end(); }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
