-- One atomic, server-owned cost reservation across every public chat/catalog
-- route. Additive and inert until the Edge functions opt in. Unlike the v3
-- log-specific guard, this ledger deliberately contains no user text, IP, or
-- session identifier. Keep the older guard untouched during migration.
BEGIN;

CREATE TABLE public.public_api_admission_buckets (
  mode text NOT NULL CHECK (mode IN ('observe', 'enforce')),
  lane text NOT NULL CHECK (lane IN ('catalog', 'model')),
  window_started_at timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  admitted_count integer NOT NULL DEFAULT 0 CHECK (admitted_count >= 0),
  PRIMARY KEY (mode, lane)
);

INSERT INTO public.public_api_admission_buckets (mode, lane)
VALUES ('observe', 'catalog'), ('observe', 'model'),
       ('enforce', 'catalog'), ('enforce', 'model');

CREATE TABLE public.public_api_admission_reservations (
  reservation_id uuid PRIMARY KEY,
  route text NOT NULL CHECK (route IN (
    'chat-consultant', 'chat-consultant-v2', 'chat-consultant-v3',
    'search-products'
  )),
  mode text NOT NULL CHECK (mode IN ('observe', 'enforce')),
  lanes text[] NOT NULL CHECK (cardinality(lanes) BETWEEN 1 AND 2),
  allowed boolean NOT NULL,
  reason text NOT NULL,
  would_reject boolean NOT NULL,
  limit_reason text,
  retry_after_seconds integer CHECK (
    retry_after_seconds IS NULL OR retry_after_seconds > 0
  ),
  lane_decisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reservation_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (reservation_expires_at IS NOT NULL OR NOT allowed)
);

CREATE INDEX public_api_admission_active_idx
  ON public.public_api_admission_reservations (mode, reservation_expires_at)
  WHERE allowed AND released_at IS NULL;
CREATE INDEX public_api_admission_expiry_idx
  ON public.public_api_admission_reservations (expires_at);

