-- Plan a field day before it starts. A stop stays PLANNED until check-in.
-- Does not create a second school or lead table.

ALTER TABLE sales_field_days DROP CONSTRAINT IF EXISTS sales_field_days_status_check;
ALTER TABLE sales_field_days ADD CONSTRAINT sales_field_days_status_check
  CHECK (status IN ('PLANNED', 'ACTIVE', 'COMPLETED'));
ALTER TABLE sales_field_days ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE sales_field_days ALTER COLUMN started_at DROP DEFAULT;

ALTER TABLE sales_visits DROP CONSTRAINT IF EXISTS sales_visits_status_check;
ALTER TABLE sales_visits ADD CONSTRAINT sales_visits_status_check
  CHECK (status IN ('PLANNED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'));
ALTER TABLE sales_visits ALTER COLUMN checkin_at DROP NOT NULL;
ALTER TABLE sales_visits ALTER COLUMN checkin_at DROP DEFAULT;

ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ;
ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS research_note TEXT;
ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS area_label TEXT;
ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS contact_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_visits_planned_day
  ON sales_visits (field_day_id, sequence_number)
  WHERE status = 'PLANNED';
