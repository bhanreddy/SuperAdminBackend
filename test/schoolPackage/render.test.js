const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

const {
  renderPackage,
  stripGoogleServices,
  assertPlist,
  assertSafeRelative,
  formatEnvValue,
} = require('../../src/services/schoolPackageRender');
const { collectBlockers, publicClusterSnapshot } = require('../../src/services/schoolConfigSchema');
const {
  ensureSchoolConfigurationSchema,
  seedDraftFromSchool,
  saveDraft,
  requestPackage,
  retryJob,
  resetSchemaForTests,
} = require('../../src/services/schoolConfiguration');
process.env.SCHOOL_LIBRARY_ROOT = '';
const { tick, memoryStorage } = require('../../src/services/schoolPackageWorker');

const FORBIDDEN = [/geetanjali/i, /ghs-maddur/i, /school-17/, /samskruthe/i, /5e99bce0-6c29-4767-9f70-10ea0ea9582f/, /testapp-7dd9e/];

function riverdale(overrides = {}) {
  return {
    origin: 'created',
    official_name: 'Riverdale Public School',
    app_display_name: 'Riverdale',
    short_name: 'Riverdale',
    school_code: 'RPS01',
    address: '12 Lake Road, Hyderabad',
    contact_phone: '9876543210',
    contact_email: 'office@riverdale.example',
    website: 'riverdale.example',
    tagline: 'Learn well',
    motto: 'Steady work',
    affiliation_label: '',
    recognition_line: '',
    recognition_no: '',
    website_gallery_enabled: false,
    primary: '#0B3A66',
    secondary: '#C47B2B',
    accent: '#E0A100',
    slug: 'riverdale',
    owner: 'nexsyrus',
    scheme: 'schoolimsriverdale',
    android_package: 'com.nexsyrussims.riverdale',
    ios_bundle_id: 'com.nexsyrussims.riverdale',
    eas_project_id: '11111111-1111-4111-8111-111111111111',
    platforms: ['android', 'web'],
    version: '1.0.0',
    version_confirmed: true,
    ios_build_number: '1',
    android_version_code: 1,
    worker_name: 'riverdale-nexsyrus',
    web_domain: 'riverdale.example',
    scheme_confirmed: true,
    identifiers_confirmed: true,
    ...overrides,
  };
}

function firebase(packageName, extraPackage) {
  return Buffer.from(JSON.stringify({
    project_info: { project_id: 'riverdale-app', project_number: '1' },
    client: [
      { client_info: { android_client_info: { package_name: extraPackage } }, api_key: [{ current_key: 'other-school' }] },
      { client_info: { android_client_info: { package_name: packageName } }, api_key: [{ current_key: 'riverdale-public' }] },
    ],
  }));
}

function assetsFor(packageName = 'com.nexsyrussims.riverdale') {
  const google = stripGoogleServices(firebase(packageName, 'com.nexsyrussims.someoneelse'), packageName);
  return {
    logo: Buffer.from('logo-bytes'),
    app_icon: Buffer.from('icon-bytes'),
    campus_photo: Buffer.from('campus-bytes'),
    favicon: Buffer.from('favicon-bytes'),
    google_services: google,
  };
}

function snapshot(url = 'https://cluster-b.example/api/v1') {
  return {
    school_backend_url: url,
    school_supabase_url: 'https://cluster-b.supabase.co',
    school_anon_key: 'public-anon-key',
    school_service_role_key: 'super-secret-service-role',
  };
}

async function unzipText(zip, entrySuffix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const zipPath = path.join(dir, 'package.zip');
  fs.writeFileSync(zipPath, zip);
  execFileSync('python3', ['-m', 'zipfile', '-e', zipPath, dir]);
  const found = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(dir);
  const match = found.find((file) => file.replace(/\\/g, '/').endsWith(entrySuffix));
  assert.ok(match, `missing ${entrySuffix}`);
  return fs.readFileSync(match, 'utf8');
}

