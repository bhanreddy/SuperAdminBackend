-- Central platform finance belongs to Nexsyrus (public), never another company's books.
-- Install connections without silently importing historical records.
BEGIN;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS expense_date date;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS paid_account text NOT NULL DEFAULT '1010';
ALTER TABLE public.billing_documents ADD COLUMN IF NOT EXISTS settles_invoice_id uuid REFERENCES public.billing_documents(id);
CREATE TABLE IF NOT EXISTS public.books_finance_links (
 source_type text NOT NULL CHECK(source_type IN ('expense','collection','billing','payroll')),
 source_id uuid NOT NULL, component text NOT NULL CHECK(component IN ('accrual','payment')),
 journal_id uuid NOT NULL REFERENCES public.books_journals(id),
 state text NOT NULL CHECK(state IN ('posted','reversed')), snapshot jsonb NOT NULL,
 amount bigint NOT NULL, reference text NOT NULL, date date NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_type,source_id,component)
);
ALTER TABLE public.books_finance_links ENABLE ROW LEVEL SECURITY;
INSERT INTO public.books_accounts(code,name,type,is_cash) VALUES
 ('2050','Employee reimbursements payable','liability',false),
 ('2100','Salaries payable','liability',false),('2110','PF deductions payable','liability',false),
 ('2120','ESI deductions payable','liability',false),('2130','Other payroll deductions payable','liability',false),
 ('5300','Salaries and wages','expense',false)
ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.books_finance_entry(
 kind text, record_id uuid, part text, entry_date date, ref text, memo text,
 entries jsonb, facts jsonb, active boolean
) RETURNS void LANGUAGE plpgsql SET search_path TO public, pg_catalog AS $$
DECLARE previous books_finance_links%ROWTYPE; journal uuid; reverse_id uuid;
 total bigint; item jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(kind || record_id::text || part,0));
 SELECT * INTO previous FROM books_finance_links WHERE source_type=kind AND source_id=record_id AND component=part FOR UPDATE;
 IF previous.source_id IS NOT NULL AND previous.snapshot=facts AND previous.state=(CASE WHEN active THEN 'posted' ELSE 'reversed' END) THEN RETURN; END IF;
 IF previous.source_id IS NOT NULL AND previous.state='posted' THEN
  reverse_id=gen_random_uuid();
  INSERT INTO books_journals(id,date,reference,notes,source,source_id,reversal_of,created_by)
   VALUES(reverse_id,(now() AT TIME ZONE 'Asia/Kolkata')::date,'Reverse ' || previous.reference,'Source corrected or cancelled','platform_reversal',reverse_id,previous.journal_id,'finance-connection');
  INSERT INTO books_journal_lines(journal_id,account_code,debit,credit)
   SELECT reverse_id,account_code,credit,debit FROM books_journal_lines WHERE journal_id=previous.journal_id;
 END IF;
 IF NOT active THEN
  UPDATE books_finance_links SET state='reversed',snapshot=facts,updated_at=now() WHERE source_type=kind AND source_id=record_id AND component=part;
  RETURN;
 END IF;
 SELECT COALESCE(sum((v->>'debit')::bigint),0) INTO total FROM jsonb_array_elements(entries) v;
 IF total<=0 THEN RAISE EXCEPTION 'Finance amount must be positive' USING ERRCODE='23514'; END IF;
 journal=gen_random_uuid();
 INSERT INTO books_journals(id,date,reference,notes,source,source_id,created_by)
 VALUES(journal,entry_date,ref,memo,'platform_' || kind || '_' || part,journal,'finance-connection');
 FOR item IN SELECT * FROM jsonb_array_elements(entries) LOOP
  IF COALESCE((item->>'debit')::bigint,0)+COALESCE((item->>'credit')::bigint,0)>0 THEN
   INSERT INTO books_journal_lines(journal_id,account_code,debit,credit)
   VALUES(journal,item->>'account',COALESCE((item->>'debit')::bigint,0),COALESCE((item->>'credit')::bigint,0));
  END IF;
 END LOOP;
 INSERT INTO books_finance_links(source_type,source_id,component,journal_id,state,snapshot,amount,reference,date)
 VALUES(kind,record_id,part,journal,'posted',facts,total,ref,entry_date)
 ON CONFLICT(source_type,source_id,component) DO UPDATE SET journal_id=EXCLUDED.journal_id,state='posted',snapshot=EXCLUDED.snapshot,amount=EXCLUDED.amount,reference=EXCLUDED.reference,date=EXCLUDED.date,updated_at=now();
 INSERT INTO books_activity(entity,entity_id,action,actor,details)
 VALUES('finance_connection',record_id,'posted','finance-connection',jsonb_build_object('source',kind,'component',part,'journal_id',journal,'reference',ref));
