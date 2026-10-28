-- Native SuperAdmin accounting. Central/admin database only; independent of tenant billing.
BEGIN;
CREATE TABLE IF NOT EXISTS books_settings (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), organization_name text NOT NULL DEFAULT 'NexSyrus',
 address text NOT NULL DEFAULT '', gstin text NOT NULL DEFAULT '', state_code text NOT NULL DEFAULT '',
 currency text NOT NULL DEFAULT 'INR' CHECK(currency='INR'), fiscal_year_month integer NOT NULL DEFAULT 4 CHECK(fiscal_year_month BETWEEN 1 AND 12),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO books_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS books_accounts (
 code text PRIMARY KEY, name text NOT NULL, type text NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
 is_cash boolean NOT NULL DEFAULT false
);
INSERT INTO books_accounts(code,name,type,is_cash) VALUES
 ('1000','Cash','asset',true),('1010','Bank','asset',true),('1100','Accounts receivable','asset',false),
 ('1200','Inventory','asset',false),('1300','Input tax','asset',false),('2000','Accounts payable','liability',false),
 ('2200','Output tax','liability',false),('3000','Owner equity','equity',false),
 ('4000','Sales','income',false),('5000','Operating expenses','expense',false),('5100','Cost of goods sold','expense',false),('5200','Purchase price variance','expense',false)
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS books_contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('customer','vendor','both')),
 name text NOT NULL CHECK(length(trim(name))>0), email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
 gstin text NOT NULL DEFAULT '', state_code text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
 payment_terms integer NOT NULL DEFAULT 30 CHECK(payment_terms BETWEEN 0 AND 365), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(trim(name))>0), sku text UNIQUE,
 unit text NOT NULL DEFAULT 'unit', hsn_sac text NOT NULL DEFAULT '', sale_rate bigint NOT NULL DEFAULT 0 CHECK(sale_rate>=0),
 purchase_rate bigint NOT NULL DEFAULT 0 CHECK(purchase_rate>=0), tax_rate integer NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 10000),
 track_inventory boolean NOT NULL DEFAULT false, stock_milli bigint NOT NULL DEFAULT 0 CHECK(stock_milli>=0), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_counters (kind text NOT NULL, year integer NOT NULL, value integer NOT NULL, PRIMARY KEY(kind,year));
