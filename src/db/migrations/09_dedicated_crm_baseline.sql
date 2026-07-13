CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shadow identity directory for CRM ownership labels. Authentication remains in
-- the School database; these rows contain no credentials.
CREATE TABLE IF NOT EXISTS founders (
  id UUID PRIMARY KEY,
  full_name TEXT,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS enquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  organization TEXT,
  message TEXT,
  website_source TEXT NOT NULL DEFAULT 'MAIN',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  budget_range TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
  assigned_to UUID,
  deal_value NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enquiries_created ON enquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_source ON enquiries(website_source, created_at DESC);

-- Public websites may create leads, but cannot enumerate or modify them.
ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT INSERT ON enquiries TO anon, authenticated;
DROP POLICY IF EXISTS website_contact_insert ON enquiries;
CREATE POLICY website_contact_insert ON enquiries FOR INSERT TO anon, authenticated WITH CHECK (
  char_length(trim(name)) BETWEEN 2 AND 100
  AND char_length(trim(email)) BETWEEN 3 AND 150
  AND char_length(COALESCE(message, '')) BETWEEN 10 AND 2000
);
