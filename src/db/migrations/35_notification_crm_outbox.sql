BEGIN;
-- CRM has a separate database. Persist a scrubbed signal locally, copy it to
-- the control plane idempotently, and acknowledge only after that insert commits.
CREATE TABLE crm_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  channel text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  user_ids jsonb NOT NULL DEFAULT '[]',
  founder_ids jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  copied_at timestamptz
);
CREATE INDEX crm_notification_pending ON crm_notification_outbox(created_at,id) WHERE copied_at IS NULL;
ALTER TABLE crm_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crm_notification_outbox FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON crm_notification_outbox FROM %I',r); END IF;
 END LOOP;
END $$;
CREATE FUNCTION crm_notification_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb:=to_jsonb(NEW); old_r jsonb:='{}'; source text; users jsonb; owners jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  old_r:=to_jsonb(OLD);
  IF NOT EXISTS(SELECT 1 FROM unnest(ARRAY['status','state','pipeline_stage_code','outcome','assigned_to','owner_founder_id','owner_user_id','assigned_user_id','due_at','next_follow_up_at']) k WHERE r->k IS DISTINCT FROM old_r->k) THEN RETURN NEW; END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(DISTINCT v),'[]') INTO users FROM jsonb_array_elements_text(jsonb_build_array(r->>'user_id',r->>'assigned_user_id',r->>'owner_user_id',r->>'submitter_user_id',r->>'executive_id')) a(v)
 WHERE v ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$';
 SELECT COALESCE(jsonb_agg(DISTINCT v),'[]') INTO owners FROM jsonb_array_elements_text(jsonb_build_array(r->>'assigned_to',r->>'owner_founder_id',r->>'recipient_founder_id',r->>'created_by_founder_id')) a(v)
 WHERE v ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$';
 source:=TG_TABLE_NAME||':'||COALESCE(r->>'id',gen_random_uuid()::text)||':'||CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE gen_random_uuid()::text END;
 INSERT INTO crm_notification_outbox(source_key,channel,kind,title,priority,user_ids,founder_ids)
 VALUES(source,TG_ARGV[0],TG_TABLE_NAME||'.'||lower(TG_OP),TG_ARGV[1]||CASE WHEN TG_OP='INSERT' THEN ' created' ELSE ' updated' END,
 CASE WHEN upper(COALESCE(r->>'status',r->>'state','')) IN ('FAILED','ESCALATED','BLOCKED') THEN 'high' ELSE 'normal' END,users,owners)
 ON CONFLICT(source_key) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crm_notification_capture() FROM PUBLIC;
DO $$ DECLARE cfg text[]; BEGIN
 FOREACH cfg SLICE 1 IN ARRAY ARRAY[
  ['enquiries','sales','Enquiry'],['crm_tasks','sales','Sales task'],['crm_demos','sales','Demo'],
  ['crm_proposal_versions','sales','Proposal'],['crm_pilots','sales','Pilot'],
  ['crm_import_batches','sales','CRM import'],['crm_onboarding_operations','sales','CRM onboarding'],
  ['sales_visits','sales','Field visit'],['sales_followups','sales','Follow-up'],
  ['field_feedback_items','sales','Field feedback']
 ] LOOP
  IF to_regclass('public.'||cfg[1]) IS NOT NULL THEN
   EXECUTE format('CREATE TRIGGER notification_crm_source AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION crm_notification_capture(%L,%L)',cfg[1],cfg[2],cfg[3]);
  END IF;
 END LOOP;
END $$;
COMMIT;