-- A release may reach PostgreSQL before the corresponding timed-out reserve
-- RPC. Retain a bounded, UUID-only cancellation so that a late reserve cannot
-- charge a ghost slot after the caller has already terminated.
CREATE TABLE public.public_api_admission_cancellations (
  reservation_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX public_api_admission_cancellation_expiry_idx
  ON public.public_api_admission_cancellations (expires_at);

ALTER TABLE public.public_api_admission_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_api_admission_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_api_admission_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.public_api_admission_buckets
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.public_api_admission_reservations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.public_api_admission_cancellations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.public_api_admission_buckets
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.public_api_admission_reservations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.public_api_admission_cancellations TO service_role;

CREATE FUNCTION public.reserve_public_api_admission(
  p_reservation_id uuid,
  p_route text,
  p_mode text,
  p_lanes text[],
  p_model_limit_per_minute integer DEFAULT NULL,
  p_model_limit_in_flight integer DEFAULT NULL,
  p_catalog_limit_per_minute integer DEFAULT NULL,
  p_catalog_limit_in_flight integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_existing public.public_api_admission_reservations%ROWTYPE;
  v_lanes text[];
  v_lane text;
  v_bucket record;
  v_now timestamptz;
  v_window_started_at timestamptz;
  v_window_count integer;
  v_in_flight integer;
  v_per_minute integer;
  v_max_in_flight integer;
  v_rate_hit boolean;
  v_flight_hit boolean;
  v_config_missing boolean := false;
  v_would_reject boolean := false;
  v_allowed boolean;
  v_reason text;
  v_limit_reason text := NULL;
  v_retry_after integer := NULL;
  v_lane_retry integer;
  v_lane_decisions jsonb := '{}'::jsonb;
BEGIN
  IF p_reservation_id IS NULL OR p_route NOT IN (
    'chat-consultant', 'chat-consultant-v2', 'chat-consultant-v3',
    'search-products'
  ) OR p_route IS NULL THEN
    RAISE EXCEPTION 'invalid public API reservation identity or route'
      USING ERRCODE = '22023';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('observe', 'enforce') THEN
    RAISE EXCEPTION 'invalid public API admission mode'
      USING ERRCODE = '22023';
  END IF;
  IF p_lanes IS NULL OR cardinality(p_lanes) NOT BETWEEN 1 AND 2 OR
    EXISTS (
      SELECT 1 FROM unnest(p_lanes) AS lane(value)
      WHERE value IS NULL OR value NOT IN ('catalog', 'model')
    ) THEN
    RAISE EXCEPTION 'invalid public API admission lanes'
      USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO v_lanes
  FROM unnest(p_lanes) AS lane(value);
  IF p_route = 'search-products' AND v_lanes <> ARRAY['catalog']::text[] THEN
    RAISE EXCEPTION 'search-products cannot reserve the model lane'
      USING ERRCODE = '22023';
  END IF;
  IF p_route <> 'search-products' AND
    v_lanes <> ARRAY['catalog', 'model']::text[] THEN
    RAISE EXCEPTION 'chat routes must reserve both cost lanes'
      USING ERRCODE = '22023';
  END IF;
  IF (p_model_limit_per_minute IS NOT NULL AND
      p_model_limit_per_minute < 1) OR
     (p_model_limit_in_flight IS NOT NULL AND
      p_model_limit_in_flight < 1) OR
     (p_catalog_limit_per_minute IS NOT NULL AND
      p_catalog_limit_per_minute < 1) OR
     (p_catalog_limit_in_flight IS NOT NULL AND
      p_catalog_limit_in_flight < 1) THEN
    RAISE EXCEPTION 'public API admission limits must be positive'
      USING ERRCODE = '22023';
  END IF;

  -- The server generates a fresh UUID. This advisory transaction lock makes
  -- same-ID retries serialize even when their (malformed) lanes differ. It is
  -- always acquired before the sorted bucket row locks below.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_reservation_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.public_api_admission_cancellations
    WHERE reservation_id = p_reservation_id
      AND expires_at > clock_timestamp()
  ) THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'cancelled', 'mode', p_mode,
      'replayed', true, 'would_reject', false,
      'retry_after_seconds', NULL
    );
  END IF;
  SELECT * INTO v_existing
  FROM public.public_api_admission_reservations
  WHERE reservation_id = p_reservation_id;
  IF FOUND THEN
    IF v_existing.route <> p_route OR v_existing.mode <> p_mode OR
      v_existing.lanes <> v_lanes THEN
      RETURN jsonb_build_object(
        'allowed', false, 'reason', 'reservation_conflict',
        'mode', p_mode, 'replayed', true, 'would_reject', false,
        'retry_after_seconds', NULL
      );
    END IF;
    RETURN jsonb_build_object(
      'allowed', v_existing.allowed, 'reason', v_existing.reason,
      'mode', v_existing.mode, 'replayed', true,
      'would_reject', v_existing.would_reject,
      'limit_reason', v_existing.limit_reason,
      'retry_after_seconds', v_existing.retry_after_seconds,
      'lane_decisions', v_existing.lane_decisions
    );
  END IF;

  -- Every route locks the same global lane rows in lexical order, so a chat
  -- request and a concurrent catalog request cannot oversubscribe a budget.
  -- Separate observe/enforce rows avoid inheriting observation counters.
  FOREACH v_lane IN ARRAY v_lanes LOOP
    SELECT window_started_at, admitted_count INTO v_bucket
    FROM public.public_api_admission_buckets
    WHERE mode = p_mode AND lane = v_lane
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'public API admission bucket missing'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  v_now := clock_timestamp();
  FOREACH v_lane IN ARRAY v_lanes LOOP
    SELECT window_started_at, admitted_count INTO v_bucket
    FROM public.public_api_admission_buckets
    WHERE mode = p_mode AND lane = v_lane;
    v_window_started_at := v_bucket.window_started_at;
    v_window_count := v_bucket.admitted_count;
    IF v_now >= v_window_started_at + interval '1 minute' THEN
      v_window_started_at := date_trunc('minute', v_now);
      v_window_count := 0;
    END IF;
    SELECT count(*)::integer INTO v_in_flight
    FROM public.public_api_admission_reservations
    WHERE mode = p_mode AND allowed AND released_at IS NULL
      AND reservation_expires_at > v_now AND v_lane = ANY(lanes);
    IF v_lane = 'model' THEN
      v_per_minute := p_model_limit_per_minute;
      v_max_in_flight := p_model_limit_in_flight;
    ELSE
      v_per_minute := p_catalog_limit_per_minute;
      v_max_in_flight := p_catalog_limit_in_flight;
    END IF;
    v_config_missing := v_config_missing OR
      v_per_minute IS NULL OR v_max_in_flight IS NULL;
    v_rate_hit := v_per_minute IS NOT NULL AND
      v_window_count >= v_per_minute;
    v_flight_hit := v_max_in_flight IS NOT NULL AND
      v_in_flight >= v_max_in_flight;
    v_would_reject := v_would_reject OR v_rate_hit OR v_flight_hit;
    IF v_rate_hit OR v_flight_hit THEN
      v_limit_reason := CASE
        WHEN v_rate_hit AND v_flight_hit THEN 'minute_and_in_flight_limit'
        WHEN v_rate_hit THEN 'minute_limit'
        ELSE 'in_flight_limit'
      END;
      v_lane_retry := CASE WHEN v_rate_hit THEN greatest(1,
        ceil(extract(epoch FROM
          v_window_started_at + interval '1 minute' - v_now))::integer)
        ELSE 5 END;
      v_retry_after := greatest(coalesce(v_retry_after, 0), v_lane_retry);
    END IF;
    v_lane_decisions := v_lane_decisions || jsonb_build_object(v_lane,
      jsonb_build_object(
        'window_count_before', v_window_count,
        'in_flight_before', v_in_flight,
        'rate_hit', v_rate_hit, 'in_flight_hit', v_flight_hit
      ));
    -- Persist window rollover only after every lane has been evaluated.
    IF v_window_started_at IS DISTINCT FROM v_bucket.window_started_at THEN
      UPDATE public.public_api_admission_buckets
      SET window_started_at = v_window_started_at, admitted_count = 0
      WHERE mode = p_mode AND lane = v_lane;
    END IF;
  END LOOP;

  v_allowed := p_mode = 'observe' OR
    (NOT v_config_missing AND NOT v_would_reject);
  v_reason := CASE
    WHEN p_mode = 'enforce' AND v_config_missing
      THEN 'configuration_missing'
    WHEN p_mode = 'enforce' AND v_would_reject THEN 'limit_exceeded'
    WHEN p_mode = 'observe' AND v_config_missing
      THEN 'observe_unconfigured'
    WHEN p_mode = 'observe' AND v_would_reject THEN 'observed_limit'
    ELSE 'admitted'
  END;
  IF NOT v_allowed AND v_config_missing THEN v_retry_after := 60; END IF;
  IF v_allowed THEN
    FOREACH v_lane IN ARRAY v_lanes LOOP
      UPDATE public.public_api_admission_buckets
      SET admitted_count = admitted_count + 1
      WHERE mode = p_mode AND lane = v_lane;
    END LOOP;
    -- A hosted Edge worker lives at most 400 seconds even on paid plans:
    -- https://supabase.com/docs/guides/functions/limits
    -- Keep the in-flight lease beyond that horizon: legacy handlers may have
    -- sequential upstream work that a handler-level timeout cannot cancel.
    -- Successful terminal paths still release immediately.
    INSERT INTO public.public_api_admission_reservations (
      reservation_id, route, mode, lanes, allowed, reason, would_reject,
      limit_reason, retry_after_seconds, lane_decisions, created_at,
      reservation_expires_at, expires_at
    ) VALUES (
      p_reservation_id, p_route, p_mode, v_lanes, true, v_reason,
      v_would_reject, v_limit_reason, v_retry_after, v_lane_decisions,
      v_now, v_now + interval '450 seconds', v_now + interval '24 hours'
    );
  END IF;

  -- Do not persist denied UUIDs: public callers can drive an unbounded number
  -- of 429s after a lane is full. The response remains unchanged and a fresh
  -- UUID is generated server-side for each request. Only admitted work needs
  -- replay and terminal release bookkeeping.

  -- Small bounded lazy purge. Never touches customer chat or catalog data.
  IF random() < 0.01 THEN
    DELETE FROM public.public_api_admission_reservations
    WHERE reservation_id IN (
      SELECT reservation_id FROM public.public_api_admission_reservations
      WHERE expires_at <= v_now ORDER BY expires_at LIMIT 1000
    );
    DELETE FROM public.public_api_admission_cancellations
    WHERE reservation_id IN (
      SELECT reservation_id FROM public.public_api_admission_cancellations
      WHERE expires_at <= v_now ORDER BY expires_at LIMIT 1000
    );
  END IF;
  RETURN jsonb_build_object(
    'allowed', v_allowed, 'reason', v_reason, 'mode', p_mode,
    'replayed', false, 'would_reject', v_would_reject,
    'limit_reason', v_limit_reason,
    'retry_after_seconds', v_retry_after,
    'lane_decisions', v_lane_decisions
  );
