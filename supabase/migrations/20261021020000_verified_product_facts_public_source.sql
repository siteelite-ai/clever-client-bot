-- Keep the operational evidence locator private. A public manufacturer URL is
-- a separate, manually reviewed claim on the immutable approved fact row.
-- Existing approvals remain NULL and cannot earn a public direct certificate.
BEGIN;

ALTER TABLE public.verified_product_facts
  ADD COLUMN public_source_url text;

COMMENT ON COLUMN public.verified_product_facts.public_source_url IS
  'Optional separately reviewed public manufacturer evidence URL. Only this field may enter a browser-visible direct-analog certificate; source_url stays private. Approve a new immutable row to add/change it.';

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_public_source_url_check CHECK (
    public_source_url IS NULL OR
    (char_length(public_source_url) BETWEEN 1 AND 1000 AND
      public_source_url ~ '^https://(signify[.]com|www[.]signify[.]com|www[.]assets[.]signify[.]com|philips[.]com|www[.]philips[.]com|images[.]philips[.]com|navigator-light[.]ru|www[.]navigator-light[.]ru|iek[.]ru|www[.]iek[.]ru|cdn-01[.]iek[.]ru|gauss[.]ru|www[.]gauss[.]ru|ledar[.]ru|www[.]ledar[.]ru)/[A-Za-z0-9._~%/()+,-]+$')
  );

COMMIT;
