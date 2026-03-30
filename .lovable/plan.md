

# План: Переключение classifyProductName() на Google API ключи

## Что меняется

Функция `classifyProductName()` (строки 515-633) сейчас использует `LOVABLE_API_KEY` + Lovable Gateway. Нужно переключить на Google API ключи из `app_settings` с тем же fallback-механизмом (`callAIWithKeyFallback`), что используется для основного LLM.

## Изменения в `supabase/functions/chat-consultant/index.ts`

### 1. Сигнатура функции
Добавить параметр `settings: CachedSettings`, чтобы получить доступ к `google_api_key`.

### 2. Парсинг ключей
Заменить `LOVABLE_API_KEY` на парсинг `settings.google_api_key` (split по запятой/newline) — точно как в `getAIConfig()` (строки 88-91).

### 3. Вызов API
Заменить прямой `fetch` на `callAIWithKeyFallback()` с:
- URL: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- Ключи: распарсенный массив из `settings.google_api_key`
- Модель: `gemini-2.5-flash-lite` (оставить как есть — это самая быстрая/дешёвая)
- Label: `'Classify'`

### 4. Таймаут
`callAIWithKeyFallback` не поддерживает `AbortController`. Обернуть вызов в `Promise.race` с 3-секундным таймаутом.

### 5. Место вызова (строка ~2693)
Передать `appSettings` в `classifyProductName(userMessage, recentHistory, appSettings)`.

### 6. Fallback
Если `google_api_key` не настроен — попробовать `LOVABLE_API_KEY` как запасной вариант (чтобы не сломать работу если Google ключи ещё не добавлены).

## Результат
- Классификатор использует те же ключи и тот же fallback, что и основной LLM
- Убирается зависимость от Lovable Gateway (~50-100ms экономия на прокси)
- `LOVABLE_API_KEY` остаётся как fallback, но не основной путь

