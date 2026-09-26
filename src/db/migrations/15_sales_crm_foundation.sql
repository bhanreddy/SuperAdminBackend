-- 15_sales_crm_foundation.sql
-- Target database: CRM_DATABASE_URL only.
-- Depends on 09_dedicated_crm_baseline.sql and 07_top_level_crm.sql.
-- Idempotent upgrade. Does not rewrite historical CLOSED/REJECTED rows into
-- definitive wins or losses.

CREATE TABLE IF NOT EXISTS crm_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contact channel: phone-only website leads are valid. Email is no longer mandatory.
ALTER TABLE enquiries ALTER COLUMN email DROP NOT NULL;
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_contact_present;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_contact_present CHECK (
  (email IS NOT NULL AND char_length(trim(email)) > 0)
  OR (phone IS NOT NULL AND char_length(trim(phone)) > 0)
);

ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS pipeline_stage_code TEXT NOT NULL DEFAULT 'NEW';
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS outcome_review_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS value_amount NUMERIC(14,2);
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS next_action_task_id UUID;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS territory_id UUID;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS acquisition_channel_id UUID;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS campaign_name TEXT;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS referral_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS product_vertical TEXT;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS intake_queue TEXT;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS sales_model_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_outcome_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_outcome_check CHECK (
  outcome IN ('OPEN', 'WON', 'LOST', 'DISQUALIFIED', 'LEGACY_UNKNOWN')
);
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_currency_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_currency_check CHECK (char_length(currency) = 3);

CREATE TABLE IF NOT EXISTS crm_stage_definitions (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  entry_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_stage_edges (
  from_code TEXT NOT NULL REFERENCES crm_stage_definitions(code),
  to_code TEXT NOT NULL REFERENCES crm_stage_definitions(code),
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (from_code, to_code)
);

INSERT INTO crm_stage_definitions (code, label, sort_order, entry_requirements) VALUES
  ('NEW', 'New', 10, '{}'::jsonb),
  ('CONTACTED', 'Contacted', 20, '{}'::jsonb),
  ('QUALIFIED', 'Qualified', 30, '{}'::jsonb),
  ('DEMO', 'Demo', 40, '{"demo_status_any":["SCHEDULED","COMPLETED"]}'::jsonb),
  ('PROPOSAL', 'Proposal', 50, '{"proposal_status_any":["DRAFT","SENT","ACCEPTED","REJECTED","EXPIRED","WITHDRAWN"]}'::jsonb),
  ('NEGOTIATION', 'Negotiation', 60, '{"proposal_status_any":["SENT","ACCEPTED"]}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO crm_stage_edges (from_code, to_code) VALUES
  ('NEW', 'CONTACTED'),
  ('CONTACTED', 'QUALIFIED'),
  ('CONTACTED', 'NEW'),
  ('QUALIFIED', 'DEMO'),
  ('QUALIFIED', 'CONTACTED'),
  ('DEMO', 'PROPOSAL'),
  ('DEMO', 'QUALIFIED'),
  ('PROPOSAL', 'NEGOTIATION'),
  ('PROPOSAL', 'DEMO'),
  ('NEGOTIATION', 'PROPOSAL')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS crm_territories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_territory_members (
  territory_id UUID NOT NULL REFERENCES crm_territories(id),
  founder_id UUID NOT NULL REFERENCES founders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (territory_id, founder_id)
);

CREATE TABLE IF NOT EXISTS crm_acquisition_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_acquisition_channels (code, label)
SELECT code, label FROM (VALUES
  ('WEBSITE', 'Website'),
  ('REFERRAL', 'Referral'),
  ('OUTBOUND', 'Outbound'),
  ('PARTNER', 'Partner'),
  ('UNKNOWN', 'Unknown')
) AS seed(code, label)
WHERE NOT EXISTS (SELECT 1 FROM crm_acquisition_channels existing WHERE existing.code = seed.code);

CREATE TABLE IF NOT EXISTS crm_outcome_reasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome TEXT NOT NULL CHECK (outcome IN ('LOST', 'DISQUALIFIED', 'WON_EXCEPTION')),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outcome, code)
);

