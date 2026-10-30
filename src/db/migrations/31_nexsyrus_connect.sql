-- Explicitly apply to the control-plane SCHOOL_DATABASE_URL, never a tenant/CRM database.
-- Prerequisites: internal_users, internal_user_sessions, audit_logs (RBAC migration).
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.internal_users') IS NULL OR to_regclass('public.internal_user_sessions') IS NULL
     OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'Connect requires existing employee, session and audit tables';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='collaboration_api') THEN
    CREATE ROLE collaboration_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='collaboration_realtime') THEN
    CREATE ROLE collaboration_realtime NOLOGIN NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT collaboration_api TO %I', current_user);
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticator') THEN
    GRANT collaboration_realtime TO authenticator;
  END IF;
END $$;

CREATE TABLE collaboration_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE,
  name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collaboration_organization_members (
  organization_id uuid NOT NULL REFERENCES collaboration_organizations(id),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id)
);
CREATE TABLE collaboration_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES collaboration_organizations(id),
  kind text NOT NULL CHECK(kind IN ('channel','dm')),
  dm_low uuid REFERENCES internal_users(id), dm_high uuid REFERENCES internal_users(id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
  created_by uuid NOT NULL REFERENCES internal_users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id),
  CHECK((kind='channel' AND dm_low IS NULL AND dm_high IS NULL) OR
        (kind='dm' AND dm_low IS NOT NULL AND dm_high IS NOT NULL AND dm_low<dm_high)),
  UNIQUE(organization_id,dm_low,dm_high)
);
CREATE TABLE collaboration_channels (
  id uuid PRIMARY KEY REFERENCES collaboration_conversations(id),
  organization_id uuid NOT NULL,
  name text NOT NULL CHECK(name ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
  purpose text NOT NULL DEFAULT '' CHECK(length(purpose)<=250),
  category text NOT NULL DEFAULT 'company' CHECK(category IN ('company','department','project')),
  visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private')),
  announcements_only boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,name),
  FOREIGN KEY(organization_id,id) REFERENCES collaboration_conversations(organization_id,id)
);
CREATE TABLE collaboration_channel_members (
  channel_id uuid NOT NULL REFERENCES collaboration_channels(id),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id,user_id)
);
CREATE INDEX collaboration_members_user ON collaboration_channel_members(user_id,channel_id);
CREATE TABLE collaboration_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES collaboration_conversations(id),
  sender_id uuid NOT NULL REFERENCES internal_users(id),
  client_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  revision bigint NOT NULL DEFAULT 0,
  parent_id uuid,
  body text NOT NULL CHECK(length(body)<=8000),
  created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz, deleted_at timestamptz,
  UNIQUE(conversation_id,id), UNIQUE(conversation_id,sequence),
  UNIQUE(conversation_id,sender_id,client_id),
  FOREIGN KEY(conversation_id,parent_id) REFERENCES collaboration_messages(conversation_id,id),
  CHECK(parent_id IS DISTINCT FROM id), CHECK(deleted_at IS NOT NULL OR length(trim(body))>0),
  CHECK(deleted_at IS NULL OR body='')
);
CREATE INDEX collaboration_history ON collaboration_messages(conversation_id,sequence DESC);
CREATE INDEX collaboration_threads ON collaboration_messages(conversation_id,parent_id,sequence);
CREATE INDEX collaboration_search ON collaboration_messages USING gin(to_tsvector('simple',body)) WHERE deleted_at IS NULL;
CREATE TABLE collaboration_message_reactions (
  message_id uuid NOT NULL REFERENCES collaboration_messages(id),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  emoji text NOT NULL CHECK(emoji IN ('👍','❤️','🎉','👀','✅')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(message_id,user_id,emoji)
);
-- A per-conversation watermark avoids one row per employee per message.
CREATE TABLE collaboration_message_reads (
  conversation_id uuid NOT NULL REFERENCES collaboration_conversations(id),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE collaboration_message_mentions (
  message_id uuid NOT NULL REFERENCES collaboration_messages(id),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(message_id,user_id)
);
CREATE TABLE collaboration_notification_preferences (
  organization_id uuid NOT NULL REFERENCES collaboration_organizations(id),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  mode text NOT NULL DEFAULT 'mentions' CHECK(mode IN ('all','mentions','muted')),
  push_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,user_id)
);
CREATE TABLE collaboration_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES internal_users(id),
  conversation_id uuid NOT NULL REFERENCES collaboration_conversations(id),
  message_id uuid NOT NULL REFERENCES collaboration_messages(id),
  kind text NOT NULL CHECK(kind IN ('mention','dm','thread','announcement','message')),
  read_at timestamptz,
  push_state text NOT NULL DEFAULT 'disabled' CHECK(push_state IN ('disabled','pending','sent')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,message_id),
  FOREIGN KEY(conversation_id,message_id) REFERENCES collaboration_messages(conversation_id,id)
);
CREATE INDEX collaboration_notification_inbox ON collaboration_notifications(user_id,created_at DESC);
CREATE TABLE collaboration_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid REFERENCES collaboration_conversations(id),
  user_id uuid REFERENCES internal_users(id),
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(conversation_id IS NOT NULL OR user_id IS NOT NULL)
);
CREATE INDEX collaboration_event_conversation ON collaboration_events(conversation_id,id);
CREATE INDEX collaboration_event_user ON collaboration_events(user_id,id);
CREATE TABLE collaboration_rate_limits (
  user_id uuid NOT NULL REFERENCES internal_users(id), action text NOT NULL,
  bucket timestamptz NOT NULL, count integer NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id,action,bucket)
);

