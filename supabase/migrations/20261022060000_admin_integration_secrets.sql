-- Additive private store for integration credentials. The running bot keeps
-- using app_settings until a separately verified server-side cutover.
BEGIN;

CREATE TABLE public.integration_secrets (
  key text PRIMARY KEY,
  secret_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_secrets_key_check CHECK (
    key IN ('openrouter_api_key', 'volt220_api_token', 'google_api_key')
  ),
  CONSTRAINT integration_secrets_value_check CHECK (
    char_length(secret_value) BETWEEN 8 AND 8192 AND
    secret_value = btrim(secret_value)
  )
);

ALTER TABLE public.integration_secrets ENABLE ROW LEVEL SECURITY;

-- No client policies, including for administrators. Only server code with
-- the service role may read or update credentials; never expose this table
-- to PostgREST's anon/authenticated roles.
REVOKE ALL PRIVILEGES ON TABLE public.integration_secrets
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_secrets
  TO service_role;

COMMENT ON TABLE public.integration_secrets IS
  'Service-role-only integration credentials; never select from a browser.';

-- A durable, atomic cost guard for the admin's explicit one-model ping.
-- In-memory Edge cooldowns do not survive concurrent isolates.
CREATE TABLE public.integration_secret_ping_cooldowns (
  user_id uuid PRIMARY KEY,
  next_allowed_at timestamptz NOT NULL
);

ALTER TABLE public.integration_secret_ping_cooldowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.integration_secret_ping_cooldowns
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.integration_secret_ping_cooldowns
  TO service_role;

CREATE FUNCTION public.claim_admin_integration_secret_ping(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.integration_secret_ping_cooldowns AS cooldown
    (user_id, next_allowed_at)
  VALUES (p_user_id, statement_timestamp() + interval '30 seconds')
  ON CONFLICT (user_id) DO UPDATE
    SET next_allowed_at = excluded.next_allowed_at
    WHERE cooldown.next_allowed_at <= statement_timestamp();

  RETURN FOUND;
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.claim_admin_integration_secret_ping(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_admin_integration_secret_ping(uuid)
  TO service_role;

COMMIT;