INSERT INTO crm_outcome_reasons (outcome, code, label)
SELECT outcome, code, label FROM (VALUES
  ('LOST', 'BUDGET', 'Budget'),
  ('LOST', 'TIMING', 'Timing'),
  ('LOST', 'COMPETITOR', 'Competitor'),
  ('LOST', 'NO_RESPONSE', 'No response'),
  ('LOST', 'NOT_A_FIT', 'Not a fit'),
  ('LOST', 'OTHER', 'Other'),
  ('DISQUALIFIED', 'NOT_A_FIT', 'Not a fit'),
  ('DISQUALIFIED', 'DUPLICATE', 'Duplicate'),
  ('DISQUALIFIED', 'SPAM', 'Spam'),
  ('DISQUALIFIED', 'OUT_OF_TERRITORY', 'Out of territory'),
  ('WON_EXCEPTION', 'VERBAL_ACCEPTANCE', 'Documented acceptance without a proposal file')
) AS seed(outcome, code, label)
WHERE NOT EXISTS (
  SELECT 1 FROM crm_outcome_reasons existing
  WHERE existing.outcome = seed.outcome AND existing.code = seed.code
);

CREATE TABLE IF NOT EXISTS crm_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  from_code TEXT,
  to_code TEXT NOT NULL,
  actor_id UUID,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_owner_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID REFERENCES enquiries(id) ON DELETE CASCADE,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE CASCADE,
  from_founder_id UUID,
  to_founder_id UUID,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_closures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  notes TEXT,
  value_amount NUMERIC(14,2),
  currency TEXT,
  closed_at TIMESTAMPTZ NOT NULL,
  proposal_version_id UUID,
  exception_reason TEXT,
  actor_id UUID,
  reopened_at TIMESTAMPTZ,
  reopen_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID REFERENCES enquiries(id) ON DELETE CASCADE,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS crm_next_action_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS result TEXT;
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE crm_activities DROP CONSTRAINT IF EXISTS crm_activities_visibility_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_visibility_check CHECK (
  visibility IN ('INTERNAL', 'CUSTOMER_MESSAGE', 'SYSTEM')
);

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_actionable_assignee;
-- Ownerless or undated open tasks cannot remain actionable. They are cancelled
-- into the review queue rather than assigned to a manufactured salesperson.
INSERT INTO crm_review_queue (enquiry_id, account_id, reason)
SELECT enquiry_id, account_id, 'ACTIONABLE_TASK_MISSING_ASSIGNEE_OR_DUE'
FROM crm_tasks
WHERE status IN ('OPEN', 'IN_PROGRESS') AND (due_at IS NULL OR owner_founder_id IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM crm_review_queue q
    WHERE q.reason = 'ACTIONABLE_TASK_MISSING_ASSIGNEE_OR_DUE'
      AND q.enquiry_id IS NOT DISTINCT FROM crm_tasks.enquiry_id
      AND q.status = 'OPEN'
  );
