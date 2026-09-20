-- 12_sprint_command_center.sql
-- Relational schema for the 10-Day RED ALERT Command Center (100 hard deliverables)

CREATE TABLE IF NOT EXISTS sprint_days (
  day INT PRIMARY KEY,
  date_label TEXT NOT NULL,
  title TEXT NOT NULL,
  handoff TEXT NOT NULL,
  gate TEXT NOT NULL,
  gate_status TEXT NOT NULL DEFAULT 'pending' CHECK (gate_status IN ('pending', 'in_progress', 'passed', 'blocked')),
  gate_notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sprint_tasks (
  id VARCHAR(32) PRIMARY KEY,
  role VARCHAR(16) NOT NULL CHECK (role IN ('tech', 'curr', 'sales', 'scale')),
  num INT NOT NULL,
  title TEXT NOT NULL,
  day INT NOT NULL REFERENCES sprint_days(day),
  orig_day_label TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  assignee_id UUID,
  assignee_name TEXT,
  blocker_reason TEXT,
  notes TEXT,
  completed_at TIMESTAMPTZ,
  last_updated_by_name TEXT,
  last_updated_by_id UUID,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sprint_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id VARCHAR(32),
  day INT,
  role VARCHAR(16),
  action TEXT NOT NULL,
  old_status VARCHAR(16),
  new_status VARCHAR(16),
  details TEXT,
  user_name TEXT,
  user_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sprint_tasks_day ON sprint_tasks(day);
CREATE INDEX IF NOT EXISTS idx_sprint_tasks_role ON sprint_tasks(role);
CREATE INDEX IF NOT EXISTS idx_sprint_tasks_status ON sprint_tasks(status);
CREATE INDEX IF NOT EXISTS idx_sprint_activity_created ON sprint_activity_logs(created_at DESC);