END;
$function$;

CREATE FUNCTION public.release_public_api_admission(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_allowed boolean;
  v_released_at timestamptz;
  v_now timestamptz;
BEGIN
  IF p_reservation_id IS NULL THEN RETURN false; END IF;
  -- Same lock as reserve: release-after-reserve sees and closes the committed
  -- row; release-before-reserve records a cancellation before it can insert.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_reservation_id::text, 0)
  );
  SELECT allowed, released_at INTO v_allowed, v_released_at
  FROM public.public_api_admission_reservations
  WHERE reservation_id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    v_now := clock_timestamp();
    INSERT INTO public.public_api_admission_cancellations (
      reservation_id, created_at, expires_at
    ) VALUES (
      p_reservation_id, v_now, v_now + interval '24 hours'
    ) ON CONFLICT (reservation_id) DO UPDATE
      SET expires_at = greatest(
        public.public_api_admission_cancellations.expires_at,
        v_now + interval '24 hours'
      );
    IF random() < 0.01 THEN
      DELETE FROM public.public_api_admission_cancellations
      WHERE reservation_id IN (
        SELECT reservation_id FROM public.public_api_admission_cancellations
        WHERE expires_at <= clock_timestamp()
        ORDER BY expires_at LIMIT 1000
      );
    END IF;
    RETURN true;
  END IF;
  IF NOT v_allowed THEN RETURN true; END IF;
  IF v_released_at IS NULL THEN
    UPDATE public.public_api_admission_reservations
    SET released_at = clock_timestamp()
    WHERE reservation_id = p_reservation_id;
  END IF;
  RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_public_api_admission(
  uuid, text, text, text[], integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_public_api_admission(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_public_api_admission(
  uuid, text, text, text[], integer, integer, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_public_api_admission(uuid)
  TO service_role;

COMMIT;
