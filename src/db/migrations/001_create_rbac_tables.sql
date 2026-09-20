-- Multi-Role RBAC System Tables Migration

-- Extend existing complaint enums for the SuperAdmin support workflow.
ALTER TYPE complaint_priority_enum ADD VALUE IF NOT EXISTS 'critical';
ALTER TYPE complaint_status_enum ADD VALUE IF NOT EXISTS 'waiting_on_client';
ALTER TYPE complaint_status_enum ADD VALUE IF NOT EXISTS 'escalated';
ALTER TYPE complaint_status_enum ADD VALUE IF NOT EXISTS 'reopened';

-- 1. Internal Users (Internal team members: Founders, Managers, Executives)
CREATE TABLE IF NOT EXISTS internal_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID,
  full_name TEXT NOT NULL,
  employee_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT,
  role TEXT NOT NULL,
  manager_id UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  territory TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'INVITED')),
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_internal_users_email ON internal_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_internal_users_employee_id ON internal_users(UPPER(employee_id));
CREATE INDEX IF NOT EXISTS idx_internal_users_phone ON internal_users(phone);
CREATE INDEX IF NOT EXISTS idx_internal_users_role ON internal_users(role);
CREATE INDEX IF NOT EXISTS idx_internal_users_manager_id ON internal_users(manager_id);
CREATE INDEX IF NOT EXISTS idx_internal_users_status ON internal_users(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_users_auth_user_id
  ON internal_users(auth_user_id) WHERE auth_user_id IS NOT NULL;
-- Idempotent upgrades for installations where internal_users already existed.
ALTER TABLE internal_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- 2. Internal User Schools (Explicit school-level tenant assignments)
CREATE TABLE IF NOT EXISTS internal_user_schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  school_id INTEGER NOT NULL,
  assigned_by UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_school UNIQUE (user_id, school_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_user_schools_user ON internal_user_schools(user_id);
CREATE INDEX IF NOT EXISTS idx_internal_user_schools_school ON internal_user_schools(school_id);

-- 3. Per-user permission overrides. Roles remain the default source of access;
-- these rows support explicit grants/denials without scattering role checks.
CREATE TABLE IF NOT EXISTS internal_user_permission_overrides (
  user_id UUID NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('GRANT', 'DENY')),
  changed_by UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_internal_permission_overrides_user
  ON internal_user_permission_overrides(user_id);

-- 4. Server-side refresh sessions. Only a SHA-256 digest of the opaque refresh
-- token is stored, allowing logout/revocation without trusting client state.
CREATE TABLE IF NOT EXISTS internal_user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_internal_sessions_user
  ON internal_user_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_sessions_active
  ON internal_user_sessions(id) WHERE revoked_at IS NULL;

-- 5. School Requirements (Custom school requests raised by Sales/Implementation/Support)
CREATE TABLE IF NOT EXISTS school_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'CUSTOM_APP' CHECK (category IN ('PAYMENT', 'CUSTOM_APP', 'TRANSPORT', 'ATTENDANCE', 'ACADEMIC', 'REPORTS', 'FEATURE', 'CUSTOMIZATION', 'INTEGRATION', 'DATA', 'HARDWARE', 'OTHER')),
  priority TEXT DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'IN_DEVELOPMENT', 'DEPLOYED', 'REJECTED')),
  feasibility_status TEXT CHECK (feasibility_status IS NULL OR feasibility_status IN ('FEASIBLE', 'NEEDS_REVIEW', 'NOT_FEASIBLE')),
  resolution_notes TEXT,
  raised_by UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_requirements_school ON school_requirements(school_id);
CREATE INDEX IF NOT EXISTS idx_school_requirements_status ON school_requirements(status);
CREATE INDEX IF NOT EXISTS idx_school_requirements_raised_by ON school_requirements(raised_by);

