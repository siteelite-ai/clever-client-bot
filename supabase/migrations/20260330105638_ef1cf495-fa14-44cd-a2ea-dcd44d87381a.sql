-- Step 1: Add valid_from / valid_until columns
ALTER TABLE public.knowledge_entries 
  ADD COLUMN valid_from timestamptz,
  ADD COLUMN valid_until timestamptz;

-- Step 2: Update search_knowledge_hybrid with expiry filter
CREATE OR REPLACE FUNCTION public.search_knowledge_hybrid(search_query text, query_embedding vector DEFAULT NULL::vector, match_count integer DEFAULT 5)
 RETURNS TABLE(id uuid, title text, content text, type text, source_url text, score double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
      AND (ke.valid_until IS NULL OR ke.valid_until > now())
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
      AND (ke.valid_until IS NULL OR ke.valid_until > now())
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
$function$;

-- Step 3: Update search_knowledge_fulltext with expiry filter
CREATE OR REPLACE FUNCTION public.search_knowledge_fulltext(search_query text, match_count integer DEFAULT 5)
 RETURNS TABLE(id uuid, title text, content text, type text, source_url text, rank real)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  tsquery_ru tsquery;
  words text[];
  word text;
  tsquery_parts text[];
BEGIN
  words := ARRAY(
    SELECT DISTINCT lower(w) 
    FROM unnest(regexp_split_to_array(lower(search_query), '[^а-яёa-z0-9]+')) AS w
    WHERE length(w) > 2 
      AND w NOT IN ('как', 'что', 'где', 'когда', 'почему', 'какой', 'какая', 'какие', 
                    'это', 'для', 'при', 'над', 'под', 'или', 'так', 'вот', 'вас', 'нас',
                    'можно', 'работает', 'есть', 'ваш', 'ваша', 'ваши', 'мне', 'вам')
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
  SELECT
    ke.id,
    ke.title,
    ke.content,
    ke.type,
    ke.source_url,
    ts_rank(ke.search_vector, tsquery_ru) as rank
  FROM public.knowledge_entries ke
  WHERE ke.search_vector @@ tsquery_ru
    AND (ke.valid_until IS NULL OR ke.valid_until > now())
  ORDER BY ts_rank(ke.search_vector, tsquery_ru) DESC
  LIMIT match_count;
END;
$function$;

-- Step 4: Update search_knowledge_chunks_hybrid with expiry filter
CREATE OR REPLACE FUNCTION public.search_knowledge_chunks_hybrid(search_query text, query_embedding vector DEFAULT NULL::vector, match_count integer DEFAULT 5, max_chunks_per_entry integer DEFAULT 2)
 RETURNS TABLE(entry_id uuid, chunk_id uuid, title text, content text, type text, source_url text, score double precision, chunk_index integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
      AND (ke.valid_until IS NULL OR ke.valid_until > now())
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
      AND (ke.valid_until IS NULL OR ke.valid_until > now())
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
$function$;