END $$;
CREATE OR REPLACE FUNCTION public.books_sync_finance(kind text, row_data jsonb)
RETURNS void LANGUAGE plpgsql SET search_path TO public, pg_catalog AS $$
DECLARE record_id uuid; amount bigint; gross bigint; pf bigint; esi bigint; deductions bigint;
 taxable bigint; tax bigint; entry_date date; ref text; active boolean; facts jsonb; account text;
 entries jsonb; invoice billing_documents%ROWTYPE; settled numeric;
BEGIN
 record_id=(row_data->>'id')::uuid;
 IF kind='expense' THEN
  IF row_data->>'school_id' IS NOT NULL THEN RETURN; END IF;
  amount=round((row_data->>'amount')::numeric*100)::bigint;
  active=row_data->>'status'='APPROVED';
  entry_date=COALESCE((row_data->>'expense_date')::date,((row_data->>'created_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date);
  ref='Expense · ' || (row_data->>'title');
  account=CASE WHEN row_data->>'category'='SALARY' THEN '5300' ELSE '5000' END;
  facts=jsonb_build_object('amount',amount,'date',entry_date,'account',account,'active',active,'title',row_data->>'title');
  PERFORM books_finance_entry(kind,record_id,'accrual',entry_date,ref,COALESCE(row_data->>'description',''),jsonb_build_array(jsonb_build_object('account',account,'debit',amount),jsonb_build_object('account','2050','credit',amount)),facts,active);
  account=row_data->>'paid_account';
  IF row_data->>'paid_at' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM books_accounts WHERE code=account AND is_cash) THEN RAISE EXCEPTION 'Select a cash or bank account'; END IF;
  facts=jsonb_build_object('amount',amount,'account',account,'paid_at',row_data->>'paid_at','active',active);
  PERFORM books_finance_entry(kind,record_id,'payment',COALESCE(((row_data->>'paid_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,entry_date),'Payment · ' || ref,'Expense reimbursement',jsonb_build_array(jsonb_build_object('account','2050','debit',amount),jsonb_build_object('account',account,'credit',amount)),facts,active AND row_data->>'paid_at' IS NOT NULL);
 ELSIF kind='collection' THEN
  amount=round((row_data->>'amount')::numeric*100)::bigint;
  active=row_data->>'status'='APPROVED';
  entry_date=((row_data->>'created_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date;
  account=CASE WHEN row_data->>'payment_mode'='CASH' THEN '1000' ELSE '1010' END;
  ref='Collection · ' || (row_data->>'month') || '/' || (row_data->>'year');
  facts=jsonb_build_object('amount',amount,'account',account,'active',active,'date',entry_date);
  PERFORM books_finance_entry(kind,record_id,'payment',entry_date,ref,COALESCE(row_data->>'notes',''),jsonb_build_array(jsonb_build_object('account',account,'debit',amount),jsonb_build_object('account','4000','credit',amount)),facts,active);
 ELSIF kind='billing' THEN
  amount=round((row_data->>'total_amount')::numeric*100)::bigint;
  taxable=round((row_data->>'taxable_value')::numeric*100)::bigint;
  tax=amount-taxable;
  active=row_data->>'status'='issued';
  entry_date=((row_data->>'issued_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date;
  ref=row_data->>'document_number';
  IF row_data->>'document_type'='tax_invoice' THEN
   IF NOT active AND EXISTS(SELECT 1 FROM billing_documents WHERE settles_invoice_id=record_id AND status='issued') THEN RAISE EXCEPTION 'Cancel linked receipts before cancelling this invoice' USING ERRCODE='23514'; END IF;
   entries=jsonb_build_array(jsonb_build_object('account','1100','debit',amount),jsonb_build_object('account','4000','credit',taxable),jsonb_build_object('account','2200','credit',tax));
  ELSE
   account='4000';
   IF row_data->>'settles_invoice_id' IS NOT NULL THEN
    SELECT * INTO invoice FROM billing_documents WHERE id=(row_data->>'settles_invoice_id')::uuid FOR UPDATE;
    IF active THEN
     IF invoice.id IS NULL OR invoice.document_type<>'tax_invoice' OR invoice.status<>'issued' OR invoice.client_legal_name<>row_data->>'client_legal_name'
        OR (to_jsonb(invoice)->>'client_id') IS DISTINCT FROM (row_data->>'client_id')
        OR (to_jsonb(invoice)->>'client_kind') IS DISTINCT FROM (row_data->>'client_kind')
        OR (to_jsonb(invoice)->>'client_cluster_id') IS DISTINCT FROM (row_data->>'client_cluster_id') THEN RAISE EXCEPTION 'Select an issued invoice for the same customer' USING ERRCODE='23514'; END IF;
     SELECT COALESCE(sum(total_amount),0) INTO settled FROM billing_documents WHERE settles_invoice_id=invoice.id AND status='issued' AND id<>record_id;
     IF settled+(row_data->>'total_amount')::numeric>invoice.total_amount THEN RAISE EXCEPTION 'Receipt exceeds invoice balance' USING ERRCODE='23514'; END IF;
    END IF;
    IF active THEN PERFORM books_sync_finance('billing',to_jsonb(invoice)); END IF;
    account='1100';
   END IF;
   entries=jsonb_build_array(jsonb_build_object('account','1010','debit',amount),jsonb_build_object('account',account,'credit',amount));
  END IF;
  facts=jsonb_build_object('amount',amount,'taxable',taxable,'entries',entries,'date',entry_date,'active',active);
  PERFORM books_finance_entry(kind,record_id,CASE WHEN row_data->>'document_type'='tax_invoice' THEN 'accrual' ELSE 'payment' END,entry_date,ref,'Client billing · ' || (row_data->>'client_legal_name'),entries,facts,active);
 ELSIF kind='payroll' THEN
  gross=round((row_data->>'gross_pay')::numeric*100)::bigint;
  amount=round((row_data->>'net_pay')::numeric*100)::bigint;
  pf=round((row_data->>'pf_deduction')::numeric*100)::bigint;
  esi=round((row_data->>'esi_deduction')::numeric*100)::bigint;
  deductions=gross-amount-pf-esi;
  active=row_data->>'status' IN ('PROCESSED','PAID') AND gross>0;
  entry_date=(make_date((row_data->>'payroll_year')::int,(row_data->>'payroll_month')::int,1)+interval '1 month - 1 day')::date;
  ref='Payroll · ' || (row_data->>'payroll_month') || '/' || (row_data->>'payroll_year') || ' · ' || (row_data->>'employee_id');
  entries=jsonb_build_array(jsonb_build_object('account','5300','debit',gross),jsonb_build_object('account','2100','credit',amount),jsonb_build_object('account','2110','credit',pf),jsonb_build_object('account','2120','credit',esi),jsonb_build_object('account','2130','credit',deductions));
  facts=jsonb_build_object('entries',entries,'date',entry_date,'active',active);
  PERFORM books_finance_entry(kind,record_id,'accrual',entry_date,ref,'Gross wages and employee deductions',entries,facts,active);
  facts=jsonb_build_object('amount',amount,'paid_at',row_data->>'paid_at','active',row_data->>'status'='PAID');
  PERFORM books_finance_entry(kind,record_id,'payment',COALESCE(((row_data->>'paid_at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,entry_date),'Payment · ' || ref,'Net salary paid through bank',jsonb_build_array(jsonb_build_object('account','2100','debit',amount),jsonb_build_object('account','1010','credit',amount)),facts,row_data->>'status'='PAID' AND amount>0);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.books_finance_source_trigger() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public, pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM books_finance_links WHERE source_type=TG_ARGV[0] AND source_id=OLD.id) THEN RAISE EXCEPTION 'Connected financial records must be reversed, not deleted' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_ARGV[0]='billing' AND TG_OP='UPDATE' AND OLD.status IN ('issued','cancelled')
    AND (to_jsonb(OLD)->'settles_invoice_id') IS DISTINCT FROM (to_jsonb(NEW)->'settles_invoice_id') THEN
  RAISE EXCEPTION 'The invoice linked to an issued receipt is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_ARGV[0]='expense' AND TG_OP='UPDATE' AND (to_jsonb(OLD)->>'school_id') IS DISTINCT FROM (to_jsonb(NEW)->>'school_id')
    AND EXISTS(SELECT 1 FROM books_finance_links WHERE source_type='expense' AND source_id=OLD.id) THEN
  RAISE EXCEPTION 'A connected platform expense cannot move to a school' USING ERRCODE='23514';
 END IF;
 PERFORM books_sync_finance(TG_ARGV[0],to_jsonb(NEW));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_connect_expenses ON public.expenses;
CREATE TRIGGER books_connect_expenses AFTER INSERT OR UPDATE OR DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.books_finance_source_trigger('expense');
DROP TRIGGER IF EXISTS books_connect_collections ON public.collections;
CREATE TRIGGER books_connect_collections AFTER INSERT OR UPDATE OR DELETE ON public.collections FOR EACH ROW EXECUTE FUNCTION public.books_finance_source_trigger('collection');
DROP TRIGGER IF EXISTS books_connect_billing ON public.billing_documents;
CREATE TRIGGER books_connect_billing AFTER INSERT OR UPDATE OR DELETE ON public.billing_documents FOR EACH ROW EXECUTE FUNCTION public.books_finance_source_trigger('billing');
DROP TRIGGER IF EXISTS books_connect_payroll ON public.payroll_runs;
CREATE TRIGGER books_connect_payroll AFTER INSERT OR UPDATE OR DELETE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION public.books_finance_source_trigger('payroll');
COMMIT;
