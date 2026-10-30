-- Run in each company schema, including public. Existing journals remain immutable.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='books_accounts' AND column_name='cash_flow_activity') THEN
  ALTER TABLE books_accounts ADD COLUMN cash_flow_activity text
   CHECK(cash_flow_activity IN ('operating','investing','financing'));
  UPDATE books_accounts SET cash_flow_activity=CASE
   WHEN type='equity' THEN 'financing'
   WHEN code IN ('1000','1010','1100','1200','1300','2000','2200','2050','2100','2110','2120','2130') OR type IN ('income','expense') THEN 'operating'
   ELSE NULL END;
 END IF;
END $$;
ALTER TABLE books_journals ADD COLUMN IF NOT EXISTS cash_flow_activity text
 CHECK(cash_flow_activity IN ('operating','investing','financing'));
CREATE INDEX IF NOT EXISTS books_journals_reporting_date ON books_journals(date,id);
COMMIT;
