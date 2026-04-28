-- Закрыть EXECUTE для anon и authenticated; оставить только service_role/postgres
REVOKE EXECUTE ON FUNCTION public.gc_chat_cache_v2() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.gc_chat_cache_v2() FROM anon;
REVOKE EXECUTE ON FUNCTION public.gc_chat_cache_v2() FROM authenticated;