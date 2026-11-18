-- Disposable PostgreSQL 16 CI only. This is NOT a Supabase schema clone.
-- The real historical migrations for chat_request_logs and its dependants
-- follow this file. These minimal identities allow their old RLS policies to
-- parse without running unrelated historical migrations or loading secrets.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
CREATE TYPE public.app_role AS ENUM ('admin', 'editor', 'viewer');
CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS 'SELECT false';
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
