/* Import trusted folder data without executing the TypeScript files. Dry run by default. */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { catalog, encodeFolder } = require('../src/services/schoolLibrary');
const { backfillFromSchool } = require('../src/services/schoolConfigSchema');

function literals(source, variable) {
  const ast = ts.createSourceFile('schoolConfig.ts', source, ts.ScriptTarget.Latest, true);
  function value(node) {
    if (!node) return undefined;
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return value(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties
      .filter(ts.isPropertyAssignment).map(p => [p.name.text, value(p.initializer)]).filter(([, v]) => v !== undefined));
    return undefined; // Never run imports, require(), functions, or expressions.
  }
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.text === variable) result = value(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result || {};
}

function extractConfig(entry) {
  const read = file => fs.readFileSync(path.join(entry.dirPath, file), 'utf8');
  const app = JSON.parse(read('app.json')).expo;
  const text = read('constants/schoolConfig.ts');
  const c = literals(text, 'SCHOOL_CONFIG');
  const theme = literals(text, 'schoolTheme');
  const splash = app.plugins?.find(p => Array.isArray(p) && p[0] === 'expo-splash-screen')?.[1];
  const keys = { name: 'official_name', tagline: 'tagline', motto: 'motto', address: 'address', contact: 'contact_phone', email: 'contact_email', website: 'website', cbseAffiliationNo: 'affiliation_label', schoolCode: 'school_code', recognitionLine: 'recognition_line', recognitionNo: 'recognition_no' };
  const config = Object.fromEntries(Object.entries(keys).filter(([key]) => c[key] !== undefined).map(([key, target]) => [target, c[key]]));
  return { ...config, app_display_name: app.name, slug: app.slug, version: app.version,
    scheme: app.scheme, owner: app.owner, platforms: app.platforms,
    android_package: app.android?.package, ios_bundle_id: app.ios?.bundleIdentifier,
    android_version_code: app.android?.versionCode, ios_build_number: app.ios?.buildNumber,
    eas_project_id: app.extra?.eas?.projectId,
    adaptive_background: app.android?.adaptiveIcon?.backgroundColor, splash_background: splash?.backgroundColor,
    notification_color: app.notification?.color, website_gallery_enabled: c.websiteGallery?.enabled,
    light: theme.light?.colors, dark: theme.dark?.colors,
    primary: theme.light?.colors?.primary, secondary: theme.light?.colors?.secondary,
    accent: c.theme?.accent || theme.light?.colors?.accent, ribbon: c.theme?.ribbonGradient,
    ribbon_tagline: c.theme?.ribbonTagline, ribbon_title: c.theme?.ribbonTitle,
    status_bar_on_ribbon: c.theme?.statusBarOnRibbon,
    worker_name: read('wrangler.jsonc').match(/"name"\s*:\s*"([^"]+)"/)?.[1],
    version_confirmed: true, scheme_confirmed: true, identifiers_confirmed: true,
  };
}

const missing = value => value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
function fillMissing(current, source) {
  const next = { ...current };
  for (const [key, value] of Object.entries(source)) if (missing(next[key]) && !missing(value)) next[key] = value;
  return next;
}