test('a new Android and web school package is consistent and does not leak another school', async () => {
  const rendered = await renderPackage({
    rawConfig: riverdale(),
    schoolId: 42,
    clusterId: 'cluster_b',
    revision: 1,
    snapshot: snapshot(),
    assetBodies: assetsFor(),
    notificationDedicated: false,
  });
  assert.equal(rendered.folder, 'riverdale-cluster_b-42-r1');
  const zipText = rendered.zip.toString('utf8');
  for (const pattern of FORBIDDEN) assert.equal(pattern.test(zipText), false, pattern.source);
  assert.equal(zipText.includes('super-secret-service-role'), false);
  assert.equal(zipText.includes('someoneelse'), false);
  assert.equal(zipText.includes('EXPO_PUBLIC_PRIMARY_COLOR'), false);
  const env = await unzipText(rendered.zip, '.env');
  const eas = await unzipText(rendered.zip, 'eas.json');
  const app = JSON.parse(await unzipText(rendered.zip, 'app.json'));
  const schoolConfig = await unzipText(rendered.zip, 'schoolConfig.ts');
  assert.match(env, /EXPO_PUBLIC_SCHOOL_ID=42/);
  assert.match(env, /EXPO_PUBLIC_SCHOOL_NAME=Riverdale/);
  assert.match(env, /EXPO_PUBLIC_API_URL=https:\/\/simsapi\.nexsyrus\.com\/api\/v1/);
  assert.equal(app.expo.name, 'Riverdale');
  assert.equal(app.expo.android.package, 'com.nexsyrussims.riverdale');
  assert.deepEqual(app.expo.platforms, ['android', 'web']);
  assert.equal(app.expo.ios.googleServicesFile, undefined);
  assert.match(schoolConfig, /name: "Riverdale Public School"/);
  assert.match(schoolConfig, /export function schoolColorWithAlpha/);
  assert.match(eas, /school-cluster-b-42/);
  assert.equal(eas.includes('submit'), false);
  const again = await renderPackage({
    rawConfig: riverdale(),
    schoolId: 42,
    clusterId: 'cluster_b',
    revision: 1,
    snapshot: snapshot(),
    assetBodies: assetsFor(),
    notificationDedicated: false,
  });
  assert.equal(again.sha256, rendered.sha256);
});

test('the same numeric school id on another cluster is a different package', async () => {
  const other = await renderPackage({
    rawConfig: riverdale({ worker_name: 'riverdale-c-nexsyrus', slug: 'riverdalec' }),
    schoolId: 42,
    clusterId: 'cluster_c',
    revision: 1,
    snapshot: { ...snapshot('https://cluster-c.example/api/v1'), school_supabase_url: 'https://cluster-c.supabase.co' },
    assetBodies: assetsFor('com.nexsyrussims.riverdalec'),
    notificationDedicated: false,
  });
  assert.equal(other.folder, 'riverdalec-cluster_c-42-r1');
  const env = await unzipText(other.zip, '.env');
  assert.match(env, /EXPO_PUBLIC_API_URL=https:\/\/simsapi\.nexsyrus\.com\/api\/v1/);
  assert.match(env, /cluster-c\.supabase\.co/);
  assert.doesNotMatch(env, /cluster-b\.example/);
});

