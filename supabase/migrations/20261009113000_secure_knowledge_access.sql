-- The widget queries knowledge through service_role Edge Functions. The
-- browser must not read the full knowledge corpus or call search RPCs directly.
-- Keep editor/admin access for the authenticated administration UI.

ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Knowledge entries are publicly readable"
  ON public.knowledge_entries;

DROP POLICY IF EXISTS "Editors and admins can read knowledge entries"
  ON public.knowledge_entries;
CREATE POLICY "Editors and admins can read knowledge entries"
  ON public.knowledge_entries FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'editor'::public.app_role)
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- RLS is the row-level guard; revoke the redundant anonymous table grants as
-- a second boundary. Authenticated admin/editor grants and service_role remain.
REVOKE ALL PRIVILEGES ON TABLE public.knowledge_entries FROM anon, PUBLIC;

-- The existing production knowledge_chunks table was provisioned outside this
-- repository's migrations. Keep a clean replay safe if it is not present, and
-- apply the same restriction whenever it is present. Any future migration that
-- creates this table must also apply this access policy at creation time.
DO $knowledge_chunks$
BEGIN
  IF to_regclass('public.knowledge_chunks') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "Knowledge chunks are publicly readable" ON public.knowledge_chunks';
    EXECUTE 'DROP POLICY IF EXISTS "Editors and admins can read knowledge chunks" ON public.knowledge_chunks';
    EXECUTE 'CREATE POLICY "Editors and admins can read knowledge chunks" ON public.knowledge_chunks FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''editor''::public.app_role) OR public.has_role(auth.uid(), ''admin''::public.app_role))';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.knowledge_chunks FROM anon, PUBLIC';
  END IF;
END;
$knowledge_chunks$;

-- Search functions are SECURITY INVOKER today, but explicit grants avoid
-- accidental public exposure if a function implementation changes later.
DO $$
DECLARE
  routine record;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'search_knowledge',
        'search_knowledge_fulltext',
        'search_knowledge_hybrid',
        'search_knowledge_chunks_hybrid'
      )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      routine.signature
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      routine.signature
    );
  END LOOP;
END;
$$;
