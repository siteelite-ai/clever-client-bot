-- Production has this table, but it was created outside the checked-in
-- migrations. A fresh isolated project needs the same search schema. Leave an
-- existing production table untouched: this block only runs when it is absent.
DO $create_knowledge_chunks$
BEGIN
  IF to_regclass('public.knowledge_chunks') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE public.knowledge_chunks (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    knowledge_entry_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    embedding vector(768),
    search_vector tsvector,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id),
    CONSTRAINT knowledge_chunks_knowledge_entry_id_fkey
      FOREIGN KEY (knowledge_entry_id) REFERENCES public.knowledge_entries(id)
      ON DELETE CASCADE,
    CONSTRAINT knowledge_chunks_knowledge_entry_id_chunk_index_key
      UNIQUE (knowledge_entry_id, chunk_index)
  );

  CREATE INDEX idx_knowledge_chunks_entry_id
    ON public.knowledge_chunks USING btree (knowledge_entry_id);
  CREATE INDEX idx_knowledge_chunks_search_vector
    ON public.knowledge_chunks USING gin (search_vector);
  CREATE INDEX idx_knowledge_chunks_embedding_hnsw
    ON public.knowledge_chunks USING hnsw (embedding vector_cosine_ops);

  CREATE TRIGGER knowledge_chunks_search_vector_trigger
    BEFORE INSERT OR UPDATE ON public.knowledge_chunks
    FOR EACH ROW EXECUTE FUNCTION public.knowledge_search_trigger();
  CREATE TRIGGER update_knowledge_chunks_updated_at
    BEFORE UPDATE ON public.knowledge_chunks
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

  ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "Editors and admins can read knowledge chunks"
    ON public.knowledge_chunks FOR SELECT TO authenticated
    USING (
      public.has_role(auth.uid(), 'editor'::public.app_role)
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    );
  CREATE POLICY "Editors can insert knowledge chunks"
    ON public.knowledge_chunks FOR INSERT TO authenticated
    WITH CHECK (
      public.has_role(auth.uid(), 'editor'::public.app_role)
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    );
  CREATE POLICY "Editors can update knowledge chunks"
    ON public.knowledge_chunks FOR UPDATE TO authenticated
    USING (
      public.has_role(auth.uid(), 'editor'::public.app_role)
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    )
    WITH CHECK (
      public.has_role(auth.uid(), 'editor'::public.app_role)
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    );
  CREATE POLICY "Editors can delete knowledge chunks"
    ON public.knowledge_chunks FOR DELETE TO authenticated
    USING (
      public.has_role(auth.uid(), 'editor'::public.app_role)
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    );

  -- Supabase's default table grants can expose a new public table to anon.
  -- Production grants TRUNCATE to authenticated; deliberately do not copy it,
  -- because TRUNCATE bypasses row-level security.
  REVOKE ALL PRIVILEGES ON TABLE public.knowledge_chunks
    FROM PUBLIC, anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_chunks
    TO authenticated;
  GRANT ALL PRIVILEGES ON TABLE public.knowledge_chunks TO service_role;
END;
$create_knowledge_chunks$;
