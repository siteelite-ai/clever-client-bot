-- Add two independently approved manufacturer axes. No SKU data, defaults or
-- catalogue-derived values are inserted; old approvals remain unchanged.
BEGIN;

ALTER TABLE public.verified_product_facts
  ADD COLUMN mounting_method text,
  ADD COLUMN luminous_flux_lm numeric(10, 2);

COMMENT ON COLUMN public.verified_product_facts.mounting_method IS
  'Explicit manufacturer-approved mounting method. NULL is unknown, never inferred from the catalogue title or category.';
COMMENT ON COLUMN public.verified_product_facts.luminous_flux_lm IS
  'Explicit manufacturer-rated luminous flux in lumens. NULL is unknown, never inferred from model numbers.';

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_mounting_method_check CHECK (
    mounting_method IS NULL OR mounting_method = 'recessed'
  ),
  ADD CONSTRAINT verified_product_facts_luminous_flux_check CHECK (
    luminous_flux_lm IS NULL OR
    (luminous_flux_lm > 0 AND luminous_flux_lm <= 1000000)
  );

-- Each axis may be the only approved claim. Retain every pre-existing claim
-- term and the existing immutable-approval trigger, RLS and privileges.
ALTER TABLE public.verified_product_facts
  DROP CONSTRAINT verified_product_facts_approved_claim_check;

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_approved_claim_check CHECK (
    approval_status <> 'approved' OR
    fixture_form IS NOT NULL OR mounting_method IS NOT NULL OR
    luminous_flux_lm IS NOT NULL OR cutout_min_mm IS NOT NULL OR
    outer_diameter_mm IS NOT NULL OR color_temperature_k IS NOT NULL OR
    integrated_led IS NOT NULL OR socket_kind IS NOT NULL OR
    driver_included IS NOT NULL OR supply_min_v IS NOT NULL
  );

COMMIT;
