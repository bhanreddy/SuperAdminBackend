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
};

module.exports = config;
