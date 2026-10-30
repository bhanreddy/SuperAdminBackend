BEGIN;
CREATE TABLE collaboration_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES collaboration_messages(id),
  uploaded_by uuid NOT NULL REFERENCES internal_users(id),
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 120),
  mime text NOT NULL, byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608),
  storage_path text NOT NULL UNIQUE, sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(message_id,sha256)
);
CREATE INDEX collaboration_attachment_message ON collaboration_attachments(message_id);
CREATE TABLE collaboration_saved_messages (
  user_id uuid NOT NULL REFERENCES internal_users(id), message_id uuid NOT NULL REFERENCES collaboration_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,message_id)
);
CREATE TABLE collaboration_pinned_messages (
  message_id uuid PRIMARY KEY REFERENCES collaboration_messages(id),
  pinned_by uuid NOT NULL REFERENCES internal_users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collaboration_presence (
  organization_id uuid NOT NULL REFERENCES collaboration_organizations(id),user_id uuid NOT NULL REFERENCES internal_users(id),
  status text NOT NULL CHECK(status IN ('online','away','busy')), note text NOT NULL DEFAULT '' CHECK(length(note)<=120),
  expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,user_id)
);
-- Source references stay in the internal boundary, not tenant-visible checklist fields.
CREATE TABLE collaboration_task_links (
  message_id uuid NOT NULL REFERENCES collaboration_messages(id),
  task_id uuid NOT NULL REFERENCES school_onboarding_checklists(id),
  created_by uuid NOT NULL REFERENCES internal_users(id),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,task_id),UNIQUE(message_id)
);
ALTER TABLE collaboration_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_saved_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_pinned_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_task_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachment_read ON collaboration_attachments FOR SELECT TO collaboration_api USING(EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=message_id AND m.deleted_at IS NULL));
CREATE POLICY attachment_insert ON collaboration_attachments FOR INSERT TO collaboration_api WITH CHECK(uploaded_by=collaboration_actor() AND EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=message_id AND m.sender_id=collaboration_actor() AND m.deleted_at IS NULL AND collaboration_can_post(m.conversation_id)));
CREATE POLICY saved_own ON collaboration_saved_messages FOR ALL TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_message_access(message_id)) WITH CHECK(user_id=collaboration_actor() AND collaboration_message_access(message_id));
CREATE POLICY pin_read ON collaboration_pinned_messages FOR SELECT TO collaboration_api USING(collaboration_message_access(message_id));
CREATE POLICY pin_insert ON collaboration_pinned_messages FOR INSERT TO collaboration_api WITH CHECK(pinned_by=collaboration_actor() AND EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=message_id AND m.deleted_at IS NULL AND collaboration_manages(m.conversation_id)));
CREATE POLICY pin_delete ON collaboration_pinned_messages FOR DELETE TO collaboration_api USING(EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=message_id AND collaboration_manages(m.conversation_id)));
CREATE POLICY presence_read ON collaboration_presence FOR SELECT TO collaboration_api USING(collaboration_in_org(organization_id) AND collaboration_in_org(organization_id,user_id));
CREATE POLICY presence_insert ON collaboration_presence FOR INSERT TO collaboration_api WITH CHECK(user_id=collaboration_actor() AND collaboration_in_org(organization_id));
CREATE POLICY presence_update ON collaboration_presence FOR UPDATE TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_in_org(organization_id)) WITH CHECK(user_id=collaboration_actor() AND collaboration_in_org(organization_id));
CREATE POLICY task_link_read ON collaboration_task_links FOR SELECT TO collaboration_api USING(collaboration_message_access(message_id));
GRANT SELECT,INSERT ON collaboration_attachments TO collaboration_api;
GRANT SELECT,INSERT,DELETE ON collaboration_saved_messages,collaboration_pinned_messages TO collaboration_api;
GRANT SELECT,INSERT,UPDATE ON collaboration_presence TO collaboration_api;
GRANT SELECT ON collaboration_task_links TO collaboration_api;

