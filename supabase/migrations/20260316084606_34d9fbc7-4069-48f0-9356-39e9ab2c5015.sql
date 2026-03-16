-- Systemic fix scaffolding for knowledge retrieval
-- 1) Fix broken hybrid function type mismatch
-- 2) Add chunk-level index table for precise retrieval from large PDFs/URLs/text

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_entry_id UUID NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768),
  search_vector tsvector,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (knowledge_entry_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_entry_id
  ON public.knowledge_chunks (knowledge_entry_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search_vector
  ON public.knowledge_chunks USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
  ON public.knowledge_chunks USING HNSW (embedding vector_cosine_ops);

ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_chunks' AND policyname = 'Knowledge chunks are publicly readable'
  ) THEN
    CREATE POLICY "Knowledge chunks are publicly readable"
    ON public.knowledge_chunks
    FOR SELECT
    USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_chunks' AND policyname = 'Editors can insert knowledge chunks'
  ) THEN
    CREATE POLICY "Editors can insert knowledge chunks"
    ON public.knowledge_chunks
    FOR INSERT
    WITH CHECK (has_role(auth.uid(), 'editor'::app_role) OR has_role(auth.uid(), 'admin'::app_role));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_chunks' AND policyname = 'Editors can update knowledge chunks'
  ) THEN
    CREATE POLICY "Editors can update knowledge chunks"
    ON public.knowledge_chunks
    FOR UPDATE
    USING (has_role(auth.uid(), 'editor'::app_role) OR has_role(auth.uid(), 'admin'::app_role));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_chunks' AND policyname = 'Editors can delete knowledge chunks'
  ) THEN
    CREATE POLICY "Editors can delete knowledge chunks"
    ON public.knowledge_chunks
    FOR DELETE
    USING (has_role(auth.uid(), 'editor'::app_role) OR has_role(auth.uid(), 'admin'::app_role));
  END IF;
END
$$;

DROP TRIGGER IF EXISTS update_knowledge_chunks_updated_at ON public.knowledge_chunks;
CREATE TRIGGER update_knowledge_chunks_updated_at
BEFORE UPDATE ON public.knowledge_chunks
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS knowledge_chunks_search_vector_trigger ON public.knowledge_chunks;
CREATE TRIGGER knowledge_chunks_search_vector_trigger
BEFORE INSERT OR UPDATE ON public.knowledge_chunks
FOR EACH ROW
EXECUTE FUNCTION public.knowledge_search_trigger();