ALTER TABLE school_requirements ADD COLUMN IF NOT EXISTS feasibility_status TEXT;
ALTER TABLE school_requirements ADD COLUMN IF NOT EXISTS resolution_notes TEXT;
ALTER TABLE school_requirements DROP CONSTRAINT IF EXISTS school_requirements_category_check;
ALTER TABLE school_requirements ADD CONSTRAINT school_requirements_category_check
  CHECK (category IN ('PAYMENT', 'CUSTOM_APP', 'TRANSPORT', 'ATTENDANCE', 'ACADEMIC', 'REPORTS', 'FEATURE', 'CUSTOMIZATION', 'INTEGRATION', 'DATA', 'HARDWARE', 'OTHER'));
ALTER TABLE school_requirements DROP CONSTRAINT IF EXISTS school_requirements_status_check;
UPDATE school_requirements SET status = CASE status
  WHEN 'PENDING' THEN 'OPEN'
  WHEN 'IN_REVIEW' THEN 'UNDER_REVIEW'
  WHEN 'APPROVED' THEN 'UNDER_REVIEW'
  WHEN 'COMPLETED' THEN 'DEPLOYED'
  ELSE status
END;
ALTER TABLE school_requirements ADD CONSTRAINT school_requirements_status_check
  CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'IN_DEVELOPMENT', 'DEPLOYED', 'REJECTED'));
ALTER TABLE school_requirements ALTER COLUMN status SET DEFAULT 'OPEN';

-- 6. School Onboarding Checklists (Milestone & task tracking for onboarding & implementation)
CREATE TABLE IF NOT EXISTS school_onboarding_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('CONTRACT_AND_SETUP', 'DATA_INGESTION', 'HARDWARE_AND_INFRA', 'APP_BUILD', 'TRAINING_AND_GO_LIVE')),
  status TEXT DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'NOT_APPLICABLE')),
  blocker_reason TEXT,
  notes TEXT,
  completed_by UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_school_checklist_task UNIQUE (school_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_school_checklists_school ON school_onboarding_checklists(school_id);
CREATE INDEX IF NOT EXISTS idx_school_checklists_task ON school_onboarding_checklists(school_id, task_key);

ALTER TABLE school_onboarding_checklists
  DROP CONSTRAINT IF EXISTS school_onboarding_checklists_category_check;
UPDATE school_onboarding_checklists
SET category = CASE category
  WHEN 'BASIC_INFO' THEN 'CONTRACT_AND_SETUP'
  WHEN 'DATA_IMPORT' THEN 'DATA_INGESTION'
  WHEN 'CONFIG' THEN 'CONTRACT_AND_SETUP'
  WHEN 'VERIFICATION' THEN 'APP_BUILD'
  WHEN 'DEPLOYMENT' THEN 'TRAINING_AND_GO_LIVE'
  ELSE category
END;
ALTER TABLE school_onboarding_checklists
  ADD CONSTRAINT school_onboarding_checklists_category_check
  CHECK (category IN ('CONTRACT_AND_SETUP', 'DATA_INGESTION', 'HARDWARE_AND_INFRA', 'APP_BUILD', 'TRAINING_AND_GO_LIVE'));
ALTER TABLE school_onboarding_checklists
  DROP CONSTRAINT IF EXISTS school_onboarding_checklists_status_check;
UPDATE school_onboarding_checklists SET status = 'NOT_STARTED' WHERE status = 'PENDING';
ALTER TABLE school_onboarding_checklists
  ADD CONSTRAINT school_onboarding_checklists_status_check
  CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'NOT_APPLICABLE'));
ALTER TABLE school_onboarding_checklists ALTER COLUMN status SET DEFAULT 'NOT_STARTED';

-- 7. Support Ticket Notes (Internal notes and customer communication updates on tickets)
CREATE TABLE IF NOT EXISTS support_ticket_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id TEXT NOT NULL,
  author_id UUID REFERENCES internal_users(id) ON DELETE SET NULL,
  author_name TEXT,
  note TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_notes_ticket ON support_ticket_notes(ticket_id);

-- Relax user_id FK on audit_logs so internal users and system actors can write audit logs
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;

-- Complaints can be created and assigned by either a school user or an internal
-- SuperAdmin operator. UUID identity is preserved while cross-domain FKs are
-- intentionally removed; all access remains enforced by the API RBAC layer.
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_raised_by_fkey;
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_assigned_to_fkey;
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_resolved_by_fkey;
