-- 16_school_prospect_import.sql
-- Additive school-prospect identity, contact channels, import staging, and a
-- read-only customer-directory projection. Does not provision tenants.

CREATE TABLE IF NOT EXISTS crm_integrity_reports (
  report_key TEXT PRIMARY KEY,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS source_import_batch_id UUID;

CREATE TABLE IF NOT EXISTS crm_school_profiles (
  account_id UUID PRIMARY KEY REFERENCES crm_accounts(id) ON DELETE CASCADE,
  udise_code TEXT,
  udise_valid BOOLEAN NOT NULL DEFAULT false,
  school_name_normalized TEXT NOT NULL,
  school_name_loose TEXT NOT NULL,
  country_code TEXT,
  state_raw TEXT,
  state_normalized TEXT,
  district_raw TEXT,
  district_normalized TEXT,
  city_raw TEXT,
  city_normalized TEXT,
  locality_raw TEXT,
  locality_normalized TEXT,
  address_line_1 TEXT,
  address_line_2 TEXT,
  postal_code TEXT,
  location_key TEXT,
  organization_phone_normalized TEXT,
  organization_email_normalized TEXT,
  board TEXT,
  management_type TEXT,
  website TEXT,
  estimated_student_count INTEGER,
  notes TEXT,
  normalization_version INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_school_profiles_udise_len CHECK (udise_code IS NULL OR char_length(udise_code) <= 32),
  CONSTRAINT crm_school_profiles_name_len CHECK (char_length(school_name_normalized) BETWEEN 1 AND 200),
  CONSTRAINT crm_school_profiles_students CHECK (
    estimated_student_count IS NULL OR (estimated_student_count >= 0 AND estimated_student_count <= 1000000)
  ),
  CONSTRAINT crm_school_profiles_postal_len CHECK (postal_code IS NULL OR char_length(postal_code) <= 16)
);

CREATE INDEX IF NOT EXISTS idx_crm_school_profiles_udise
  ON crm_school_profiles (udise_code)
  WHERE udise_valid = true AND udise_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_school_profiles_name_location
  ON crm_school_profiles (school_name_normalized, location_key)
  WHERE location_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_school_profiles_phone
  ON crm_school_profiles (organization_phone_normalized)
  WHERE organization_phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_school_profiles_email
  ON crm_school_profiles (organization_email_normalized)
  WHERE organization_email_normalized IS NOT NULL;

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS contact_kind TEXT NOT NULL DEFAULT 'PERSON';
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS role_code TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS is_decision_maker BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS preferred_language TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS preference_source TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS preference_at TIMESTAMPTZ;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS updated_by UUID;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS name_status TEXT NOT NULL DEFAULT 'VERIFIED';
ALTER TABLE crm_contacts ALTER COLUMN full_name DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_kind_check
    CHECK (contact_kind IN ('PERSON', 'ORGANIZATION'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_name_status_check
    CHECK (name_status IN ('VERIFIED', 'UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_name_present_check
    CHECK (
      (name_status = 'VERIFIED' AND full_name IS NOT NULL AND char_length(trim(full_name)) >= 2)
      OR (name_status = 'UNKNOWN' AND full_name IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS crm_contact_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  method_type TEXT NOT NULL CHECK (method_type IN ('PHONE', 'EMAIL', 'WHATSAPP')),
  display_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  country_code TEXT,
  extension TEXT,
  label TEXT,
  is_primary_for_type BOOLEAN NOT NULL DEFAULT false,
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_state IN ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  verified_at TIMESTAMPTZ,
  source_type TEXT,
  source_ref TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_contact_methods_display_len CHECK (char_length(display_value) BETWEEN 1 AND 254)
);

CREATE INDEX IF NOT EXISTS idx_crm_contact_methods_lookup
  ON crm_contact_methods (method_type, normalized_value)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contact_methods_value
  ON crm_contact_methods (contact_id, method_type, normalized_value, COALESCE(extension, ''))
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contact_methods_primary
  ON crm_contact_methods (contact_id, method_type)
  WHERE is_primary_for_type = true AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('platform', 'owner')),
  scope_founder_id UUID,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  normalization_version INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  sheet_name TEXT,
  header_row_number INTEGER,
  mapping JSONB,
  defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  structure JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  preview_revision INTEGER NOT NULL DEFAULT 0,
  preview_hash TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID,
  idempotency_key TEXT,
  confirm_payload_hash TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_token UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  cancel_requested_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_import_batches_status_check CHECK (status IN (
    'UPLOADED', 'PARSING', 'AWAITING_MAPPING', 'PREVIEW_QUEUED', 'PREVIEWING',
    'PREVIEW_READY', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_crm_import_batches_scope
  ON crm_import_batches (scope_founder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_import_batches_status
  ON crm_import_batches (status, updated_at);

CREATE TABLE IF NOT EXISTS crm_import_files (
  batch_id UUID PRIMARY KEY REFERENCES crm_import_batches(id) ON DELETE CASCADE,
  body BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES crm_import_batches(id) ON DELETE CASCADE,
  sheet_name TEXT NOT NULL DEFAULT '',
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  original_cells JSONB NOT NULL DEFAULT '[]'::jsonb,
  normalized JSONB,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification TEXT,
  customer_status TEXT,
  school_group_id TEXT,
  selected_action TEXT,
  action_reason TEXT,
  target_account_id UUID,
  target_version INTEGER,
  field_changes JSONB,
  result JSONB,
  result_status TEXT,
  retryable BOOLEAN NOT NULL DEFAULT false,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, sheet_name, row_number)
);

CREATE INDEX IF NOT EXISTS idx_crm_import_rows_batch
  ON crm_import_rows (batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_crm_import_rows_state
  ON crm_import_rows (batch_id, result_status, classification);

ALTER TABLE crm_accounts DROP CONSTRAINT IF EXISTS crm_accounts_source_import_batch_fk;
ALTER TABLE crm_accounts
  ADD CONSTRAINT crm_accounts_source_import_batch_fk
  FOREIGN KEY (source_import_batch_id) REFERENCES crm_import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_accounts_prospect_cursor
  ON crm_accounts (updated_at DESC, id DESC)
  WHERE vertical = 'SCHOOL' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_accounts_owner_lifecycle
  ON crm_accounts (owner_founder_id, lifecycle_stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_school_customer_directory (
  cluster_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  school_code TEXT,
  name TEXT,
  school_name_normalized TEXT,
  school_name_loose TEXT,
  address_raw TEXT,
  country_code TEXT,
  state_normalized TEXT,
  district_normalized TEXT,
  city_normalized TEXT,
  postal_code TEXT,
  location_key TEXT,
  phones TEXT[] NOT NULL DEFAULT '{}',
  emails TEXT[] NOT NULL DEFAULT '{}',
  crm_account_id UUID,
  correlation_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  onboarding_status TEXT,
  source_fingerprint TEXT,
  normalization_version INTEGER NOT NULL,
  last_verified_at TIMESTAMPTZ,
  last_refresh_status TEXT NOT NULL,
  completeness JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, school_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_directory_phones ON crm_school_customer_directory USING GIN (phones);
CREATE INDEX IF NOT EXISTS idx_crm_directory_emails ON crm_school_customer_directory USING GIN (emails);
CREATE INDEX IF NOT EXISTS idx_crm_directory_name
  ON crm_school_customer_directory (school_name_normalized, location_key);

CREATE TABLE IF NOT EXISTS crm_directory_refreshes (
  cluster_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('OK', 'FAILED', 'STALE')),
  last_success_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT,
  school_count INTEGER NOT NULL DEFAULT 0
);

DO $$
DECLARE
  violations integer;
BEGIN
  SELECT count(*) INTO violations FROM (
    SELECT account_id FROM crm_contacts
    WHERE COALESCE(is_primary, false) = true AND archived_at IS NULL
    GROUP BY account_id HAVING count(*) > 1
  ) extra;
  IF violations = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contacts_one_active_primary
      ON crm_contacts (account_id)
      WHERE is_primary = true AND archived_at IS NULL;
  ELSE
    INSERT INTO crm_integrity_reports (report_key, details)
    VALUES ('primary_contact_violations', jsonb_build_object('accounts', violations))
    ON CONFLICT (report_key) DO UPDATE SET details = EXCLUDED.details, reported_at = now();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crm_bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.row_version IS NOT DISTINCT FROM OLD.row_version THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_accounts_row_version ON crm_accounts;
CREATE TRIGGER crm_accounts_row_version
BEFORE UPDATE ON crm_accounts
FOR EACH ROW EXECUTE FUNCTION crm_bump_row_version();

DROP TRIGGER IF EXISTS crm_contacts_row_version ON crm_contacts;
CREATE TRIGGER crm_contacts_row_version
BEFORE UPDATE ON crm_contacts
FOR EACH ROW EXECUTE FUNCTION crm_bump_row_version();

DROP TRIGGER IF EXISTS crm_school_profiles_row_version ON crm_school_profiles;
CREATE TRIGGER crm_school_profiles_row_version
BEFORE UPDATE ON crm_school_profiles
FOR EACH ROW EXECUTE FUNCTION crm_bump_row_version();

ALTER TABLE crm_school_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contact_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_import_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_school_customer_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_directory_refreshes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_integrity_reports ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'crm_school_profiles', 'crm_contact_methods', 'crm_import_batches', 'crm_import_files',
    'crm_import_rows', 'crm_school_customer_directory', 'crm_directory_refreshes', 'crm_integrity_reports'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', target);
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', target);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;