CREATE TABLE IF NOT EXISTS books_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('quote','sales_order','invoice','credit_note','purchase_order','bill','expense','vendor_credit')),
 number text UNIQUE NOT NULL, contact_id uuid REFERENCES books_contacts(id), contact_snapshot jsonb NOT NULL,
 organization_snapshot jsonb NOT NULL, date date NOT NULL, due_date date, reference text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
 lines jsonb NOT NULL, subtotal bigint NOT NULL CHECK(subtotal>=0), tax bigint NOT NULL CHECK(tax>=0), total bigint NOT NULL CHECK(total>=0),
 tax_breakup jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','void')),
 paid_account text REFERENCES books_accounts(code), source_id uuid REFERENCES books_documents(id),
 created_by text, created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS books_one_conversion ON books_documents(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_document_list ON books_documents(kind,date DESC);
CREATE TABLE IF NOT EXISTS books_journals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL, reference text NOT NULL, notes text NOT NULL DEFAULT '',
 source text NOT NULL, source_id uuid NOT NULL, reversal_of uuid UNIQUE REFERENCES books_journals(id),
 created_by text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS books_journal_lines (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, journal_id uuid NOT NULL REFERENCES books_journals(id),
 account_code text NOT NULL REFERENCES books_accounts(code), debit bigint NOT NULL DEFAULT 0 CHECK(debit>=0),
 credit bigint NOT NULL DEFAULT 0 CHECK(credit>=0), CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
);
CREATE INDEX IF NOT EXISTS books_ledger_account ON books_journal_lines(account_code,journal_id);
CREATE TABLE IF NOT EXISTS books_stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES books_items(id),
 document_id uuid REFERENCES books_documents(id), quantity_milli bigint NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES books_documents(id),
 date date NOT NULL, amount bigint NOT NULL CHECK(amount>0), account_code text NOT NULL REFERENCES books_accounts(code),
 method text NOT NULL DEFAULT 'bank_transfer', reference text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','void')),
 request_key uuid UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_credit_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), credit_id uuid NOT NULL REFERENCES books_documents(id),
 document_id uuid NOT NULL REFERENCES books_documents(id), amount bigint NOT NULL CHECK(amount>0), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(credit_id<>document_id)
);
CREATE TABLE IF NOT EXISTS books_bank_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_code text NOT NULL REFERENCES books_accounts(code), date date NOT NULL,
 description text NOT NULL, amount bigint NOT NULL CHECK(amount<>0), reference text NOT NULL DEFAULT '',
 external_key text NOT NULL, matched_payment_id uuid UNIQUE REFERENCES books_payments(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_code,external_key)
);
CREATE TABLE IF NOT EXISTS books_projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, contact_id uuid REFERENCES books_contacts(id),
 budget bigint NOT NULL DEFAULT 0 CHECK(budget>=0), hourly_rate bigint NOT NULL DEFAULT 0 CHECK(hourly_rate>=0),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_time_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES books_projects(id), date date NOT NULL,
 minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440), description text NOT NULL, billable boolean NOT NULL DEFAULT true,
 invoice_id uuid REFERENCES books_documents(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_recurring (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), template_id uuid NOT NULL REFERENCES books_documents(id),
 interval_months integer NOT NULL CHECK(interval_months IN (1,3,6,12)), next_date date NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid REFERENCES books_documents(id),
 filename text NOT NULL, content_type text NOT NULL, size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),
 content bytea NOT NULL, sha256 text NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books_activity (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, entity text NOT NULL, entity_id uuid NOT NULL,
 action text NOT NULL, actor text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'books_%' LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
 END LOOP;
END $$;
-- Posted ledger facts cannot be edited/deleted. Corrections append reversing entries.
CREATE OR REPLACE FUNCTION books_immutable_journal() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Posted journal entries are immutable; append a reversal' USING ERRCODE='23514'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS books_journal_immutable ON books_journals;
CREATE TRIGGER books_journal_immutable BEFORE UPDATE OR DELETE ON books_journals FOR EACH ROW EXECUTE FUNCTION books_immutable_journal();
DROP TRIGGER IF EXISTS books_line_immutable ON books_journal_lines;
CREATE TRIGGER books_line_immutable BEFORE UPDATE OR DELETE ON books_journal_lines FOR EACH ROW EXECUTE FUNCTION books_immutable_journal();
CREATE OR REPLACE FUNCTION books_check_journal_balance() RETURNS trigger AS $$
DECLARE target uuid; d numeric; c numeric; n integer;
BEGIN
 IF TG_TABLE_NAME='books_journals' THEN target=NEW.id; ELSE target=NEW.journal_id; END IF;
 SELECT COALESCE(sum(debit),0),COALESCE(sum(credit),0),count(*) INTO d,c,n FROM books_journal_lines WHERE journal_id=target;
 IF n<2 OR d<>c THEN RAISE EXCEPTION 'Journal must contain balanced debit/credit lines' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS books_balanced_header ON books_journals;
CREATE CONSTRAINT TRIGGER books_balanced_header AFTER INSERT ON books_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION books_check_journal_balance();
DROP TRIGGER IF EXISTS books_balanced_line ON books_journal_lines;
CREATE CONSTRAINT TRIGGER books_balanced_line AFTER INSERT ON books_journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION books_check_journal_balance();
CREATE OR REPLACE FUNCTION books_guard_document() RETURNS trigger AS $$
BEGIN
 IF OLD.status IN ('posted','void') AND NOT (OLD.status='posted' AND NEW.status='void' AND
  (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status')) THEN
  RAISE EXCEPTION 'Posted documents are immutable; void and replace' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS books_document_immutable ON books_documents;
CREATE TRIGGER books_document_immutable BEFORE UPDATE ON books_documents FOR EACH ROW EXECUTE FUNCTION books_guard_document();
CREATE OR REPLACE FUNCTION books_guard_new_line() RETURNS trigger AS $$
DECLARE owner_xid xid;
BEGIN
 SELECT xmin INTO owner_xid FROM books_journals WHERE id=NEW.journal_id;
 IF owner_xid IS DISTINCT FROM pg_current_xact_id()::text::xid THEN
  RAISE EXCEPTION 'Append journal lines only in the transaction creating their journal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS books_new_line_owner ON books_journal_lines;
CREATE TRIGGER books_new_line_owner BEFORE INSERT ON books_journal_lines FOR EACH ROW EXECUTE FUNCTION books_guard_new_line();
COMMIT;
