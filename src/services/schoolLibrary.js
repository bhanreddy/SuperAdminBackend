const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { gzipSync, gunzipSync } = require('zlib');
const { effectiveConfig, slugify } = require('./schoolConfigSchema');

const ZIP_DATE = new Date('2026-01-01T00:00:00Z');
const DEFAULT_ROOT = '/Volumes/PortableSSD';
const TEMPLATE_DIR_NAME = 'Default File';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function libraryRoot() {
  if (process.env.SCHOOL_LIBRARY_ROOT === '') return null;
  const configured = process.env.SCHOOL_LIBRARY_ROOT || DEFAULT_ROOT;
  try {
    if (!fs.existsSync(configured) || !fs.statSync(configured).isDirectory()) return null;
  } catch {
    return null;
  }
  return configured;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseEnv(text) {
  const map = {};
  for (const line of String(text || '').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    }
    map[key] = value;
  }
  return map;
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function safeFolderName(name) {
  const cleaned = String(name || 'School').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'School';
}

function listEntries(dir, base = dir) {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name !== '.env' && (entry.name.startsWith('.') || entry.name.startsWith('._'))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      entries.push(...listEntries(full, base));
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (!rel || rel.split('/').some((part) => part === '..' || (part.startsWith('.') && part !== '.env'))) continue;
    entries.push({ rel, full });
  }
  return entries;
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function describeDirectory(dirPath) {
  const folder = path.basename(dirPath);
  const appPath = path.join(dirPath, 'app.json');
  const easPath = path.join(dirPath, 'eas.json');
  const envPath = fs.existsSync(path.join(dirPath, '.env'))
    ? path.join(dirPath, '.env')
    : path.join(dirPath, 'env');
  let appName = '';
  let slug = '';
  let projectId = '';
  if (fs.existsSync(appPath)) {
    try {
      const app = readJson(appPath);
      appName = app?.expo?.name || '';
      slug = app?.expo?.slug || '';
      projectId = app?.expo?.extra?.eas?.projectId || '';
    } catch {
      appName = '';
    }
  }
  const env = fs.existsSync(envPath) ? parseEnv(readText(envPath)) : {};
  let schoolId = Number(env.EXPO_PUBLIC_SCHOOL_ID);
  if (!Number.isInteger(schoolId) || schoolId <= 0) schoolId = null;
  if (!schoolId && fs.existsSync(easPath)) {
    const match = readText(easPath).match(/"school-(\d+)"/);
    if (match) schoolId = Number(match[1]);
  }
  const isTemplate = folder === TEMPLATE_DIR_NAME || slug === 'demo-ims';
  return {
    folder,
    dirPath,
    isTemplate,
    schoolId,
    supabaseUrl: env.EXPO_PUBLIC_SUPABASE_URL || (() => {
      if (!fs.existsSync(easPath)) return null;
      const eas = readJson(easPath);
      return Object.values(eas.build || {}).find((v) => v.env?.EXPO_PUBLIC_SUPABASE_URL)?.env.EXPO_PUBLIC_SUPABASE_URL || null;
    })(),
    appName,
    envName: env.EXPO_PUBLIC_SCHOOL_NAME || '',
    schoolCode: env.EXPO_PUBLIC_SCHOOL_CODE || '',
    projectId,
  };
}

function catalog() {
  const root = libraryRoot();
  if (!root) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$') && entry.name !== 'System Volume Information')
    .map((entry) => describeDirectory(path.join(root, entry.name)))
    .filter((item) => fs.existsSync(path.join(item.dirPath, 'app.json')));
}

function findSchoolFolder({ schoolId, name, code, supabaseUrl }) {
  const folders = catalog().filter((item) => (!item.isTemplate || Number(schoolId) === 1) && (!supabaseUrl || !item.supabaseUrl || item.supabaseUrl === supabaseUrl));
  const id = Number(schoolId);
  const byId = folders.filter((item) => item.schoolId === id);
  if (byId.length > 1) throw new Error('Ambiguous school folder identity');
  if (byId.length === 1) return byId[0];
  const nameKey = normalize(name);
  const codeKey = normalize(code);
  const hits = folders.filter((item) => {
    if (item.schoolId && item.schoolId !== id) return false;
    const names = [item.appName, item.envName, item.folder.replace(/ file$/i, '')].map(normalize);
    if (nameKey && names.includes(nameKey)) return true;
    if (codeKey && codeKey.length >= 3 && normalize(item.schoolCode) === codeKey) return true;
    return false;
  });
  return hits.length === 1 ? hits[0] : null;
}

function templateFolder() {
  return catalog().find((item) => item.isTemplate) || null;
}

function describeLibrary({ schoolId, name, code }) {
  const exact = findSchoolFolder({ schoolId, name, code });
  if (exact) return { mode: 'exact', folder: exact.folder };
  if (templateFolder()) return { mode: 'template', folder: null };
  return { mode: null, folder: null };
}

function zipNamed(folder, files) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of ordered) {
      archive.append(file.body, { name: `${folder}/${file.path}`, date: ZIP_DATE });
    }
    archive.finalize();
  });
}

