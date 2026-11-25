BEGIN;

-- Control-plane employees only. Recipient identity comes from internal_users.
CREATE TABLE notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  channel text NOT NULL CHECK(channel IN ('announcements','security','assignments','support','sales','finance','payroll','approvals','deployments','curriculum','connect','system')),
  kind text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','critical')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body text NOT NULL DEFAULT '' CHECK(length(body)<=2000),
  action_path text,
  school_id integer,
  required_permission text,
  audience jsonb NOT NULL,
  payload_hash text,
  mirror_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dead_at timestamptz
);
CREATE INDEX notification_event_queue ON notification_events(available_at,id) WHERE processed_at IS NULL AND dead_at IS NULL;
CREATE TABLE notification_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  archived_at timestamptz,
  UNIQUE(event_id,user_id)
);
CREATE INDEX notification_inbox_feed ON notification_inbox(user_id,created_at DESC,id DESC) WHERE archived_at IS NULL;
CREATE INDEX notification_inbox_unread ON notification_inbox(user_id,event_id) WHERE read_at IS NULL AND archived_at IS NULL;
CREATE TABLE notification_write_limits (
  user_id uuid PRIMARY KEY REFERENCES internal_users(id) ON DELETE CASCADE,
  window_at timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL DEFAULT 1
);
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('announcements','security','assignments','support','sales','finance','payroll','approvals','deployments','curriculum','connect','system')),
  inbox_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT false,
  push_enabled boolean NOT NULL DEFAULT false,
  sms_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,channel),
  CHECK(channel<>'security' OR inbox_enabled)
);
CREATE TABLE notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES internal_user_sessions(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK(length(token) BETWEEN 20 AND 4096),
  platform text NOT NULL CHECK(platform IN ('android','ios','web')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_devices_user ON notification_devices(user_id);
CREATE UNIQUE INDEX notification_device_session ON notification_devices(session_id);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES notification_inbox(id) ON DELETE CASCADE,
  transport text NOT NULL CHECK(transport IN ('email','push','sms')),
  device_id uuid REFERENCES notification_devices(id) ON DELETE SET NULL,
  target_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','awaiting_receipt','sent','dead','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  sent_at timestamptz,
  receipt_id text,
  receipt_started_at timestamptz,
  receipt_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE(inbox_id,transport,target_key)
);
CREATE INDEX notification_delivery_queue ON notification_deliveries(available_at,id) WHERE state IN ('pending','processing','awaiting_receipt');

-- Capture in the SAME transaction as the business write. Rollbacks remove the
-- event too. No network calls and no sensitive source snapshots.
CREATE FUNCTION notification_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  r jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END; old_r jsonb := '{}'::jsonb;
  chan text := TG_ARGV[0]; perm text := NULLIF(TG_ARGV[1],'');
  path text := NULLIF(TG_ARGV[2],''); label text := TG_ARGV[3];
  users jsonb := '[]'::jsonb; audience_value jsonb;
  school integer; event_kind text; event_title text; event_body text := '';
  priority_value text := 'normal'; source text;
BEGIN
  IF TG_OP='UPDATE' THEN
    old_r := to_jsonb(OLD);
    IF NOT EXISTS(SELECT 1 FROM unnest(ARRAY['status','state','priority','assigned_to','assigned_user_id','owner_user_id','supervising_manager_id','role','manager_id','must_change_password','token_version','owner_founder_id','due_date','due_at','approval_status','payment_status','release_status']) k
      WHERE r->k IS DISTINCT FROM old_r->k) THEN RETURN NEW; END IF;
  END IF;
  event_kind := TG_TABLE_NAME || '.' || lower(TG_OP);
  event_title := label || CASE WHEN TG_OP='INSERT' THEN ' created' ELSE ' updated' END;
  IF r->>'school_id' ~ '^[0-9]{1,9}$' THEN school := (r->>'school_id')::integer; END IF;
  SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) INTO users FROM jsonb_array_elements_text(jsonb_build_array(
    r->>'assigned_to',r->>'assigned_user_id',r->>'owner_user_id',r->>'raised_by',r->>'supervising_manager_id',r->>'escalated_to',r->>'submitted_by'
  )) v(value) WHERE value ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$';
  audience_value := jsonb_build_object('mode',CASE WHEN school IS NOT NULL THEN 'school' ELSE 'founders' END,'user_ids',users,'include_founders',true);
  IF upper(COALESCE(r->>'priority',''))='CRITICAL' THEN priority_value := 'critical';
  ELSIF upper(COALESCE(r->>'priority',''))='URGENT' OR upper(COALESCE(r->>'status',r->>'state','')) IN ('FAILED','ESCALATED','BLOCKED') THEN priority_value := 'high'; END IF;
  IF TG_TABLE_NAME='complaints' THEN
    audience_value := jsonb_build_object('mode','direct','user_ids',users,'include_founders',true);
  ELSIF TG_TABLE_NAME='internal_users' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    audience_value := jsonb_build_object('mode','direct','user_ids',jsonb_build_array(r->>'id'),'include_founders',true);
    event_title := 'Account access updated'; school := NULL;
  ELSIF TG_TABLE_NAME='internal_user_schools' THEN
    audience_value := jsonb_build_object('mode','direct','user_ids',jsonb_build_array(r->>'user_id'),'include_founders',false);
    event_title := CASE WHEN TG_OP='DELETE' THEN 'School assignment removed' ELSE 'School assignment updated' END; school := NULL;
  ELSIF TG_TABLE_NAME='audit_logs' THEN
    event_kind := COALESCE(r->>'action','');
    IF event_kind IN ('PASSWORD_RESET','PERMISSION_CHANGED') THEN
      chan := 'security'; perm := NULL; path := NULL; event_title := 'Account security updated';
      users := CASE WHEN r->>'entity_id' ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' THEN jsonb_build_array(r->>'entity_id') ELSE jsonb_build_array(r->>'user_id') END;
      audience_value := jsonb_build_object('mode','direct','user_ids',users,'include_founders',true); school := NULL;
    ELSIF event_kind IN ('CONFIG_DRAFT_SAVED','CONFIG_ASSET_UPLOADED','PACKAGE_REQUESTED','SCHOOL_CONTACTS_UPDATED') THEN
      chan := 'deployments'; perm := 'configs.read'; event_title := 'School configuration updated';
    ELSE RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='collaboration_notifications' THEN
    IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
    audience_value := jsonb_build_object('mode','direct','user_ids',jsonb_build_array(r->>'user_id'),'include_founders',false);
    event_title := CASE r->>'kind' WHEN 'mention' THEN 'You were mentioned' WHEN 'dm' THEN 'New direct message' WHEN 'thread' THEN 'New thread reply' WHEN 'announcement' THEN 'New Connect announcement' ELSE 'New Connect message' END;
    path := '/connect'; school := NULL; perm := NULL;
  ELSIF TG_TABLE_NAME='notifications' THEN
    IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
    SELECT COALESCE(jsonb_agg(u.id),'[]'::jsonb) INTO users FROM internal_users u
      WHERE u.id::text=r->>'user_id' OR u.auth_user_id::text=r->>'user_id'
      OR EXISTS(SELECT 1 FROM founders f WHERE f.id::text=r->>'founder_id' AND (f.user_id=u.id OR f.user_id=u.auth_user_id));
    IF jsonb_array_length(users)=0 THEN RETURN NEW; END IF;
    audience_value := jsonb_build_object('mode','direct','user_ids',users,'include_founders',false);
    event_title := left(COALESCE(NULLIF(r->>'title',''),'Notification'),160);
    event_body := left(COALESCE(r->>'body',''),2000); perm := NULL; school := NULL;
  ELSIF TG_TABLE_NAME='books_activity' THEN
    audience_value := jsonb_build_object('mode','direct','user_ids',jsonb_build_array(r->>'actor'),'include_founders',true);
    event_title := 'Accounting activity updated';
  END IF;
  IF TG_TABLE_NAME='school_intake_requests' THEN
    audience_value := jsonb_build_object('mode','direct','user_ids',users,'include_founders',true); school := NULL;
  ELSIF TG_TABLE_NAME='books_access_events' THEN
    audience_value := jsonb_build_object('mode','direct','user_ids',jsonb_build_array(r->>'target_user_id'),'include_founders',true);
    event_title := 'Accounting access updated'; school := NULL;
  END IF;
  IF TG_TABLE_NAME IN ('school_requirements','school_onboarding_checklists') AND NULLIF(r->>'title','') IS NOT NULL THEN
    event_title := left(event_title||': '||(r->>'title'),160);
  END IF;
  source := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ':' || COALESCE(r->>'id',gen_random_uuid()::text) || ':' || CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE gen_random_uuid()::text END;
  INSERT INTO notification_events(source_key,channel,kind,priority,title,body,action_path,school_id,required_permission,audience)
    VALUES(source,chan,event_kind,priority_value,event_title,event_body,path,school,perm,audience_value) ON CONFLICT(source_key) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION notification_capture() FROM PUBLIC;