CREATE OR REPLACE FUNCTION public.search_knowledge_hybrid(
  search_query TEXT,
  query_embedding vector DEFAULT NULL,
  match_count INTEGER DEFAULT 5
)
RETURNS TABLE(
  id UUID,
  title TEXT,
  content TEXT,
  type TEXT,
  source_url TEXT,
  score DOUBLE PRECISION
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  tsquery_ru tsquery;
  words TEXT[];
  word TEXT;
  tsquery_parts TEXT[];
BEGIN
  words := ARRAY(
    SELECT DISTINCT lower(w)
    FROM unnest(regexp_split_to_array(lower(search_query), '[^а-яёa-z0-9]+')) AS w
    WHERE length(w) > 2
      AND w NOT IN (
        'как','что','где','когда','почему','какой','какая','какие','это','для','при','над','под','или','так',
        'вот','вас','нас','можно','работает','есть','ваш','ваша','ваши','мне','вам'
      )
  );

  IF array_length(words, 1) > 0 THEN
    FOREACH word IN ARRAY words LOOP
      tsquery_parts := array_append(tsquery_parts, word || ':*');
    END LOOP;
    tsquery_ru := to_tsquery('russian', array_to_string(tsquery_parts, ' | '));
  ELSE
    tsquery_ru := plainto_tsquery('russian', search_query);
  END IF;

  RETURN QUERY
  WITH fts_results AS (
    SELECT
      ke.id,
      ke.title,
      ke.content,
      ke.type,
      ke.source_url,
      ROW_NUMBER() OVER (ORDER BY ts_rank(ke.search_vector, tsquery_ru) DESC) AS rn
    FROM public.knowledge_entries ke
    WHERE ke.search_vector @@ tsquery_ru
    LIMIT GREATEST(match_count, 1) * 3
  ),
  vec_results AS (
    SELECT
      ke.id,
      ke.title,
      ke.content,
      ke.type,
      ke.source_url,
      ROW_NUMBER() OVER (ORDER BY ke.embedding <=> query_embedding) AS rn
    FROM public.knowledge_entries ke
    WHERE query_embedding IS NOT NULL
      AND ke.embedding IS NOT NULL
      AND 1 - (ke.embedding <=> query_embedding) > 0.25
    LIMIT GREATEST(match_count, 1) * 3
  ),
  combined AS (
    SELECT
      COALESCE(f.id, v.id) AS id,
      COALESCE(f.title, v.title) AS title,
      COALESCE(f.content, v.content) AS content,
      COALESCE(f.type, v.type) AS type,
      COALESCE(f.source_url, v.source_url) AS source_url,
      COALESCE((1.0 / (60 + f.rn))::double precision, 0::double precision) +
      COALESCE((1.0 / (60 + v.rn))::double precision, 0::double precision) AS rrf_score
    FROM fts_results f
    FULL OUTER JOIN vec_results v ON f.id = v.id
  )
  SELECT
    combined.id,
    combined.title,
    combined.content,
    combined.type,
    combined.source_url,
    combined.rrf_score AS score
  FROM combined
  ORDER BY combined.rrf_score DESC
  LIMIT GREATEST(match_count, 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.search_knowledge_chunks_hybrid(
  search_query TEXT,
  query_embedding vector DEFAULT NULL,
  match_count INTEGER DEFAULT 5,
  max_chunks_per_entry INTEGER DEFAULT 2
)
RETURNS TABLE(
  entry_id UUID,
  chunk_id UUID,
  title TEXT,
  content TEXT,
  type TEXT,
  source_url TEXT,
  score DOUBLE PRECISION,
  chunk_index INTEGER
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  tsquery_ru tsquery;
  words TEXT[];
  word TEXT;
  tsquery_parts TEXT[];
BEGIN
  words := ARRAY(
    SELECT DISTINCT lower(w)
    FROM unnest(regexp_split_to_array(lower(search_query), '[^а-яёa-z0-9]+')) AS w
    WHERE length(w) > 2
      AND w NOT IN (
        'как','что','где','когда','почему','какой','какая','какие','это','для','при','над','под','или','так',
        'вот','вас','нас','можно','работает','есть','ваш','ваша','ваши','мне','вам'
      )
  );

  IF array_length(words, 1) > 0 THEN
    FOREACH word IN ARRAY words LOOP
      tsquery_parts := array_append(tsquery_parts, word || ':*');
    END LOOP;
    tsquery_ru := to_tsquery('russian', array_to_string(tsquery_parts, ' | '));
  ELSE
    tsquery_ru := plainto_tsquery('russian', search_query);
  END IF;

  RETURN QUERY
  WITH fts_results AS (
    SELECT
      kc.id AS chunk_id,
      kc.knowledge_entry_id,
      ke.title,
      kc.content,
      ke.type,
      ke.source_url,
      kc.chunk_index,
      ROW_NUMBER() OVER (ORDER BY ts_rank(kc.search_vector, tsquery_ru) DESC) AS rn
    FROM public.knowledge_chunks kc
    JOIN public.knowledge_entries ke ON ke.id = kc.knowledge_entry_id
    WHERE kc.search_vector @@ tsquery_ru
    LIMIT GREATEST(match_count, 1) * 4
  ),
  vec_results AS (
    SELECT
      kc.id AS chunk_id,
      kc.knowledge_entry_id,
      ke.title,
      kc.content,
      ke.type,
      ke.source_url,
      kc.chunk_index,
      ROW_NUMBER() OVER (ORDER BY kc.embedding <=> query_embedding) AS rn
    FROM public.knowledge_chunks kc
    JOIN public.knowledge_entries ke ON ke.id = kc.knowledge_entry_id
    WHERE query_embedding IS NOT NULL
      AND kc.embedding IS NOT NULL
      AND 1 - (kc.embedding <=> query_embedding) > 0.25
    LIMIT GREATEST(match_count, 1) * 4
  ),
  combined AS (
    SELECT
      COALESCE(f.knowledge_entry_id, v.knowledge_entry_id) AS entry_id,
      COALESCE(f.chunk_id, v.chunk_id) AS chunk_id,
      COALESCE(f.title, v.title) AS title,
      COALESCE(f.content, v.content) AS content,
      COALESCE(f.type, v.type) AS type,
      COALESCE(f.source_url, v.source_url) AS source_url,
      COALESCE(f.chunk_index, v.chunk_index) AS chunk_index,
      COALESCE((1.0 / (60 + f.rn))::double precision, 0::double precision) +
      COALESCE((1.0 / (60 + v.rn))::double precision, 0::double precision) AS rrf_score
    FROM fts_results f
    FULL OUTER JOIN vec_results v ON f.chunk_id = v.chunk_id
  ),
  ranked AS (
    SELECT
      combined.*,
      ROW_NUMBER() OVER (
        PARTITION BY combined.entry_id
        ORDER BY combined.rrf_score DESC, combined.chunk_index ASC
      ) AS entry_rank
    FROM combined
  )
  SELECT
    ranked.entry_id,
    ranked.chunk_id,
    ranked.title,
    ranked.content,
    ranked.type,
    ranked.source_url,
    ranked.rrf_score AS score,
    ranked.chunk_index
  FROM ranked
  WHERE ranked.entry_rank <= GREATEST(max_chunks_per_entry, 1)
  ORDER BY ranked.rrf_score DESC, ranked.chunk_index ASC
  LIMIT GREATEST(match_count, 1);
END;
$$;