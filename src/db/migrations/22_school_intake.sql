-- School intake queue. A sales executive submits a dossier here.
-- The school tenant is created only after the founder approves it.

CREATE TABLE IF NOT EXISTS school_intake_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  submitted_by UUID NOT NULL REFERENCES internal_users(id),
  reviewed_by UUID REFERENCES internal_users(id),
  dossier JSONB NOT NULL,
  intelligence JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_note TEXT,
  school_id INTEGER,
  cluster_id TEXT,
  provision_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  onboarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT school_intake_requests_status_check CHECK (
    status IN ('SUBMITTED', 'CHANGES_REQUESTED', 'REJECTED', 'PROVISIONING', 'ONBOARDED', 'FAILED')
  )
);

CREATE INDEX IF NOT EXISTS idx_school_intake_status ON school_intake_requests(status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_school_intake_submitter ON school_intake_requests(submitted_by, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_school_intake_code ON school_intake_requests ((upper(dossier->>'code')));

CREATE TABLE IF NOT EXISTS school_intake_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES school_intake_requests(id) ON DELETE CASCADE,
  actor_id UUID,
  event_type TEXT NOT NULL,
  note TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_intake_events_request ON school_intake_events(request_id, created_at);
