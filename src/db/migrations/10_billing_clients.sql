-- Live SaaS subscription settings for clients discovered from cluster databases.
CREATE TABLE IF NOT EXISTS billing_clients (
  client_kind TEXT NOT NULL CHECK (client_kind IN ('school', 'medical')),
  client_cluster_id TEXT NOT NULL,
  client_external_id TEXT NOT NULL,
  monthly_fee NUMERIC(12,2),
  payment_link TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_kind, client_cluster_id, client_external_id),
  CHECK (monthly_fee IS NULL OR monthly_fee >= 0)
);

-- School ids are integers in SchoolIMS. A UUID column made their informational
-- billing back-reference unusable. It is deliberately non-FK, so text is correct.
ALTER TABLE billing_documents
  ALTER COLUMN client_id TYPE TEXT USING client_id::text;