-- actor is set by the trusted server only while using collaboration_api.
-- Realtime is an isolated role: its JWT cannot read existing school tables.
CREATE FUNCTION collaboration_actor() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE a text; claims jsonb; BEGIN
  IF current_setting('role',true)='collaboration_api' THEN
    a:=current_setting('connect.actor',true);
  ELSIF current_setting('role',true)='collaboration_realtime' THEN
    claims:=NULLIF(current_setting('request.jwt.claims',true),'')::jsonb;
    IF claims->>'purpose' IS DISTINCT FROM 'nexsyrus-connect' THEN RETURN NULL; END IF;
    a:=claims->>'sub';
    IF NOT EXISTS(SELECT 1 FROM internal_user_sessions s JOIN internal_users u ON u.id=s.user_id
      WHERE s.id::text=claims->>'sid' AND s.user_id::text=a AND s.revoked_at IS NULL
      AND s.expires_at>now() AND u.token_version::text=claims->>'tv') THEN RETURN NULL; END IF;
  ELSE RETURN NULL; END IF;
  IF a IS NULL OR a !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM internal_users WHERE id=a::uuid AND status='ACTIVE' AND role NOT IN ('CA','CA_LEAD')) THEN RETURN a::uuid; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION collaboration_in_org(org uuid, employee uuid DEFAULT collaboration_actor()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT (CASE WHEN current_setting('role',true)='collaboration_api'
    THEN COALESCE(NULLIF(current_setting('connect.organization',true),'')=org::text,true)
    WHEN current_setting('role',true)='collaboration_realtime'
    THEN COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'organization_id'=org::text,false)
    ELSE false END) AND EXISTS(SELECT 1 FROM collaboration_organization_members m
  JOIN collaboration_organizations o ON o.id=m.organization_id
  JOIN internal_users u ON u.id=m.user_id
  WHERE m.organization_id=org AND m.user_id=employee AND o.active AND u.status='ACTIVE' AND u.role NOT IN ('CA','CA_LEAD'))
