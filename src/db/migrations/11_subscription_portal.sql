-- Founder-owned subscription settings mirrored into each SchoolIMS cluster.
-- Apply to the Super Admin database after 10_billing_clients.sql.

ALTER TABLE billing_clients
  ADD COLUMN IF NOT EXISTS plan_name TEXT NOT NULL DEFAULT 'NexSyrus School ERP',
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'annual', 'custom')),
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('trial', 'active', 'past_due', 'paused', 'cancelled')),
  ADD COLUMN IF NOT EXISTS current_period_start DATE,
  ADD COLUMN IF NOT EXISTS current_period_end DATE,
  ADD COLUMN IF NOT EXISTS next_due_date DATE,
  ADD COLUMN IF NOT EXISTS amount_due NUMERIC(12,2) NOT NULL DEFAULT 0
    CHECK (amount_due >= 0),
  ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminder_message VARCHAR(280),
  ADD COLUMN IF NOT EXISTS last_paid_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_billing_documents_portal_client
  ON billing_documents(client_kind, client_cluster_id, client_id, created_at DESC);
