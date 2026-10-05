-- Platform-owned authoring library. Tenant operational tables are intentionally
-- not used: their school/chapter requirements cannot represent reusable content.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
  IF to_regclass('public.content_assets') IS NULL THEN
    RAISE EXCEPTION 'Install the content asset architecture (v462) before the learning library';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.learning_content_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  definition text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  grade text NOT NULL DEFAULT '',
  board text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'en',
  tags text[] NOT NULL DEFAULT '{}',
  learning_objectives text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Library paging and future consumer selection by subject/grade/language.
CREATE INDEX IF NOT EXISTS idx_learning_topics_page ON public.learning_content_topics(updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_learning_topics_selection ON public.learning_content_topics(status,subject,grade,language);
CREATE TABLE IF NOT EXISTS public.learning_content_subtopics (
  id uuid PRIMARY KEY,
  topic_id uuid NOT NULL REFERENCES public.learning_content_topics(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  definition text NOT NULL DEFAULT '',
  sequence integer NOT NULL CHECK (sequence >= 0),
  UNIQUE(id,topic_id), UNIQUE(topic_id,sequence)
);
CREATE TABLE IF NOT EXISTS public.learning_content_questions (
  id uuid PRIMARY KEY,
  topic_id uuid NOT NULL REFERENCES public.learning_content_topics(id) ON DELETE CASCADE,
  subtopic_id uuid,
  kind text NOT NULL CHECK (kind IN ('example','activity','exercise','long_answer')),
  question text NOT NULL CHECK (length(question) > 0),
  answer text NOT NULL DEFAULT '',
  explanation text NOT NULL DEFAULT '',
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  marks numeric(6,2) NOT NULL DEFAULT 1 CHECK (marks >= 0 AND marks <= 1000),
  bloom_level text NOT NULL DEFAULT 'understand' CHECK (bloom_level IN ('remember','understand','apply','analyze','evaluate','create')),
  sequence integer NOT NULL CHECK (sequence >= 0),
  FOREIGN KEY(subtopic_id,topic_id) REFERENCES public.learning_content_subtopics(id,topic_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_learning_questions_selection ON public.learning_content_questions(topic_id,kind,difficulty,marks);
CREATE INDEX IF NOT EXISTS idx_learning_questions_subtopic ON public.learning_content_questions(subtopic_id);
CREATE TABLE IF NOT EXISTS public.learning_content_images (
  id uuid PRIMARY KEY,
  topic_id uuid NOT NULL REFERENCES public.learning_content_topics(id) ON DELETE CASCADE,
  subtopic_id uuid,
  asset_id uuid NOT NULL REFERENCES public.content_assets(id) ON DELETE RESTRICT,
  alt_text text NOT NULL CHECK(length(alt_text)>0),
  caption text NOT NULL DEFAULT '',
  sequence integer NOT NULL CHECK(sequence >= 0),
  FOREIGN KEY(subtopic_id,topic_id) REFERENCES public.learning_content_subtopics(id,topic_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_learning_images_topic ON public.learning_content_images(topic_id,sequence);
CREATE TABLE IF NOT EXISTS public.learning_content_revisions (
  topic_id uuid NOT NULL REFERENCES public.learning_content_topics(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(topic_id,revision)
);
CREATE TABLE IF NOT EXISTS public.learning_content_requests (
  request_key uuid NOT NULL,
  actor_id text NOT NULL,
  checksum text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_key,actor_id)
);
CREATE OR REPLACE FUNCTION public.freeze_learning_content_revision() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Learning content revision history is append-only' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_freeze_learning_content_revision ON public.learning_content_revisions;
CREATE TRIGGER trg_freeze_learning_content_revision BEFORE UPDATE OR DELETE ON public.learning_content_revisions
FOR EACH ROW EXECUTE FUNCTION public.freeze_learning_content_revision();
-- Only the authenticated SuperAdmin backend may access platform content.
ALTER TABLE public.learning_content_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_content_subtopics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_content_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_content_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_content_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_content_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learning_content_topics,public.learning_content_subtopics,
  public.learning_content_questions,public.learning_content_images,
  public.learning_content_revisions,public.learning_content_requests FROM PUBLIC;
COMMIT;
