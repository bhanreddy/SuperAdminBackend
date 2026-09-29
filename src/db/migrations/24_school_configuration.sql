-- School configuration drafts, immutable revisions, assets, and package jobs.
-- Lives on the master database and is always keyed by (cluster_id, school_id).

CREATE TABLE IF NOT EXISTS school_config_drafts (
  cluster_id TEXT NOT NULL,
  school_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  asset_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  intake_id UUID,
  origin TEXT NOT NULL DEFAULT 'created',
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, school_id)
);

CREATE TABLE IF NOT EXISTS school_config_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id TEXT NOT NULL,
  school_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL,
  derived_from UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_config_assets_school
  ON school_config_assets (cluster_id, school_id, slot);

CREATE TABLE IF NOT EXISTS school_config_revisions (
  cluster_id TEXT NOT NULL,
  school_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  config JSONB NOT NULL,
  cluster_snapshot JSONB NOT NULL,
  asset_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_version TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, school_id, revision)
);

CREATE TABLE IF NOT EXISTS school_package_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id TEXT NOT NULL,
  school_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_expires_at TIMESTAMPTZ,
  locked_by TEXT,
  error JSONB,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT school_package_jobs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  UNIQUE (cluster_id, school_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_school_package_jobs_claim
  ON school_package_jobs (status, updated_at);

CREATE TABLE IF NOT EXISTS school_package_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES school_package_jobs(id),
  cluster_id TEXT NOT NULL,
  school_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cluster_id, school_id, revision)
);
