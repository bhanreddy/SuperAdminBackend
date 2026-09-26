-- 18_trackable_links.sql
-- Additive CRM campaign links, revisions, opens, and attribution.
-- Printed short codes are never recycled or hard-deleted.
-- Immutable here means ordinary writes cannot rewrite historical attribution.
-- Personal telemetry is purged by crm_track_purge_ephemeral(); do not backfill
-- old enquiries with invented QR touches. Historical text campaign/source stays UNKNOWN.
--
-- Disable strategy (do not DROP history): turn off
-- CRM_FEATURE_TRACK_WRITE, CRM_FEATURE_TRACK_RESOLVE,
-- CRM_FEATURE_TRACK_ATTRIBUTION, and CRM_FEATURE_TRACK_REPORTS.
-- The public resolver then stops redirecting. Issued codes stay reserved.

ALTER TABLE crm_school_profiles ADD COLUMN IF NOT EXISTS mandal_raw TEXT;
ALTER TABLE crm_school_profiles ADD COLUMN IF NOT EXISTS mandal_normalized TEXT;
ALTER TABLE crm_school_profiles DROP CONSTRAINT IF EXISTS crm_school_profiles_mandal_len;
ALTER TABLE crm_school_profiles ADD CONSTRAINT crm_school_profiles_mandal_len CHECK (
  (mandal_raw IS NULL OR char_length(mandal_raw) <= 80)
  AND (mandal_normalized IS NULL OR char_length(mandal_normalized) <= 80)
);