$$;
CREATE FUNCTION collaboration_admin(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT collaboration_in_org(org) AND EXISTS(SELECT 1 FROM internal_users
  WHERE id=collaboration_actor() AND role IN ('FOUNDER','SUPER_ADMIN'))
$$;
CREATE FUNCTION collaboration_can_read(conv uuid, employee uuid DEFAULT collaboration_actor()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM collaboration_conversations c WHERE c.id=conv
    AND collaboration_in_org(c.organization_id,employee)
    AND ((c.kind='dm' AND employee IN(c.dm_low,c.dm_high)) OR
      (c.kind='channel' AND EXISTS(SELECT 1 FROM collaboration_channel_members m WHERE m.channel_id=c.id AND m.user_id=employee))))
$$;
CREATE FUNCTION collaboration_manages(channel uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM collaboration_channels c WHERE c.id=channel AND collaboration_in_org(c.organization_id)
    AND (collaboration_admin(c.organization_id) OR EXISTS(SELECT 1 FROM collaboration_channel_members m
       WHERE m.channel_id=c.id AND m.user_id=collaboration_actor() AND m.role='manager')))
$$;
CREATE FUNCTION collaboration_can_post(conv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT collaboration_can_read(conv) AND NOT EXISTS(SELECT 1 FROM collaboration_channels c
    WHERE c.id=conv AND (c.archived_at IS NOT NULL OR (c.announcements_only AND NOT collaboration_manages(c.id))))
$$;
CREATE FUNCTION collaboration_message_access(msg uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=msg AND collaboration_can_read(m.conversation_id))
$$;
CREATE FUNCTION collaboration_event_visible(conv uuid, recipient uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT recipient=collaboration_actor() OR (recipient IS NULL AND collaboration_can_read(conv))
$$;
-- Fanout is transactionally called after validated mentions have been persisted.
-- Unique(user_id,message_id) is shared by in-app and push delivery; retries never duplicate.
CREATE FUNCTION collaboration_notify(msg uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE m collaboration_messages; BEGIN
  SELECT * INTO m FROM collaboration_messages WHERE id=msg AND sender_id=collaboration_actor() AND deleted_at IS NULL;
  IF m.id IS NULL OR NOT collaboration_can_post(m.conversation_id) THEN
    RAISE EXCEPTION 'Not allowed to notify this message' USING ERRCODE='42501';
  END IF;
  INSERT INTO collaboration_notifications(user_id,conversation_id,message_id,kind,push_state)
  SELECT recipient,m.conversation_id,m.id,kind,CASE WHEN push_enabled THEN 'pending' ELSE 'disabled' END
  FROM (
    SELECT u.id AS recipient, COALESCE(p.mode,'mentions') AS mode,COALESCE(p.push_enabled,false) AS push_enabled,
      CASE WHEN EXISTS(SELECT 1 FROM collaboration_message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=u.id) THEN 'mention'
           WHEN c.kind='dm' THEN 'dm'
           WHEN m.parent_id IS NOT NULL AND EXISTS(SELECT 1 FROM collaboration_messages t
              WHERE (t.id=m.parent_id OR t.parent_id=m.parent_id) AND t.sender_id=u.id) THEN 'thread'
           WHEN ch.announcements_only THEN 'announcement' ELSE 'message' END AS kind
    FROM collaboration_conversations c
    JOIN collaboration_organization_members om ON om.organization_id=c.organization_id
    JOIN internal_users u ON u.id=om.user_id
    LEFT JOIN collaboration_channels ch ON ch.id=c.id
    LEFT JOIN collaboration_notification_preferences p ON p.organization_id=c.organization_id AND p.user_id=u.id
    WHERE c.id=m.conversation_id AND u.id<>m.sender_id AND collaboration_can_read(c.id,u.id)
  ) recipients WHERE mode<>'muted' AND (kind<>'message' OR mode='all')
  ON CONFLICT(user_id,message_id) DO NOTHING;
END $$;

CREATE FUNCTION collaboration_immutable_conversation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.kind,NEW.dm_low,NEW.dm_high,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.kind,OLD.dm_low,OLD.dm_high,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Conversation participants and company are immutable' USING ERRCODE='23514';
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER collaboration_conversation_identity BEFORE UPDATE ON collaboration_conversations
FOR EACH ROW EXECUTE FUNCTION collaboration_immutable_conversation();

-- Constrain writes even if an API implementation accidentally omits a check.
CREATE FUNCTION collaboration_validate_message() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.conversation_id<>OLD.conversation_id OR NEW.sender_id<>OLD.sender_id
    OR NEW.sequence<>OLD.sequence OR NEW.client_id<>OLD.client_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.created_at<>OLD.created_at OR OLD.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Message identity and tombstones are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN NEW.revision:=OLD.revision+1; END IF;
  IF TG_OP='INSERT' AND NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collaboration_messages
    WHERE id=NEW.parent_id AND conversation_id=NEW.conversation_id AND parent_id IS NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Thread parent must be a live root in this conversation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collaboration_message_validation BEFORE INSERT OR UPDATE ON collaboration_messages
FOR EACH ROW EXECUTE FUNCTION collaboration_validate_message();

-- Every durable change invalidates authorized REST views; no body/name/attachment data is broadcast.
CREATE FUNCTION collaboration_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE c uuid; u uuid; msg uuid; BEGIN
  IF TG_TABLE_NAME='collaboration_messages' THEN c:=COALESCE(NEW.conversation_id,OLD.conversation_id); msg:=COALESCE(NEW.id,OLD.id);
  ELSIF TG_TABLE_NAME='collaboration_message_reactions' THEN
    msg:=COALESCE(NEW.message_id,OLD.message_id);
    SELECT conversation_id INTO c FROM collaboration_messages WHERE id=msg;
    UPDATE collaboration_messages SET revision=revision+1 WHERE id=msg AND deleted_at IS NULL;
    RETURN COALESCE(NEW,OLD);
  ELSIF TG_TABLE_NAME='collaboration_channel_members' THEN
    c:=COALESCE(NEW.channel_id,OLD.channel_id); u:=COALESCE(NEW.user_id,OLD.user_id);
  ELSIF TG_TABLE_NAME='collaboration_channels' THEN c:=COALESCE(NEW.id,OLD.id);
  ELSE c:=COALESCE(NEW.conversation_id,OLD.conversation_id); u:=COALESCE(NEW.user_id,OLD.user_id); END IF;
  INSERT INTO collaboration_events(conversation_id,user_id,message_id) VALUES(c,u,msg);
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER collaboration_message_event AFTER INSERT OR UPDATE ON collaboration_messages FOR EACH ROW EXECUTE FUNCTION collaboration_changed();
CREATE TRIGGER collaboration_reaction_event AFTER INSERT OR DELETE ON collaboration_message_reactions FOR EACH ROW EXECUTE FUNCTION collaboration_changed();
CREATE TRIGGER collaboration_member_event AFTER INSERT OR UPDATE OR DELETE ON collaboration_channel_members FOR EACH ROW EXECUTE FUNCTION collaboration_changed();
CREATE TRIGGER collaboration_channel_event AFTER UPDATE ON collaboration_channels FOR EACH ROW EXECUTE FUNCTION collaboration_changed();
CREATE TRIGGER collaboration_notification_event AFTER INSERT OR UPDATE ON collaboration_notifications FOR EACH ROW EXECUTE FUNCTION collaboration_changed();
CREATE TRIGGER collaboration_read_event AFTER INSERT OR UPDATE ON collaboration_message_reads FOR EACH ROW EXECUTE FUNCTION collaboration_changed();

ALTER TABLE collaboration_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_read ON collaboration_organizations FOR SELECT TO collaboration_api USING(collaboration_in_org(id));
CREATE POLICY org_member_read ON collaboration_organization_members FOR SELECT TO collaboration_api USING(collaboration_in_org(organization_id));
CREATE POLICY org_member_insert ON collaboration_organization_members FOR INSERT TO collaboration_api WITH CHECK(collaboration_admin(organization_id));
CREATE POLICY org_member_delete ON collaboration_organization_members FOR DELETE TO collaboration_api USING(collaboration_admin(organization_id) AND user_id<>collaboration_actor());
CREATE POLICY conversation_read ON collaboration_conversations FOR SELECT TO collaboration_api USING(
  collaboration_in_org(organization_id) AND ((kind='dm' AND collaboration_actor() IN(dm_low,dm_high)) OR
    (kind='channel' AND collaboration_can_read(id))));
CREATE POLICY conversation_insert ON collaboration_conversations FOR INSERT TO collaboration_api WITH CHECK(
  collaboration_in_org(organization_id) AND created_by=collaboration_actor() AND
  ((kind='channel' AND collaboration_admin(organization_id)) OR
   (kind='dm' AND collaboration_actor() IN(dm_low,dm_high) AND collaboration_in_org(organization_id,dm_low) AND collaboration_in_org(organization_id,dm_high))));
CREATE POLICY conversation_update ON collaboration_conversations FOR UPDATE TO collaboration_api USING(collaboration_can_post(id)) WITH CHECK(collaboration_can_post(id));
CREATE POLICY channel_read ON collaboration_channels FOR SELECT TO collaboration_api USING(
  collaboration_in_org(organization_id) AND (visibility='public' OR collaboration_can_read(id) OR collaboration_admin(organization_id)));
CREATE POLICY channel_insert ON collaboration_channels FOR INSERT TO collaboration_api WITH CHECK(collaboration_admin(organization_id));
CREATE POLICY channel_update ON collaboration_channels FOR UPDATE TO collaboration_api USING(collaboration_manages(id)) WITH CHECK(collaboration_manages(id));
CREATE POLICY member_read ON collaboration_channel_members FOR SELECT TO collaboration_api USING(collaboration_can_read(channel_id) OR collaboration_manages(channel_id));
CREATE POLICY member_insert ON collaboration_channel_members FOR INSERT TO collaboration_api WITH CHECK(
  EXISTS(SELECT 1 FROM collaboration_channels c WHERE c.id=channel_id AND collaboration_in_org(c.organization_id,user_id)
    AND c.archived_at IS NULL AND (collaboration_manages(c.id) OR
      (c.visibility='public' AND user_id=collaboration_actor() AND role='member'))));
CREATE POLICY member_delete ON collaboration_channel_members FOR DELETE TO collaboration_api USING(collaboration_manages(channel_id) OR user_id=collaboration_actor());
CREATE POLICY member_update ON collaboration_channel_members FOR UPDATE TO collaboration_api USING(collaboration_manages(channel_id)) WITH CHECK(collaboration_manages(channel_id));
CREATE POLICY message_read ON collaboration_messages FOR SELECT TO collaboration_api USING(collaboration_can_read(conversation_id));
CREATE POLICY message_insert ON collaboration_messages FOR INSERT TO collaboration_api WITH CHECK(sender_id=collaboration_actor() AND collaboration_can_post(conversation_id));
CREATE POLICY message_update ON collaboration_messages FOR UPDATE TO collaboration_api USING(sender_id=collaboration_actor() AND collaboration_can_post(conversation_id) AND deleted_at IS NULL)
  WITH CHECK(sender_id=collaboration_actor() AND collaboration_can_post(conversation_id));
CREATE POLICY reaction_read ON collaboration_message_reactions FOR SELECT TO collaboration_api USING(collaboration_message_access(message_id));
CREATE POLICY reaction_insert ON collaboration_message_reactions FOR INSERT TO collaboration_api WITH CHECK(user_id=collaboration_actor() AND EXISTS(SELECT 1 FROM collaboration_messages WHERE id=message_id AND deleted_at IS NULL AND collaboration_can_post(conversation_id)));
CREATE POLICY reaction_delete ON collaboration_message_reactions FOR DELETE TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_message_access(message_id));
CREATE POLICY read_state ON collaboration_message_reads FOR ALL TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_can_read(conversation_id)) WITH CHECK(user_id=collaboration_actor() AND collaboration_can_read(conversation_id));
CREATE POLICY mention_read ON collaboration_message_mentions FOR SELECT TO collaboration_api USING(collaboration_message_access(message_id));
CREATE POLICY mention_insert ON collaboration_message_mentions FOR INSERT TO collaboration_api WITH CHECK(EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=message_id AND m.sender_id=collaboration_actor() AND collaboration_can_read(m.conversation_id,user_id)));
CREATE POLICY mention_delete ON collaboration_message_mentions FOR DELETE TO collaboration_api USING(EXISTS(SELECT 1 FROM collaboration_messages m WHERE m.id=message_id AND m.sender_id=collaboration_actor()));
CREATE POLICY preferences_own ON collaboration_notification_preferences FOR ALL TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_in_org(organization_id)) WITH CHECK(user_id=collaboration_actor() AND collaboration_in_org(organization_id));
CREATE POLICY notification_read ON collaboration_notifications FOR SELECT TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_can_read(conversation_id));
CREATE POLICY notification_update ON collaboration_notifications FOR UPDATE TO collaboration_api USING(user_id=collaboration_actor() AND collaboration_can_read(conversation_id)) WITH CHECK(user_id=collaboration_actor() AND collaboration_can_read(conversation_id));
CREATE POLICY event_api ON collaboration_events FOR SELECT TO collaboration_api USING(user_id=collaboration_actor() OR (user_id IS NULL AND collaboration_can_read(conversation_id)));
CREATE POLICY event_realtime ON collaboration_events FOR SELECT TO collaboration_realtime USING(collaboration_event_visible(conversation_id,user_id));
CREATE POLICY rate_own ON collaboration_rate_limits FOR ALL TO collaboration_api USING(user_id=collaboration_actor()) WITH CHECK(user_id=collaboration_actor());

