-- Disposable PostgreSQL 16 CI only. Checks compatibility with the *actual*
-- chat log, idempotency and admission migrations replayed by the workflow.
BEGIN;

DO $test$
DECLARE
  v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY[
    'created_at', 'expires_at', 'session_id', 'client_ip', 'user_agent',
    'user_query', 'classifier', 'branch', 'steps', 'final_products_count',
    'final_response', 'total_ms', 'message_id', 'response_events',
    'chat_v3_topic_id'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.chat_request_logs'::regclass
        AND attname = v_col AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'real chat log column missing: %', v_col;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.chat_request_logs'::regclass
      AND attname = 'chat_v3_topic_id' AND NOT attnotnull
      AND atthasdef = false
  ) THEN
    RAISE EXCEPTION 'new topic binding is not nullable/default-off';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.chat_request_logs'::regclass
      AND c.relname = 'idx_chat_request_logs_message_id'
      AND i.indisunique AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'existing idempotency index was lost';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.chat_request_logs'::regclass
      AND tgname = 'trg_gc_chat_request_logs'
      AND tgfoid = 'public.gc_chat_request_logs()'::regprocedure
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'existing lazy GC trigger was lost';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.chat_request_logs'::regclass AND relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'chat_request_logs'
      AND policyname = 'Admins read chat logs'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'chat_request_logs'
      AND policyname = 'Editors read chat logs'
  ) THEN
    RAISE EXCEPTION 'existing chat log RLS/policies were lost';
  END IF;
  IF to_regprocedure('public.check_chat_v3_admission(uuid,text,integer,integer)')
      IS NULL OR
    to_regprocedure('public.reserve_public_api_admission(uuid,text,text,text[],integer,integer,integer,integer)')
      IS NULL THEN
    RAISE EXCEPTION 'existing admission RPC was lost';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_request_logs
    WHERE message_id = 'pre-migration-v3-log'
      AND pipeline = 'v3' AND error = 'in_progress'
      AND chat_v3_topic_id IS NULL
  ) THEN
    RAISE EXCEPTION 'existing claimed v3 row changed';
  END IF;
END;
$test$;

SET LOCAL ROLE service_role;
INSERT INTO public.chat_request_logs
  (message_id, pipeline, error, session_id, steps)
VALUES ('legacy-after-conversation-migration', 'v3', 'in_progress',
  'disposable-ci-session', '[]'::jsonb);
UPDATE public.chat_request_logs
SET error = NULL, response_events = '[{"type":"done"}]'::jsonb
WHERE message_id = 'legacy-after-conversation-migration';
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_request_logs
    WHERE message_id = 'legacy-after-conversation-migration'
      AND error IS NULL AND chat_v3_topic_id IS NULL
      AND response_events = '[{"type":"done"}]'::jsonb
  ) THEN
    RAISE EXCEPTION 'legacy insert/finalize changed by conversation migration';
  END IF;
END;
$test$;
ROLLBACK;