function quoteEnv(value) {
  const text = String(value ?? '');
  if (/[\u0000\r\n]/.test(text)) throw new Error('Environment values cannot contain line breaks');
  if (/[\s#"'\\=]/.test(text)) return JSON.stringify(text);
  return text;
}

function patchAppJson(body, identity) {
  const app = JSON.parse(body.toString('utf8'));
  app.expo = app.expo || {};
  app.expo.name = identity.displayName;
  app.expo.slug = identity.slug;
  app.expo.owner = identity.owner;
  app.expo.scheme = identity.scheme;
  if (identity.platforms.length) app.expo.platforms = identity.platforms;
  app.expo.android = app.expo.android || {};
  app.expo.android.versionCode = identity.androidVersionCode;
  app.expo.ios = app.expo.ios || {};
  app.expo.ios.buildNumber = identity.iosBuildNumber;
  if (identity.version) app.expo.version = identity.version;
  app.expo.android = app.expo.android || {};
  app.expo.ios = app.expo.ios || {};
  app.expo.android.package = identity.packageName;
  app.expo.ios.bundleIdentifier = identity.bundleId;
  app.expo.extra = app.expo.extra || {};
  app.expo.extra.eas = app.expo.extra.eas || {};
  if (identity.projectId) app.expo.extra.eas.projectId = identity.projectId;
  else delete app.expo.extra.eas.projectId;
  return Buffer.from(`${JSON.stringify(app, null, 2)}\n`);
}

function patchEasJson(body, identity) {
  const eas = JSON.parse(body.toString('utf8'));
  const previous = 'school-1';
  const next = `school-${identity.schoolId}`;
  const build = {};
  for (const [key, value] of Object.entries(eas.build || {})) {
    const renamed = key.replace(previous, next);
    if (value?.env && Object.hasOwn(value.env, 'EXPO_PUBLIC_API_URL')) value.env.EXPO_PUBLIC_API_URL = identity.apiUrl;
    if (value && value.extends === previous) value.extends = next;
    if (renamed === next && value.env) {
      value.env.EXPO_PUBLIC_SCHOOL_ID = String(identity.schoolId);
      value.env.EXPO_PUBLIC_SCHOOL_CODE = identity.code;
      value.env.EXPO_PUBLIC_SCHOOL_NAME = identity.displayName;
      if (identity.apiUrl) value.env.EXPO_PUBLIC_API_URL = identity.apiUrl;
      if (identity.supabaseUrl) value.env.EXPO_PUBLIC_SUPABASE_URL = identity.supabaseUrl;
      if (identity.anonKey) value.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = identity.anonKey;
    }
    build[renamed] = value;
  }
  eas.build = build;
  if (eas.submit) {
    const submit = {};
    for (const [key, value] of Object.entries(eas.submit)) {
      const renamed = key.replace(previous, next);
      if (value?.android?.serviceAccountKeyPath) {
        value.android.serviceAccountKeyPath = `./secrets/play-service-account-${next}.json`;
      }
      submit[renamed] = value;
    }
    eas.submit = submit;
  }
  return Buffer.from(`${JSON.stringify(eas, null, 2)}\n`);
}

// Keep every unrelated source byte; replace only public API values in build inputs.
function patchFolderApi(files, apiUrl) {
  if (!apiUrl) return files;
  if (/[\u0000\r\n]/.test(apiUrl)) throw new Error('Unsafe school API URL');
  return files.map(file => {
    if (!['.env', 'env', 'eas.json'].includes(file.rel)) return file;
    let text = file.body.toString('utf8');
    if (file.rel === '.env' || file.rel === 'env') {
      const pattern = /^(\s*(?:export\s+)?EXPO_PUBLIC_API_URL\s*=)[^\r\n]*/gm;
      text = pattern.test(text)
        ? text.replace(pattern, (line, prefix) => {
          const oldValue = line.slice(prefix.length).trim();
          const value = oldValue.startsWith('"') ? JSON.stringify(apiUrl)
            : oldValue.startsWith("'") ? `'${apiUrl}'` : quoteEnv(apiUrl);
          return prefix + value;
        })
        : text + (text.endsWith('\n') ? '' : '\n') + `EXPO_PUBLIC_API_URL=${quoteEnv(apiUrl)}\n`;
    } else if (file.rel === 'eas.json') {
      text = text.replace(/("EXPO_PUBLIC_API_URL"\s*:\s*)"(?:\\.|[^"\\])*"/g, (_, prefix) => prefix + JSON.stringify(apiUrl));
    } else return file;
    return { ...file, body: Buffer.from(text) };
  });
}

function patchEnv(body, identity) {
  const current = parseEnv(body.toString('utf8'));
  const apiUrl = identity.apiUrl || current.EXPO_PUBLIC_API_URL || '';
  const supabaseUrl = identity.supabaseUrl || current.EXPO_PUBLIC_SUPABASE_URL || '';
  const anonKey = identity.anonKey || current.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
  const lines = [
    `EXPO_PUBLIC_SCHOOL_ID=${identity.schoolId}`,
    `EXPO_PUBLIC_SCHOOL_CODE=${quoteEnv(identity.code)}`,
    `EXPO_PUBLIC_SCHOOL_NAME=${quoteEnv(identity.displayName)}`,
    `EXPO_PUBLIC_API_URL=${quoteEnv(apiUrl)}`,
    `EXPO_PUBLIC_SUPABASE_URL=${quoteEnv(supabaseUrl)}`,
    `EXPO_PUBLIC_SUPABASE_ANON_KEY=${quoteEnv(anonKey)}`,
    `EXPO_PUBLIC_BUNDLE_ID=${quoteEnv(identity.bundleId)}`,
    '',
  ];
  return Buffer.from(lines.join('\n'));
}

function patchWrangler(body, workerName) {
  return Buffer.from(body.toString('utf8').replace(/"name"\s*:\s*"[^"]*"/, `"name": ${JSON.stringify(workerName)}`));
}

function patchSchoolConfig(body, identity) {
  let text = body.toString('utf8');
  const start = text.indexOf('export const SCHOOL_CONFIG');
  if (start < 0) throw new Error('Template SCHOOL_CONFIG is missing');
  let section = text.slice(start);
  const values = {
    name: identity.officialName, schoolCode: identity.code, address: identity.address,
    contact: identity.phone, email: identity.email, website: identity.website,
    tagline: identity.tagline, motto: identity.motto,
    cbseAffiliationNo: identity.config.affiliation_label,
    recognitionLine: identity.config.recognition_line, recognitionNo: identity.config.recognition_no,
  };
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp('(\\b' + key + '\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')');
    section = section.replace(pattern, (_, prefix) => prefix + JSON.stringify(value || ''));
  }
  section = section.replace(/(websiteGallery:\s*{\s*enabled:\s*)(true|false)/, (_, prefix) => prefix + Boolean(identity.config.website_gallery_enabled));
  const replaceProperty = (input, key, val) => input.replace(new RegExp('(' + key + ':\\s*)([\"\'][^\"\']*[\"\']|\\[[^\\]]*\\])'), (_, prefix) => prefix + JSON.stringify(val));
  for (const [key, val] of Object.entries({ accent: identity.config.accent, ribbonTagline: identity.config.ribbon_tagline, ribbonTitle: identity.config.ribbon_title, ribbonGradient: identity.config.ribbon, statusBarOnRibbon: identity.config.status_bar_on_ribbon })) {
    if (val != null) section = replaceProperty(section, key, val);
  }
  let head = text.slice(0, start);
  const darkStart = head.indexOf('  dark:');
  if (darkStart > 0) {
    let light = head.slice(0, darkStart), dark = head.slice(darkStart);
    for (const [key, val] of Object.entries(identity.config.light || {})) light = replaceProperty(light, key, val);
    for (const [key, val] of Object.entries(identity.config.dark || {})) dark = replaceProperty(dark, key, val);
    head = light + dark;
  }
  return Buffer.from(head + section);
}

function identityFromConfig(rawConfig, schoolId, snapshot) {
  const { config } = effectiveConfig({ ...rawConfig, origin: rawConfig?.origin || 'created' });
  const officialName = config.official_name || config.app_display_name || `School ${schoolId}`;
  const displayName = config.app_display_name || officialName;
  const slug = config.slug || slugify(displayName) || `school${schoolId}`;
  const packageName = config.android_package || `com.nexsyrussims.${slug}`;
  const bundleId = config.ios_bundle_id || packageName;
  const projectId = UUID.test(config.eas_project_id || '') ? config.eas_project_id : '';
  const anonKey = require('./schoolConfigSchema').publicClusterSnapshot(snapshot || {}).school_anon_key || '';
  if (!config.official_name || !config.school_code || !snapshot?.school_backend_url || !snapshot?.school_supabase_url || !anonKey) {
    throw Object.assign(new Error('School name, code, and assigned cluster connection values are required'), {code:'FOLDER_IDENTITY_MISSING'});
  }
  if (/service_role|private_key/i.test(String(anonKey))) {
    throw Object.assign(new Error('Cluster snapshot refused'), { code: 'SECRET_REFUSED' });
  }
  return {
    schoolId: Number(schoolId),
    officialName,
    displayName,
    code: config.school_code || slug,
    slug,
    packageName,
    bundleId,
    owner: config.owner || 'nexsyrus',
    scheme: config.scheme,
    platforms: config.platforms || [],
    androidVersionCode: config.android_version_code || 1,
    iosBuildNumber: String(config.ios_build_number || '1'),
    config,
    version: config.version_confirmed ? config.version : '',
    projectId,
    workerName: config.worker_name || `${slug}-nexsyrus`,
    address: config.address || '',
    phone: config.contact_phone || '',
    email: config.contact_email || '',
    website: config.website || '',
    tagline: config.tagline || '',
    motto: config.motto || '',
    apiUrl: snapshot?.school_backend_url || '',
    supabaseUrl: snapshot?.school_supabase_url || '',
    anonKey,
  };
}

function applyIdentity(files, identity, assetBodies) {
  const replacements = {
    'app.json': (body) => patchAppJson(body, identity),
    'eas.json': (body) => patchEasJson(body, identity),
    '.env': (body) => patchEnv(body, identity),
    env: (body) => patchEnv(body, identity),
    'wrangler.jsonc': (body) => patchWrangler(body, identity.workerName),
    'constants/schoolConfig.ts': (body) => patchSchoolConfig(body, identity),
  };
  const assets = {
    'assets/images/icon.png': assetBodies?.logo,
    'assets/images/icon-v2.png': assetBodies?.app_icon,
    'assets/images/schoolImage.png': assetBodies?.campus_photo,
    'assets/images/favicon.png': assetBodies?.favicon,
    'assets/images/notification-icon.png': assetBodies?.notification_icon,
    'google-services.json': assetBodies?.google_services,
    'GoogleService-Info.plist': assetBodies?.google_service_info_plist,
  };
  const updated = files.map((file) => {
    if (assets[file.rel]) return { ...file, body: Buffer.from(assets[file.rel]) };
    if (replacements[file.rel]) return { ...file, body: replacements[file.rel](file.body) };
    return file;
  });
  for (const [rel, body] of Object.entries(assets)) {
    if (body && !updated.some(f => f.rel === rel)) updated.push({rel, path:rel, body:Buffer.from(body)});
  }
  return updated;
}

function assertNoForeignSchool(files, identity, templateProjectId) {
  const watched = files.filter((file) => /^(app\.json|eas\.json|\.env|env|wrangler\.jsonc|constants\/schoolConfig\.ts)$/.test(file.rel));
  const text = Buffer.concat(watched.map((file) => file.body)).toString('utf8');
  if (/service_role/i.test(text)) {
    throw Object.assign(new Error('School folder contained a service-role marker'), { code: 'SECRET_REFUSED' });
  }
  if (templateProjectId && text.includes(templateProjectId)) {
    throw Object.assign(new Error('New school folder still contains the template EAS project'), { code: 'TEMPLATE_IDENTITY' });
  }
  if (text.includes('com.schoolims.default2') || text.includes('demo-ims') || text.includes('Nexsyrus School IMS')) {
    throw Object.assign(new Error('New school folder still contains the template identity'), { code: 'TEMPLATE_IDENTITY' });
  }
  if (!text.includes(String(identity.schoolId)) || !text.includes(identity.displayName)) {
    throw Object.assign(new Error('New school folder is missing this school identity'), { code: 'TEMPLATE_IDENTITY' });
  }
}

async function packSchoolConstants({ schoolId, rawConfig, snapshot, assetBodies, folderSource, storage }) {
  if (folderSource) return packStoredFolder({ folderSource, storage, schoolId, rawConfig, snapshot, assetBodies });
  const root = libraryRoot();
  if (!root) return null;
  const config = rawConfig || {};
  const exact = findSchoolFolder({
    schoolId,
    name: config.official_name || config.app_display_name,
    code: config.school_code,
    supabaseUrl: snapshot?.school_supabase_url,
  });
  if (exact) {
    const files = listEntries(exact.dirPath).map((file) => ({
      rel: file.rel,
      path: file.rel,
      body: fs.readFileSync(file.full),
    }));
    const zip = await zipNamed(exact.folder, files);
    return {
      folder: exact.folder,
      source: 'exact',
      zip,
      sha256: crypto.createHash('sha256').update(zip).digest('hex'),
    };
  }
  const template = templateFolder();
  if (!template) return null;
  const identity = identityFromConfig(config, schoolId, snapshot);
  const loaded = listEntries(template.dirPath).map((file) => ({
    rel: file.rel,
    path: file.rel,
    body: fs.readFileSync(file.full),
  }));
  const files = applyIdentity(loaded, identity, assetBodies);
  assertNoForeignSchool(files, identity, template.projectId);
  const folder = safeFolderName(`${identity.officialName} File`);
  const zip = await zipNamed(folder, files);
  return {
    folder,
    source: 'template',
    zip,
    sha256: crypto.createHash('sha256').update(zip).digest('hex'),
  };
}

function encodeFolder(entry) {
  const files = listEntries(entry.dirPath).map(({ rel, full }) => ({ path: rel, body: fs.readFileSync(full).toString('base64') }));
  const body = gzipSync(Buffer.from(JSON.stringify({ folder: entry.folder, projectId: entry.projectId, files })));
  return { body, fileCount: files.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

async function storedLibrary(sql, clusterId, schoolId) {
  const rows = await sql`SELECT folder, storage_path, sha256, school_id FROM school_folder_sources
    WHERE (cluster_id = ${clusterId} AND school_id IN (${Number(schoolId)}, 0))
       OR (cluster_id = '*' AND school_id = 0)
    ORDER BY school_id DESC, (cluster_id = ${clusterId}) DESC LIMIT 1`;
  const source = rows[0];
  return source ? { ...source, mode: Number(source.school_id) === 0 ? 'template' : 'exact' } : null;
}

async function packStoredFolder({ folderSource, storage, schoolId, rawConfig, snapshot, assetBodies }) {
  const bytes = await storage.get(folderSource.storage_path);
  if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== folderSource.sha256) {
    throw Object.assign(new Error('Imported school folder is missing or its checksum failed'), { code: 'FOLDER_SOURCE_INVALID' });
  }
  const source = JSON.parse(gunzipSync(bytes).toString('utf8'));
  let files = source.files.map((file) => {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((p) => !p || p === '..')) throw new Error('Unsafe imported folder path');
    return { rel: file.path, path: file.path, body: Buffer.from(file.body, 'base64') };
  });
  let folder = source.folder;
  if (folderSource.mode === 'template') {
    const identity = identityFromConfig(rawConfig, schoolId, snapshot);
    files = applyIdentity(files, identity, assetBodies);
    assertNoForeignSchool(files, identity, source.projectId);
    folder = safeFolderName(`${identity.officialName} File`);
  }
  files = patchFolderApi(files, snapshot?.school_backend_url);
  const zip = await zipNamed(folder, files);
  return { folder, source: folderSource.mode, zip, sha256: crypto.createHash('sha256').update(zip).digest('hex') };
}

module.exports = {
  patchFolderApi,
  catalog,
  listEntries,
  encodeFolder,
  storedLibrary,
  libraryRoot,
  describeLibrary,
  findSchoolFolder,
  packSchoolConstants,
};
