-- Upgrade an existing Sprint Command Center to the RED ALERT v3 owner model.
-- Task/day replacement is performed idempotently by src/services/sprintSeed.js.

ALTER TABLE sprint_tasks
  DROP CONSTRAINT IF EXISTS sprint_tasks_role_check;

ALTER TABLE sprint_tasks
  ADD CONSTRAINT sprint_tasks_role_check
  CHECK (role IN ('tech', 'curr', 'sales', 'scale')) NOT VALID;
