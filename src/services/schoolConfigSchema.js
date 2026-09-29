const crypto = require('crypto');

const TEMPLATE_VERSION = 'schoolims-template/1';
const GALLERY_CONTACT_URL = 'https://api.whatsapp.com/send?phone=917892654731&text=Hi%2C%20I%20want%20to%20build%20a%20website%20for%20my%20school.';
const ENV_KEYS = [
  'EXPO_PUBLIC_SCHOOL_ID',
  'EXPO_PUBLIC_SCHOOL_CODE',
  'EXPO_PUBLIC_SCHOOL_NAME',
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
];

const KNOWN_KEYS = [
  'official_name',
  'app_display_name',
  'short_name',
  'school_code',
  'address',
  'contact_phone',
  'contact_email',
  'website',
  'tagline',
  'motto',
  'affiliation_label',
  'recognition_line',
  'recognition_no',
  'website_gallery_enabled',
  'primary',
  'secondary',
  'accent',
  'light',
  'dark',
  'ribbon',
  'ribbon_tagline',
  'ribbon_title',
  'status_bar_on_ribbon',
  'adaptive_background',
  'splash_background',
  'notification_color',
  'slug',
  'owner',
  'scheme',
  'android_package',
  'ios_bundle_id',
  'eas_project_id',
  'platforms',
  'version',
  'version_confirmed',
  'ios_build_number',
  'android_version_code',
  'worker_name',
  'web_domain',
  'scheme_confirmed',
  'identifiers_confirmed',
];

const ASSET_SLOTS = ['logo', 'app_icon', 'splash', 'adaptive_foreground', 'notification_icon', 'favicon', 'campus_photo', 'google_services', 'google_service_info_plist'];
const PLATFORMS = ['android', 'ios', 'web'];
const HEX = /^#[0-9A-Fa-f]{6}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SLUG = /^[a-z0-9]+$/;
const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const WORKER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i;

function coded(status, error, code, blockers) {
  const err = new Error(error);
  err.status = status;
  err.code = code;
  if (blockers) err.blockers = blockers;
  return err;
}

function emptyConfig(origin = 'created') {
  return {
    official_name: '',
    app_display_name: '',
    short_name: '',
    school_code: '',
    address: '',
    contact_phone: '',
    contact_email: '',
    website: '',
    tagline: '',
    motto: '',
    affiliation_label: '',
    recognition_line: '',
    recognition_no: '',
    website_gallery_enabled: false,
    primary: '',
    secondary: '',
    accent: '',
    light: null,
    dark: null,
    ribbon: null,
    ribbon_tagline: '',
    ribbon_title: '#FFFFFF',
    status_bar_on_ribbon: 'light',
    adaptive_background: '',
    splash_background: '#FFFFFF',
    notification_color: '',
    slug: '',
    owner: 'nexsyrus',
    scheme: '',
    android_package: '',
    ios_bundle_id: '',
    eas_project_id: '',
    platforms: [],
    version: origin === 'created' ? '1.0.0' : '',
    version_confirmed: origin === 'created',
    ios_build_number: '1',
    android_version_code: 1,
    worker_name: '',
    web_domain: '',
    scheme_confirmed: origin === 'created',
    identifiers_confirmed: origin === 'created',
  };
}