-- Modules must be installed before this migration. Optional modules are skipped.
DO $$ DECLARE cfg text[]; BEGIN
  FOREACH cfg SLICE 1 IN ARRAY ARRAY[
    ['school_requirements','approvals','requirements.read','/requirements','Requirement'],
    ['complaints','support','complaints.read','/complaints','Support ticket'],
    ['school_onboarding_checklists','assignments','checklist.read','/checklist','Onboarding task'],
    ['internal_users','security','','','Account'],
    ['internal_user_schools','assignments','','','School assignment'],
    ['audit_logs','system','','','Workspace'],
    ['collaboration_notifications','connect','','/connect','Connect notification'],
    ['notifications','system','','','Notification'],
    ['crm_tasks','sales','','','Sales task'],
    ['school_intake_requests','sales','','','School intake'],
    ['expenses','approvals','','/console/expenses','Expense'],
    ['collections','approvals','','/console/collections','Collection'],
    ['sprint_tasks','assignments','','/console/sprint','Sprint task'],
    ['learning_content_requests','curriculum','curriculum.read','','Content request'],
    ['curriculum_versions','curriculum','curriculum.read','','Curriculum version'],
    ['billing_documents','finance','','/console/billing','Billing document'],
    ['payroll_runs','payroll','','/console/payroll','Payroll run'],
    ['books_access_events','security','','/books','Accounting access'],
    ['books_activity','finance','','/books','Accounting activity'],
    ['school_package_jobs','deployments','builds.read','','School package'],
    ['curriculum_releases','curriculum','curriculum.read','','Curriculum release']
  ] LOOP
    IF to_regclass('public.'||cfg[1]) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS notification_source_event ON %I',cfg[1]);
      EXECUTE format('CREATE TRIGGER notification_source_event AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.notification_capture(%L,%L,%L,%L)',cfg[1],cfg[2],cfg[3],cfg[4],cfg[5]);
    END IF;
  END LOOP;
  DROP TRIGGER IF EXISTS notification_school_assignment_removed ON internal_user_schools;
  CREATE TRIGGER notification_school_assignment_removed AFTER DELETE ON internal_user_schools FOR EACH ROW EXECUTE FUNCTION notification_capture('assignments','','','School assignment');
