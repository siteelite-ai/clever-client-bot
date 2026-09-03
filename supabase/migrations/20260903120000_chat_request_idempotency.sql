-- One browser message may reconnect through another transport, but it must
-- never execute the catalog/LLM pipeline twice. The service-role-only log
-- table doubles as a short-lived replay store (existing TTL: 24 hours).
ALTER TABLE public.chat_request_logs
  ADD COLUMN IF NOT EXISTS message_id text,
  ADD COLUMN IF NOT EXISTS response_events jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.chat_request_logs
  DROP CONSTRAINT IF EXISTS chat_request_logs_response_events_array;

ALTER TABLE public.chat_request_logs
  ADD CONSTRAINT chat_request_logs_response_events_array
  CHECK (jsonb_typeof(response_events) = 'array');

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_request_logs_message_id
  ON public.chat_request_logs (message_id)
  WHERE message_id IS NOT NULL;
