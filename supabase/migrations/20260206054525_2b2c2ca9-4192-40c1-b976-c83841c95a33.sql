-- Улучшенная функция поиска с OR-логикой для лучшего recall
DROP FUNCTION IF EXISTS public.search_knowledge_fulltext(text, int);

CREATE OR REPLACE FUNCTION public.search_knowledge_fulltext(
  search_query text,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  type TEXT,
  source_url TEXT,
  rank real
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  tsquery_ru tsquery;
  words text[];
  word text;
  tsquery_parts text[];
BEGIN
  -- Очищаем запрос: убираем стоп-слова и короткие слова
  words := ARRAY(
    SELECT DISTINCT lower(w) 
    FROM unnest(regexp_split_to_array(lower(search_query), '[^а-яёa-z0-9]+')) AS w
    WHERE length(w) > 2 
      AND w NOT IN ('как', 'что', 'где', 'когда', 'почему', 'какой', 'какая', 'какие', 
                    'это', 'для', 'при', 'над', 'под', 'или', 'так', 'вот', 'вас', 'нас',
                    'можно', 'работает', 'есть', 'ваш', 'ваша', 'ваши', 'мне', 'вам')
  );
  
  -- Если после фильтрации остались слова — строим OR-запрос
  IF array_length(words, 1) > 0 THEN
    FOREACH word IN ARRAY words LOOP
      tsquery_parts := array_append(tsquery_parts, word || ':*'); -- Prefix-match для частичного совпадения
    END LOOP;
    
    -- Объединяем через OR (|) вместо AND (&)
    tsquery_ru := to_tsquery('russian', array_to_string(tsquery_parts, ' | '));
  ELSE
    -- Если ключевых слов не осталось — используем оригинальный запрос
    tsquery_ru := plainto_tsquery('russian', search_query);
  END IF;
  
  RETURN QUERY
  SELECT
    ke.id,
    ke.title,
    ke.content,
    ke.type,
    ke.source_url,
    ts_rank(ke.search_vector, tsquery_ru) as rank
  FROM public.knowledge_entries ke
  WHERE ke.search_vector @@ tsquery_ru
  ORDER BY ts_rank(ke.search_vector, tsquery_ru) DESC
  LIMIT match_count;
END;
$$;