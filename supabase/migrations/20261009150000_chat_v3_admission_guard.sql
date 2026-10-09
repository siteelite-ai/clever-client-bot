-- Optional global cost guard for the public v3 Edge Function. This migration
-- only creates new objects; it does not change existing chat logs or policies.
-- The Edge Function must first win the existing unique message_id log claim,
-- then call this RPC before any paid catalog/LLM work. Existing/replayed turns
-- never call this RPC and therefore never consume an admission slot.

CREATE TABLE public.chat_v3_admission_buckets (
  mode text PRIMARY KEY CHECK (mode IN ('observe', 'enforce')),
  window_started_at timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  admitted_count integer NOT NULL DEFAULT 0 CHECK (admitted_count >= 0)
);

INSERT INTO public.chat_v3_admission_buckets (mode)
VALUES ('observe'), ('enforce');

CREATE TABLE public.chat_v3_admission_decisions (
  log_id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('observe', 'enforce')),
  allowed boolean NOT NULL,
  reason text NOT NULL,
  would_reject boolean NOT NULL,
  limit_reason text,
  window_count_before integer NOT NULL CHECK (window_count_before >= 0),
  in_flight_before integer NOT NULL CHECK (in_flight_before >= 0),
  retry_after_seconds integer CHECK (retry_after_seconds IS NULL OR retry_after_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  reservation_expires_at timestamptz,
  released_at timestamptz,
  CHECK (reservation_expires_at IS NOT NULL OR NOT allowed)
);

CREATE INDEX chat_v3_admission_decisions_expires_idx
  ON public.chat_v3_admission_decisions (expires_at);
CREATE INDEX chat_v3_admission_decisions_active_idx
  ON public.chat_v3_admission_decisions (mode, reservation_expires_at)
  WHERE allowed AND released_at IS NULL;

ALTER TABLE public.chat_v3_admission_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_v3_admission_decisions ENABLE ROW LEVEL SECURITY;

-- No client policies. The RPC is SECURITY INVOKER so it cannot bypass table
-- privileges or RLS if its EXECUTE grant is accidentally widened later.
REVOKE ALL PRIVILEGES ON TABLE public.chat_v3_admission_buckets
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.chat_v3_admission_decisions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.chat_v3_admission_buckets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_v3_admission_decisions
  TO service_role;

