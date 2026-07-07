-- 05_billing.sql
-- NexSyrus Client Billing Module (SaaS subscription invoicing — GST + Non-GST).
--
-- SCOPE: This is NexSyrus billing its OWN clients (schools / clinics / retail) for
-- the SaaS subscription itself. It is NOT school-internal fee collection. These
-- documents live in the CENTRAL/admin DB (the School Supabase reached via the raw
-- `postgres` connection in src/config/db.js — the same DB that holds `clusters`,
-- `collections`, `expenses`, `enquiries`). Run this ONCE on the central DB only.
--
-- DESIGN NOTE (STEP-0 audit outcome): There is no central `clients` table. Real
-- clients are `schools` + `medical_profile` rows that live INSIDE each cluster's
-- own Supabase, across two verticals — so a hard FK from a central billing table
-- is impossible. Per the chosen "free-text snapshot only" model, a billing
-- document carries its own frozen client snapshot (legal name / GSTIN / address)
-- captured at issue time. `client_id` / `client_kind` / `client_cluster_id` are
-- OPTIONAL, informational back-references only — never FK-enforced, never joined.
--
-- All statements are additive and idempotent. No existing table is altered.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Supplier / GST configuration (single source — NOT hardcoded in code).
--    One row, id = 1. Seeded with safe placeholders; Bhanu must fill real values.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_config (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  supplier_legal_name  TEXT,
  supplier_gstin       TEXT,
  supplier_state_code  TEXT,           -- 2-digit, normally first 2 chars of supplier_gstin
  supplier_address     TEXT,
  invoice_prefix       TEXT NOT NULL DEFAULT 'NEX',
  default_gst_rate     NUMERIC(4,2) NOT NULL DEFAULT 18.00,
  default_sac_code     TEXT,           -- TODO(Bhanu): confirm SAC for SaaS services with CA
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_config (id, supplier_legal_name, supplier_gstin, supplier_state_code,
                            supplier_address, invoice_prefix, default_gst_rate, default_sac_code)
VALUES (1, 'NexSyrus', NULL, NULL, NULL, 'NEX', 18.00, NULL)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Per-financial-year, per-document-type atomic counter.
--    This is the ONLY source of invoice / receipt sequence numbers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_document_counters (
  financial_year TEXT NOT NULL,        -- e.g. '2026-27'
  document_type  TEXT NOT NULL CHECK (document_type IN ('tax_invoice', 'receipt')),
  last_number    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (financial_year, document_type)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Issued documents. Immutable once status = 'issued' (enforced by trigger).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_number TEXT UNIQUE NOT NULL,        -- e.g. NEX/26-27/TI/0001 | NEX/26-27/RCT/0001
  document_type   TEXT NOT NULL CHECK (document_type IN ('tax_invoice', 'receipt')),
  financial_year  TEXT NOT NULL,

  -- Optional, informational client back-reference. NO foreign key (clients live
  -- in per-cluster DBs). Never joined — the snapshot fields below are authoritative.
  client_id          UUID,
  client_kind        TEXT CHECK (client_kind IN ('school', 'medical')),
  client_cluster_id  TEXT,

  -- SNAPSHOT fields — frozen at issue time. A compliance document must reflect
  -- what was true the day it was issued.
  client_legal_name     TEXT NOT NULL,
  client_gstin          TEXT,
  client_billing_address TEXT NOT NULL,
  client_state_code     TEXT,

  supplier_gstin             TEXT NOT NULL,
  supplier_state_code        TEXT NOT NULL,
  place_of_supply_state_code TEXT NOT NULL,

  line_items   JSONB NOT NULL,                 -- [{description, sac_code, quantity, rate, amount}]
  taxable_value NUMERIC(12,2) NOT NULL,

  cgst_rate   NUMERIC(4,2),
  cgst_amount NUMERIC(12,2),
  sgst_rate   NUMERIC(4,2),
  sgst_amount NUMERIC(12,2),
  igst_rate   NUMERIC(4,2),
  igst_amount NUMERIC(12,2),

  total_amount NUMERIC(12,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  pdf_url      TEXT,
  issued_at    TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_documents_client  ON billing_documents(client_id);
CREATE INDEX IF NOT EXISTS idx_billing_documents_fy_type ON billing_documents(financial_year, document_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Immutability guard.
--    Once status = 'issued', the only permitted mutation is status -> 'cancelled'.
--    Any change to a financial / snapshot field on an issued document is rejected
--    at the DATABASE level (not application discipline). Corrections are made by
--    issuing a NEW linked document, never by editing the original.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION billing_documents_guard_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    -- The single allowed transition: issued -> cancelled, touching nothing else.
    IF NEW.status = 'cancelled' AND ROW(
        NEW.document_number, NEW.document_type, NEW.financial_year,
        NEW.client_legal_name, NEW.client_gstin, NEW.client_billing_address,
        NEW.client_state_code, NEW.supplier_gstin, NEW.supplier_state_code,
        NEW.place_of_supply_state_code, NEW.line_items, NEW.taxable_value,
        NEW.cgst_rate, NEW.cgst_amount, NEW.sgst_rate, NEW.sgst_amount,
        NEW.igst_rate, NEW.igst_amount, NEW.total_amount
      ) IS NOT DISTINCT FROM ROW(
        OLD.document_number, OLD.document_type, OLD.financial_year,
        OLD.client_legal_name, OLD.client_gstin, OLD.client_billing_address,
        OLD.client_state_code, OLD.supplier_gstin, OLD.supplier_state_code,
        OLD.place_of_supply_state_code, OLD.line_items, OLD.taxable_value,
        OLD.cgst_rate, OLD.cgst_amount, OLD.sgst_rate, OLD.sgst_amount,
        OLD.igst_rate, OLD.igst_amount, OLD.total_amount
      ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'billing_documents row % is issued and immutable; only status -> cancelled is permitted (issue a new linked document to correct)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_billing_documents_immutable ON billing_documents;
CREATE TRIGGER trg_billing_documents_immutable
  BEFORE UPDATE ON billing_documents
  FOR EACH ROW
  EXECUTE FUNCTION billing_documents_guard_immutable();
