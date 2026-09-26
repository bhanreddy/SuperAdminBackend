require('dotenv').config();

const required = (key) => {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    console.error(`\n❌  Missing required environment variable: ${key}\n`);
    process.exit(1);
  }
  return value.trim();
};

const optional = (key, defaultValue) => {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  return value.trim();
};

const flag = (key, defaultValue) => {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  console.error(`\n❌  Invalid boolean environment variable: ${key}\n`);
  process.exit(1);
};

const boundedInt = (key, fallback, ceiling) => {
  const value = process.env[key];
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ceiling) {
    console.error(`\n❌  Invalid integer environment variable: ${key}\n`);
    process.exit(1);
  }
  return parsed;
};

const config = {
  port: Number(optional('PORT', '4000')),
  // Canonical public backend origin used in certificate verification links.
  // When omitted, document rendering safely derives the current request origin.
  publicBaseUrl: optional('PUBLIC_BASE_URL', ''),

  // School Supabase project (JWT auth + super_admins/founders + storage)
  schoolSupabase: {
    url: required('SCHOOL_SUPABASE_URL'),
    anonKey: required('SCHOOL_SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SCHOOL_SUPABASE_SERVICE_ROLE_KEY'),
    jwtSecret: optional('SCHOOL_SUPABASE_JWT_SECRET', ''),
  },

  // School Postgres direct connection (for raw SQL on school tables)
  schoolDatabaseUrl: required('SCHOOL_DATABASE_URL'),

  // Dedicated Nexsyrus CRM / website enquiries database.
  crmDatabaseUrl: optional('CRM_DATABASE_URL', ''),

  // Medical Supabase project (medical_profile + POS tables)
  medicalSupabase: {
    url: optional('MEDICAL_SUPABASE_URL', ''),
    anonKey: optional('MEDICAL_SUPABASE_ANON_KEY', ''),
    serviceRoleKey: optional('MEDICAL_SUPABASE_SERVICE_ROLE_KEY', ''),
  },

  // CORS
  allowedOrigins: (optional('ALLOWED_ORIGINS', '*') || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  crmFeatures: {
    prospectReads: flag('CRM_FEATURE_PROSPECT_READS', true),
    importPreview: flag('CRM_FEATURE_IMPORT_PREVIEW', true),
    importExecute: flag('CRM_FEATURE_IMPORT_EXECUTE', false),
    salesCommandRead: flag('CRM_FEATURE_SALES_COMMAND_READ', false),
    pilotWrite: flag('CRM_FEATURE_PILOT_WRITE', false),
    trackWrite: flag('CRM_FEATURE_TRACK_WRITE', false),
    trackResolve: flag('CRM_FEATURE_TRACK_RESOLVE', false),
    trackAttribution: flag('CRM_FEATURE_TRACK_ATTRIBUTION', false),
    trackReports: flag('CRM_FEATURE_TRACK_REPORTS', false),
  },

  crmImport: {
    csvMaxBytes: boundedInt('CRM_IMPORT_CSV_MAX_BYTES', 25 * 1024 * 1024, 25 * 1024 * 1024),
    xlsxMaxBytes: boundedInt('CRM_IMPORT_XLSX_MAX_BYTES', 10 * 1024 * 1024, 10 * 1024 * 1024),
    xlsxExpandedMaxBytes: boundedInt('CRM_IMPORT_XLSX_EXPANDED_MAX_BYTES', 64 * 1024 * 1024, 64 * 1024 * 1024),
    maxRows: boundedInt('CRM_IMPORT_MAX_ROWS', 50000, 50000),
    maxColumns: boundedInt('CRM_IMPORT_MAX_COLUMNS', 100, 100),
    maxCells: boundedInt('CRM_IMPORT_MAX_CELLS', 1000000, 1000000),
    maxCellBytes: boundedInt('CRM_IMPORT_MAX_CELL_BYTES', 8192, 8192),
    maxRowBytes: boundedInt('CRM_IMPORT_MAX_ROW_BYTES', 65536, 65536),
    maxSheets: boundedInt('CRM_IMPORT_MAX_SHEETS', 20, 20),
    maxZipEntries: boundedInt('CRM_IMPORT_MAX_ZIP_ENTRIES', 64, 64),
    maxCompressionRatio: boundedInt('CRM_IMPORT_MAX_COMPRESSION_RATIO', 100, 100),
    parseTimeoutMs: boundedInt('CRM_IMPORT_PARSE_TIMEOUT_MS', 20000, 120000),
    maxQueuedBytes: boundedInt('CRM_IMPORT_MAX_QUEUED_BYTES', 100 * 1024 * 1024, 100 * 1024 * 1024),
    retentionDays: boundedInt('CRM_IMPORT_RETENTION_DAYS', 30, 365),
    directoryFreshnessHours: boundedInt('CRM_DIRECTORY_FRESHNESS_HOURS', 24, 168),
    workerEnabled: flag('CRM_IMPORT_WORKER_ENABLED', false),
    workerIntervalMs: boundedInt('CRM_IMPORT_WORKER_INTERVAL_MS', 2000, 60000),
    leaseSeconds: boundedInt('CRM_IMPORT_LEASE_SECONDS', 45, 300),
    maxAttempts: boundedInt('CRM_IMPORT_MAX_ATTEMPTS', 5, 20),
  },
};

module.exports = config;
