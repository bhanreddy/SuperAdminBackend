-- Field feedback capture and internal backlog queues.
-- Product, Sales/Enablement, and Curriculum do not have a live backlog API in
-- this service. These tables are the configurable queues for those teams.
-- A submission is immutable. Routing state is separate from backlog status.
-- Sending feedback does not commit a delivery date.

CREATE TABLE IF NOT EXISTS field_feedback_destinations (
  key TEXT PRIMARY KEY CHECK (key IN ('product', 'sales_enablement', 'curriculum', 'triage')),
  label TEXT NOT NULL,
  accountable_team TEXT NOT NULL,
  default_owner_founder_id UUID REFERENCES founders(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO field_feedback_destinations (key, label, accountable_team)
VALUES
  ('product', 'Product backlog', 'Product'),
  ('sales_enablement', 'Sales/Enablement backlog', 'Sales and Enablement'),
  ('curriculum', 'Curriculum backlog', 'Curriculum'),
  ('triage', 'Triage queue', 'Feedback triage')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS field_feedback_routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('feature_request', 'objection', 'curriculum_finding', 'unsure')),
  destination_key TEXT NOT NULL REFERENCES field_feedback_destinations(key),
  priority INTEGER NOT NULL DEFAULT 10,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO field_feedback_routing_rules (category, destination_key, priority, active)
SELECT seed.category, seed.destination_key, 10, true
FROM (VALUES
  ('feature_request', 'product'),
  ('objection', 'sales_enablement'),
  ('curriculum_finding', 'curriculum'),
  ('unsure', 'triage')
) AS seed(category, destination_key)
WHERE NOT EXISTS (
  SELECT 1 FROM field_feedback_routing_rules existing
  WHERE existing.category = seed.category AND existing.active = true
);

CREATE TABLE IF NOT EXISTS field_feedback_triagers (
  founder_id UUID PRIMARY KEY REFERENCES founders(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('feature_request', 'objection', 'curriculum_finding', 'unsure')),
  title TEXT NOT NULL,
  observation TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('customer_interaction', 'class_session', 'demo', 'visit', 'other')),
  context_note TEXT,
  source_type TEXT CHECK (source_type IN ('enquiry', 'account', 'school')),
  source_id TEXT,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE SET NULL,
  customer_label TEXT,
  product_area TEXT,
  course_name TEXT,
  module_name TEXT,
  lesson_name TEXT,
  impact TEXT,
  reported_urgency TEXT CHECK (reported_urgency IS NULL OR reported_urgency IN ('low', 'normal', 'high', 'critical')),
  evidence TEXT,
  submitter_user_id UUID NOT NULL,
  submitter_founder_id UUID REFERENCES founders(id) ON DELETE SET NULL,
  submitter_name TEXT,
  submitter_email TEXT,
  prefill JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES field_feedback_submissions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 1000000),
  checksum TEXT NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES field_feedback_submissions(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL CHECK (category IN ('feature_request', 'objection', 'curriculum_finding', 'unsure')),
  title TEXT NOT NULL,
  source_observation TEXT NOT NULL,
  focus_note TEXT,
  context_kind TEXT NOT NULL,
  context_note TEXT,
  source_type TEXT,
  source_id TEXT,
  account_id UUID,
  customer_label TEXT,
  product_area TEXT,
  course_name TEXT,
  module_name TEXT,
  lesson_name TEXT,
  impact TEXT,
  evidence TEXT,
  reported_urgency TEXT,
  submitter_user_id UUID NOT NULL,
  submitter_founder_id UUID,
  submitter_name TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  destination_key TEXT NOT NULL REFERENCES field_feedback_destinations(key),
  accountable_team TEXT NOT NULL,
  owner_founder_id UUID REFERENCES founders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'needs_clarification', 'accepted', 'in_progress', 'resolved', 'duplicate', 'declined')),
  triage_priority TEXT CHECK (triage_priority IS NULL OR triage_priority IN ('low', 'medium', 'high', 'urgent')),
  routing_state TEXT NOT NULL DEFAULT 'pending' CHECK (routing_state IN ('pending', 'routed', 'failed')),
  external_ref TEXT,
  routing_error TEXT,
  routing_attempts INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT,
  resolution_note TEXT,
  duplicate_of_id UUID REFERENCES field_feedback_items(id) ON DELETE RESTRICT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  routed_at TIMESTAMPTZ,
  UNIQUE (submission_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS field_feedback_queue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL UNIQUE REFERENCES field_feedback_items(id) ON DELETE RESTRICT,
  destination_key TEXT NOT NULL REFERENCES field_feedback_destinations(key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_routing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES field_feedback_items(id) ON DELETE CASCADE,
  from_category TEXT,
  to_category TEXT,
  from_destination TEXT,
  to_destination TEXT,
  reason TEXT NOT NULL,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID REFERENCES field_feedback_submissions(id) ON DELETE CASCADE,
  item_id UUID REFERENCES field_feedback_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_id UUID,
  reason TEXT,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES field_feedback_items(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL,
  author_name TEXT,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'clarification_request')),
  visibility TEXT NOT NULL CHECK (visibility IN ('shared', 'internal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_feedback_item_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES field_feedback_submissions(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES field_feedback_items(id) ON DELETE CASCADE,
  related_item_id UUID NOT NULL REFERENCES field_feedback_items(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('split', 'duplicate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, related_item_id, link_type)
);

CREATE TABLE IF NOT EXISTS field_feedback_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES field_feedback_items(id) ON DELETE CASCADE,
  submission_id UUID NOT NULL REFERENCES field_feedback_submissions(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  recipient_user_id UUID,
  recipient_founder_id UUID,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel_state TEXT NOT NULL DEFAULT 'pending' CHECK (channel_state IN ('pending', 'delivered', 'unavailable', 'skipped')),
  channel_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_field_feedback_items_destination
  ON field_feedback_items (destination_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_feedback_items_owner
  ON field_feedback_items (owner_founder_id, status);
CREATE INDEX IF NOT EXISTS idx_field_feedback_items_account
  ON field_feedback_items (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_feedback_submissions_submitter
  ON field_feedback_submissions (submitter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_feedback_routing_history_item
  ON field_feedback_routing_history (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_feedback_events_item
  ON field_feedback_events (item_id, created_at DESC);

CREATE OR REPLACE FUNCTION field_feedback_submission_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.observation IS DISTINCT FROM OLD.observation
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.feedback_type IS DISTINCT FROM OLD.feedback_type
     OR NEW.client_key IS DISTINCT FROM OLD.client_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.submitter_user_id IS DISTINCT FROM OLD.submitter_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'field feedback submissions are immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_field_feedback_submission_immutable ON field_feedback_submissions;
CREATE TRIGGER trg_field_feedback_submission_immutable
BEFORE UPDATE ON field_feedback_submissions
FOR EACH ROW EXECUTE FUNCTION field_feedback_submission_immutable();

CREATE OR REPLACE FUNCTION field_feedback_item_wording_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_observation IS DISTINCT FROM OLD.source_observation
     OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
     OR NEW.reported_urgency IS DISTINCT FROM OLD.reported_urgency
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.submitter_user_id IS DISTINCT FROM OLD.submitter_user_id
  THEN
    RAISE EXCEPTION 'original field feedback wording is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_field_feedback_item_wording_immutable ON field_feedback_items;
CREATE TRIGGER trg_field_feedback_item_wording_immutable
BEFORE UPDATE ON field_feedback_items
FOR EACH ROW EXECUTE FUNCTION field_feedback_item_wording_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON field_feedback_destinations, field_feedback_routing_rules, field_feedback_triagers,
      field_feedback_submissions, field_feedback_attachments, field_feedback_items, field_feedback_queue_entries,
      field_feedback_routing_history, field_feedback_events, field_feedback_comments, field_feedback_item_links,
      field_feedback_notifications FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON field_feedback_destinations, field_feedback_routing_rules, field_feedback_triagers,
      field_feedback_submissions, field_feedback_attachments, field_feedback_items, field_feedback_queue_entries,
      field_feedback_routing_history, field_feedback_events, field_feedback_comments, field_feedback_item_links,
      field_feedback_notifications FROM authenticated;
  END IF;
END $$;