END $$;

-- Keep the existing Connect/legacy surfaces and the shared inbox consistent.
-- The distinct-value guard makes bidirectional updates terminate immediately.
CREATE FUNCTION notification_mirror_source_read() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE event_id_value uuid; BEGIN
 IF NEW.read_at IS NOT DISTINCT FROM OLD.read_at THEN RETURN NEW; END IF;
 UPDATE notification_events SET mirror_read_at=NEW.read_at
 WHERE source_key=TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME||':'||NEW.id::text||':insert'
 AND jsonb_array_length(audience->'user_ids')=1
 RETURNING id INTO event_id_value;
 IF event_id_value IS NOT NULL THEN
  UPDATE notification_inbox SET read_at=NEW.read_at WHERE event_id=event_id_value;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION notification_mirror_inbox_read() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE source text; source_id uuid; BEGIN
 IF NEW.read_at IS NOT DISTINCT FROM OLD.read_at THEN RETURN NEW; END IF;
 SELECT source_key INTO source FROM notification_events WHERE id=NEW.event_id AND jsonb_array_length(audience->'user_ids')=1;
 IF source LIKE 'public.collaboration_notifications:%:insert' OR source LIKE 'public.notifications:%:insert' THEN
  source_id:=split_part(source,':',2)::uuid;
  IF source LIKE 'public.collaboration_notifications:%' THEN
   UPDATE collaboration_notifications SET read_at=NEW.read_at WHERE id=source_id AND user_id=NEW.user_id;
  ELSE
   UPDATE notifications SET read_at=NEW.read_at WHERE id=source_id;
  END IF;
  UPDATE notification_events SET mirror_read_at=NEW.read_at WHERE id=NEW.event_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION notification_mirror_source_read(),notification_mirror_inbox_read() FROM PUBLIC;
