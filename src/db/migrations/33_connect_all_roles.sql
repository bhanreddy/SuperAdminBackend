-- All active control-plane account roles may use Connect. Company membership,
-- private-channel membership, DM participants and session validity still gate data.
BEGIN;
CREATE OR REPLACE FUNCTION collaboration_actor() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
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
  IF EXISTS(SELECT 1 FROM internal_users WHERE id=a::uuid AND status='ACTIVE') THEN RETURN a::uuid; END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION collaboration_in_org(org uuid, employee uuid DEFAULT collaboration_actor()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT (CASE WHEN current_setting('role',true)='collaboration_api'
    THEN COALESCE(NULLIF(current_setting('connect.organization',true),'')=org::text,true)
    WHEN current_setting('role',true)='collaboration_realtime'
    THEN COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'organization_id'=org::text,false)
    ELSE false END) AND EXISTS(SELECT 1 FROM collaboration_organization_members m
  JOIN collaboration_organizations o ON o.id=m.organization_id
  JOIN internal_users u ON u.id=m.user_id
  WHERE m.organization_id=org AND m.user_id=employee AND o.active AND u.status='ACTIVE')
$$;

-- One-time enrollment for the requested rollout. Journaled execution means a
-- later explicit removal is not undone by a login or a subsequent migration run.
INSERT INTO collaboration_organization_members(organization_id,user_id)
SELECT o.id,u.id FROM collaboration_organizations o CROSS JOIN internal_users u
WHERE o.code='nexsyrus' AND o.active AND u.status='ACTIVE'
ON CONFLICT DO NOTHING;

-- Enroll new active accounts and accounts being activated, regardless of role.
-- Updating profile/role or setting ACTIVE to ACTIVE never restores removed access.
CREATE FUNCTION collaboration_enroll_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status='ACTIVE' THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO collaboration_organization_members(organization_id,user_id)
      SELECT id,NEW.id FROM collaboration_organizations WHERE code='nexsyrus' AND active
      ON CONFLICT DO NOTHING;
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      INSERT INTO collaboration_organization_members(organization_id,user_id)
      SELECT id,NEW.id FROM collaboration_organizations WHERE code='nexsyrus' AND active
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION collaboration_enroll_account() FROM PUBLIC;
CREATE TRIGGER collaboration_account_enrollment
AFTER INSERT OR UPDATE OF status ON internal_users
FOR EACH ROW EXECUTE FUNCTION collaboration_enroll_account();
COMMIT;