function compactName(name) {
  return String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

function workerFromSlug(slug) {
  let name = `${slug}-nexsyrus`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (name.length > 63) name = name.slice(0, 63).replace(/-$/, '');
  return name;
}

function channels(hex) {
  const h = hex.slice(1);
  return [0, 2, 4].map((index) => parseInt(h.slice(index, index + 2), 16));
}

function mix(hex, toward, amount) {
  const a = channels(hex);
  const b = channels(toward);
  const mixed = a.map((value, index) => Math.round(value + (b[index] - value) * amount));
  return `#${mixed.map((part) => part.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function deriveColors(primary, secondary, accent) {
  const p = HEX.test(primary || '') ? primary.toUpperCase() : '#1A73E8';
  const s = HEX.test(secondary || '') ? secondary.toUpperCase() : '#F5921B';
  const a = HEX.test(accent || '') ? accent.toUpperCase() : '#F9A825';
  return {
    light: {
      primary: p,
      primaryLight: mix(p, '#FFFFFF', 0.28),
      primaryDark: mix(p, '#000000', 0.22),
      secondary: s,
      accent: a,
    },
    dark: {
      primary: mix(p, '#FFFFFF', 0.35),
      primaryLight: mix(p, '#FFFFFF', 0.5),
      primaryDark: mix(p, '#FFFFFF', 0.15),
      secondary: mix(s, '#FFFFFF', 0.25),
      accent: mix(a, '#FFFFFF', 0.3),
    },
    ribbon: [mix(p, '#000000', 0.28), p, mix(p, '#FFFFFF', 0.12), mix(p, '#FFFFFF', 0.28)],
    ribbonTagline: mix(a, '#FFFFFF', 0.45),
    adaptiveBackground: mix(p, '#FFFFFF', 0.82),
  };
}

function suggestions(config) {
  const short = config.short_name || compactName(config.official_name);
  const slug = config.slug || slugify(short);
  const android = config.android_package || (slug ? `com.nexsyrussims.${slug}` : '');
  const colors = deriveColors(config.primary, config.secondary, config.accent);
  return {
    app_display_name: config.official_name || '',
    short_name: short,
    slug,
    android_package: android,
    ios_bundle_id: config.ios_bundle_id || android,
    scheme: slug ? `schoolims${slug}` : '',
    worker_name: slug ? workerFromSlug(slug) : '',
    version: '1.0.0',
    owner: 'nexsyrus',
    colors,
  };
}

function isBackfill(config) {
  return config.origin === 'backfill';
}

function effectiveConfig(config) {
  const stored = { ...emptyConfig(config.origin || 'created'), ...config };
  const suggested = suggestions(stored);
  const next = { ...stored };
  const fill = ['app_display_name', 'short_name', 'slug', 'worker_name', 'owner'];
  if (!isBackfill(stored)) fill.push('android_package', 'ios_bundle_id', 'scheme', 'version');
  if (stored.android_package && !stored.ios_bundle_id && !isBackfill(stored)) next.ios_bundle_id = stored.android_package;
  for (const key of fill) {
    if (!next[key] && suggested[key]) next[key] = suggested[key];
  }
  if (isBackfill(stored)) {
    if (!stored.scheme_confirmed) next.scheme = stored.scheme || '';
    if (!stored.version_confirmed) next.version = stored.version || '';
    if (!stored.identifiers_confirmed) {
      next.slug = stored.slug || '';
      next.worker_name = stored.worker_name || '';
      next.android_package = stored.android_package || '';
      next.ios_bundle_id = stored.ios_bundle_id || '';
    }
  }
  const colors = deriveColors(next.primary, next.secondary, next.accent);
  next.light = stored.light || (next.primary ? colors.light : null);
  next.dark = stored.dark || (next.primary ? colors.dark : null);
  next.ribbon = stored.ribbon || (next.primary ? colors.ribbon : null);
  if (!next.ribbon_tagline && next.primary) next.ribbon_tagline = colors.ribbonTagline;
  if (!next.notification_color && next.primary) next.notification_color = next.primary;
  if (!next.adaptive_background && next.primary) next.adaptive_background = colors.adaptiveBackground;
  if (!next.splash_background) next.splash_background = '#FFFFFF';
  if (!next.ribbon_title) next.ribbon_title = '#FFFFFF';
  return { config: next, suggestions: suggested };
}

function blocker(field, platform, message) {
  return { field, platform: platform || null, message };
}

function collectBlockers(rawConfig, assets = {}, clusterSnapshot = null) {
  const { config } = effectiveConfig(rawConfig || {});
  const blocks = [];
  const need = (field, message, platform) => {
    if (!config[field]) blocks.push(blocker(field, platform, message));
  };
  need('official_name', 'Official school name is required.');
  need('app_display_name', 'App display name is required.');
  need('school_code', 'School code is required.');
  need('address', 'Address is required for the letterhead.');
  need('slug', 'Expo slug is required. Accept the suggestion or enter one.');
  need('scheme', 'URL scheme is required. Existing schools must confirm the scheme already shipped.');
  need('worker_name', 'Cloudflare worker name is required.');
  need('primary', 'Primary color is required.');
  if (!config.platforms || !config.platforms.length) {
    blocks.push(blocker('platforms', null, 'Select at least one platform.'));
  }
  if (config.version && !SEMVER.test(config.version)) {
    blocks.push(blocker('version', null, 'Version must be semantic, such as 1.0.0.'));
  } else if (!config.version) {
    blocks.push(blocker('version', null, 'Confirm the application version.'));
  }
  if (isBackfill(rawConfig || {}) && !rawConfig.version_confirmed) {
    blocks.push(blocker('version', null, 'Confirm the version this school already ships before generating a package.'));
  }
  const platforms = new Set(config.platforms || []);
  if (platforms.has('android')) {
    if (!config.android_package) blocks.push(blocker('android_package', 'android', 'Android package name is required.'));
    if (!config.eas_project_id) blocks.push(blocker('eas_project_id', 'android', 'EAS project ID is required for Android. Paste it from the Expo project. It is not generated here.'));
    if (!assets.google_services) blocks.push(blocker('google_services', 'android', 'Upload google-services.json for this Android package.'));
  }
  if (platforms.has('ios')) {
    if (!config.ios_bundle_id) blocks.push(blocker('ios_bundle_id', 'ios', 'iOS bundle identifier is required.'));
    if (!config.eas_project_id) blocks.push(blocker('eas_project_id', 'ios', 'EAS project ID is required for iOS.'));
    if (!assets.google_service_info_plist) blocks.push(blocker('google_service_info_plist', 'ios', 'Upload GoogleService-Info.plist for this iOS bundle.'));
  }
  if (!assets.logo) blocks.push(blocker('logo', null, 'Upload the school logo.'));
  if (!assets.app_icon) blocks.push(blocker('app_icon', null, 'Upload the app icon.'));
  if (!assets.campus_photo) blocks.push(blocker('campus_photo', null, 'Upload the campus photograph used by the admin header.'));
  if (clusterSnapshot) {
    if (!clusterSnapshot.school_backend_url) blocks.push(blocker('api_url', null, 'The assigned cluster has no school API URL.'));
    if (!clusterSnapshot.school_supabase_url) blocks.push(blocker('supabase_url', null, 'The assigned cluster has no Supabase URL.'));
    if (!clusterSnapshot.school_anon_key) blocks.push(blocker('supabase_anon_key', null, 'The assigned cluster has no public client key.'));
  }
  return blocks;
}

function assertHex(value, field) {
  if (!value) return '';
  if (!HEX.test(value)) throw coded(400, `${field} must be a #RRGGBB color`, 'INVALID_FIELD');
  return value.toUpperCase();
}

function normalizeField(key, value) {
  if (value == null) return value;
  if (key === 'platforms') {
    if (!Array.isArray(value)) throw coded(400, 'platforms must be a list', 'INVALID_FIELD');
    const unique = [...new Set(value.map((item) => String(item).toLowerCase()))];
    if (unique.some((item) => !PLATFORMS.includes(item))) throw coded(400, 'platforms must be android, ios, or web', 'INVALID_FIELD');
    return unique;
  }
  if (key === 'website_gallery_enabled' || key === 'version_confirmed' || key === 'scheme_confirmed' || key === 'identifiers_confirmed') {
    return Boolean(value);
  }
  if (key === 'android_version_code') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw coded(400, 'android_version_code must be a positive integer', 'INVALID_FIELD');
    return number;
  }
  if (key === 'light' || key === 'dark') {
    if (!value || typeof value !== 'object') throw coded(400, `${key} colors must be an object`, 'INVALID_FIELD');
    const next = {};
    for (const colorKey of ['primary', 'primaryLight', 'primaryDark', 'secondary', 'accent']) {
      next[colorKey] = assertHex(value[colorKey] || '', `${key}.${colorKey}`);
    }
    return next;
  }
  if (key === 'ribbon') {
    if (!Array.isArray(value) || value.length !== 4) throw coded(400, 'ribbon must be four colors', 'INVALID_FIELD');
    return value.map((color, index) => assertHex(color, `ribbon[${index}]`));
  }
  if (['primary', 'secondary', 'accent', 'ribbon_tagline', 'ribbon_title', 'adaptive_background', 'splash_background', 'notification_color'].includes(key)) {
    return assertHex(String(value || ''), key);
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw coded(400, `${key} has an invalid type`, 'INVALID_FIELD');
  const text = String(value).trim();
  if (/[\u0000\r\n]/.test(text)) throw coded(400, `${key} cannot contain line breaks`, 'INVALID_FIELD');
  if (key === 'school_code' && text && !/^[A-Z0-9-]{2,32}$/.test(text)) throw coded(400, 'School code must be uppercase letters, numbers, or hyphens', 'INVALID_FIELD');
  if (key === 'slug' && text && !SLUG.test(text)) throw coded(400, 'Slug must be lowercase letters and numbers', 'INVALID_FIELD');
  if ((key === 'android_package' || key === 'ios_bundle_id') && text && !PACKAGE_NAME.test(text)) throw coded(400, `${key} must be a reverse-DNS identifier`, 'INVALID_FIELD');
  if (key === 'scheme' && text && !/^[a-z][a-z0-9+.-]{1,63}$/.test(text)) throw coded(400, 'URL scheme is invalid', 'INVALID_FIELD');
  if (key === 'worker_name' && text && !WORKER.test(text)) throw coded(400, 'Worker name must be a Cloudflare worker token', 'INVALID_FIELD');
  if (key === 'eas_project_id' && text && !UUID.test(text)) throw coded(400, 'EAS project ID must be a UUID from the Expo project', 'INVALID_FIELD');
  if (key === 'version' && text && !SEMVER.test(text)) throw coded(400, 'Version must look like 1.0.0', 'INVALID_FIELD');
  if (key === 'contact_email' && text && !EMAIL.test(text)) throw coded(400, 'Contact email is invalid', 'INVALID_FIELD');
  if (key === 'website' && text && !HOST.test(text)) throw coded(400, 'Website must be a hostname or http(s) URL', 'INVALID_FIELD');
  if (key === 'web_domain' && text && !/^[a-z0-9.-]+$/i.test(text)) throw coded(400, 'Web domain must be a hostname', 'INVALID_FIELD');
  if (key === 'owner' && text && !/^[a-z0-9][a-z0-9-]{1,30}$/i.test(text)) throw coded(400, 'Expo owner is invalid', 'INVALID_FIELD');
  if (key === 'status_bar_on_ribbon' && text && !['light', 'dark'].includes(text)) throw coded(400, 'status bar style must be light or dark', 'INVALID_FIELD');
  if (['official_name', 'app_display_name'].includes(key) && text.length > 120) throw coded(400, `${key} is too long`, 'INVALID_FIELD');
  if (['tagline', 'motto'].includes(key) && text.length > 80) throw coded(400, `${key} is too long`, 'INVALID_FIELD');
  return text;
}

function applyPatch(current, patch, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw coded(400, 'config object is required', 'INVALID_CONFIG');
  const unknown = Object.keys(patch).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length) throw coded(400, `Unknown fields: ${unknown.join(', ')}`, 'UNKNOWN_FIELD');
  const base = { ...emptyConfig(current.origin || 'created'), ...current };
  if (patch.owner !== undefined && patch.owner !== base.owner && !options.isFounder) {
    throw coded(403, 'Only the founder can change the Expo owner', 'OWNER_LOCKED');
  }
  const next = { ...base };
  for (const key of KNOWN_KEYS) {
    if (patch[key] !== undefined) next[key] = normalizeField(key, patch[key]);
  }
  if (patch.scheme) next.scheme_confirmed = true;
  if (patch.version) next.version_confirmed = true;
  if (patch.slug || patch.worker_name || patch.android_package || patch.ios_bundle_id) next.identifiers_confirmed = true;
  return next;
}

