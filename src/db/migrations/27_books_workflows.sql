-- Workflow fields verified against the signed-in Zoho Books forms.
-- Additive upgrade for installations that already applied 26_books.sql.
BEGIN;
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT '';
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS salesperson text NOT NULL DEFAULT '';
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS terms text NOT NULL DEFAULT '';
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS discount_type text NOT NULL DEFAULT 'amount' CHECK(discount_type IN ('amount','percent'));
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS discount_value bigint NOT NULL DEFAULT 0 CHECK(discount_value>=0);
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS discount_total bigint NOT NULL DEFAULT 0 CHECK(discount_total>=0);
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS adjustment bigint NOT NULL DEFAULT 0;
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS adjustment_description text NOT NULL DEFAULT 'Adjustment';
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS challan_type text NOT NULL DEFAULT '';
ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_kind_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_kind_check CHECK(kind IN ('quote','sales_order','invoice','credit_note','purchase_order','bill','expense','vendor_credit','delivery_challan'));
INSERT INTO books_accounts(code,name,type,is_cash) VALUES
 ('4900','Sales adjustments','income',false),('5900','Purchase adjustments','expense',false)
ON CONFLICT DO NOTHING;
COMMIT;
