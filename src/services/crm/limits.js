/**
 * Central bounds for school-prospect identity and import.
 * SQL checks in 16_school_prospect_import.sql mirror these lengths.
 * Env may lower a deployment, never raise it past these ceilings.
 */
const LIMITS = {
  csvMaxBytes: 25 * 1024 * 1024,
  xlsxMaxBytes: 10 * 1024 * 1024,
  xlsxExpandedMaxBytes: 64 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 100,
  maxCells: 1_000_000,
  maxCellBytes: 8 * 1024,
  maxRowBytes: 64 * 1024,
  maxSheets: 20,
  maxZipEntries: 64,
  maxCompressionRatio: 100,
  parseTimeoutMs: 20_000,
  maxQueuedBytes: 100 * 1024 * 1024,
  schoolName: 200,
  udise: 32,
  postal: 16,
  phoneDisplay: 64,
  email: 254,
  address: 300,
  notes: 4000,
  locality: 120,
  mandal: 80,
  adminName: 80,
  roleTitle: 120,
  personName: 120,
  estimatedStudentsMax: 1_000_000,
  retentionDays: 30,
  directoryFreshnessHours: 24,
  pageLimit: 100,
};

const CALLING_CODES = {
  IN: '91',
  US: '1',
  CA: '1',
  GB: '44',
  AE: '971',
  SG: '65',
  AU: '61',
};

const COUNTRY_ALIASES = {
  in: 'IN',
  india: 'IN',
  bharat: 'IN',
  us: 'US',
  usa: 'US',
  'united states': 'US',
  'united states of america': 'US',
  ca: 'CA',
  canada: 'CA',
  gb: 'GB',
  uk: 'GB',
  'united kingdom': 'GB',
  ae: 'AE',
  uae: 'AE',
  'united arab emirates': 'AE',
  sg: 'SG',
  singapore: 'SG',
  au: 'AU',
  australia: 'AU',
};

const STATE_ALIASES = {
  in: {
    'tamil nadu': 'tamil nadu',
    tamilnadu: 'tamil nadu',
    tn: 'tamil nadu',
    telangana: 'telangana',
    ts: 'telangana',
    tg: 'telangana',
    'andhra pradesh': 'andhra pradesh',
    andhrapradesh: 'andhra pradesh',
    ap: 'andhra pradesh',
    karnataka: 'karnataka',
    ka: 'karnataka',
    kerala: 'kerala',
    kl: 'kerala',
    maharashtra: 'maharashtra',
    mh: 'maharashtra',
    delhi: 'delhi',
    'nct of delhi': 'delhi',
    'new delhi': 'delhi',
    'uttar pradesh': 'uttar pradesh',
    up: 'uttar pradesh',
    gujarat: 'gujarat',
    gj: 'gujarat',
    rajasthan: 'rajasthan',
    rj: 'rajasthan',
    'west bengal': 'west bengal',
    wb: 'west bengal',
    'madhya pradesh': 'madhya pradesh',
    mp: 'madhya pradesh',
  },
};

const NAME_ABBREVIATIONS = {
  sr: 'senior',
  jr: 'junior',
  sec: 'secondary',
  sch: 'school',
  pub: 'public',
  hss: 'higher secondary school',
  and: 'and',
};

const ROLE_CODES = ['PRINCIPAL', 'CORRESPONDENT', 'OWNER', 'ADMINISTRATOR', 'ACCOUNTS', 'IT', 'ADMISSIONS', 'OTHER'];

const PRIVILEGED_FIELDS = new Set([
  'tenant_id',
  'external_client_id',
  'cluster_id',
  'cluster_url',
  'database_url',
  'password',
  'credential',
  'credentials',
  'lifecycle',
  'lifecycle_stage',
  'account_type',
  'outcome',
  'pipeline_stage',
  'service_role',
  'owner_scope',
]);

module.exports = {
  LIMITS,
  CALLING_CODES,
  COUNTRY_ALIASES,
  STATE_ALIASES,
  NAME_ABBREVIATIONS,
  ROLE_CODES,
  PRIVILEGED_FIELDS,
};