CREATE TABLE IF NOT EXISTS crm_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('BROCHURE', 'DEMO', 'EVENT', 'LANDING', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  owner_founder_id UUID REFERENCES founders(id) ON DELETE RESTRICT,
  territory_id UUID REFERENCES crm_territories(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT crm_campaigns_code_shape CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,48}$'),
  CONSTRAINT crm_campaigns_name_len CHECK (char_length(name) BETWEEN 2 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_campaigns_code ON crm_campaigns (code);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_owner_active
  ON crm_campaigns (owner_founder_id, created_at DESC)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_territory_active
  ON crm_campaigns (territory_id, created_at DESC)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_created ON crm_campaigns (created_at DESC);

CREATE TABLE IF NOT EXISTS crm_track_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code TEXT NOT NULL,
  campaign_id UUID REFERENCES crm_campaigns(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL,
  owner_founder_id UUID REFERENCES founders(id) ON DELETE RESTRICT,
  current_revision_id UUID,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT crm_track_links_code_shape CHECK (short_code ~ '^[A-Za-z0-9_-]{16}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_track_links_short_code ON crm_track_links (short_code);
CREATE INDEX IF NOT EXISTS idx_crm_track_links_owner_active
  ON crm_track_links (owner_founder_id, created_at DESC)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_crm_track_links_campaign_status
  ON crm_track_links (campaign_id, status, created_at DESC)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_track_links_expiry
  ON crm_track_links (expires_at)
  WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_track_link_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES crm_track_links(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  destination_url TEXT NOT NULL,
  destination_class TEXT NOT NULL CHECK (destination_class IN ('OWNED_SITE', 'DOCUMENT', 'PLAY_STORE', 'APP_STORE', 'WEBSITE')),
  source_code TEXT,
  channel_id UUID REFERENCES crm_acquisition_channels(id) ON DELETE RESTRICT,
  channel_code_snapshot TEXT,
  channel_label_snapshot TEXT,
  campaign_id UUID REFERENCES crm_campaigns(id) ON DELETE RESTRICT,
  campaign_code_snapshot TEXT,
  campaign_name_snapshot TEXT,
  campaign_type_snapshot TEXT,
  medium TEXT NOT NULL CHECK (medium IN ('QR', 'LINK')),
  purpose TEXT NOT NULL CHECK (purpose IN ('BROCHURE', 'DEMO', 'EVENT', 'LANDING')),
  owner_founder_id UUID REFERENCES founders(id) ON DELETE RESTRICT,
  owner_name_snapshot TEXT,
  territory_id UUID REFERENCES crm_territories(id) ON DELETE RESTRICT,
  territory_code_snapshot TEXT,
  territory_name_snapshot TEXT,
  country_code TEXT,
  state_raw TEXT,
  state_normalized TEXT,
  district_raw TEXT,
  district_normalized TEXT,
  mandal_raw TEXT,
  mandal_normalized TEXT,
  locality_raw TEXT,
  locality_normalized TEXT,
  target_account_id UUID REFERENCES crm_accounts(id) ON DELETE RESTRICT,
  target_enquiry_id UUID REFERENCES enquiries(id) ON DELETE RESTRICT,
  target_school_name_snapshot TEXT,
  target_cluster_id TEXT,
  target_school_id TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_reason TEXT,
  CONSTRAINT crm_track_rev_version_unique UNIQUE (link_id, version),
  CONSTRAINT crm_track_rev_link_id_unique UNIQUE (link_id, id),
  CONSTRAINT crm_track_rev_destination_len CHECK (char_length(destination_url) BETWEEN 8 AND 2000),
  CONSTRAINT crm_track_rev_notes_len CHECK (notes IS NULL OR char_length(notes) <= 2000),
  CONSTRAINT crm_track_rev_reason_len CHECK (change_reason IS NULL OR char_length(change_reason) <= 200),
  CONSTRAINT crm_track_rev_tags_bound CHECK (cardinality(tags) <= 20),
  CONSTRAINT crm_track_rev_school_tuple CHECK (
    (target_cluster_id IS NULL AND target_school_id IS NULL)
    OR (target_cluster_id IS NOT NULL AND target_school_id IS NOT NULL AND char_length(target_school_id) <= 64)
  ),
  CONSTRAINT crm_track_rev_geo_len CHECK (
    (country_code IS NULL OR char_length(country_code) <= 8)
    AND (state_raw IS NULL OR char_length(state_raw) <= 120)
    AND (district_raw IS NULL OR char_length(district_raw) <= 120)
    AND (mandal_raw IS NULL OR char_length(mandal_raw) <= 80)
    AND (mandal_normalized IS NULL OR char_length(mandal_normalized) <= 80)
    AND (locality_raw IS NULL OR char_length(locality_raw) <= 120)
    AND (target_school_name_snapshot IS NULL OR char_length(target_school_name_snapshot) <= 200)
  )
);

ALTER TABLE crm_track_links DROP CONSTRAINT IF EXISTS crm_track_links_current_revision_fk;
ALTER TABLE crm_track_links
  ADD CONSTRAINT crm_track_links_current_revision_fk
  FOREIGN KEY (id, current_revision_id)
  REFERENCES crm_track_link_revisions (link_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION crm_track_link_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rev UUID;
BEGIN
  SELECT current_revision_id INTO rev FROM crm_track_links WHERE id = NEW.id;
  IF rev IS NULL THEN
    RAISE EXCEPTION 'track link requires a current revision';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS crm_track_link_revision_guard ON crm_track_links;
CREATE CONSTRAINT TRIGGER crm_track_link_revision_guard
AFTER INSERT OR UPDATE OF current_revision_id ON crm_track_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_track_link_revision_guard();

CREATE TABLE IF NOT EXISTS crm_track_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES crm_track_links(id) ON DELETE RESTRICT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL CHECK (new_status IN ('ACTIVE', 'DISABLED')),
  previous_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  actor_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  old_version INTEGER NOT NULL,
  new_version INTEGER NOT NULL,
  CONSTRAINT crm_track_status_reason_len CHECK (reason IS NULL OR char_length(reason) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_crm_track_status_link ON crm_track_status_events (link_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS crm_track_opens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL,
  revision_id UUID NOT NULL,
  request_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_class TEXT NOT NULL CHECK (event_class IN ('QUALIFIED', 'PREVIEW', 'BOT', 'REPEAT', 'UNKNOWN')),
  countable BOOLEAN NOT NULL,
  device_class TEXT NOT NULL DEFAULT 'unknown',
  browser_class TEXT NOT NULL DEFAULT 'unknown',
  platform_class TEXT NOT NULL DEFAULT 'unknown',
  referrer_origin TEXT,
  destination_class TEXT NOT NULL,
  repeat_of_id UUID,
  processing_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT crm_track_opens_request UNIQUE (request_id),
  CONSTRAINT crm_track_opens_revision_fk FOREIGN KEY (link_id, revision_id)
    REFERENCES crm_track_link_revisions (link_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_track_opens_repeat_fk FOREIGN KEY (repeat_of_id) REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  CONSTRAINT crm_track_opens_class_len CHECK (
    char_length(device_class) <= 32 AND char_length(browser_class) <= 32 AND char_length(platform_class) <= 32
    AND (referrer_origin IS NULL OR char_length(referrer_origin) <= 200)
    AND char_length(request_id) BETWEEN 8 AND 80
  )
);

CREATE INDEX IF NOT EXISTS idx_crm_track_opens_link_time ON crm_track_opens (link_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_track_opens_revision_time ON crm_track_opens (revision_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_track_opens_class_time ON crm_track_opens (event_class, observed_at DESC);

CREATE TABLE IF NOT EXISTS crm_track_browser_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  browser_key TEXT NOT NULL,
  link_id UUID NOT NULL REFERENCES crm_track_links(id) ON DELETE RESTRICT,
  bucket_start TIMESTAMPTZ NOT NULL,
  open_id UUID NOT NULL REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT crm_track_browser_unique UNIQUE (browser_key, link_id, bucket_start),
  CONSTRAINT crm_track_browser_key_len CHECK (char_length(browser_key) BETWEEN 16 AND 128)
);

CREATE INDEX IF NOT EXISTS idx_crm_track_browser_expiry ON crm_track_browser_windows (expires_at);

CREATE TABLE IF NOT EXISTS crm_track_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  first_open_id UUID NOT NULL REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  current_open_id UUID NOT NULL REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  link_id UUID NOT NULL REFERENCES crm_track_links(id) ON DELETE RESTRICT,
  revision_id UUID NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  site_origin TEXT NOT NULL,
  previous_context_id UUID REFERENCES crm_track_contexts(id) ON DELETE RESTRICT,
  CONSTRAINT crm_track_contexts_token UNIQUE (token_hash),
  CONSTRAINT crm_track_contexts_revision_fk FOREIGN KEY (link_id, revision_id)
    REFERENCES crm_track_link_revisions (link_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_track_contexts_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 minutes'),
  CONSTRAINT crm_track_contexts_origin_len CHECK (char_length(site_origin) BETWEEN 8 AND 200),
  CONSTRAINT crm_track_contexts_hash_len CHECK (char_length(token_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_crm_track_contexts_expiry ON crm_track_contexts (expires_at);

CREATE OR REPLACE FUNCTION crm_track_context_consume_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.first_open_id IS DISTINCT FROM OLD.first_open_id
     OR NEW.current_open_id IS DISTINCT FROM OLD.current_open_id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.site_origin IS DISTINCT FROM OLD.site_origin
     OR NEW.previous_context_id IS DISTINCT FROM OLD.previous_context_id
  THEN
    RAISE EXCEPTION 'context identity is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'context consumption is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_track_context_consume_only ON crm_track_contexts;
CREATE TRIGGER crm_track_context_consume_only
BEFORE UPDATE ON crm_track_contexts
FOR EACH ROW EXECUTE FUNCTION crm_track_context_consume_only();

CREATE TABLE IF NOT EXISTS crm_enquiry_attribution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE RESTRICT,
  open_id UUID NOT NULL REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  association_kind TEXT NOT NULL CHECK (association_kind IN ('FORM_CAPTURE', 'AUTHORIZED_ATTACH', 'CORRECTION_RETRACT')),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID,
  intake_command_id TEXT,
  supersedes_id UUID REFERENCES crm_enquiry_attribution_events(id) ON DELETE RESTRICT,
  mismatch_state TEXT NOT NULL DEFAULT 'NONE' CHECK (mismatch_state IN ('NONE', 'TARGET_MISMATCH', 'REVIEW')),
  CONSTRAINT crm_enquiry_attr_intake_len CHECK (intake_command_id IS NULL OR char_length(intake_command_id) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_enquiry_attr_intake
  ON crm_enquiry_attribution_events (enquiry_id, open_id, association_kind, intake_command_id)
  WHERE intake_command_id IS NOT NULL AND association_kind <> 'CORRECTION_RETRACT';
CREATE INDEX IF NOT EXISTS idx_crm_enquiry_attr_enquiry ON crm_enquiry_attribution_events (enquiry_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS crm_enquiry_attribution_current (
  enquiry_id UUID PRIMARY KEY REFERENCES enquiries(id) ON DELETE RESTRICT,
  first_open_id UUID REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  latest_open_id UUID REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_track_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('ENQUIRY_CREATED', 'DEMO_REQUESTED', 'DEMO_BOOKED', 'DEMO_COMPLETED', 'WON', 'LOST')),
  enquiry_id UUID NOT NULL REFERENCES enquiries(id) ON DELETE RESTRICT,
  demo_id UUID REFERENCES crm_demos(id) ON DELETE RESTRICT,
  closure_id UUID REFERENCES crm_closures(id) ON DELETE RESTRICT,
  open_id UUID REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  revision_id UUID,
  first_open_id UUID REFERENCES crm_track_opens(id) ON DELETE RESTRICT,
  converted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  creator_type TEXT NOT NULL CHECK (creator_type IN ('PUBLIC_INTAKE', 'STAFF', 'SYSTEM')),
  attribution_rule_version INTEGER NOT NULL DEFAULT 1,
  attribution_model TEXT NOT NULL CHECK (attribution_model IN ('first', 'latest', 'unattributed')),
  CONSTRAINT crm_track_conversions_unique UNIQUE (kind, source_type, source_id),
  CONSTRAINT crm_track_conversions_source_len CHECK (char_length(source_type) <= 40 AND char_length(source_id) <= 80)
);

CREATE INDEX IF NOT EXISTS idx_crm_track_conversions_enquiry ON crm_track_conversions (enquiry_id, kind, converted_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_track_conversions_time ON crm_track_conversions (converted_at DESC, kind);

CREATE TABLE IF NOT EXISTS crm_track_rate_buckets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1 CHECK (hit_count >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT crm_track_rate_unique UNIQUE (bucket_key, window_start),
  CONSTRAINT crm_track_rate_key_len CHECK (char_length(bucket_key) BETWEEN 4 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_crm_track_rate_expiry ON crm_track_rate_buckets (expires_at);

CREATE OR REPLACE FUNCTION crm_track_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS crm_track_revisions_append_only ON crm_track_link_revisions;
CREATE TRIGGER crm_track_revisions_append_only
BEFORE UPDATE OR DELETE ON crm_track_link_revisions
FOR EACH ROW EXECUTE FUNCTION crm_track_forbid_mutation();

DROP TRIGGER IF EXISTS crm_track_status_append_only ON crm_track_status_events;
CREATE TRIGGER crm_track_status_append_only
BEFORE UPDATE OR DELETE ON crm_track_status_events
FOR EACH ROW EXECUTE FUNCTION crm_track_forbid_mutation();

DROP TRIGGER IF EXISTS crm_track_opens_append_only ON crm_track_opens;
CREATE TRIGGER crm_track_opens_append_only
BEFORE UPDATE OR DELETE ON crm_track_opens
FOR EACH ROW EXECUTE FUNCTION crm_track_forbid_mutation();

DROP TRIGGER IF EXISTS crm_enquiry_attr_append_only ON crm_enquiry_attribution_events;
CREATE TRIGGER crm_enquiry_attr_append_only
BEFORE UPDATE OR DELETE ON crm_enquiry_attribution_events
FOR EACH ROW EXECUTE FUNCTION crm_track_forbid_mutation();

DROP TRIGGER IF EXISTS crm_track_conversions_append_only ON crm_track_conversions;
CREATE TRIGGER crm_track_conversions_append_only
BEFORE UPDATE OR DELETE ON crm_track_conversions
FOR EACH ROW EXECUTE FUNCTION crm_track_forbid_mutation();

CREATE OR REPLACE FUNCTION crm_track_forbid_link_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued track links cannot be deleted';
END $$;

DROP TRIGGER IF EXISTS crm_track_links_no_delete ON crm_track_links;
CREATE TRIGGER crm_track_links_no_delete
BEFORE DELETE ON crm_track_links
FOR EACH ROW EXECUTE FUNCTION crm_track_forbid_link_delete();

DROP TRIGGER IF EXISTS crm_campaigns_row_version ON crm_campaigns;
CREATE TRIGGER crm_campaigns_row_version
BEFORE UPDATE ON crm_campaigns
FOR EACH ROW EXECUTE FUNCTION crm_bump_row_version();

DROP TRIGGER IF EXISTS crm_track_links_row_version ON crm_track_links;
CREATE TRIGGER crm_track_links_row_version
BEFORE UPDATE ON crm_track_links
FOR EACH ROW EXECUTE FUNCTION crm_bump_row_version();

CREATE OR REPLACE FUNCTION crm_track_purge_ephemeral(p_now TIMESTAMPTZ DEFAULT now())
RETURNS TABLE (browser_windows INTEGER, rate_buckets INTEGER, contexts INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
  windows INTEGER;
  buckets INTEGER;
  contexts INTEGER;
BEGIN
  DELETE FROM crm_track_browser_windows WHERE expires_at < p_now;
  GET DIAGNOSTICS windows = ROW_COUNT;
  DELETE FROM crm_track_rate_buckets WHERE expires_at < p_now;
  GET DIAGNOSTICS buckets = ROW_COUNT;
  DELETE FROM crm_track_contexts
  WHERE expires_at < p_now - interval '1 day'
    AND (consumed_at IS NOT NULL OR expires_at < p_now - interval '1 day');
  GET DIAGNOSTICS contexts = ROW_COUNT;
  RETURN QUERY SELECT windows, buckets, contexts;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON crm_campaigns, crm_track_links, crm_track_link_revisions, crm_track_status_events,
      crm_track_opens, crm_track_browser_windows, crm_track_contexts, crm_enquiry_attribution_events,
      crm_enquiry_attribution_current, crm_track_conversions, crm_track_rate_buckets FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON crm_campaigns, crm_track_links, crm_track_link_revisions, crm_track_status_events,
      crm_track_opens, crm_track_browser_windows, crm_track_contexts, crm_enquiry_attribution_events,
      crm_enquiry_attribution_current, crm_track_conversions, crm_track_rate_buckets FROM authenticated;
  END IF;
END $$;
