-- Backfill valid_from / valid_until for 8 known promotion entries
UPDATE public.knowledge_entries SET valid_from = '2023-07-01'::timestamptz, valid_until = '2024-07-07'::timestamptz WHERE id = '02679b30-c034-4f98-818a-8ce1e82e0a21';
UPDATE public.knowledge_entries SET valid_from = '2024-06-01'::timestamptz, valid_until = '2024-07-31'::timestamptz WHERE id = 'a8e7791b-135f-411b-add1-077b23e57479';
UPDATE public.knowledge_entries SET valid_from = '2024-06-01'::timestamptz, valid_until = '2024-07-31'::timestamptz WHERE id = '8e539d11-0641-466f-b1af-3e4d0dce0d33';
UPDATE public.knowledge_entries SET valid_from = '2021-05-01'::timestamptz, valid_until = '2023-06-30'::timestamptz WHERE id = '590e3072-5178-423e-9771-47aba1f1e640';
UPDATE public.knowledge_entries SET valid_from = '2025-01-01'::timestamptz, valid_until = '2025-02-28'::timestamptz WHERE id = '4b4e6512-97e9-43bf-a27a-1a5f6a5346cd';
UPDATE public.knowledge_entries SET valid_from = '2025-01-01'::timestamptz, valid_until = '2030-12-31'::timestamptz WHERE id = 'ad0125bb-13d3-4936-961f-b91f78147797';
UPDATE public.knowledge_entries SET valid_from = '2023-04-04'::timestamptz, valid_until = '2023-06-30'::timestamptz WHERE id = '88c9b11f-cb61-448d-a5d8-340b5c2f9e37';
UPDATE public.knowledge_entries SET valid_from = '2024-09-20'::timestamptz, valid_until = '2024-10-15'::timestamptz WHERE id = '76902a53-c45d-41b7-bbea-36954015f6fd';