const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const {
  TEMPLATE_VERSION,
  GALLERY_CONTACT_URL,
  ENV_KEYS,
  effectiveConfig,
  collectBlockers,
  publicClusterSnapshot,
} = require('./schoolConfigSchema');

const TEMPLATE_DIR = path.join(__dirname, '../../templates/schoolims/v1');
const ZIP_DATE = new Date('2026-01-01T00:00:00Z');
const KEEP = new Set(JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'constants.keep.json'), 'utf8')).doNotGenerate);

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
}

function assertSafeRelative(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '')) {
    const error = new Error(`Unsafe package path: ${relativePath}`);
    error.status = 400;
    error.code = 'UNSAFE_PATH';
    throw error;
  }
  if (KEEP.has(normalized)) {
    const error = new Error(`${normalized} is shared application code and is not generated`);
    error.status = 400;
    error.code = 'SHARED_FILE';
    throw error;
  }
  return normalized;
}

function formatEnvValue(value) {
  const text = String(value ?? '');
  if (/[\u0000\r\n]/.test(text)) {
    const error = new Error('Environment values cannot contain line breaks');
    error.status = 400;
    error.code = 'UNSAFE_ENV';
    throw error;
  }
  if (/[\s#"'\\=]/.test(text)) return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return text;
}

function envMap(config, schoolId, snapshot) {
  return {
    EXPO_PUBLIC_SCHOOL_ID: String(schoolId),
    EXPO_PUBLIC_SCHOOL_CODE: config.school_code,
    EXPO_PUBLIC_SCHOOL_NAME: config.app_display_name,
    EXPO_PUBLIC_API_URL: snapshot.school_backend_url,
    EXPO_PUBLIC_SUPABASE_URL: snapshot.school_supabase_url,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: snapshot.school_anon_key,
  };
}

function renderEnv(config, schoolId, snapshot) {
  const map = envMap(config, schoolId, snapshot);
  const extra = Object.keys(map).filter((key) => !ENV_KEYS.includes(key));
  if (extra.length) throw new Error(`Env key is not allowlisted: ${extra.join(', ')}`);
  return `${ENV_KEYS.map((key) => `${key}=${formatEnvValue(map[key])}`).join('\n')}\n`;
}

function profileName(clusterId, schoolId) {
  return `school-${String(clusterId).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${schoolId}`.replace(/-+/g, '-');
}

function renderAppJson(config, options) {
  const app = JSON.parse(readTemplate('app.base.json'));
  const platforms = config.platforms;
  const notificationIcon = options.notificationDedicated
    ? './assets/images/notification-icon.png'
    : './assets/images/icon-v2.png';
  app.expo.name = config.app_display_name;
  app.expo.slug = config.slug;
  app.expo.version = config.version;
  app.expo.platforms = platforms;
  app.expo.scheme = config.scheme;
  app.expo.owner = config.owner || 'nexsyrus';
  app.expo.icon = './assets/images/icon-v2.png';
  app.expo.web.favicon = './assets/images/favicon.png';
  app.expo.notification.icon = notificationIcon;
  app.expo.notification.color = config.notification_color || config.primary;
  app.expo.android.package = config.android_package;
  app.expo.android.versionCode = config.android_version_code || 1;
  app.expo.android.adaptiveIcon.backgroundColor = config.adaptive_background || '#E6F4FE';
  app.expo.android.adaptiveIcon.foregroundImage = './assets/images/icon-v2.png';
  app.expo.android.adaptiveIcon.monochromeImage = './assets/images/icon-v2.png';
  app.expo.ios.bundleIdentifier = config.ios_bundle_id || config.android_package;
  app.expo.ios.buildNumber = String(config.ios_build_number || '1');
  const splash = app.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
  if (splash) {
    splash[1].backgroundColor = config.splash_background || '#FFFFFF';
    splash[1].image = './assets/images/icon.png';
  }
  const notifications = app.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-notifications');
  if (notifications) {
    notifications[1].color = config.notification_color || config.primary;
    notifications[1].icon = notificationIcon === './assets/images/notification-icon.png'
      ? './assets/images/notification-icon.png'
      : './assets/images/icon.png';
  }
  if (platforms.includes('android')) app.expo.android.googleServicesFile = './google-services.json';
  else delete app.expo.android.googleServicesFile;
  if (platforms.includes('ios')) app.expo.ios.googleServicesFile = './GoogleService-Info.plist';
  else delete app.expo.ios.googleServicesFile;
  if (platforms.some((platform) => platform === 'android' || platform === 'ios')) {
    app.expo.extra.eas = { projectId: config.eas_project_id };
  }
  return `${JSON.stringify(app, null, 2)}\n`;
}

function renderEasJson(config, schoolId, clusterId, snapshot) {
  const eas = JSON.parse(readTemplate('eas.base.json'));
  const name = profileName(clusterId, schoolId);
  const env = envMap(config, schoolId, snapshot);
  eas.build[name] = {
    extends: 'base',
    android: { buildType: 'apk' },
    env,
  };
  eas.build[`${name}-production`] = {
    extends: name,
    distribution: 'store',
    autoIncrement: true,
    channel: 'production',
    android: { buildType: 'app-bundle' },
  };
  eas.build[`${name}-production-apk`] = {
    extends: name,
    distribution: 'internal',
    autoIncrement: true,
    channel: 'production',
    android: { buildType: 'apk' },
  };
  if (eas.submit) delete eas.submit;
  return `${JSON.stringify(eas, null, 2)}\n`;
}

function renderWrangler(workerName) {
  const base = JSON.parse(readTemplate('wrangler.base.json'));
  base.name = workerName;
  const json = JSON.stringify(base, null, 2);
  return `${json.replace(
    '"not_found_handling": "single-page-application"',
    '// SPA fallback: a deep link that is not a built file is served dist/index.html with HTTP 200.\n    "not_found_handling": "single-page-application"',
  )}\n`;
}

function tsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function tsColor(value) {
  const color = String(value || '').toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) {
    const error = new Error(`Refusing to emit an unsafe color: ${value}`);
    error.code = 'UNSAFE_COLOR';
    throw error;
  }
  return JSON.stringify(color);
}

function renderSchoolConfigTs(config) {
  const light = config.light;
  const dark = config.dark;
  const ribbon = config.ribbon;
  const gallery = config.website_gallery_enabled
    ? `{
    enabled: true,
    unavailableTitle: 'Build Your School Website',
    unavailableMessage: 'You need to build a website first. Contact Nexsyrus to Build Your Own Website.',
    contactUrl: ${tsString(GALLERY_CONTACT_URL)},
  }`
    : `{
    enabled: false,
    unavailableTitle: 'Build Your School Website',
    unavailableMessage: 'You need to build a website first. Contact Nexsyrus to Build Your Own Website.',
    contactUrl: ${tsString(GALLERY_CONTACT_URL)},
  }`;
  const middle = `
export const schoolTheme: { light: SchoolTheme; dark: SchoolTheme } = {
  light: {
    ...defaultLightTheme,
    colors: {
      ...defaultLightTheme.colors,
      primary: ${tsColor(light.primary)},
      primaryLight: ${tsColor(light.primaryLight)},
      primaryDark: ${tsColor(light.primaryDark)},
      secondary: ${tsColor(light.secondary)},
      accent: ${tsColor(light.accent)},
      info: ${tsColor(light.primary)},
      notification: ${tsColor(light.secondary)},
      navIconActive: ${tsColor(light.primary)},
    },
  },
  dark: {
    ...defaultDarkTheme,
    colors: {
      ...defaultDarkTheme.colors,
      primary: ${tsColor(dark.primary)},
      primaryLight: ${tsColor(dark.primaryLight)},
      primaryDark: ${tsColor(dark.primaryDark)},
      secondary: ${tsColor(dark.secondary)},
      accent: ${tsColor(dark.accent)},
      info: ${tsColor(dark.primary)},
      notification: ${tsColor(dark.secondary)},
      navIconActive: ${tsColor(dark.primaryLight)},
    },
  },
};

export const SCHOOL_CONFIG = {
  name: ${tsString(config.official_name)},
  tagline: ${tsString(config.tagline)},
  motto: ${tsString(config.motto)},
  logo: require('../../assets/images/icon.png'),
  address: ${tsString(config.address)},
  contact: ${tsString(config.contact_phone)},
  email: ${tsString(config.contact_email)},
  website: ${tsString(config.website)},
  websiteGallery: ${gallery},
  cbseAffiliationNo: ${tsString(config.affiliation_label)},
  schoolCode: ${tsString(config.school_code)},
  recognitionLine: ${tsString(config.recognition_line)},
  recognitionNo: ${tsString(config.recognition_no)},
  theme: {
    accent: ${tsColor(config.accent || light.accent)},
    ribbonTagline: ${tsColor(config.ribbon_tagline)},
    ribbonGradient: ${JSON.stringify(ribbon)} as const,
    ribbonGradientLocations: [0, 0.30, 0.65, 1] as const,
    ribbonTitle: ${tsColor(config.ribbon_title || '#FFFFFF')},
    marqueeSeparator: 'rgba(255,255,255,0.85)',
    ribbonBody: 'rgba(255,255,255,0.92)',
    ribbonBodyMuted: 'rgba(255,255,255,0.9)',
    statusBarOnRibbon: ${tsString(config.status_bar_on_ribbon || 'light')} as 'light' | 'dark',
  },
};
`;
  return `${readTemplate('schoolConfig.head.ts').trim()}\n${middle}\n${readTemplate('schoolConfig.tail.ts').trim()}\n`;
}

function folderName(config, clusterId, schoolId, revision) {
  return `${config.slug}-${clusterId}-${schoolId}-r${revision}`;
}

function packageFiles(config, options) {
  const files = [
    { path: 'SchoolIMS-Frontend/app.json', body: options.appJson },
    { path: 'SchoolIMS-Frontend/eas.json', body: options.easJson },
    { path: 'SchoolIMS-Frontend/wrangler.jsonc', body: options.wrangler },
    { path: 'SchoolIMS-Frontend/.env', body: options.envFile },
    { path: 'SchoolIMS-Frontend/src/constants/schoolConfig.ts', body: options.schoolConfig },
    { path: 'SchoolIMS-Frontend/assets/images/icon.png', body: options.assets.logo },
    { path: 'SchoolIMS-Frontend/assets/images/icon-v2.png', body: options.assets.app_icon },
    { path: 'SchoolIMS-Frontend/assets/images/favicon.png', body: options.assets.favicon || options.assets.app_icon },
    { path: 'SchoolIMS-Frontend/assets/images/schoolImage.png', body: options.assets.campus_photo },
  ];
  if (options.notificationDedicated && options.assets.notification_icon) {
    files.push({ path: 'SchoolIMS-Frontend/assets/images/notification-icon.png', body: options.assets.notification_icon });
  }
  if (config.platforms.includes('android') && options.assets.google_services) {
    files.push({ path: 'SchoolIMS-Frontend/google-services.json', body: options.assets.google_services });
  }
  if (config.platforms.includes('ios') && options.assets.google_service_info_plist) {
    files.push({ path: 'SchoolIMS-Frontend/GoogleService-Info.plist', body: options.assets.google_service_info_plist });
  }
  return files.map((file) => ({ ...file, path: assertSafeRelative(file.path.replace(/^SchoolIMS-Frontend\//, '')) && file.path }));
}

function buildDocuments(config, meta) {
  const schoolConfigDoc = {
    template_version: TEMPLATE_VERSION,
    cluster_id: meta.clusterId,
    school_id: meta.schoolId,
    revision: meta.revision,
    config,
    cluster_snapshot: meta.snapshot,
  };
  const manifestFiles = meta.files.map((file) => ({
    path: file.path,
    sha256: crypto.createHash('sha256').update(file.body).digest('hex'),
    bytes: Buffer.byteLength(file.body),
    action: 'replace',
  }));
  const manifest = {
    templateVersion: TEMPLATE_VERSION,
    cluster_id: meta.clusterId,
    school_id: meta.schoolId,
    revision: meta.revision,
    folder: meta.folder,
    platforms_requested: config.platforms,
    platforms_included: config.platforms,
    files: manifestFiles,
    require_present: ['src/constants/school.ts'],
    do_not_replace: [...KEEP],
  };
  const report = {
    ok: true,
    blockers: [],
    checks: [
      'json_roundtrip',
      'env_allowlist',
      'asset_paths',
      'no_service_role',
      'firebase_package_match',
    ],
  };
  const readme = [
    `# ${config.official_name} configuration package`,
    '',
    `Revision ${meta.revision} for school ${meta.schoolId} on ${meta.clusterId}.`,
    'This is a SchoolIMS frontend configuration package. It is not an APK and it does not deploy anything.',
    '',
    'Apply it from a SchoolIMS checkout that advertises the same template version:',
    '',
    '```bash',
    'node scripts/apply-school-package.mjs /path/to/this.zip .',
    '```',
    '',
    'The script replaces only the allowlisted files and leaves shared application code in place.',
    `Selected platforms: ${config.platforms.join(', ')}.`,
    config.web_domain ? `Intended web domain (not configured in Cloudflare by this package): ${config.web_domain}` : 'No web domain was recorded.',
    `EAS profile prefix: ${profileName(meta.clusterId, meta.schoolId)}.`,
    'Run scripts/new-school-setup.sh yourself after apply when Android or iOS files are included.',
    '',
  ].join('\n');
  return { schoolConfigDoc, manifest, report, readme };
}

function renderPackageParts({ rawConfig, schoolId, clusterId, revision, snapshot, assetBodies, notificationDedicated }) {
  const safeSnapshot = publicClusterSnapshot(snapshot);
  const { config } = effectiveConfig({ ...rawConfig, origin: rawConfig.origin || 'created' });
  const blockers = collectBlockers(config, {
    logo: assetBodies.logo,
    app_icon: assetBodies.app_icon,
    campus_photo: assetBodies.campus_photo,
    google_services: assetBodies.google_services,
    google_service_info_plist: assetBodies.google_service_info_plist,
  }, safeSnapshot);
  if (blockers.length) {
    const error = new Error('Configuration is not ready to package');
    error.status = 422;
    error.code = 'PLATFORM_BLOCKED';
    error.blockers = blockers;
    throw error;
  }
  const appJson = renderAppJson(config, { notificationDedicated });
  const easJson = renderEasJson(config, schoolId, clusterId, safeSnapshot);
  const envFile = renderEnv(config, schoolId, safeSnapshot);
  const wrangler = renderWrangler(config.worker_name);
  const schoolConfig = renderSchoolConfigTs(config);
  JSON.parse(appJson);
  JSON.parse(easJson);
  const easEnv = JSON.parse(easJson).build[profileName(clusterId, schoolId)].env;
  const envPairs = Object.fromEntries(envFile.trim().split('\n').map((line) => {
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    let value = line.slice(index + 1);
    if (value.startsWith('"')) value = JSON.parse(value);
    return [key, value];
  }));
  for (const key of ENV_KEYS) {
    if (String(envPairs[key]) !== String(easEnv[key])) {
      throw new Error(`Env and eas.json diverged on ${key}`);
    }
  }
  if (envFile.includes('EXPO_PUBLIC_PRIMARY_COLOR') || easJson.includes('EXPO_PUBLIC_PRIMARY_COLOR')) {
    throw new Error('Primary color must not be emitted as an env var');
  }
  if (/service_role/i.test(`${appJson}\n${easJson}\n${envFile}\n${schoolConfig}\n${wrangler}`)) {
    throw new Error('Rendered package contained a service-role marker');
  }
  const folder = folderName(config, clusterId, schoolId, revision);
  const files = packageFiles(config, {
    appJson,
    easJson,
    wrangler,
    envFile,
    schoolConfig,
    assets: assetBodies,
    notificationDedicated,
  });
  const docs = buildDocuments(config, { clusterId, schoolId, revision, snapshot: safeSnapshot, files, folder });
  const root = [
    { path: 'school-config.json', body: Buffer.from(`${JSON.stringify(docs.schoolConfigDoc, null, 2)}\n`) },
    { path: 'manifest.json', body: Buffer.from(`${JSON.stringify(docs.manifest, null, 2)}\n`) },
    { path: 'validation-report.json', body: Buffer.from(`${JSON.stringify(docs.report, null, 2)}\n`) },
    { path: 'README.md', body: Buffer.from(docs.readme) },
    ...files.map((file) => ({ path: file.path, body: Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body) })),
  ].map((file) => ({ path: `${folder}/${file.path}`.replace(/\\/g, '/'), body: file.body }));
  for (const file of root) {
    if (file.path.includes('..')) throw new Error('Unsafe archive path');
  }
  return { folder, files: root, config, manifest: docs.manifest };
}

function zipFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of ordered) archive.append(file.body, { name: file.path, date: ZIP_DATE });
    archive.finalize();
  });
}

async function renderPackage(input) {
  const parts = renderPackageParts(input);
  const zip = await zipFiles(parts.files);
  return {
    ...parts,
    zip,
    sha256: crypto.createHash('sha256').update(zip).digest('hex'),
  };
}

function snippetFromDraft(rawConfig, school, cluster) {
  const snapshot = publicClusterSnapshot(cluster);
  const { config } = effectiveConfig(rawConfig);
  const display = config.app_display_name || school.name;
  const env_file = renderEnv({
    ...config,
    school_code: config.school_code || school.code,
    app_display_name: display,
  }, school.id, snapshot);
  const app_json_changes = {
    name: display,
    slug: config.slug || `schoolims-${school.id}`,
    'android.package': config.android_package || school.android_package,
    'ios.bundleIdentifier': config.ios_bundle_id || school.ios_bundle_id,
  };
  const eas_profile = {
    [profileName(school.cluster_id || cluster.cluster_id, school.id)]: {
      extends: 'base',
      android: { buildType: 'apk' },
      env: envMap({
        ...config,
        school_code: config.school_code || school.code,
        app_display_name: display,
      }, school.id, snapshot),
    },
  };
  return {
    env_file,
    app_json_changes,
    eas_profile,
    firebase_package: config.android_package || school.android_package,
    setup_commands: [
      'node scripts/apply-school-package.mjs <downloaded.zip> .',
      './scripts/new-school-setup.sh',
    ],
  };
}

function stripGoogleServices(raw, packageName) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    const error = new Error('google-services.json is not valid JSON');
    error.status = 422;
    error.code = 'FIREBASE_INVALID';
    throw error;
  }
  if (raw.toString('utf8').includes('REPLACE THIS FILE')) {
    const error = new Error('google-services.json is still a template');
    error.status = 422;
    error.code = 'FIREBASE_PLACEHOLDER';
    throw error;
  }
  const clients = (parsed.client || []).filter((client) => client?.client_info?.android_client_info?.package_name === packageName);
  if (clients.length !== 1) {
    const error = new Error(`google-services.json must contain the Android package ${packageName}`);
    error.status = 422;
    error.code = 'FIREBASE_PACKAGE_MISMATCH';
    throw error;
  }
  return Buffer.from(`${JSON.stringify({ ...parsed, client: clients }, null, 2)}\n`);
}