function backfillFromSchool(school, origin) {
  const config = emptyConfig(origin);
  config.official_name = school.name || '';
  config.school_code = school.code || '';
  config.address = school.address || '';
  config.contact_phone = school.contact_phone || '';
  config.contact_email = school.contact_email || '';
  config.android_package = school.android_package || '';
  config.ios_bundle_id = school.ios_bundle_id || '';
  config.primary = HEX.test(school.primary_color || '') ? school.primary_color.toUpperCase() : (school.primary_color ? '' : '');
  if (origin === 'created') {
    const suggested = suggestions({ ...config, origin });
    config.app_display_name = suggested.app_display_name;
    config.short_name = suggested.short_name;
    config.slug = suggested.slug;
    config.android_package = config.android_package || suggested.android_package;
    config.ios_bundle_id = config.ios_bundle_id || suggested.ios_bundle_id;
    config.scheme = suggested.scheme;
    config.worker_name = suggested.worker_name;
    config.version = '1.0.0';
    config.version_confirmed = true;
    config.scheme_confirmed = true;
    config.identifiers_confirmed = true;
    config.platforms = [];
  }
  return config;
}

function publicClusterSnapshot(cluster) {
  if (!cluster) return null;
  const snapshot = {
    school_backend_url: cluster.school_backend_url || '',
    school_supabase_url: cluster.school_supabase_url || '',
    school_anon_key: cluster.school_anon_key || '',
  };
  const serialized = JSON.stringify(snapshot);
  if (/service_role|BEGIN (RSA |OPENSSH |PRIVATE )KEY/i.test(serialized)) {
    throw coded(500, 'Cluster snapshot contained a secret and was refused', 'SECRET_REFUSED');
  }
  return snapshot;
}

function diffValues(from, to) {
  const left = from || {};
  const right = to || {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => ({ field: key, from: left[key] ?? null, to: right[key] ?? null }));
}

function hashRequest(draft, snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: draft.version,
    config: draft.config,
    asset_ids: draft.asset_ids || {},
    snapshot,
    template: TEMPLATE_VERSION,
  })).digest('hex');
}

module.exports = {
  TEMPLATE_VERSION,
  GALLERY_CONTACT_URL,
  ENV_KEYS,
  KNOWN_KEYS,
  ASSET_SLOTS,
  emptyConfig,
  suggestions,
  effectiveConfig,
  collectBlockers,
  applyPatch,
  backfillFromSchool,
  publicClusterSnapshot,
  diffValues,
  hashRequest,
  deriveColors,
  slugify,
  coded,
  HEX,
};
