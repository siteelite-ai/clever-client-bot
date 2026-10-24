-- Per-trusted-subject admission. Additive and inert while the Edge gate is
-- OFF. A subject is an HMAC digest computed at trusted ingress; never persist
-- an address, bearer token, session ID, or untrusted browser identifier here.
-- The single subject bucket is shared by all four public routes and by
-- observe/enforce modes. The existing global cost-lane guard remains separate.
BEGIN;

CREATE TABLE public.public_subject_admission_buckets (
  subject_hash text PRIMARY KEY CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  admitted_count integer NOT NULL DEFAULT 0 CHECK (admitted_count >= 0),
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX public_subject_admission_bucket_expiry_idx
  ON public.public_subject_admission_buckets (last_seen_at);

CREATE TABLE public.public_subject_admission_reservations (
  reservation_id uuid PRIMARY KEY,
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  route text NOT NULL CHECK (route IN (
    'chat-consultant', 'chat-consultant-v2', 'chat-consultant-v3',
    'search-products'
  )),
  mode text NOT NULL CHECK (mode IN ('observe', 'enforce')),
  reason text NOT NULL,
  would_reject boolean NOT NULL,
  limit_reason text,
  retry_after_seconds integer CHECK (
    retry_after_seconds IS NULL OR retry_after_seconds > 0
  ),
  created_at timestamptz NOT NULL,
  reservation_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);
CREATE INDEX public_subject_admission_active_idx
  ON public.public_subject_admission_reservations (
    subject_hash, reservation_expires_at
  ) WHERE released_at IS NULL;
CREATE INDEX public_subject_admission_reservation_expiry_idx
  ON public.public_subject_admission_reservations (expires_at);

-- A terminal release may arrive before the delayed reserve RPC. Record a
-- UUID-only cancellation, so a late reserve cannot consume a ghost slot.
CREATE TABLE public.public_subject_admission_cancellations (
  reservation_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX public_subject_admission_cancellation_expiry_idx
  ON public.public_subject_admission_cancellations (expires_at);

ALTER TABLE public.public_subject_admission_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_subject_admission_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_subject_admission_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.public_subject_admission_buckets
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.public_subject_admission_reservations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.public_subject_admission_cancellations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.public_subject_admission_buckets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.public_subject_admission_reservations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.public_subject_admission_cancellations TO service_role;

-- V3 idempotent turn claims must bind a replay to the same trusted subject
-- when the gate is enabled. Old rows stay NULL and are not retroactively
-- trusted. A NOT VALID check protects new writes without a full-table scan.
ALTER TABLE public.chat_request_logs
  ADD COLUMN IF NOT EXISTS public_subject_hash text;
ALTER TABLE public.chat_request_logs
  ADD CONSTRAINT chat_request_logs_public_subject_hash_shape
  CHECK (public_subject_hash IS NULL OR
    public_subject_hash ~ '^[0-9a-f]{64}$') NOT VALID;

CREATE FUNCTION public.reserve_public_subject_admission(
  p_subject_hash text,
  p_route text,
  p_reservation_id uuid,
  p_mode text,
  p_window_seconds integer,
  p_max_requests integer,
  p_max_inflight integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_existing public.public_subject_admission_reservations%ROWTYPE;
  v_bucket public.public_subject_admission_buckets%ROWTYPE;
  v_now timestamptz;
  v_count integer;
  v_inflight integer;
  v_rate_hit boolean;
  v_flight_hit boolean;
  v_would_reject boolean;
  v_config_missing boolean;
  v_allowed boolean;
  v_reason text;
  v_limit_reason text;
  v_retry_after integer;
BEGIN
  IF p_subject_hash IS NULL OR
    p_subject_hash !~ '^[0-9a-f]{64}$' OR
    p_route IS NULL OR p_route NOT IN (
      'chat-consultant', 'chat-consultant-v2', 'chat-consultant-v3',
      'search-products'
    ) OR p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'invalid public subject reservation identity or route'
      USING ERRCODE = '22023';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('observe', 'enforce') THEN
    RAISE EXCEPTION 'invalid public subject admission mode'
      USING ERRCODE = '22023';
  END IF;
  -- v1 is deliberately a fixed minute window. Reject incompatible callers
  -- rather than let mixed deployments silently reset each other's quota.
  IF p_window_seconds IS DISTINCT FROM 60 OR
    (p_max_requests IS NOT NULL AND
      p_max_requests NOT BETWEEN 1 AND 1000000) OR
    (p_max_inflight IS NOT NULL AND
      p_max_inflight NOT BETWEEN 1 AND 1000000) THEN
    RAISE EXCEPTION 'invalid public subject admission limits'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize same-ID reserve/release before taking the shared subject row.
  -- A hash collision in the advisory key only over-serializes; the UUID
  -- primary key still decides identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_reservation_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.public_subject_admission_cancellations
    WHERE reservation_id = p_reservation_id
      AND expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'reason', 'cancelled', 'mode', p_mode,
      'replayed', true, 'would_reject', false,
      'retry_after_seconds', NULL
    );
  END IF;
  SELECT * INTO v_existing
  FROM public.public_subject_admission_reservations
  WHERE reservation_id = p_reservation_id;
  IF FOUND THEN
    IF v_existing.subject_hash <> p_subject_hash OR
      v_existing.route <> p_route OR v_existing.mode <> p_mode OR
      v_existing.released_at IS NOT NULL OR
      v_existing.reservation_expires_at <= pg_catalog.clock_timestamp()
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false, 'reason', 'reservation_conflict',
        'mode', p_mode, 'replayed', true, 'would_reject', false,
        'retry_after_seconds', NULL
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true, 'reason', v_existing.reason,
      'mode', v_existing.mode, 'replayed', true,
      'would_reject', v_existing.would_reject,
      'limit_reason', v_existing.limit_reason,
      'retry_after_seconds', v_existing.retry_after_seconds
    );
  END IF;

  -- A single row per subject means switching among v1/v2/v3/search-products
  -- or between observe/enforce cannot multiply the budget. Row locking makes
  -- minute and in-flight decisions atomic across concurrent Edge workers.
  v_now := pg_catalog.clock_timestamp();
  INSERT INTO public.public_subject_admission_buckets (
    subject_hash, window_started_at, admitted_count, last_seen_at
  ) VALUES (p_subject_hash, v_now, 0, v_now)
  ON CONFLICT (subject_hash) DO NOTHING;
  SELECT * INTO v_bucket
  FROM public.public_subject_admission_buckets
  WHERE subject_hash = p_subject_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public subject admission bucket missing'
      USING ERRCODE = '55000';
  END IF;
  v_now := pg_catalog.clock_timestamp();
  v_count := v_bucket.admitted_count;
  IF v_now >= v_bucket.window_started_at + interval '60 seconds' THEN
    v_count := 0;
    UPDATE public.public_subject_admission_buckets
    SET window_started_at = v_now, admitted_count = 0,
      last_seen_at = v_now
    WHERE subject_hash = p_subject_hash;
  ELSE
    UPDATE public.public_subject_admission_buckets
    SET last_seen_at = v_now WHERE subject_hash = p_subject_hash;
  END IF;
  SELECT count(*)::integer INTO v_inflight
  FROM public.public_subject_admission_reservations
  WHERE subject_hash = p_subject_hash AND released_at IS NULL
    AND reservation_expires_at > v_now;

  v_config_missing := p_max_requests IS NULL OR p_max_inflight IS NULL;
  v_rate_hit := p_max_requests IS NOT NULL AND
    v_count >= p_max_requests;
  v_flight_hit := p_max_inflight IS NOT NULL AND
    v_inflight >= p_max_inflight;
  v_would_reject := v_rate_hit OR v_flight_hit;
  v_allowed := p_mode = 'observe' OR
    (NOT v_config_missing AND NOT v_would_reject);
  v_reason := CASE
    WHEN p_mode = 'enforce' AND v_config_missing
      THEN 'configuration_missing'
    WHEN p_mode = 'enforce' AND v_would_reject
      THEN 'limit_exceeded'
    WHEN p_mode = 'observe' AND v_config_missing
      THEN 'observe_unconfigured'
    WHEN p_mode = 'observe' AND v_would_reject
      THEN 'observed_limit'
    ELSE 'admitted'
  END;
  v_limit_reason := CASE
    WHEN v_rate_hit AND v_flight_hit THEN 'minute_and_in_flight_limit'
    WHEN v_rate_hit THEN 'minute_limit'
    WHEN v_flight_hit THEN 'in_flight_limit'
    ELSE NULL
  END;
  v_retry_after := CASE
    WHEN p_mode = 'enforce' AND v_config_missing THEN 60
    WHEN v_rate_hit THEN greatest(1,
      ceil(extract(epoch FROM
        v_bucket.window_started_at + interval '60 seconds' - v_now))::integer)
    WHEN v_flight_hit THEN 5
    ELSE NULL
  END;

  IF v_allowed THEN
    UPDATE public.public_subject_admission_buckets
    SET admitted_count = admitted_count + 1
    WHERE subject_hash = p_subject_hash;
    -- Hosted Edge workers have a 400-second lifetime. A 450-second lease
    -- prevents ghost in-flight occupancy if an RPC outlives its caller.
    INSERT INTO public.public_subject_admission_reservations (
      reservation_id, subject_hash, route, mode, reason, would_reject,
      limit_reason, retry_after_seconds, created_at,
      reservation_expires_at, expires_at
    ) VALUES (
      p_reservation_id, p_subject_hash, p_route, p_mode, v_reason,
      v_would_reject, v_limit_reason, v_retry_after, v_now,
      v_now + interval '450 seconds', v_now + interval '24 hours'
    );
  END IF;

  -- Denials do not create per-attempt rows. Bounded lazy cleanup controls
  -- high-cardinality subjects and UUID tombstones without user-data tables.
  IF pg_catalog.random() < 0.01 THEN
    DELETE FROM public.public_subject_admission_reservations
    WHERE reservation_id IN (
      SELECT reservation_id
      FROM public.public_subject_admission_reservations
      WHERE expires_at <= v_now ORDER BY expires_at LIMIT 1000
    );
    DELETE FROM public.public_subject_admission_cancellations
    WHERE reservation_id IN (
      SELECT reservation_id
      FROM public.public_subject_admission_cancellations
      WHERE expires_at <= v_now ORDER BY expires_at LIMIT 1000
    );
    DELETE FROM public.public_subject_admission_buckets
    WHERE subject_hash IN (
      SELECT subject_hash FROM public.public_subject_admission_buckets
      WHERE last_seen_at <= v_now - interval '24 hours'
      ORDER BY last_seen_at LIMIT 1000 FOR UPDATE SKIP LOCKED
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'allowed', v_allowed, 'reason', v_reason, 'mode', p_mode,
    'replayed', false, 'would_reject', v_would_reject,
    'limit_reason', v_limit_reason,
    'retry_after_seconds', v_retry_after
  );
END;
$function$;

CREATE FUNCTION public.release_public_subject_admission(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_released_at timestamptz;
  v_now timestamptz;
BEGIN
  IF p_reservation_id IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_reservation_id::text, 0)
  );
  SELECT released_at INTO v_released_at
  FROM public.public_subject_admission_reservations
  WHERE reservation_id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    v_now := pg_catalog.clock_timestamp();
    INSERT INTO public.public_subject_admission_cancellations (
      reservation_id, created_at, expires_at
    ) VALUES (
      p_reservation_id, v_now, v_now + interval '24 hours'
    ) ON CONFLICT (reservation_id) DO UPDATE
      SET expires_at = greatest(
        public.public_subject_admission_cancellations.expires_at,
        v_now + interval '24 hours'
      );
    RETURN true;
  END IF;
  IF v_released_at IS NULL THEN
    UPDATE public.public_subject_admission_reservations
    SET released_at = pg_catalog.clock_timestamp()
    WHERE reservation_id = p_reservation_id;
  END IF;
  RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_public_subject_admission(
  text, text, uuid, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_public_subject_admission(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_public_subject_admission(
  text, text, uuid, text, integer, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_public_subject_admission(uuid)
  TO service_role;

COMMIT;
