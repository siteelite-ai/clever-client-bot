-- Draft-only, manually curated manufacturer facts. These rows are not live
-- catalog data: server code must bind each approved row to the exact live
-- product id, article and canonical URL before using any claim. No SKU rows
-- are seeded here. Only a PostgreSQL administrator may write or approve rows.
BEGIN;

CREATE TABLE public.verified_product_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text NOT NULL,
  article text NOT NULL,
  catalog_url text NOT NULL,
  source_url text NOT NULL,
  document_version text NOT NULL,
  -- HTML sources have no physical page; PDF sources must name one.
  document_page integer,
  verified_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  approval_status text NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  approved_by text,

  -- A missing technical field means "not verified", never "false" or zero.
  cutout_shape text,
  cutout_kind text,
  cutout_min_mm numeric(7, 2),
  cutout_max_mm numeric(7, 2),
  outer_diameter_mm numeric(7, 2),
  color_temperature_k integer,
  integrated_led boolean,
  socket_kind text,
  socket_code text,
  driver_included boolean,
  driver_type text,
  supply_min_v numeric(7, 2),
  supply_max_v numeric(7, 2),

  CONSTRAINT verified_product_facts_product_id_check CHECK (
    char_length(product_id) BETWEEN 1 AND 160 AND product_id = btrim(product_id)
  ),
  CONSTRAINT verified_product_facts_article_check CHECK (
    char_length(article) BETWEEN 1 AND 200 AND article = btrim(article)
  ),
  CONSTRAINT verified_product_facts_catalog_url_check CHECK (
    char_length(catalog_url) BETWEEN 1 AND 600 AND
    catalog_url ~ '^https://220volt[.]kz/catalog/[^/[:space:]?#]+/[^/[:space:]?#]+/[^/[:space:]?#]+(/[^/[:space:]?#]+)*/$'
  ),
  CONSTRAINT verified_product_facts_source_url_check CHECK (
    char_length(source_url) BETWEEN 1 AND 1000 AND
    source_url ~ '^https://([A-Za-z0-9-]+[.])+[A-Za-z0-9-]+([/?][^[:space:]#]*)?$'
  ),
  CONSTRAINT verified_product_facts_document_check CHECK (
    char_length(document_version) BETWEEN 1 AND 80 AND
    document_version = btrim(document_version) AND
    (document_page IS NULL OR document_page BETWEEN 1 AND 10000) AND
    (source_url !~* '[.]pdf([?][^[:space:]#]*)?$' OR document_page IS NOT NULL)
  ),
  CONSTRAINT verified_product_facts_validity_check CHECK (
    valid_until > verified_at AND
    valid_until <= verified_at + interval '366 days'
  ),
  CONSTRAINT verified_product_facts_approval_check CHECK (
    approval_status IN ('pending', 'approved', 'rejected') AND
    (
      (approval_status = 'approved' AND approved_at IS NOT NULL AND
        approved_by IS NOT NULL AND char_length(approved_by) BETWEEN 1 AND 160 AND
        approved_by = btrim(approved_by) AND
        approved_at >= verified_at AND approved_at < valid_until)
      OR
      (approval_status <> 'approved' AND approved_at IS NULL AND approved_by IS NULL)
    ) AND
    (revoked_at IS NULL OR
      (approval_status = 'approved' AND revoked_at >= approved_at))
  ),
  CONSTRAINT verified_product_facts_cutout_check CHECK (
    (cutout_shape IS NULL AND cutout_kind IS NULL AND
      cutout_min_mm IS NULL AND cutout_max_mm IS NULL)
    OR
    (cutout_shape IS NOT NULL AND cutout_kind IS NOT NULL AND
      cutout_shape = 'round' AND cutout_kind IN ('exact', 'range') AND
      cutout_min_mm IS NOT NULL AND cutout_max_mm IS NOT NULL AND
      cutout_min_mm > 0 AND cutout_max_mm <= 10000 AND
      (
        (cutout_kind = 'exact' AND cutout_min_mm = cutout_max_mm)
        OR
        (cutout_kind = 'range' AND cutout_min_mm < cutout_max_mm)
      ))
  ),
  CONSTRAINT verified_product_facts_outer_diameter_check CHECK (
    outer_diameter_mm IS NULL OR
    (outer_diameter_mm > 0 AND outer_diameter_mm <= 10000 AND
      (cutout_max_mm IS NULL OR outer_diameter_mm > cutout_max_mm))
  ),
  CONSTRAINT verified_product_facts_temperature_check CHECK (
    color_temperature_k IS NULL OR color_temperature_k BETWEEN 1000 AND 20000
  ),
  CONSTRAINT verified_product_facts_socket_check CHECK (
    (socket_kind IS NULL AND socket_code IS NULL)
    OR (socket_kind = 'none' AND socket_code IS NULL)
    OR (socket_kind IS NOT NULL AND socket_kind = 'base' AND
      socket_code IS NOT NULL AND
      char_length(socket_code) BETWEEN 1 AND 20 AND
      socket_code ~ '^[A-Za-z]{1,5}[0-9]{1,3}[A-Za-z0-9-]{0,12}$')
  ),
  CONSTRAINT verified_product_facts_led_socket_check CHECK (
    integrated_led IS DISTINCT FROM true OR socket_kind IS DISTINCT FROM 'base'
  ),
  CONSTRAINT verified_product_facts_driver_check CHECK (
    driver_type IS NULL OR
    (driver_included IS TRUE AND char_length(driver_type) BETWEEN 1 AND 80 AND
      driver_type = btrim(driver_type))
  ),
  CONSTRAINT verified_product_facts_supply_check CHECK (
    (supply_min_v IS NULL AND supply_max_v IS NULL)
    OR
    (supply_min_v IS NOT NULL AND supply_max_v IS NOT NULL AND
      supply_min_v > 0 AND supply_max_v <= 10000 AND
      supply_min_v <= supply_max_v)
  ),
  CONSTRAINT verified_product_facts_approved_claim_check CHECK (
    approval_status <> 'approved' OR
    cutout_min_mm IS NOT NULL OR outer_diameter_mm IS NOT NULL OR
    color_temperature_k IS NOT NULL OR integrated_led IS NOT NULL OR
    socket_kind IS NOT NULL OR driver_included IS NOT NULL OR
    supply_min_v IS NOT NULL
  )
);