test('a branding revision does not change the previous package hash', async () => {
  const first = await renderPackage({
    rawConfig: riverdale(),
    schoolId: 17,
    clusterId: 'cluster_a',
    revision: 1,
    snapshot: snapshot('https://cluster-a.example/api/v1'),
    assetBodies: assetsFor(),
    notificationDedicated: false,
  });
  const second = await renderPackage({
    rawConfig: riverdale({ accent: '#112233', tagline: 'New term' }),
    schoolId: 17,
    clusterId: 'cluster_a',
    revision: 2,
    snapshot: snapshot('https://cluster-a.example/api/v1'),
    assetBodies: { ...assetsFor(), logo: Buffer.from('new-logo') },
    notificationDedicated: false,
  });
  assert.notEqual(first.sha256, second.sha256);
  const rerun = await renderPackage({
    rawConfig: riverdale(),
    schoolId: 17,
    clusterId: 'cluster_a',
    revision: 1,
    snapshot: snapshot('https://cluster-a.example/api/v1'),
    assetBodies: assetsFor(),
    notificationDedicated: false,
  });
  assert.equal(rerun.sha256, first.sha256);
  const config = await unzipText(second.zip, 'schoolConfig.ts');
  assert.match(config, /#112233/);
});

test('missing iOS Firebase is a platform blocker and Android can still be selected alone', () => {
  const both = collectBlockers(riverdale({ platforms: ['android', 'ios'] }), { logo: true, app_icon: true, campus_photo: true, google_services: true }, publicClusterSnapshot(snapshot()));
  assert.ok(both.some((item) => item.platform === 'ios' && item.field === 'google_service_info_plist'));
  const android = collectBlockers(riverdale(), { logo: true, app_icon: true, campus_photo: true, google_services: true }, publicClusterSnapshot(snapshot()));
  assert.equal(android.length, 0);
});

test('unsafe env, paths, and placeholder Firebase files are rejected', () => {
  assert.throws(() => formatEnvValue('line\nbreak'), /line breaks/);
  assert.throws(() => assertSafeRelative('../school.ts'));
  assert.throws(() => assertSafeRelative('src/constants/school.ts'));
  assert.throws(() => stripGoogleServices(Buffer.from('{"client":[]}'), 'com.nexsyrussims.riverdale'));
  assert.throws(() => assertPlist(Buffer.from('<key>BUNDLE_ID</key><string>com.placeholder.app</string><key>PROJECT_ID</key><string>placeholder-project</string><key>GOOGLE_APP_ID</key><string>0</string>'), 'com.placeholder.app'));
});

test('generated schoolConfig transpiles and keeps the worklet export', async () => {
  const tsPath = path.resolve(__dirname, '../../../../SchoolIMS/SchoolIMS-Frontend/node_modules/typescript');
  const ts = require(tsPath);
  const rendered = await renderPackage({
    rawConfig: riverdale(),
    schoolId: 42,
    clusterId: 'cluster_b',
    revision: 1,
    snapshot: snapshot(),
    assetBodies: assetsFor(),
    notificationDedicated: false,
  });
  const source = await unzipText(rendered.zip, 'schoolConfig.ts');
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  assert.equal((result.diagnostics || []).length, 0);
  assert.match(result.outputText, /schoolColorWithAlpha/);
});

test('draft conflicts, package retries, and downloads stay on the original school', async () => {
  resetSchemaForTests();
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 });
  await server.start();
  const address = server.server.address();
  const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${address.port}/postgres`, { ssl: false, max: 1, onnotice: () => {} });
  try {
  await ensureSchoolConfigurationSchema(sql);
  const seeded = await seedDraftFromSchool(sql, {
    clusterId: 'cluster_b',
    school: { id: 42, name: 'Riverdale Public School', code: 'RPS01', address: '12 Lake Road' },
    origin: 'created',
  });
  await assert.rejects(
    saveDraft(sql, { clusterId: 'cluster_b', schoolId: 42, expectedVersion: 99, patch: { tagline: 'Nope' }, isFounder: true }),
    (err) => err.code === 'CONFIG_VERSION_CONFLICT',
  );
  const saved = await saveDraft(sql, {
    clusterId: 'cluster_b',
    schoolId: 42,
    expectedVersion: seeded.version,
    patch: {
      official_name: 'Riverdale Public School',
      app_display_name: 'Riverdale',
      address: '12 Lake Road',
      primary: '#0B3A66',
      secondary: '#C47B2B',
      accent: '#E0A100',
      platforms: ['web'],
      eas_project_id: '',
    },
    isFounder: true,
  });
  const presence = { logo: true, app_icon: true, campus_photo: true };
  const first = await requestPackage(sql, {
    clusterId: 'cluster_b',
    schoolId: 42,
    userId: null,
    idempotencyKey: 'riverdale-generate-1',
    cluster: snapshot(),
    assetPresence: presence,
  });
  const replay = await requestPackage(sql, {
    clusterId: 'cluster_b',
    schoolId: 42,
    userId: null,
    idempotencyKey: 'riverdale-generate-1',
    cluster: snapshot(),
    assetPresence: presence,
  });
  assert.equal(replay.job.id, first.job.id);
  await assert.rejects(
    requestPackage(sql, {
      clusterId: 'cluster_b',
      schoolId: 42,
      userId: null,
      idempotencyKey: 'riverdale-generate-1',
      cluster: { ...snapshot(), school_supabase_url: 'https://other.supabase.co' },
      assetPresence: presence,
    }),
    (err) => err.code === 'IDEMPOTENCY_CONFLICT',
  );
  const storage = memoryStorage();
  const assetRows = [
    ['logo', 'logo-bytes'],
    ['app_icon', 'icon-bytes'],
    ['campus_photo', 'campus-bytes'],
    ['favicon', 'favicon-bytes'],
  ];
  const assetIds = {};
  for (const [slot, body] of assetRows) {
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const objectPath = `cluster_b/42/assets/${slot}/${digest}.png`;
    await storage.put(objectPath, Buffer.from(body), 'image/png');
    const [row] = await sql`
      INSERT INTO school_config_assets (cluster_id, school_id, slot, storage_path, sha256, mime, byte_size)
      VALUES ('cluster_b', 42, ${slot}, ${objectPath}, ${digest}, 'image/png', ${body.length})
      RETURNING id
    `;
    assetIds[slot] = row.id;
  }
  await sql`
    UPDATE school_config_revisions
    SET asset_ids = ${sql.json(assetIds)}
    WHERE cluster_id = 'cluster_b' AND school_id = 42
  `;
  await tick(sql, storage);
  const [artifact] = await sql`SELECT sha256, revision FROM school_package_artifacts WHERE cluster_id = 'cluster_b' AND school_id = 42`;
  assert.equal(artifact.revision, 1);
  const [schools] = await sql`SELECT to_regclass('public.schools') AS name`;
  assert.equal(schools.name, null);
  await sql`
    UPDATE school_package_jobs
    SET status = 'FAILED', attempt_count = 3, error = ${sql.json({ message: 'storage blip' })}
    WHERE id = ${first.job.id}
  `;
  await sql`DELETE FROM school_package_artifacts WHERE cluster_id = 'cluster_b' AND school_id = 42`;
  const retried = await retryJob(sql, { clusterId: 'cluster_b', schoolId: 42, jobId: first.job.id });
  assert.equal(retried.revision, 1);
  assert.equal(retried.status, 'QUEUED');
  const [schoolCount] = await sql`SELECT COUNT(*)::int AS count FROM school_config_drafts`;
  assert.equal(schoolCount.count, 1);
  assert.equal(saved.version > seeded.version, true);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
    await server.stop();
  }
});

test('the apply script replaces allowlisted files and leaves shared school.ts', async () => {
  const { pathToFileURL } = require('url');
  const rendered = await renderPackage({
    rawConfig: riverdale(),
    schoolId: 42,
    clusterId: 'cluster_b',
    revision: 1,
    snapshot: snapshot(),
    assetBodies: assetsFor(),
    notificationDedicated: false,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
  const zipPath = path.join(root, 'package.zip');
  fs.writeFileSync(zipPath, rendered.zip);
  const extracted = path.join(root, 'extracted');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(extracted);
  execFileSync('python3', ['-m', 'zipfile', '-e', zipPath, extracted]);
  fs.mkdirSync(path.join(checkout, 'src/constants'), { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, '../../../../SchoolIMS/SchoolIMS-Frontend/schoolims.template.json'),
    path.join(checkout, 'schoolims.template.json'),
  );
  fs.writeFileSync(path.join(checkout, 'src/constants/school.ts'), 'export const SCHOOL_ID = 1;\n');
  fs.writeFileSync(path.join(checkout, 'app.json'), '{"old":true}\n');
  const apply = await import(pathToFileURL(path.resolve(__dirname, '../../../../SchoolIMS/SchoolIMS-Frontend/scripts/apply-school-package.mjs')).href);
  assert.throws(
    () => apply.planApply({ manifest: { templateVersion: 'other', files: [] }, marker: { templateVersion: 'schoolims-template/1', applyPaths: [] } }),
    (err) => err.code === 'TEMPLATE_MISMATCH',
  );
  assert.throws(() => apply.assertRelative('../school.ts'), (err) => err.code === 'UNSAFE_PATH');
  const result = apply.applyExtractedPackage(extracted, checkout);
  assert.equal(result.revision, 1);
  assert.equal(fs.readFileSync(path.join(checkout, 'src/constants/school.ts'), 'utf8'), 'export const SCHOOL_ID = 1;\n');
  assert.match(fs.readFileSync(path.join(checkout, 'app.json'), 'utf8'), /Riverdale/);
  assert.match(fs.readFileSync(path.join(checkout, '.env'), 'utf8'), /EXPO_PUBLIC_SCHOOL_ID=42/);
});
