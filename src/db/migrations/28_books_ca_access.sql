-- CA accounts reuse the existing internal directory, sessions and permission overrides.
-- No account or financial access is granted by this migration.
BEGIN;
ALTER TABLE internal_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS books_access_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_user_id uuid NOT NULL REFERENCES internal_users(id),
 actor_id text, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE books_access_events ENABLE ROW LEVEL SECURITY;
COMMIT;
