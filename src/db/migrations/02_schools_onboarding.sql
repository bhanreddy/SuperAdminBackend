-- Phase 4: School Onboarding and Cluster Assignment
-- Migration to add cluster and onboarding fields to the schools table.

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS cluster_id TEXT DEFAULT 'cluster_a',
  ADD COLUMN IF NOT EXISTS backend_url TEXT,
  ADD COLUMN IF NOT EXISTS android_package TEXT,
  ADD COLUMN IF NOT EXISTS ios_bundle_id TEXT,
  ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#1A73E8',
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT 
    DEFAULT 'pending_build'
    CHECK (onboarding_status IN (
      'pending_build',
      'apk_delivered', 
      'live',
      'suspended'
    )),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Update existing schools to have cluster_a
UPDATE schools SET cluster_id = 'cluster_a' WHERE cluster_id IS NULL;