CREATE FUNCTION collaboration_attachment_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
  UPDATE collaboration_messages SET revision=revision+1 WHERE id=NEW.message_id AND deleted_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER collaboration_attachment_event AFTER INSERT ON collaboration_attachments FOR EACH ROW EXECUTE FUNCTION collaboration_attachment_changed();
CREATE TRIGGER collaboration_pin_event AFTER INSERT OR DELETE ON collaboration_pinned_messages FOR EACH ROW EXECUTE FUNCTION collaboration_changed();
-- Pin events need the same message lookup as reactions.
CREATE OR REPLACE FUNCTION collaboration_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE c uuid; u uuid; msg uuid; BEGIN
  IF TG_TABLE_NAME='collaboration_messages' THEN
    c:=COALESCE(NEW.conversation_id,OLD.conversation_id);msg:=COALESCE(NEW.id,OLD.id);
    IF NEW.parent_id IS NOT NULL THEN UPDATE collaboration_messages SET revision=revision+1 WHERE id=NEW.parent_id AND deleted_at IS NULL;END IF;
  ELSIF TG_TABLE_NAME IN ('collaboration_message_reactions','collaboration_pinned_messages') THEN
    msg:=COALESCE(NEW.message_id,OLD.message_id);SELECT conversation_id INTO c FROM collaboration_messages WHERE id=msg;
    IF TG_TABLE_NAME='collaboration_message_reactions' THEN
      UPDATE collaboration_messages SET revision=revision+1 WHERE id=msg AND deleted_at IS NULL;RETURN COALESCE(NEW,OLD);
    END IF;
  ELSIF TG_TABLE_NAME='collaboration_channel_members' THEN c:=COALESCE(NEW.channel_id,OLD.channel_id);u:=COALESCE(NEW.user_id,OLD.user_id);
  ELSIF TG_TABLE_NAME='collaboration_channels' THEN c:=COALESCE(NEW.id,OLD.id);
  ELSE c:=COALESCE(NEW.conversation_id,OLD.conversation_id);u:=COALESCE(NEW.user_id,OLD.user_id);END IF;
  INSERT INTO collaboration_events(conversation_id,user_id,message_id) VALUES(c,u,msg);RETURN COALESCE(NEW,OLD);
END $$;
CREATE FUNCTION collaboration_employee_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
  INSERT INTO collaboration_events(user_id) VALUES(COALESCE(NEW.user_id,OLD.user_id));RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER collaboration_employee_event AFTER INSERT OR DELETE ON collaboration_organization_members FOR EACH ROW EXECUTE FUNCTION collaboration_employee_changed();
CREATE FUNCTION collaboration_presence_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$ BEGIN
  INSERT INTO collaboration_events(user_id) SELECT user_id FROM collaboration_organization_members WHERE organization_id=NEW.organization_id;
  RETURN NEW;
END $$;
CREATE TRIGGER collaboration_presence_event AFTER INSERT OR UPDATE ON collaboration_presence FOR EACH ROW EXECUTE FUNCTION collaboration_presence_changed();
REVOKE ALL ON FUNCTION collaboration_employee_changed(),collaboration_presence_changed() FROM PUBLIC;

