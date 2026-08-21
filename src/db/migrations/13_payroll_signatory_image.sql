-- 13_payroll_signatory_image.sql
-- Digital signature image used on HR certificates (internship, employment, etc).
-- Stored as a data URI so generated HTML remains self-contained.

ALTER TABLE payroll_config
  ADD COLUMN IF NOT EXISTS authorised_signatory_image TEXT;
