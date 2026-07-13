-- 07_top_level_crm.sql
-- Central NexSyrus CRM. Additive and idempotent; existing enquiries remain the
-- lead source and are extended rather than replaced.

CREATE TABLE IF NOT EXISTS crm_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'PROSPECT'
    CHECK (account_type IN ('PROSPECT', 'CUSTOMER', 'PARTNER', 'INACTIVE')),
  vertical TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (vertical IN ('SCHOOL', 'MEDICAL', 'RETAIL', 'OTHER')),
  lifecycle_stage TEXT NOT NULL DEFAULT 'LEAD'
    CHECK (lifecycle_stage IN ('LEAD', 'QUALIFIED', 'ONBOARDING', 'ACTIVE', 'AT_RISK', 'CHURNED')),
  owner_founder_id UUID REFERENCES founders(id) ON DELETE SET NULL,
  external_client_id TEXT,
  cluster_id TEXT,
  website TEXT,
  phone TEXT,
  email TEXT,
  billing_status TEXT,
  health_score INTEGER CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100),
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_accounts_external_ref
  ON crm_accounts(cluster_id, vertical, external_client_id)
  WHERE external_client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_accounts_lifecycle ON crm_accounts(lifecycle_stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_accounts_owner ON crm_accounts(owner_founder_id, lifecycle_stage);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role_title TEXT,
  email TEXT,
  phone TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  preferred_channel TEXT CHECK (preferred_channel IS NULL OR preferred_channel IN ('PHONE', 'EMAIL', 'WHATSAPP', 'IN_APP')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_account ON crm_contacts(account_id, is_primary DESC);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(lower(email)) WHERE email IS NOT NULL;

ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES crm_accounts(id) ON DELETE SET NULL;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE enquiries ADD CONSTRAINT enquiries_priority_check
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_enquiries_crm_queue
  ON enquiries(status, assigned_to, next_follow_up_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_account ON enquiries(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_unassigned ON enquiries(created_at DESC) WHERE assigned_to IS NULL;

CREATE TABLE IF NOT EXISTS crm_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL DEFAULT 'FOLLOW_UP'
    CHECK (task_type IN ('FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING', 'ONBOARDING', 'COLLECTION', 'APPROVAL', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  owner_founder_id UUID REFERENCES founders(id) ON DELETE SET NULL,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE CASCADE,
  enquiry_id UUID REFERENCES enquiries(id) ON DELETE CASCADE,
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID,
  automation_rule_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (account_id IS NOT NULL OR enquiry_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_owner_queue ON crm_tasks(owner_founder_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_account ON crm_tasks(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_enquiry ON crm_tasks(enquiry_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_type TEXT NOT NULL,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE CASCADE,
  enquiry_id UUID REFERENCES enquiries(id) ON DELETE CASCADE,
  task_id UUID REFERENCES crm_tasks(id) ON DELETE SET NULL,
  actor_id UUID,
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (account_id IS NOT NULL OR enquiry_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_account ON crm_activities(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_enquiry ON crm_activities(enquiry_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS crm_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES crm_automation_rules(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(rule_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_crm_automation_queue
  ON crm_automation_runs(status, available_at) WHERE status IN ('PENDING', 'FAILED');

INSERT INTO crm_automation_rules (name, trigger_event, conditions, actions, is_enabled)
SELECT 'New prospect follow-up', 'account.created', '{}'::jsonb,
  '[{"type":"CREATE_TASK","title":"Contact new prospect","task_type":"FOLLOW_UP","priority":"HIGH","due_in_minutes":60}]'::jsonb,
  true
WHERE NOT EXISTS (SELECT 1 FROM crm_automation_rules WHERE name = 'New prospect follow-up');

INSERT INTO crm_automation_rules (name, trigger_event, conditions, actions, is_enabled)
SELECT 'Converted lead onboarding', 'enquiry.converted', '{}'::jsonb,
  '[{"type":"CREATE_TASK","title":"Start customer onboarding","task_type":"ONBOARDING","priority":"HIGH","due_in_minutes":1440}]'::jsonb,
  true
WHERE NOT EXISTS (SELECT 1 FROM crm_automation_rules WHERE name = 'Converted lead onboarding');

ALTER TABLE crm_tasks
  DROP CONSTRAINT IF EXISTS crm_tasks_automation_rule_id_fkey;
ALTER TABLE crm_tasks
  ADD CONSTRAINT crm_tasks_automation_rule_id_fkey
  FOREIGN KEY (automation_rule_id) REFERENCES crm_automation_rules(id) ON DELETE SET NULL;

-- Backend uses the direct service connection. RLS remains enabled as a defense
-- in depth boundary for accidental client-side Supabase access.
ALTER TABLE crm_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_automation_runs ENABLE ROW LEVEL SECURITY;
