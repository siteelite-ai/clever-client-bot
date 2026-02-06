-- Fix the return type for rank column
DROP FUNCTION IF EXISTS public.search_knowledge_fulltext(text, int);

CREATE OR REPLACE FUNCTION public.search_knowledge_fulltext(
  search_query text,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  type TEXT,
  source_url TEXT,
  rank real
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  tsquery_ru tsquery;
BEGIN
  -- Convert search query to tsquery with Russian stemming
  tsquery_ru := plainto_tsquery('russian', search_query);
  
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
  ORDER BY ts_rank(ke.search_vector, tsquery_ru) DESC
  LIMIT match_count;
END;
$$;