-- Default-off v3 state, migration 2/3. Keep this ACCESS EXCLUSIVE lock
-- extremely short; if the live log table is busy, retry later rather than
-- blocking chat traffic. No index on the busy table is created in this stage.
BEGIN;
SET LOCAL lock_timeout = '2s';

-- Nullable, additive binding on the existing idempotency claim. A future
-- server integration must resolve the bearer and set this on the *newly
-- inserted* claimed log row, never from browser history, slots or a replayed
-- message_id. Existing production logs stay NULL and the new begin RPC
-- refuses them; no old flow is made dependent on this column.
ALTER TABLE public.chat_request_logs
  ADD COLUMN chat_v3_topic_id uuid;

CREATE FUNCTION public.guard_chat_v3_topic_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.chat_v3_topic_id IS DISTINCT FROM OLD.chat_v3_topic_id THEN
      RAISE EXCEPTION 'chat v3 topic binding is immutable after log insert'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.chat_v3_topic_id IS NOT NULL THEN
    IF NEW.message_id IS NULL OR NEW.pipeline IS DISTINCT FROM 'v3' OR
      NEW.error IS DISTINCT FROM 'in_progress' OR NOT EXISTS (
        SELECT 1 FROM public.chat_v3_conversations c
        WHERE c.id = NEW.chat_v3_topic_id AND c.status = 'active'
          AND c.expires_at > clock_timestamp()
          AND c.idle_expires_at > clock_timestamp()
      ) THEN
      RAISE EXCEPTION 'invalid chat v3 topic binding at claim insert'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- Zero function executions on legacy NULL bindings or ordinary log terminal
-- updates. The AFTER guards see the final row even if a future BEFORE trigger
-- changes its binding, rather than relying on an explicit SET of this column.
CREATE TRIGGER guard_chat_v3_topic_binding_insert
  AFTER INSERT ON public.chat_request_logs
  FOR EACH ROW WHEN (NEW.chat_v3_topic_id IS NOT NULL)
  EXECUTE FUNCTION public.guard_chat_v3_topic_binding();
CREATE TRIGGER guard_chat_v3_topic_binding_update
  AFTER UPDATE ON public.chat_request_logs
  FOR EACH ROW WHEN (OLD.chat_v3_topic_id IS DISTINCT FROM NEW.chat_v3_topic_id)
  EXECUTE FUNCTION public.guard_chat_v3_topic_binding();
REVOKE EXECUTE ON FUNCTION public.guard_chat_v3_topic_binding()
  FROM PUBLIC, anon, authenticated;

COMMIT;
