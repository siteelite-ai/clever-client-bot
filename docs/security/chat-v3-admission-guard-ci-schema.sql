-- Disposable PostgreSQL 16 fixture for the admission guard CI job only.
-- Keep the chat_request_logs columns and message_id uniqueness used by the
-- RPC aligned with the real migrations, without applying unrelated schema.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE public.chat_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id text,
  session_id text,
  user_query text,
  pipeline text,
  branch text,
  error text
);

CREATE UNIQUE INDEX idx_chat_request_logs_message_id
  ON public.chat_request_logs (message_id)
  WHERE message_id IS NOT NULL;

ALTER TABLE public.chat_request_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.chat_request_logs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_request_logs
  TO service_role;
