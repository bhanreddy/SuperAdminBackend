const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'school-library-'));
process.env.SCHOOL_LIBRARY_ROOT = root;

const { packSchoolConstants, describeLibrary } = require('../../src/services/schoolLibrary');

function write(rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

const sharedSchoolTs = 'export const SCHOOL_ID = Number(process.env.EXPO_PUBLIC_SCHOOL_ID);\n';
const templateApp = {
  expo: {
    name: 'Nexsyrus School IMS',
    slug: 'demo-ims',
    version: '3.1.2',
    owner: 'bhan_reddy',
    ios: { bundleIdentifier: 'com.schoolims.default2' },
    android: { package: 'com.schoolims.default2' },
    extra: { eas: { projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
  },
};
const ghsApp = {
  expo: {
    name: 'Geetanjali High School Maddur',
    slug: 'geetanjalihighschoolmaddur',
    android: { package: 'com.nexsyrussims.geetanjalihighschool' },
    extra: { eas: { projectId: '5e99bce0-6c29-4767-9f70-10ea0ea9582f' } },
  },
};

write('Default File/app.json', `${JSON.stringify(templateApp, null, 2)}\n`);
write('Default File/eas.json', `${JSON.stringify({
  build: {
    base: { node: '20.18.0' },
    'school-1': { env: { EXPO_PUBLIC_SCHOOL_ID: '1', EXPO_PUBLIC_SCHOOL_NAME: 'Default School', EXPO_PUBLIC_SCHOOL_CODE: 'DEFAULT', EXPO_PUBLIC_API_URL: 'https://template.example/api', EXPO_PUBLIC_SUPABASE_URL: 'https://template.supabase.co', EXPO_PUBLIC_SUPABASE_ANON_KEY: 'template-anon' } },
    'school-1-production': { extends: 'school-1' },
  },
  submit: { 'school-1-production': { android: { serviceAccountKeyPath: './secrets/play-service-account-school-1.json' } } },
}, null, 2)}\n`);
write('Default File/.env', 'EXPO_PUBLIC_SCHOOL_ID=1\nEXPO_PUBLIC_SCHOOL_CODE=Nexsyrus School IMS\nEXPO_PUBLIC_SCHOOL_NAME="Default School"\nEXPO_PUBLIC_API_URL=https://template.example/api\nEXPO_PUBLIC_SUPABASE_URL=https://template.supabase.co\nEXPO_PUBLIC_SUPABASE_ANON_KEY=template-anon\nEXPO_PUBLIC_BUNDLE_ID="com.schoolims.default2"\n');
write('Default File/wrangler.jsonc', '{ "name": "default" }\n');
write('Default File/constants/school.ts', sharedSchoolTs);
write('Default File/constants/schoolConfig.ts', 'export const SCHOOL_CONFIG = {\n  name: "Nexsyrus School IMS",\n  address: "Maddur , Telangana 509336",\n  contact: "9347556547",\n  email: "nexsyrus@nexsyrus.com",\n  website: "www.nexsyrus.com",\n  tagline: "Step in with Confidence and Step out with Success",\n  motto: "Be Confident, Do Confidently",\n  schoolCode: "NSIMS",\n};\n');
write('Default File/assets/images/icon.png', 'default-icon');
write('Default File/assets/sounds/notification_default.wav', 'shared-sound');
write('Default File/._app.json', 'apple-double');
write('GHS File/app.json', `${JSON.stringify(ghsApp, null, 2)}\n`);
write('GHS File/.env', 'EXPO_PUBLIC_SCHOOL_ID=17\nEXPO_PUBLIC_SCHOOL_CODE=46117\nEXPO_PUBLIC_SCHOOL_NAME="Geetanjali High School Maddur"\n');
write('GHS File/eas.json', '{ "build": { "school-17": {} } }\n');
write('GHS File/wrangler.jsonc', '{ "name": "ghs-maddur-nexsyrus" }\n');
write('GHS File/constants/school.ts', sharedSchoolTs);
write('GHS File/constants/only-ghs.txt', 'geetanjali-only');
write('GHS File/assets/images/icon.png', 'ghs-icon');

function unzip(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-'));
  const zipPath = path.join(dir, 'folder.zip');
  fs.writeFileSync(zipPath, buffer);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  execFileSync('python3', ['-m', 'zipfile', '-e', zipPath, out]);
  return out;
}

test('an existing school downloads its exact constants folder', async () => {
  const packed = await packSchoolConstants({
    schoolId: 17,
    rawConfig: { official_name: 'Something Else', school_code: 'OTHER', origin: 'backfill' },
    snapshot: { school_backend_url: 'https://other.example', school_supabase_url: 'https://other.supabase.co', school_anon_key: 'other' },
    assetBodies: { logo: Buffer.from('uploaded') },
  });
  assert.equal(packed.folder, 'GHS File');
  assert.equal(packed.source, 'exact');
  const out = unzip(packed.zip);
  assert.equal(fs.readFileSync(path.join(out, 'GHS File/constants/only-ghs.txt'), 'utf8'), 'geetanjali-only');
  assert.equal(fs.readFileSync(path.join(out, 'GHS File/app.json'), 'utf8'), fs.readFileSync(path.join(root, 'GHS File/app.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(out, 'GHS File/assets/images/icon.png'), 'utf8'), 'ghs-icon');
  assert.equal(fs.existsSync(path.join(out, 'GHS File/._app.json')), false);
  const tree = execFileSync('python3', ['-c', 'import os,sys; print("\\n".join(sorted(os.path.relpath(os.path.join(d,f), sys.argv[1]) for d,_,fs in os.walk(sys.argv[1]) for f in fs)))', out], { encoding: 'utf8' });
  assert.doesNotMatch(tree, /Riverdale|Default File/);
});

test('a new school downloads the same folder layout with its own identity', async () => {
  const packed = await packSchoolConstants({
    schoolId: 42,
    rawConfig: {
      origin: 'created',
      official_name: 'Riverdale Public School',
      app_display_name: 'Riverdale',
      school_code: 'RPS01',
      address: '12 Lake Road',
      contact_phone: '9876543210',
      contact_email: 'office@riverdale.example',
      website: 'riverdale.example',
      tagline: 'Learn well',
      motto: 'Steady work',
      android_package: 'com.nexsyrussims.riverdale',
      ios_bundle_id: 'com.nexsyrussims.riverdale',
      slug: 'riverdale',
      worker_name: 'riverdale-nexsyrus',
    },
    snapshot: {
      school_backend_url: 'https://cluster.example/api/v1',
      school_supabase_url: 'https://cluster.supabase.co',
      school_anon_key: 'cluster-anon',
    },
    assetBodies: { logo: Buffer.from('riverdale-logo') },
  });
  assert.equal(packed.source, 'template');
  assert.equal(packed.folder, 'Riverdale Public School File');
  const out = unzip(packed.zip);
  const base = path.join(out, 'Riverdale Public School File');
  assert.equal(fs.readFileSync(path.join(base, 'constants/school.ts'), 'utf8'), sharedSchoolTs);
  assert.equal(fs.readFileSync(path.join(base, 'assets/sounds/notification_default.wav'), 'utf8'), 'shared-sound');
  assert.equal(fs.readFileSync(path.join(base, 'assets/images/icon.png'), 'utf8'), 'riverdale-logo');
  const app = fs.readFileSync(path.join(base, 'app.json'), 'utf8');
  const env = fs.readFileSync(path.join(base, '.env'), 'utf8');
  const eas = fs.readFileSync(path.join(base, 'eas.json'), 'utf8');
  const config = fs.readFileSync(path.join(base, 'constants/schoolConfig.ts'), 'utf8');
  assert.match(app, /Riverdale/);
  assert.match(app, /com\.nexsyrussims\.riverdale/);
  assert.doesNotMatch(app, /demo-ims|com\.schoolims\.default2|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|Geetanjali|ghs-icon/);
  assert.match(env, /EXPO_PUBLIC_SCHOOL_ID=42/);
  assert.match(env, /EXPO_PUBLIC_SCHOOL_CODE=RPS01/);
  assert.match(env, /https:\/\/cluster\.example\/api\/v1/);
  assert.match(eas, /school-42/);
  assert.match(eas, /cluster-anon/);
  assert.doesNotMatch(eas, /school-1|template-anon|play-service-account-school-1/);
  assert.match(config, /Riverdale Public School/);
  assert.match(config, /RPS01/);
  assert.doesNotMatch(`${app}\n${env}\n${eas}\n${config}`, /Geetanjali|only-ghs|5e99bce0/);
  assert.equal(describeLibrary({ schoolId: 17, name: 'Riverdale', code: 'RPS01' }).folder, 'GHS File');
  assert.equal(describeLibrary({ schoolId: 42, name: 'Riverdale Public School', code: 'RPS01' }).mode, 'template');
});

test('stored source downloads without an SSD and rejects corrupted bytes', async () => {
  const { encodeFolder, findSchoolFolder } = require('../../src/services/schoolLibrary');
  const entry = findSchoolFolder({schoolId:17});
  const encoded = encodeFolder(entry);
  const source = {mode:'exact', storage_path:'immutable/source', sha256:encoded.sha256};
  const previous = process.env.SCHOOL_LIBRARY_ROOT;
  process.env.SCHOOL_LIBRARY_ROOT = '';
  try {
    const packed = await packSchoolConstants({schoolId:17, folderSource:source, storage:{get:async()=>encoded.body}});
    const out = unzip(packed.zip);
    for (const f of require('../../src/services/schoolLibrary').listEntries(entry.dirPath)) {
      assert.deepEqual(fs.readFileSync(path.join(out, entry.folder, f.rel)), fs.readFileSync(f.full));
    }
    await assert.rejects(packSchoolConstants({schoolId:17,folderSource:source,storage:{get:async()=>Buffer.from('corrupt')}}), /checksum/);
  } finally {process.env.SCHOOL_LIBRARY_ROOT=previous;}
});

test('missing new-school contact values never inherit the demo school contacts', async () => {
  const packed=await packSchoolConstants({schoolId:51,rawConfig:{official_name:'New School',school_code:'NEW',origin:'created'}, snapshot:{school_backend_url:'https://new.example',school_supabase_url:'https://new.supabase.co',school_anon_key:'public'}});
  const out=unzip(packed.zip);
  const config=fs.readFileSync(path.join(out,packed.folder,'constants/schoolConfig.ts'),'utf8');
  assert.doesNotMatch(config,/9347556547|nexsyrus@nexsyrus.com|Maddur/);
});

test('folder data is parsed as literals without executing imported TypeScript', () => {
  const {literals,fillMissing}=require('../../scripts/importSchoolFolders');
  const c=literals('throw new Error("must never execute"); export const SCHOOL_CONFIG={name:"Example",logo:require("private"),theme:{ribbonGradient:["#000000","#FFFFFF"] as const},websiteGallery:{enabled:false}};', 'SCHOOL_CONFIG');
  assert.equal(c.name,'Example');
  assert.equal(c.logo,undefined);
  assert.equal(c.websiteGallery.enabled,false);
  assert.deepEqual(fillMissing({name:'Existing',phone:'',enabled:false},{name:'SSD',phone:'123',enabled:true}),{name:'Existing',phone:'123',enabled:false});
});

test('API migration changes only environment and EAS API fields, preserving binary assets and other settings', () => {
  const {patchFolderApi}=require('../../src/services/schoolLibrary');
  const api='https://simsapi.nexsyrus.com/api/v1';
  const image=Buffer.from([255,0,128,1]);
  const input=[
    {rel:'.env',body:Buffer.from('# school\r\nEXPO_PUBLIC_API_URL=http://localhost:4000\r\nEXPO_PUBLIC_SCHOOL_ID=17\r\n')},
    {rel:'env',body:Buffer.from('EXPO_PUBLIC_SCHOOL_ID=16\n')},
    {rel:'eas.json',body:Buffer.from('{"build":{"a":{"env":{"EXPO_PUBLIC_API_URL":"http://old","OTHER":"keep"}},"b":{"env":{"EXPO_PUBLIC_API_URL":"http://another"}}}}')},
    {rel:'assets/icon.png',body:image},
  ];
  const output=patchFolderApi(input,api);
  assert.equal(output[0].body.toString(),`# school\r\nEXPO_PUBLIC_API_URL=${api}\r\nEXPO_PUBLIC_SCHOOL_ID=17\r\n`);
  assert.equal(output[1].body.toString(),`EXPO_PUBLIC_SCHOOL_ID=16\nEXPO_PUBLIC_API_URL=${api}\n`);
  const eas=JSON.parse(output[2].body);
  assert.equal(eas.build.a.env.EXPO_PUBLIC_API_URL,api);
  assert.equal(eas.build.b.env.EXPO_PUBLIC_API_URL,api);
  assert.equal(eas.build.a.env.OTHER,'keep');
  assert.equal(output[3].body,image);
  const quoted=Buffer.from(`EXPO_PUBLIC_API_URL="${api}"\n`);
  assert.deepEqual(patchFolderApi([{rel:'.env',body:quoted}],api)[0].body,quoted);
});

test('new package snapshots use the public API even if cluster metadata still points at localhost', () => {
  const {publicClusterSnapshot}=require('../../src/services/schoolConfigSchema');
  const {schoolPublicApiUrl}=require('../../src/config/schoolPublicApi');
  assert.equal(publicClusterSnapshot({school_backend_url:'http://localhost:4000'}).school_backend_url,'https://simsapi.nexsyrus.com/api/v1');
  process.env.SCHOOL_PUBLIC_API_URL='https://next.example/api/v1/';
  try{assert.equal(schoolPublicApiUrl(),'https://next.example/api/v1');}finally{delete process.env.SCHOOL_PUBLIC_API_URL;}
});
