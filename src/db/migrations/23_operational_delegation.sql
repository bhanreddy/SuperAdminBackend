-- Multi-Role Operational Delegation & Hierarchy Extension
-- Additive migration: Preserves all existing tables, accounts, and relationships.

-- 1. Extend internal_users with distinct job_title
ALTER TABLE internal_users ADD COLUMN IF NOT EXISTS job_title TEXT;

-- 2. Extend schools with direct contact details
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_designation TEXT;

-- 3. Extend school_onboarding_checklists for delegated work items and accountability
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES internal_users(id) ON DELETE SET NULL;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS supervising_manager_id UUID REFERENCES internal_users(id) ON DELETE SET NULL;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'MEDIUM';
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS completion_outcome TEXT;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS evidence_url TEXT;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS escalation_reason TEXT;
ALTER TABLE school_onboarding_checklists ADD COLUMN IF NOT EXISTS escalated_to UUID REFERENCES internal_users(id) ON DELETE SET NULL;

-- 4. Constraint for task priority
ALTER TABLE school_onboarding_checklists DROP CONSTRAINT IF EXISTS school_onboarding_checklists_priority_check;
ALTER TABLE school_onboarding_checklists ADD CONSTRAINT school_onboarding_checklists_priority_check
  CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));

-- 5. Indexes for performant hierarchy and delegation queries
CREATE INDEX IF NOT EXISTS idx_school_checklists_assigned_to ON school_onboarding_checklists(assigned_to);
CREATE INDEX IF NOT EXISTS idx_school_checklists_supervising_manager ON school_onboarding_checklists(supervising_manager_id);
CREATE INDEX IF NOT EXISTS idx_school_checklists_due_date ON school_onboarding_checklists(due_date);
CREATE INDEX IF NOT EXISTS idx_school_checklists_status ON school_onboarding_checklists(status);
CREATE INDEX IF NOT EXISTS idx_internal_users_job_title ON internal_users(job_title);