async function main() {
  const sql = require('../src/config/db');
  const { schoolSupabaseAdmin } = require('../src/config/supabase');
  const { ensureSchoolConfigurationSchema } = require('../src/services/schoolConfiguration');
  const { supabaseStorage, BUCKET } = require('../src/services/schoolPackageWorker');
  const apply = process.argv.includes('--apply');
  try {
    const clusters = await sql`SELECT cluster_id, school_supabase_url FROM clusters`;
    const schools = await sql`SELECT * FROM schools ORDER BY id`;
    const drafts = await sql`SELECT * FROM school_config_drafts`;
    const entries = catalog();
    const plan = entries.map(entry => {
      const cluster = clusters.find(c => c.school_supabase_url === entry.supabaseUrl);
      if (!cluster) throw new Error(`No matching cluster for ${entry.folder}`);
      const school = schools.find(s => s.cluster_id === cluster.cluster_id && s.id === entry.schoolId);
      if (!school) throw new Error(`No matching school for ${entry.folder} (id ${entry.schoolId})`);
      const config = Object.fromEntries(Object.entries(extractConfig(entry)).filter(([, v]) => v !== undefined));
      const mapping = { name: 'official_name', code: 'school_code', address: 'address', contact_phone: 'contact_phone', contact_email: 'contact_email', android_package: 'android_package', ios_bundle_id: 'ios_bundle_id', primary_color: 'primary' };
      const proposed = Object.fromEntries(Object.entries(mapping).map(([key, src]) => [key, config[src]]));
      const filled = fillMissing(school, proposed);
      const patch = Object.fromEntries(Object.entries(filled).filter(([k,v]) => v !== school[k]));
      const conflicts = Object.entries(proposed).filter(([k,v]) => !missing(v) && !missing(school[k]) && school[k] !== v).map(([field, source]) => ({field, database:school[field], source}));
      const existing = drafts.find(d => d.cluster_id === cluster.cluster_id && d.school_id === school.id);
      const draftConfig = existing ? fillMissing(existing.config, config) : { ...backfillFromSchool(school, 'backfill'), ...config, origin: 'backfill' };
      return { entry, cluster, school, config, patch, conflicts, existing, draftConfig };
    });
    const report = plan.map(p => ({folder:p.entry.folder, cluster:p.cluster.cluster_id, school_id:p.school.id, filled_fields:Object.keys(p.patch), conflicts:p.conflicts}));
    console.log(JSON.stringify({apply, schools:report}, null, 2));
    if (!apply) return;
    const backupDir = path.join(__dirname, '../.school-library-backups');
    fs.mkdirSync(backupDir, { recursive:true, mode:0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    fs.writeFileSync(path.join(backupDir, `${stamp}.json`), JSON.stringify({schools,drafts,report},null,2), {mode:0o600});
    await ensureSchoolConfigurationSchema(sql);
    const bucket = await schoolSupabaseAdmin.storage.getBucket(BUCKET);
    if (bucket.error) {
      const created = await schoolSupabaseAdmin.storage.createBucket(BUCKET, {public:false, fileSizeLimit:52428800});
      if (created.error) throw created.error;
    } else if (bucket.data.public) throw new Error('School package bucket must be private');
    const storage = supabaseStorage();
    for (const p of plan) {
      const encoded = encodeFolder(p.entry);
      const objectPath = `${p.cluster.cluster_id}/library/${encoded.sha256}.json.gz`;
      await storage.put(objectPath, encoded.body, 'application/gzip');
      const stored = await storage.get(objectPath);
      const hash = require('crypto').createHash('sha256').update(stored || '').digest('hex');
      if (hash !== encoded.sha256) throw new Error(`Upload verification failed: ${p.entry.folder}`);
      const assetSpecs = {logo:'assets/images/icon.png',app_icon:'assets/images/icon-v2.png',campus_photo:'assets/images/schoolImage.png'};
      const importedAssets = [];
      for (const [slot, relative] of Object.entries(assetSpecs)) {
        const full = path.join(p.entry.dirPath, relative);
        if (!fs.existsSync(full)) continue;
        const bytes = fs.readFileSync(full);
        const digest = require('crypto').createHash('sha256').update(bytes).digest('hex');
        const meta = await require('sharp')(bytes).metadata();
        const storagePath = `${p.cluster.cluster_id}/${p.school.id}/library-assets/${digest}.${meta.format}`;
        const mime = `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`;
        await storage.put(storagePath, bytes, mime);
        importedAssets.push({slot,digest,storagePath,mime,width:meta.width,height:meta.height,byteSize:bytes.length});
      }
      await sql.begin(async tx => {
        for (const sourceId of p.entry.isTemplate ? [0, p.school.id, -1] : [p.school.id]) {
          const sourceCluster = sourceId === -1 ? '*' : p.cluster.cluster_id;
          const storedId = sourceId === -1 ? 0 : sourceId;
          await tx`INSERT INTO school_folder_sources (cluster_id,school_id,folder,storage_path,sha256,config,file_count)
            VALUES (${sourceCluster},${storedId},${p.entry.folder},${objectPath},${encoded.sha256},${tx.json(p.config)},${encoded.fileCount})
            ON CONFLICT (cluster_id,school_id) DO UPDATE SET folder=EXCLUDED.folder, storage_path=EXCLUDED.storage_path,
              sha256=EXCLUDED.sha256, config=EXCLUDED.config, file_count=EXCLUDED.file_count, imported_at=NOW()`;
        }
        // Lock and recompute missing fields to preserve edits made during the import.
        const [school] = await tx`SELECT * FROM schools WHERE id=${p.school.id} AND cluster_id=${p.cluster.cluster_id} FOR UPDATE`;
        for (const [key,value] of Object.entries(p.patch)) if (missing(school[key])) {
          await tx`UPDATE schools SET ${tx({[key]:value})} WHERE id=${school.id} AND cluster_id=${p.cluster.cluster_id}`;
        }
        let [current] = await tx`SELECT * FROM school_config_drafts WHERE cluster_id=${p.cluster.cluster_id} AND school_id=${p.school.id} FOR UPDATE`;
        if (!current) {
          await tx`INSERT INTO school_config_drafts (cluster_id,school_id,config,origin) VALUES (${p.cluster.cluster_id},${p.school.id},${tx.json(p.draftConfig)},'backfill')`;
        } else {
          const next = fillMissing(current.config, p.config);
          if (JSON.stringify(next) !== JSON.stringify(current.config)) await tx`UPDATE school_config_drafts SET config=${tx.json(next)},version=version+1,updated_at=NOW() WHERE cluster_id=${p.cluster.cluster_id} AND school_id=${p.school.id}`;
        }
        [current] = await tx`SELECT * FROM school_config_drafts WHERE cluster_id=${p.cluster.cluster_id} AND school_id=${p.school.id} FOR UPDATE`;
        const assetIds = {...current.asset_ids};
        for (const a of importedAssets) {
          if (assetIds[a.slot]) continue;
          const [asset] = await tx`INSERT INTO school_config_assets(cluster_id,school_id,slot,storage_path,sha256,mime,width,height,byte_size)
            VALUES (${p.cluster.cluster_id},${p.school.id},${a.slot},${a.storagePath},${a.digest},${a.mime},${a.width},${a.height},${a.byteSize}) RETURNING id`;
          assetIds[a.slot] = asset.id;
        }
        if (JSON.stringify(assetIds) !== JSON.stringify(current.asset_ids)) await tx`UPDATE school_config_drafts SET asset_ids=${tx.json(assetIds)},version=version+1,updated_at=NOW() WHERE cluster_id=${p.cluster.cluster_id} AND school_id=${p.school.id}`;
      });
      console.log(`Imported and verified: ${p.entry.folder} (${encoded.fileCount} files)`);
    }
    fs.writeFileSync(path.join(backupDir, `${stamp}-report.json`), JSON.stringify(report,null,2), {mode:0o600});
  } finally { await sql.end(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode=1; });
module.exports = { literals, extractConfig, fillMissing };
