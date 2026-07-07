-- Phase 6: Cluster Service Role Keys
-- Run this on Cluster A (Master DB) to securely store service role credentials for each cluster.

ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS school_service_role_key TEXT,
  ADD COLUMN IF NOT EXISTS medical_service_role_key TEXT;

-- Security check comment on columns
COMMENT ON COLUMN clusters.school_service_role_key IS 'SECURITY: Must NEVER be exposed to frontend. Accessed via backend service role only.';
COMMENT ON COLUMN clusters.medical_service_role_key IS 'SECURITY: Must NEVER be exposed to frontend. Accessed via backend service role only.';

-- Seed Cluster A's own service role keys immediately.
-- IMPORTANT: Replace {SUPABASE_SERVICE_ROLE_KEY} and {MEDICAL_SUPABASE_SERVICE_ROLE_KEY} 
-- with the actual keys before running this script in production.
UPDATE clusters
SET
  school_service_role_key = '{SUPABASE_SERVICE_ROLE_KEY}',
  medical_service_role_key = '{MEDICAL_SUPABASE_SERVICE_ROLE_KEY}'
WHERE cluster_id = 'cluster_a';