function assertPlist(raw, bundleId) {
  const text = raw.toString('utf8');
  const bundle = text.match(/<key>BUNDLE_ID<\/key>\s*<string>([^<]*)<\/string>/);
  const project = text.match(/<key>PROJECT_ID<\/key>\s*<string>([^<]*)<\/string>/);
  const appId = text.match(/<key>GOOGLE_APP_ID<\/key>\s*<string>([^<]*)<\/string>/);
  const found = bundle ? bundle[1].trim() : '';
  if (!found || found !== bundleId) {
    const error = new Error(`GoogleService-Info.plist bundle ${found || '(missing)'} does not match ${bundleId}`);
    error.status = 422;
    error.code = 'FIREBASE_BUNDLE_MISMATCH';
    throw error;
  }
  if (/placeholder/i.test(found) || /placeholder/i.test(project ? project[1] : '') || /^0+$/.test((appId ? appId[1] : '').replace(/[^0-9]/g, ''))) {
    const error = new Error('GoogleService-Info.plist is still a placeholder');
    error.status = 422;
    error.code = 'FIREBASE_PLACEHOLDER';
    throw error;
  }
  return raw;
}

module.exports = {
  TEMPLATE_DIR,
  renderEnv,
  renderAppJson,
  renderEasJson,
  renderWrangler,
  renderSchoolConfigTs,
  renderPackage,
  renderPackageParts,
  snippetFromDraft,
  stripGoogleServices,
  assertPlist,
  profileName,
  formatEnvValue,
  assertSafeRelative,
};
