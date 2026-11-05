-- Disposable PostgreSQL 16 fixture only. Never apply to production.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE public.chat_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id text UNIQUE,
  pipeline text,
  error text,
  response_events jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE public.chat_request_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.chat_request_logs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_request_logs
  TO service_role;

-- Proves that the additive nullable column leaves an already-existing claim
-- unchanged; it must not implicitly opt into the new state path.
INSERT INTO public.chat_request_logs (message_id, pipeline, error)
VALUES ('pre-migration-v3-log', 'v3', 'in_progress');
