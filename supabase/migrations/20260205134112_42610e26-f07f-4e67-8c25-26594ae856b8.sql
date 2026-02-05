-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Create knowledge entries table
CREATE TABLE public.knowledge_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('url', 'text', 'pdf')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  embedding vector(1536),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;

-- Create public read policy (entries visible to all for bot usage)
CREATE POLICY "Knowledge entries are publicly readable"
ON public.knowledge_entries
FOR SELECT
USING (true);

-- Create admin policies (any authenticated user can manage for now)
CREATE POLICY "Authenticated users can insert knowledge entries"
ON public.knowledge_entries
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Authenticated users can update knowledge entries"
ON public.knowledge_entries
FOR UPDATE
USING (true);

CREATE POLICY "Authenticated users can delete knowledge entries"
ON public.knowledge_entries
FOR DELETE
USING (true);

-- Create trigger for automatic timestamp updates
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_knowledge_entries_updated_at
BEFORE UPDATE ON public.knowledge_entries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for vector similarity search
CREATE INDEX knowledge_entries_embedding_idx ON public.knowledge_entries
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create function for semantic search
CREATE OR REPLACE FUNCTION public.search_knowledge(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  type TEXT,
  source_url TEXT,
  similarity float
)
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ke.id,
    ke.title,
    ke.content,
    ke.type,
    ke.source_url,
    1 - (ke.embedding <=> query_embedding) as similarity
  FROM public.knowledge_entries ke
  WHERE ke.embedding IS NOT NULL
    AND 1 - (ke.embedding <=> query_embedding) > match_threshold
  ORDER BY ke.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;