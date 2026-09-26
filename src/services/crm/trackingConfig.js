const { CrmError } = require('./errors');

const ATTRIBUTION_RULE_VERSION = 1;
const CLASSIFIER_VERSION = 1;
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

function readFlag(key) {
  const value = process.env[key];
  if (value === undefined || value === '') return false;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean environment variable: ${key}`);
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function currentTrackingConfig() {
  return {
    write: readFlag('CRM_FEATURE_TRACK_WRITE'),
    resolve: readFlag('CRM_FEATURE_TRACK_RESOLVE'),
    attribution: readFlag('CRM_FEATURE_TRACK_ATTRIBUTION'),
    reports: readFlag('CRM_FEATURE_TRACK_REPORTS'),
    publicOrigin: String(process.env.TRACKING_PUBLIC_ORIGIN || '').trim().replace(/\/$/, ''),
    ingressSecret: String(process.env.TRACKING_INGRESS_SECRET || '').trim(),
    browserKeySecret: String(process.env.TRACKING_BROWSER_KEY_SECRET || process.env.TRACKING_INGRESS_SECRET || '').trim(),
    intakeSecret: String(process.env.CRM_ENQUIRY_INTAKE_SECRET || '').trim(),
    allowedHosts: splitList(process.env.TRACKING_ALLOWED_DESTINATION_HOSTS).map((host) => host.toLowerCase()),
    ownedOrigins: splitList(process.env.TRACKING_OWNED_SITE_ORIGINS),
    resolvePerMinute: Number(process.env.TRACKING_RESOLVE_PER_MINUTE || 60),
    enquiryPerMinute: Number(process.env.TRACKING_ENQUIRY_PER_MINUTE || 30),
  };
}

function assertTrackingFlag(name) {
  const config = currentTrackingConfig();
  if (!config[name]) {
    throw new CrmError(503, 'Trackable links are disabled', 'TRACK_DISABLED');
  }
  return config;
}

function assertTrackingStartup() {
  let config;
  try {
    config = currentTrackingConfig();
  } catch (err) {
    console.error(`\n❌  ${err.message}\n`);
    process.exit(1);
  }
  if (!(config.resolve || config.attribution || config.write)) return;
  if (!config.publicOrigin || !/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(config.publicOrigin)) {
    console.error('\n❌  TRACKING_PUBLIC_ORIGIN must be an https origin with no path when tracking flags are enabled\n');
    process.exit(1);
  }
  if ((config.resolve || config.attribution) && config.ingressSecret.length < 16) {
    console.error('\n❌  TRACKING_INGRESS_SECRET must be at least 16 characters when resolve or attribution is enabled\n');
    process.exit(1);
  }
}

module.exports = {
  ATTRIBUTION_RULE_VERSION,
  CLASSIFIER_VERSION,
  CONTEXT_TTL_MS,
  CODE_PATTERN,
  currentTrackingConfig,
  assertTrackingFlag,
  assertTrackingStartup,
};
