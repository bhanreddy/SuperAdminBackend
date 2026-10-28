-- Organization membership and delegated accounting management. Existing books stay in public.
BEGIN;
ALTER TABLE public.internal_users ADD COLUMN IF NOT EXISTS books_company_scoped boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.books_companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE,
 name text NOT NULL, schema_name text NOT NULL UNIQUE,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.books_companies(code,name,schema_name) VALUES
 ('nexsyrus','Nexsyrus','public'),('nexmaxx','Nexmaxx','books_nexmaxx') ON CONFLICT(code) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.books_company_access (
 user_id uuid NOT NULL REFERENCES public.internal_users(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.books_companies(id),
 permissions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(permissions)='array'),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,company_id)
);
-- Preserve previously granted access for the original company, including zero-grant accounts.
INSERT INTO public.books_company_access(user_id,company_id,permissions)
SELECT u.id,c.id,COALESCE((SELECT jsonb_agg(p.permission) FROM public.internal_user_permission_overrides p
 WHERE p.user_id=u.id AND p.effect='GRANT' AND p.permission LIKE 'books.%'),'[]'::jsonb)
FROM public.internal_users u CROSS JOIN public.books_companies c
WHERE u.role='CA' AND NOT u.books_company_scoped AND c.code='nexsyrus' ON CONFLICT DO NOTHING;
UPDATE public.internal_users SET books_company_scoped=true WHERE role IN ('CA','CA_LEAD');
ALTER TABLE public.books_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books_company_access ENABLE ROW LEVEL SECURITY;
COMMIT;
