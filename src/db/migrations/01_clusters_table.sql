-- Phase 3: Cluster Management
-- Migration to create the clusters table in the Cluster A Supabase instance.
-- Must be executed by a superuser/admin in the Supabase SQL Editor.

CREATE TABLE clusters (
  cluster_id        TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  school_backend_url  TEXT NOT NULL,
  medical_backend_url TEXT NOT NULL,
  school_supabase_url TEXT,
  medical_supabase_url TEXT,
  school_anon_key   TEXT,
  medical_anon_key  TEXT,
  max_schools       INT DEFAULT 40,
  school_count      INT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;

-- Only service role can access this table
CREATE POLICY "Service role has full access to clusters" 
ON clusters 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- Seed Cluster A
INSERT INTO clusters (
  cluster_id, label, status,
  school_backend_url, medical_backend_url,
  school_supabase_url, medical_supabase_url,
  school_anon_key, medical_anon_key,
  max_schools, school_count
) VALUES (
  'cluster_a', 'Cluster A', 'active',
  current_setting('app.settings.school_backend_url', true),
  current_setting('app.settings.school_backend_url', true),
  current_setting('app.settings.school_supabase_url', true),
  current_setting('app.settings.medical_supabase_url', true),
  current_setting('app.settings.school_anon_key', true),
  current_setting('app.settings.medical_anon_key', true),
  40, 0
);
-- Note: Replace the current_setting() calls above with the actual literal string values
-- from your Cluster A environment (.env) before running this seed script.