CREATE FUNCTION collaboration_convert_task(msg uuid,school integer,title_value text,description_value text,assignee uuid,
  priority_value text,deadline timestamptz,status_value text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=collaboration_actor();m collaboration_messages;employee internal_users;task uuid;root boolean;permitted boolean;BEGIN
  SELECT * INTO m FROM collaboration_messages WHERE id=msg AND deleted_at IS NULL AND collaboration_can_read(conversation_id);
  IF m.id IS NULL THEN RAISE EXCEPTION 'Message not found' USING ERRCODE='42501';END IF;
  SELECT * INTO employee FROM internal_users WHERE id=actor AND status='ACTIVE';
  root:=employee.role IN ('FOUNDER','SUPER_ADMIN');
  permitted:=root OR ((employee.role IN ('SALES_MANAGER','IMPLEMENTATION_MANAGER') OR EXISTS(SELECT 1 FROM internal_user_permission_overrides WHERE user_id=actor AND permission='checklist.delegate' AND effect='GRANT'))
    AND NOT EXISTS(SELECT 1 FROM internal_user_permission_overrides WHERE user_id=actor AND permission='checklist.delegate' AND effect='DENY'));
  IF NOT COALESCE(permitted,false) OR NOT EXISTS(SELECT 1 FROM schools WHERE id=school)
    OR NOT EXISTS(SELECT 1 FROM internal_users WHERE id=assignee AND status='ACTIVE' AND role NOT IN ('CA','CA_LEAD'))
    OR NOT collaboration_can_read(m.conversation_id,assignee) THEN RAISE EXCEPTION 'Task delegation denied' USING ERRCODE='42501';END IF;
  IF NOT root THEN
    IF NOT EXISTS(WITH RECURSIVE reports AS (
      SELECT id FROM internal_users WHERE id=actor UNION SELECT u.id FROM internal_users u JOIN reports r ON u.manager_id=r.id WHERE u.status='ACTIVE'
    ) SELECT 1 FROM internal_user_schools s WHERE s.school_id=school AND s.user_id IN(SELECT id FROM reports))
      OR NOT EXISTS(SELECT 1 FROM internal_users WHERE id=assignee AND (id=actor OR manager_id=actor)) THEN
      RAISE EXCEPTION 'Task school or assignee is outside employee scope' USING ERRCODE='42501';END IF;
  END IF;
  IF length(trim(title_value)) NOT BETWEEN 1 AND 180 OR length(description_value)>4000
    OR priority_value NOT IN ('LOW','MEDIUM','HIGH','CRITICAL') OR status_value NOT IN ('NOT_STARTED','IN_PROGRESS','BLOCKED')
    OR (status_value='BLOCKED' AND length(trim(description_value))=0) THEN RAISE EXCEPTION 'Invalid task' USING ERRCODE='23514';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(msg::text,0));
  SELECT task_id INTO task FROM collaboration_task_links WHERE message_id=msg;
  IF task IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM school_onboarding_checklists WHERE id=task AND school_id=school) THEN
      RAISE EXCEPTION 'Message already converted for a different school' USING ERRCODE='23514';END IF;
    RETURN task;
  END IF;
  INSERT INTO school_onboarding_checklists(school_id,task_key,title,category,status,assigned_to,supervising_manager_id,priority,due_date,instructions,blocker_reason)
    VALUES(school,'connect_'||replace(msg::text,'-',''),title_value,'APP_BUILD',status_value,assignee,CASE WHEN root THEN NULL ELSE actor END,
      priority_value,deadline,description_value,CASE WHEN status_value='BLOCKED' THEN description_value ELSE NULL END) RETURNING id INTO task;
  INSERT INTO collaboration_task_links(message_id,task_id,created_by) VALUES(msg,task,actor);
  INSERT INTO audit_logs(user_id,action,entity,entity_id,details,created_at) VALUES(actor,'CONNECT_TASK_CREATED','CONNECT',msg::text,jsonb_build_object('school_id',school,'task_id',task),now());
  RETURN task;
END $$;
REVOKE ALL ON FUNCTION collaboration_convert_task(uuid,integer,text,text,uuid,text,timestamptz,text),collaboration_attachment_changed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collaboration_convert_task(uuid,integer,text,text,uuid,text,timestamptz,text) TO collaboration_api;

DO $$ DECLARE t text;r text;BEGIN
  FOREACH t IN ARRAY ARRAY['collaboration_attachments','collaboration_saved_messages','collaboration_pinned_messages','collaboration_presence','collaboration_task_links'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,r);END IF;
    END LOOP;
  END LOOP;
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets(id,name,public,file_size_limit) VALUES('nexsyrus-connect','nexsyrus-connect',false,8388608) ON CONFLICT(id) DO NOTHING;
    -- Restrictive policies prevent an existing broad authenticated bucket policy
    -- from exposing Connect objects. The server storage service role bypasses RLS.
    CREATE POLICY collaboration_storage_private ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
      USING(bucket_id<>'nexsyrus-connect') WITH CHECK(bucket_id<>'nexsyrus-connect');
  END IF;
END $$;
COMMIT;