GRANT USAGE ON SCHEMA public TO collaboration_api,collaboration_realtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON collaboration_organization_members, collaboration_conversations,collaboration_channels,
  collaboration_channel_members,collaboration_messages,collaboration_message_reactions,collaboration_message_reads,
  collaboration_message_mentions,collaboration_notification_preferences,collaboration_notifications,collaboration_rate_limits TO collaboration_api;
GRANT SELECT ON collaboration_organizations,collaboration_events TO collaboration_api;
GRANT SELECT ON collaboration_events TO collaboration_realtime;
GRANT SELECT(id,full_name,employee_id,role,status,manager_id) ON internal_users TO collaboration_api;
GRANT INSERT ON audit_logs TO collaboration_api;
-- Helpers are not public RPCs. Trigger functions run only through database triggers.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'collaboration_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO collaboration_api',f.name);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION collaboration_event_visible(uuid,uuid) TO collaboration_realtime;
-- Supabase installations may grant public-schema defaults to anon/authenticated.
-- Remove those inherited grants explicitly, even though RLS is also enabled.
DO $$ DECLARE t record; r text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'collaboration_%' LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t.tablename);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',t.tablename,r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Explicit company scope, never school_id=1. Initial membership reuses directory identities.
INSERT INTO collaboration_organizations(code,name) VALUES('nexsyrus','NexSyrus');
INSERT INTO collaboration_organization_members(organization_id,user_id)
 SELECT o.id,u.id FROM collaboration_organizations o CROSS JOIN internal_users u
 WHERE o.code='nexsyrus' AND u.status='ACTIVE' AND u.role NOT IN ('CA','CA_LEAD');

-- Enable only identifier invalidations. No message/DM table is published by this migration.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE collaboration_events;
  END IF;
END $$;
COMMIT;