UPDATE crm_tasks
SET status = 'CANCELLED', updated_at = now()
WHERE status IN ('OPEN', 'IN_PROGRESS') AND (due_at IS NULL OR owner_founder_id IS NULL);

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_actionable_check;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_actionable_check CHECK (
  status NOT IN ('OPEN', 'IN_PROGRESS') OR (due_at IS NOT NULL AND owner_founder_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS crm_demos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  host_founder_id UUID REFERENCES founders(id),
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  location TEXT,
  meeting_url TEXT,
  agenda TEXT,
  result TEXT,
  follow_up_task_id UUID REFERENCES crm_tasks(id),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS crm_demo_reschedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demo_id UUID NOT NULL REFERENCES crm_demos(id) ON DELETE CASCADE,
  old_starts_at TIMESTAMPTZ NOT NULL,
  old_ends_at TIMESTAMPTZ NOT NULL,
  new_starts_at TIMESTAMPTZ NOT NULL,
  new_ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE SET NULL,
  proposal_number TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (char_length(currency) = 3),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_proposal_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES crm_proposals(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (char_length(currency) = 3),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')),
  validity_date DATE,
  delivery_state TEXT NOT NULL DEFAULT 'NOT_DELIVERED' CHECK (delivery_state IN ('NOT_DELIVERED', 'RECORDED_SENT')),
  sent_recorded_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, version_no)
);

CREATE TABLE IF NOT EXISTS crm_private_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_version_id UUID NOT NULL REFERENCES crm_proposal_versions(id) ON DELETE CASCADE,
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 2000000),
  body BYTEA NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_onboarding_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  enquiry_id UUID NOT NULL REFERENCES enquiries(id),
  account_id UUID REFERENCES crm_accounts(id),
  requested_cluster_id TEXT,
  cluster_id TEXT,
  vertical TEXT NOT NULL DEFAULT 'SCHOOL',
  correlation_key UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_school_id TEXT,
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_capacity_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE REFERENCES crm_onboarding_operations(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'CONSUMED', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_command_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS crm_proposal_counters (
  year INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL
);

-- Backfill once. Later sales writes set sales_model_version to 1 themselves.
UPDATE enquiries
SET
  pipeline_stage_code = CASE status
    WHEN 'CONTACTED' THEN 'CONTACTED'
    WHEN 'QUALIFIED' THEN 'QUALIFIED'
    ELSE 'NEW'
  END,
  outcome = CASE
    WHEN status IN ('CLOSED', 'REJECTED') THEN 'LEGACY_UNKNOWN'
    ELSE 'OPEN'
  END,
  outcome_review_required = status IN ('CLOSED', 'REJECTED'),
  stage_entered_at = COALESCE(updated_at, created_at, now()),
  value_amount = COALESCE(value_amount, deal_value),
  intake_queue = CASE WHEN assigned_to IS NULL AND status NOT IN ('CLOSED', 'REJECTED') THEN 'UNASSIGNED_INTAKE' ELSE intake_queue END,
  sales_model_version = 1
WHERE sales_model_version = 0;

ALTER TABLE enquiries ALTER COLUMN sales_model_version SET DEFAULT 1;

INSERT INTO crm_tasks (
  title, task_type, status, priority, owner_founder_id, enquiry_id, account_id, due_at, metadata
)
SELECT
  'Follow up',
  'FOLLOW_UP',
  'OPEN',
  'MEDIUM',
  e.assigned_to,
  e.id,
  e.account_id,
  e.next_follow_up_at,
  jsonb_build_object('backfill', 'next_follow_up')
FROM enquiries e
JOIN founders f ON f.id = e.assigned_to AND f.is_active = true
WHERE e.next_follow_up_at IS NOT NULL
  AND e.next_action_task_id IS NULL
  AND e.outcome = 'OPEN'
  AND NOT EXISTS (
    SELECT 1 FROM crm_tasks t
    WHERE t.enquiry_id = e.id AND t.metadata->>'backfill' = 'next_follow_up'
  );

UPDATE enquiries e
SET next_action_task_id = t.id
FROM crm_tasks t
WHERE t.enquiry_id = e.id
  AND t.metadata->>'backfill' = 'next_follow_up'
  AND e.next_action_task_id IS NULL;

INSERT INTO crm_review_queue (enquiry_id, reason)
SELECT e.id, 'AMBIGUOUS_NEXT_FOLLOW_UP'
FROM enquiries e
WHERE e.next_follow_up_at IS NOT NULL
  AND e.next_action_task_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM crm_review_queue q
    WHERE q.enquiry_id = e.id AND q.reason = 'AMBIGUOUS_NEXT_FOLLOW_UP' AND q.status = 'OPEN'
  );

INSERT INTO crm_review_queue (account_id, reason)
SELECT a.id, 'AMBIGUOUS_TENANT_LINK'
FROM crm_accounts a
WHERE a.external_client_id IS NOT NULL
  AND (a.cluster_id IS NULL OR btrim(a.cluster_id) = '')
  AND NOT EXISTS (
    SELECT 1 FROM crm_review_queue q
    WHERE q.account_id = a.id AND q.reason = 'AMBIGUOUS_TENANT_LINK' AND q.status = 'OPEN'
  );

CREATE OR REPLACE FUNCTION crm_forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit history is immutable';
END $$;

DROP TRIGGER IF EXISTS activity_logs_immutable ON activity_logs;
CREATE TRIGGER activity_logs_immutable
BEFORE UPDATE OR DELETE ON activity_logs
FOR EACH ROW EXECUTE FUNCTION crm_forbid_audit_mutation();

DROP TRIGGER IF EXISTS stage_history_immutable ON crm_stage_history;
CREATE TRIGGER stage_history_immutable
BEFORE UPDATE OR DELETE ON crm_stage_history
FOR EACH ROW EXECUTE FUNCTION crm_forbid_audit_mutation();

DROP TRIGGER IF EXISTS closures_immutable_update ON crm_closures;
CREATE TRIGGER closures_immutable_update
BEFORE UPDATE OF outcome, reason_code, notes, value_amount, currency, closed_at, actor_id OR DELETE ON crm_closures
FOR EACH ROW EXECUTE FUNCTION crm_forbid_audit_mutation();

CREATE OR REPLACE FUNCTION crm_proposal_version_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'issued proposal versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
    NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.validity_date IS DISTINCT FROM OLD.validity_date
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
  ) THEN
    RAISE EXCEPTION 'issued proposal versions are immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS proposal_versions_frozen ON crm_proposal_versions;