CREATE FUNCTION public.check_chat_v3_admission(
  p_log_id uuid,
  p_mode text DEFAULT 'off',
  p_limit_per_minute integer DEFAULT NULL,
  p_limit_in_flight integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_log record;
  v_existing public.chat_v3_admission_decisions%ROWTYPE;
  v_window_started_at timestamptz;
  v_window_count integer;
  v_in_flight integer;
  v_now timestamptz;
  v_rate_hit boolean;
  v_flight_hit boolean;
  v_would_reject boolean;
  v_allowed boolean;
  v_reason text;
  v_limit_reason text;
  v_retry_after integer;
BEGIN
  IF p_log_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_claim',
      'mode', p_mode, 'replayed', false, 'would_reject', false);
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'observe', 'enforce') THEN
    RAISE EXCEPTION 'invalid chat v3 admission mode: %', p_mode
      USING ERRCODE = '22023';
  END IF;
  IF p_mode <> 'off' AND (
    (p_limit_per_minute IS NOT NULL AND p_limit_per_minute < 1) OR
    (p_limit_in_flight IS NOT NULL AND p_limit_in_flight < 1)
  ) THEN
    RAISE EXCEPTION 'chat v3 admission limits must be positive'
      USING ERRCODE = '22023';
  END IF;

  -- Return a committed prior decision before checking the log's terminal
  -- state. This makes a retry after an ambiguous HTTP response idempotent.
  SELECT * INTO v_existing
  FROM public.chat_v3_admission_decisions
  WHERE log_id = p_log_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', v_existing.allowed,
      'reason', v_existing.reason,
      'mode', v_existing.mode,
      'replayed', true,
      'would_reject', v_existing.would_reject,
      'limit_reason', v_existing.limit_reason,
      'window_count_before', v_existing.window_count_before,
      'in_flight_before', v_existing.in_flight_before,
      'retry_after_seconds', v_existing.retry_after_seconds
    );
  END IF;

  -- Serialize repeated calls for one claimed log, even across mode changes.
  -- This is a row lock only: no existing log data is modified by this RPC.
  SELECT message_id, pipeline, error INTO v_log
  FROM public.chat_request_logs
  WHERE id = p_log_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false,
      'reason', 'claim_not_in_progress', 'mode', p_mode,
      'replayed', false, 'would_reject', false);
  END IF;
  IF v_log.message_id IS NULL OR v_log.pipeline IS DISTINCT FROM 'v3'
    OR v_log.error IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('allowed', false,
      'reason', 'claim_not_in_progress', 'mode', p_mode,
      'replayed', false, 'would_reject', false);
  END IF;

  -- The same log could be retried while waiting on its row lock.
  SELECT * INTO v_existing
  FROM public.chat_v3_admission_decisions
  WHERE log_id = p_log_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', v_existing.allowed,
      'reason', v_existing.reason,
      'mode', v_existing.mode,
      'replayed', true,
      'would_reject', v_existing.would_reject,
      'limit_reason', v_existing.limit_reason,
      'window_count_before', v_existing.window_count_before,
      'in_flight_before', v_existing.in_flight_before,
      'retry_after_seconds', v_existing.retry_after_seconds
    );
  END IF;

  IF p_mode = 'off' THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'off',
      'mode', 'off', 'replayed', false, 'would_reject', false);
  END IF;

  -- One row lock per mode serializes the read/check/increment/reserve path.
  -- Observe and enforce have separate counters, so enabling enforcement does
  -- not inherit the observation window's traffic as a surprise denial.
  SELECT window_started_at, admitted_count
    INTO v_window_started_at, v_window_count
  FROM public.chat_v3_admission_buckets
  WHERE mode = p_mode
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat v3 admission bucket missing for mode %', p_mode
      USING ERRCODE = '55000';
  END IF;
  v_now := clock_timestamp();
  IF v_now >= v_window_started_at + interval '1 minute' THEN
    v_window_started_at := date_trunc('minute', v_now);
    v_window_count := 0;
  END IF;

  SELECT count(*)::integer INTO v_in_flight
  FROM public.chat_v3_admission_decisions
  WHERE mode = p_mode
    AND allowed
    AND released_at IS NULL
    AND reservation_expires_at > v_now;

  v_rate_hit := p_limit_per_minute IS NOT NULL
    AND v_window_count >= p_limit_per_minute;
  v_flight_hit := p_limit_in_flight IS NOT NULL
    AND v_in_flight >= p_limit_in_flight;
  v_would_reject := v_rate_hit OR v_flight_hit;
  v_limit_reason := CASE
    WHEN v_rate_hit AND v_flight_hit THEN 'minute_and_in_flight_limit'
    WHEN v_rate_hit THEN 'minute_limit'
    WHEN v_flight_hit THEN 'in_flight_limit'
    ELSE NULL
  END;
  v_allowed := p_mode = 'observe' OR (
    p_limit_per_minute IS NOT NULL AND p_limit_in_flight IS NOT NULL
    AND NOT v_would_reject
  );
  v_reason := CASE
    WHEN p_mode = 'enforce' AND
      (p_limit_per_minute IS NULL OR p_limit_in_flight IS NULL)
      THEN 'configuration_missing'
    WHEN p_mode = 'enforce' AND v_would_reject THEN 'limit_exceeded'
    WHEN p_mode = 'observe' AND
      (p_limit_per_minute IS NULL OR p_limit_in_flight IS NULL)
      THEN 'observe_unconfigured'
    WHEN p_mode = 'observe' AND v_would_reject THEN 'observed_limit'
    ELSE 'admitted'
  END;
  v_retry_after := CASE
    WHEN v_rate_hit THEN greatest(1, ceil(extract(epoch FROM
      v_window_started_at + interval '1 minute' - v_now))::integer)
    WHEN v_flight_hit THEN 5
    WHEN v_reason = 'configuration_missing' THEN 60
    ELSE NULL
  END;

  IF v_allowed THEN
    UPDATE public.chat_v3_admission_buckets
    SET window_started_at = v_window_started_at,
        admitted_count = v_window_count + 1
    WHERE mode = p_mode;
  ELSIF v_window_count = 0 THEN
    -- Persist a rolled window even if the first request is denied because of
    -- missing configuration or a still-active reservation.
    UPDATE public.chat_v3_admission_buckets
    SET window_started_at = v_window_started_at,
        admitted_count = 0
    WHERE mode = p_mode;
  END IF;

  INSERT INTO public.chat_v3_admission_decisions (
    log_id, mode, allowed, reason, would_reject, limit_reason,
    window_count_before, in_flight_before, retry_after_seconds, created_at,
    expires_at, reservation_expires_at
  ) VALUES (
    p_log_id, p_mode, v_allowed, v_reason, v_would_reject,
    v_limit_reason, v_window_count, v_in_flight, v_retry_after, v_now,
    v_now + interval '24 hours',
    CASE WHEN v_allowed THEN v_now + interval '3 minutes' ELSE NULL END
  );

  -- The decision ledger is operational telemetry, not customer content.
  -- Purge only its own expired rows; existing chat logs are never deleted here.
  IF random() < 0.01 THEN
    DELETE FROM public.chat_v3_admission_decisions
    WHERE log_id IN (
      SELECT log_id FROM public.chat_v3_admission_decisions
      WHERE expires_at <= v_now
      ORDER BY expires_at
      LIMIT 1000
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_allowed,
    'reason', v_reason,
    'mode', p_mode,
    'replayed', false,
    'would_reject', v_would_reject,
    'limit_reason', v_limit_reason,
    'window_count_before', v_window_count,
    'in_flight_before', v_in_flight,
    'retry_after_seconds', v_retry_after
  );
END;
$function$;

CREATE FUNCTION public.release_chat_v3_admission(p_log_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_log_id IS NULL THEN RETURN false; END IF;
  UPDATE public.chat_v3_admission_decisions
  SET released_at = clock_timestamp()
  WHERE log_id = p_log_id AND allowed AND released_at IS NULL;
  RETURN FOUND;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_chat_v3_admission(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_chat_v3_admission(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_chat_v3_admission(uuid, text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_chat_v3_admission(uuid)
  TO service_role;
