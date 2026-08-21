-- 12_employee_payroll.sql
-- NexSyrus central employee, payroll and HR document module.
-- Additive and idempotent. Run once on the central SuperAdmin database.

CREATE TABLE IF NOT EXISTS payroll_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  organisation_name TEXT NOT NULL DEFAULT 'NexSyrus',
  organisation_address TEXT,
  authorised_signatory TEXT,
  authorised_signatory_title TEXT DEFAULT 'Founder & CEO',
  salary_day INTEGER NOT NULL DEFAULT 28 CHECK (salary_day BETWEEN 1 AND 28),
  auto_process_enabled BOOLEAN NOT NULL DEFAULT true,
  pf_rate NUMERIC(5,2) NOT NULL DEFAULT 12.00,
  esi_rate NUMERIC(5,2) NOT NULL DEFAULT 0.75,
  esi_gross_limit NUMERIC(12,2) NOT NULL DEFAULT 21000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payroll_config ADD COLUMN IF NOT EXISTS authorised_signatory_image TEXT;

INSERT INTO payroll_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS employee_code_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  designation TEXT NOT NULL,
  department TEXT NOT NULL,
  employment_type TEXT NOT NULL DEFAULT 'FULL_TIME'
    CHECK (employment_type IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ON_LEAVE', 'EXITED')),
  joining_date DATE NOT NULL,
  exit_date DATE,
  date_of_birth DATE,
  pan_number TEXT,
  bank_account_number TEXT,
  bank_ifsc TEXT,
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (basic_salary >= 0),
  hra NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (hra >= 0),
  allowances NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  fixed_deductions NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fixed_deductions >= 0),
  pf_enabled BOOLEAN NOT NULL DEFAULT false,
  esi_enabled BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (exit_date IS NULL OR exit_date >= joining_date)
);

CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status, full_name);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department, status);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  payroll_month INTEGER NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  payroll_year INTEGER NOT NULL CHECK (payroll_year BETWEEN 2000 AND 2200),
  working_days NUMERIC(5,2) NOT NULL,
  paid_days NUMERIC(5,2) NOT NULL,
  basic_pay NUMERIC(12,2) NOT NULL,
  hra_pay NUMERIC(12,2) NOT NULL,
  allowance_pay NUMERIC(12,2) NOT NULL,
  gross_pay NUMERIC(12,2) NOT NULL,
  pf_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  esi_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSED'
    CHECK (status IN ('DRAFT', 'PROCESSED', 'PAID', 'FAILED')),
  calculation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(employee_id, payroll_year, payroll_month)
);

CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll_runs(payroll_year DESC, payroll_month DESC, status);

CREATE TABLE IF NOT EXISTS employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  payroll_run_id UUID REFERENCES payroll_runs(id) ON DELETE SET NULL,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'PAYSLIP', 'EMPLOYMENT_CERTIFICATE', 'EXPERIENCE_CERTIFICATE',
    'INTERNSHIP_CERTIFICATE', 'OFFER_LETTER', 'RELIEVING_LETTER'
  )),
  document_number TEXT NOT NULL UNIQUE,
  verification_token UUID NOT NULL DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe upgrade path if this migration was applied before certificate
-- verification links were introduced.
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS verification_token UUID DEFAULT gen_random_uuid();
UPDATE employee_documents SET verification_token = gen_random_uuid() WHERE verification_token IS NULL;
ALTER TABLE employee_documents ALTER COLUMN verification_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_documents_verification_token
  ON employee_documents(verification_token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_documents_payslip
  ON employee_documents(payroll_run_id, document_type)
  WHERE document_type = 'PAYSLIP';
CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id, generated_at DESC);