CREATE TRIGGER notification_inbox_read_mirror AFTER UPDATE OF read_at ON notification_inbox FOR EACH ROW EXECUTE FUNCTION notification_mirror_inbox_read();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['collaboration_notifications','notifications'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN
   EXECUTE format('CREATE TRIGGER notification_read_mirror AFTER UPDATE OF read_at ON %I FOR EACH ROW EXECUTE FUNCTION public.notification_mirror_source_read()',t);
  END IF;
 END LOOP;
END $$;

-- Existing non-public Books companies get the same generic activity signal.
DO $$ DECLARE ns text; BEGIN
 FOR ns IN SELECT schemaname FROM pg_tables WHERE schemaname LIKE 'books_%' AND tablename='books_activity' LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS notification_source_event ON %I.books_activity',ns);
  EXECUTE format('CREATE TRIGGER notification_source_event AFTER INSERT ON %I.books_activity FOR EACH ROW EXECUTE FUNCTION public.notification_capture(%L,%L,%L,%L)',ns,'finance','','/books','Accounting activity');
 END LOOP;
END $$;

-- Preserve existing targeted notices and their read state. Unaddressed global
-- legacy rows are deliberately not reassigned to arbitrary employees.
DO $$ BEGIN
 IF to_regclass('public.notifications') IS NOT NULL AND to_regclass('public.founders') IS NOT NULL THEN
  INSERT INTO notification_events(source_key,channel,kind,title,body,audience,created_at,processed_at)
  SELECT 'public.notifications:'||n.id::text||':insert','system','legacy',
    left(COALESCE(NULLIF(n.title,''),'Notification'),160),left(COALESCE(n.body,''),2000),
    jsonb_build_object('mode','direct','user_ids',jsonb_agg(DISTINCT u.id)),COALESCE(n.created_at,now()),now()
  FROM notifications n JOIN internal_users u ON u.id=n.user_id OR u.auth_user_id=n.user_id
   OR EXISTS(SELECT 1 FROM founders f WHERE f.id=n.founder_id AND (f.user_id=u.id OR f.user_id=u.auth_user_id))
  GROUP BY n.id,n.title,n.body,n.created_at ON CONFLICT(source_key) DO NOTHING;
  INSERT INTO notification_inbox(event_id,user_id,created_at,read_at)
  SELECT e.id,u.id,e.created_at,n.read_at FROM notification_events e
  JOIN notifications n ON e.source_key='public.notifications:'||n.id::text||':insert'
  JOIN internal_users u ON (e.audience->'user_ids') ? u.id::text ON CONFLICT(event_id,user_id) DO NOTHING;
 END IF;
END $$;

ALTER TABLE notification_write_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_events,notification_inbox,notification_preferences,notification_devices,notification_deliveries,notification_write_limits FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON notification_events,notification_inbox,notification_preferences,notification_devices,notification_deliveries,notification_write_limits FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
