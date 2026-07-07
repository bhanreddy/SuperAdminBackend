-- 06_billing_logo.sql
-- Optional supplier logo for billing documents. Additive, idempotent.
-- When set (an https URL or a data: URI), it overrides the bundled brand mark in
-- the document header + watermark. When null, the renderer uses the bundled logo.
-- Run on the central (Cluster A school) database.

ALTER TABLE billing_config
  ADD COLUMN IF NOT EXISTS supplier_logo_url TEXT;