CREATE TRIGGER proposal_versions_frozen
BEFORE UPDATE OR DELETE ON crm_proposal_versions
FOR EACH ROW EXECUTE FUNCTION crm_proposal_version_frozen();

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_next_action_fk;
ALTER TABLE enquiries
  ADD CONSTRAINT enquiries_next_action_fk
  FOREIGN KEY (next_action_task_id) REFERENCES crm_tasks(id) ON DELETE RESTRICT;

DO $$ BEGIN
  ALTER TABLE enquiries ADD CONSTRAINT enquiries_territory_fk FOREIGN KEY (territory_id) REFERENCES crm_territories(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE enquiries ADD CONSTRAINT enquiries_channel_fk FOREIGN KEY (acquisition_channel_id) REFERENCES crm_acquisition_channels(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_enquiries_owner_stage ON enquiries (assigned_to, pipeline_stage_code, outcome, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_territory_outcome ON enquiries (territory_id, outcome, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_next_action ON enquiries (next_action_task_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_channel ON enquiries (acquisition_channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_due_queue ON crm_tasks (owner_founder_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_crm_demos_enquiry_start ON crm_demos (enquiry_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_proposals_enquiry ON crm_proposals (enquiry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_onboarding_status ON crm_onboarding_operations (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_stage_history_enquiry ON crm_stage_history (enquiry_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_review_open ON crm_review_queue (status, created_at DESC);

-- Public callers may submit a lead only through the constrained function.
-- They cannot set owner, account, outcome, stage, value, or conversion fields.
CREATE OR REPLACE FUNCTION ingest_website_enquiry(
  p_name TEXT,
  p_email TEXT,
  p_phone TEXT,
  p_message TEXT,
  p_product TEXT,
  p_website_source TEXT,
  p_channel_code TEXT,
  p_campaign TEXT
) RETURNS TABLE (id UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  channel UUID;
BEGIN
  IF char_length(trim(COALESCE(p_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Name is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_email, '')), '') IS NULL AND NULLIF(trim(COALESCE(p_phone, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Email or phone is required';
  END IF;
  SELECT c.id INTO channel FROM crm_acquisition_channels c
  WHERE c.code = COALESCE(NULLIF(trim(p_channel_code), ''), 'WEBSITE') AND c.archived_at IS NULL;
  RETURN QUERY
  INSERT INTO enquiries (
    name, email, phone, message, website_source, category, status,
    pipeline_stage_code, outcome, acquisition_channel_id, campaign_name,
    product_vertical, intake_queue, sales_model_version
  ) VALUES (
    trim(p_name),
    NULLIF(lower(trim(COALESCE(p_email, ''))), ''),
    NULLIF(trim(COALESCE(p_phone, '')), ''),
    NULLIF(trim(COALESCE(p_message, '')), ''),
    COALESCE(NULLIF(trim(p_website_source), ''), 'NEXSYRUS_WEBSITE'),
    COALESCE(NULLIF(trim(p_product), ''), 'SchoolIMS'),
    'NEW',
    'NEW',
    'OPEN',
    channel,
    NULLIF(trim(COALESCE(p_campaign, '')), ''),
    COALESCE(NULLIF(trim(p_product), ''), 'SchoolIMS'),
    'UNASSIGNED_INTAKE',
    1
  )
  RETURNING enquiries.id, enquiries.created_at;
END $$;

REVOKE ALL ON FUNCTION ingest_website_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON enquiries FROM anon;
    GRANT EXECUTE ON FUNCTION ingest_website_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON enquiries FROM authenticated;
    GRANT EXECUTE ON FUNCTION ingest_website_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
  END IF;
END $$;

REVOKE UPDATE, DELETE ON activity_logs FROM PUBLIC;
REVOKE UPDATE, DELETE ON crm_stage_history FROM PUBLIC;
REVOKE UPDATE, DELETE ON crm_closures FROM PUBLIC;

-- Projection is installed after backfill so known due times are preserved
-- while tasks are linked. Later edits of next_follow_up_at cannot diverge
-- from the designated task.
CREATE OR REPLACE FUNCTION crm_project_next_follow_up() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_action_task_id IS NULL THEN
    NEW.next_follow_up_at := NULL;
  ELSE
    SELECT due_at INTO NEW.next_follow_up_at FROM crm_tasks WHERE id = NEW.next_action_task_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enquiries_project_next_follow_up ON enquiries;
CREATE TRIGGER enquiries_project_next_follow_up
BEFORE INSERT OR UPDATE ON enquiries
FOR EACH ROW EXECUTE FUNCTION crm_project_next_follow_up();