-- Expiry is deliberately not in this predicate: now() is time-varying and
-- cannot define a stable partial index. Revoke an approved row before approving
-- its replacement, even if the old row's valid_until has passed.
CREATE UNIQUE INDEX verified_product_facts_one_active_approval_per_product_idx
  ON public.verified_product_facts (product_id)
  WHERE approval_status = 'approved' AND revoked_at IS NULL;

CREATE INDEX verified_product_facts_approval_lookup_idx
  ON public.verified_product_facts (approval_status, valid_until)
  WHERE revoked_at IS NULL;

-- Approval applies to the exact row reviewed, not to a mutable product ID.
-- An approved row can only be revoked; replacement evidence is a new row
-- with a new approval. Even an expired approved row must be revoked first.
CREATE FUNCTION public.guard_verified_product_facts_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.approval_status = 'approved' THEN
      RAISE EXCEPTION 'approved manufacturer facts cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.approval_status = 'approved' THEN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND
      (to_jsonb(NEW) - 'revoked_at') = (to_jsonb(OLD) - 'revoked_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'approved manufacturer facts are immutable; revoke and insert a newly reviewed row';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER verified_product_facts_approval_immutable
BEFORE UPDATE OR DELETE ON public.verified_product_facts
FOR EACH ROW EXECUTE FUNCTION public.guard_verified_product_facts_approval();

ALTER TABLE public.verified_product_facts ENABLE ROW LEVEL SECURITY;
-- No client RLS policies: a service-role server read is the only API path.
REVOKE ALL PRIVILEGES ON TABLE public.verified_product_facts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.verified_product_facts TO service_role;

COMMIT;
