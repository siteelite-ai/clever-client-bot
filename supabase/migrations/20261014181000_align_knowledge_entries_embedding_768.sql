-- Production uses vector(768) for both knowledge tables, but the original
-- knowledge_entries migration declared vector(1536). Align only a fresh,
-- empty database; never truncate or convert existing embeddings implicitly.
DO $align_knowledge_entries_embedding$
DECLARE
  embedding_type text;
  embedding_index_oid oid;
  embedding_index record;
BEGIN
  IF to_regclass('public.knowledge_entries') IS NULL THEN
    RAISE EXCEPTION 'knowledge_entries is missing; apply earlier migrations first';
  END IF;

  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod)
    INTO embedding_type
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.knowledge_entries'::regclass
    AND a.attname = 'embedding'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF embedding_type = 'vector(768)' THEN
    RETURN;
  END IF;
  IF embedding_type IS DISTINCT FROM 'vector(1536)' THEN
    RAISE EXCEPTION 'unsupported knowledge_entries.embedding type: %',
      coalesce(embedding_type, '<missing>');
  END IF;
  IF EXISTS (SELECT 1 FROM public.knowledge_entries) THEN
    RAISE EXCEPTION 'refusing to change knowledge_entries.embedding from vector(1536): table is not empty';
  END IF;

  -- The initial migration creates a one-key, non-partial ivfflat/cosine index
  -- with lists=100. Check the catalog structure, not a permissive text match,
  -- before replacing it. An unfamiliar index must be reviewed manually.
  embedding_index_oid := to_regclass('public.knowledge_entries_embedding_idx');
  IF embedding_index_oid IS NOT NULL THEN
    SELECT
      i.indrelid AS table_oid,
      i.indnatts AS attribute_count,
      i.indnkeyatts AS key_count,
      i.indisunique AS is_unique,
      i.indisvalid AS is_valid,
      i.indpred IS NULL AS has_no_predicate,
      i.indexprs IS NULL AS has_no_expression,
      a.attname AS key_column,
      am.amname AS access_method,
      opc.opcname AS operator_class,
      idx.reloptions AS options
    INTO embedding_index
    FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_class AS idx ON idx.oid = i.indexrelid
    JOIN pg_catalog.pg_am AS am ON am.oid = idx.relam
    JOIN pg_catalog.pg_opclass AS opc ON opc.oid = i.indclass[0]
    LEFT JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indexrelid = embedding_index_oid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'knowledge_entries_embedding_idx is not an index';
    END IF;
    IF embedding_index.table_oid IS DISTINCT FROM 'public.knowledge_entries'::regclass
      OR embedding_index.attribute_count IS DISTINCT FROM 1
      OR embedding_index.key_count IS DISTINCT FROM 1
      OR embedding_index.is_unique IS DISTINCT FROM false
      OR embedding_index.is_valid IS DISTINCT FROM true
      OR embedding_index.has_no_predicate IS DISTINCT FROM true
      OR embedding_index.has_no_expression IS DISTINCT FROM true
      OR embedding_index.key_column IS DISTINCT FROM 'embedding'
      OR embedding_index.access_method IS DISTINCT FROM 'ivfflat'
      OR embedding_index.operator_class IS DISTINCT FROM 'vector_cosine_ops'
      OR embedding_index.options IS DISTINCT FROM ARRAY['lists=100']::text[] THEN
      RAISE EXCEPTION 'unexpected knowledge_entries_embedding_idx structure; review before changing embedding type';
    END IF;
    DROP INDEX public.knowledge_entries_embedding_idx;
  END IF;

  ALTER TABLE public.knowledge_entries
    ALTER COLUMN embedding TYPE vector(768)
    USING embedding::vector(768);

  CREATE INDEX knowledge_entries_embedding_idx
    ON public.knowledge_entries USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
END;
$align_knowledge_entries_embedding$;
