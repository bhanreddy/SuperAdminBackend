-- 20_field_visits.sql
-- Sales Executive Field Visit & School Intelligence System.
-- Additive only. Reuses enquiries (leads), crm_accounts, crm_contacts,
-- crm_school_profiles, crm_tasks, crm_demos, crm_stage_history.
-- Does NOT duplicate school/lead/contact/task concepts.

-- Executive home/base location (one row per founder, privacy: only business metrics exposed)
CREATE TABLE IF NOT EXISTS crm_executive_home_base (
  founder_id UUID PRIMARY KEY,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  locality TEXT,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily field day per executive
CREATE TABLE IF NOT EXISTS sales_field_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executive_id UUID NOT NULL,
  executive_name TEXT,
  date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  start_locality TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED')),
  total_distance_km NUMERIC(10,2) NOT NULL DEFAULT 0,
  planned_count INTEGER NOT NULL DEFAULT 0,
  visited_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  demo_count INTEGER NOT NULL DEFAULT 0,
  client_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (executive_id, date)
);
CREATE INDEX IF NOT EXISTS idx_field_days_exec_date ON sales_field_days (executive_id, date DESC);

-- Core visit record
CREATE TABLE IF NOT EXISTS sales_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executive_id UUID NOT NULL,
  field_day_id UUID REFERENCES sales_field_days(id) ON DELETE SET NULL,
  school_account_id UUID REFERENCES crm_accounts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES enquiries(id) ON DELETE SET NULL,
  planned BOOLEAN NOT NULL DEFAULT true,
  unplanned BOOLEAN NOT NULL DEFAULT false,
  sequence_number INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'CHECKED_IN'
    CHECK (status IN ('CHECKED_IN','IN_PROGRESS','COMPLETED','SKIPPED')),
  checkin_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkout_at TIMESTAMPTZ,
  checkin_lat DOUBLE PRECISION,
  checkin_lng DOUBLE PRECISION,
  checkout_lat DOUBLE PRECISION,
  checkout_lng DOUBLE PRECISION,
  gps_accuracy DOUBLE PRECISION,
  verification_status TEXT NOT NULL DEFAULT 'VERIFIED'
    CHECK (verification_status IN ('VERIFIED','WARNING','OUTSIDE','NO_SCHOOL_GPS')),
  proximity_distance_m DOUBLE PRECISION,
  remote_reason TEXT,
  previous_visit_id UUID REFERENCES sales_visits(id) ON DELETE SET NULL,
  origin_type TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (origin_type IN ('HOME_BASE','PREVIOUS_SCHOOL','MANUAL_ROUTE_CORRECTION','DAY_START_LOCATION','UNKNOWN')),
  origin_lat DOUBLE PRECISION,
  origin_lng DOUBLE PRECISION,
  route_distance_km NUMERIC(10,2),
  straight_distance_km NUMERIC(10,2),
  distance_source TEXT NOT NULL DEFAULT 'haversine'
    CHECK (distance_source IN ('google_routes','mapbox','haversine','cached_route')),
  distance_calculated_at TIMESTAMPTZ,
  visit_outcome TEXT CHECK (visit_outcome IN (
    'INTERESTED','DEMO_COMPLETED','FOLLOW_UP_REQUIRED','PROPOSAL_REQUESTED',
    'PILOT_REQUESTED','NEGOTIATION','NOT_INTERESTED','DM_UNAVAILABLE',
    'REVISIT_REQUIRED','CLOSED_WON','CLOSED_LOST')),
  lost_reason TEXT,
  visit_duration_minutes INTEGER,
  qualification JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority TEXT CHECK (priority IS NULL OR priority IN ('HIGH','MEDIUM','LOW')),
  priority_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  client_key TEXT NOT NULL UNIQUE,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visits_exec_day ON sales_visits (executive_id, checkin_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_day ON sales_visits (field_day_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_visits_school ON sales_visits (school_account_id, checkin_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_lead ON sales_visits (lead_id, checkin_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_outcome ON sales_visits (visit_outcome, checkin_at DESC);

-- Extended school sales profile (one per account, updated not re-entered)
CREATE TABLE IF NOT EXISTS school_sales_profiles (
  account_id UUID PRIMARY KEY REFERENCES crm_accounts(id) ON DELETE CASCADE,
  total_students INTEGER CHECK (total_students IS NULL OR (total_students >= 0 AND total_students <= 100000)),
  student_range TEXT CHECK (student_range IS NULL OR student_range IN ('<200','200-500','500-1000','1000-2000','2000+')),
  teaching_staff INTEGER,
  non_teaching_staff INTEGER,
  bus_count INTEGER,
  branch_count INTEGER,
  fee_range TEXT,
  growth_trend TEXT CHECK (growth_trend IS NULL OR growth_trend IN ('GROWING','STABLE','DECLINING','UNKNOWN')),
  uses_erp BOOLEAN,
  erp_vendor TEXT,
  erp_yearly_cost NUMERIC(14,2),
  erp_modules TEXT[] NOT NULL DEFAULT '{}',
  erp_satisfaction TEXT CHECK (erp_satisfaction IS NULL OR erp_satisfaction IN ('LOW','MEDIUM','HIGH')),
  erp_renewal_month INTEGER CHECK (erp_renewal_month IS NULL OR (erp_renewal_month BETWEEN 1 AND 12)),
  erp_problems TEXT,
  erp_switch_reason TEXT,
  product_interests TEXT[] NOT NULL DEFAULT '{}',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  visit_count INTEGER NOT NULL DEFAULT 0,
  last_visit_at TIMESTAMPTZ,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Requirement discovery rows
CREATE TABLE IF NOT EXISTS school_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES sales_visits(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('MANAGEMENT','TEACHER','PARENT')),
  problem_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_requirements_account ON school_requirements (account_id, category);

-- Demo sessions tied to visit (mirrors into crm_demos when lead known)
CREATE TABLE IF NOT EXISTS sales_demo_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES sales_visits(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES enquiries(id) ON DELETE SET NULL,
  demo_type TEXT NOT NULL DEFAULT 'QUICK_DEMO'
    CHECK (demo_type IN ('QUICK_DEMO','FULL_DEMO','MANAGEMENT_DEMO','STAFF_DEMO','TECHNICAL_DEMO','FOLLOW_UP_DEMO')),
  duration_minutes INTEGER,
  attendees_count INTEGER,
  features_shown TEXT[] NOT NULL DEFAULT '{}',
  questions TEXT,
  objections TEXT,
  requested_features TEXT,
  given_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Commercial intelligence per visit
CREATE TABLE IF NOT EXISTS sales_commercials (
  visit_id UUID PRIMARY KEY REFERENCES sales_visits(id) ON DELETE CASCADE,
  current_erp_cost NUMERIC(14,2),
  expected_budget NUMERIC(14,2),
  quoted_price NUMERIC(14,2),
  billing_preference TEXT,
  pricing_objection TEXT,
  requested_discount_pct NUMERIC(5,2),
  procurement_timeline TEXT,
  discount_approval_required BOOLEAN NOT NULL DEFAULT false,
  discount_approval_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (discount_approval_status IN ('NONE','PENDING','APPROVED','REJECTED'))
);

-- Follow-ups (also mirrored into crm_tasks when lead known)
CREATE TABLE IF NOT EXISTS sales_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID REFERENCES sales_visits(id) ON DELETE SET NULL,
  account_id UUID REFERENCES crm_accounts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES enquiries(id) ON DELETE SET NULL,
  executive_id UUID NOT NULL,
  action TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  contact_name TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','BREACHED','CANCELLED')),
  crm_task_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followups_exec_due ON sales_followups (executive_id, status, due_at);

-- Append-only visit timeline events (immutable)
CREATE TABLE IF NOT EXISTS sales_visit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES sales_visits(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  label TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visit_events_visit ON sales_visit_events (visit_id, occurred_at);

CREATE OR REPLACE FUNCTION sales_visit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'visit timeline is append-only';
END $$;
DROP TRIGGER IF EXISTS visit_events_immutable ON sales_visit_events;
CREATE TRIGGER visit_events_no_update
BEFORE UPDATE OR DELETE ON sales_visit_events
FOR EACH ROW EXECUTE FUNCTION sales_visit_events_immutable();

-- Evidence metadata (binary stored via existing upload infra / bytea capped)
CREATE TABLE IF NOT EXISTS sales_visit_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES sales_visits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('SCHOOL_PHOTO','BUSINESS_CARD','BROCHURE_HANDOVER','MEETING_NOTE','PROPOSAL_DOC','VOICE_NOTE','MEETING_PHOTO')),
  file_name TEXT,
  content_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 15000000)),
  storage_ref TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extend contacts for decision-maker intelligence (reuses crm_contacts)
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS influence_level TEXT
  CHECK (influence_level IS NULL OR influence_level IN ('DECISION_MAKER','STRONG_INFLUENCER','EVALUATOR','GATEKEEPER','USER'));
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS decision_authority TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS preferred_contact_method TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS preferred_followup_time TEXT;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS last_met_at TIMESTAMPTZ;

REVOKE ALL ON sales_field_days, sales_visits, school_sales_profiles, school_requirements,
  sales_demo_sessions, sales_commercials, sales_followups, sales_visit_events,
  sales_visit_evidence, crm_executive_home_base FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON sales_field_days, sales_visits, school_sales_profiles, school_requirements,
      sales_demo_sessions, sales_commercials, sales_followups, sales_visit_events,
      sales_visit_evidence, crm_executive_home_base FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON sales_field_days, sales_visits, school_sales_profiles, school_requirements,
      sales_demo_sessions, sales_commercials, sales_followups, sales_visit_events,
      sales_visit_evidence, crm_executive_home_base FROM authenticated;
  END IF;
END $$;
