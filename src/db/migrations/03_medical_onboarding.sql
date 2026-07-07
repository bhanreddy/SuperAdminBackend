-- 03_medical_onboarding.sql
-- Run this on EVERY cluster's Supabase (Cluster A now, future clusters on provision)

-- Add onboarding and subscription fields to medical_profile table
ALTER TABLE medical_profile
  ADD COLUMN IF NOT EXISTS cluster_id TEXT DEFAULT 'cluster_a',
  ADD COLUMN IF NOT EXISTS backend_url TEXT,
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS razorpay_key_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT 
    DEFAULT 'trial'
    CHECK (subscription_status IN (
      'trial',
      'active',
      'expired',
      'suspended'
    )),
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT
    DEFAULT 'pending_build'
    CHECK (onboarding_status IN (
      'pending_build',
      'app_delivered',
      'live',
      'suspended'
    )),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Backfill existing medical shops to cluster A
UPDATE medical_profile SET cluster_id = 'cluster_a' WHERE cluster_id IS NULL;

-- Add medical_count to clusters table
ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS medical_count INT DEFAULT 0;

-- Backfill existing count for cluster_a
UPDATE clusters 
SET medical_count = (
  SELECT COUNT(*) FROM medical_profile 
  WHERE medical_profile.cluster_id = clusters.cluster_id
)
WHERE cluster_id = 'cluster_a';
