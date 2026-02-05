-- Add full-text search support for knowledge entries
ALTER TABLE public.knowledge_entries 
ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Create function to generate search vector
CREATE OR REPLACE FUNCTION public.knowledge_search_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := 
    setweight(to_tsvector('russian', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create trigger to auto-update search vector
DROP TRIGGER IF EXISTS knowledge_search_update ON public.knowledge_entries;
CREATE TRIGGER knowledge_search_update
BEFORE INSERT OR UPDATE ON public.knowledge_entries
FOR EACH ROW
EXECUTE FUNCTION public.knowledge_search_trigger();

-- Update existing rows
UPDATE public.knowledge_entries SET 
  search_vector = setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('russian', coalesce(content, '')), 'B');

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS knowledge_entries_search_idx 
ON public.knowledge_entries USING GIN(search_vector);

-- Create full-text search function
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
  rank float
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