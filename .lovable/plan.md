

## Проблема

Сейчас в системе одна настройка модели (`ai_model`) — она используется только для основного LLM. Микро-LLM классификатор жёстко привязан к `gemini-2.5-flash-lite` через Google API или Lovable Gateway. Если Google ключей нет — классификатор падает с ошибкой 400 через Gateway, и весь быстрый путь поиска ломается.

Нужно: дать возможность настраивать модель для классификатора отдельно, и добавить OpenRouter как провайдер для микро-LLM.

## План

### Шаг 1. Добавить поля в базу данных

Новые колонки в таблице `app_settings`:
- `classifier_provider` (text, default `'auto'`) — провайдер для классификатора: `auto` / `google` / `openrouter`
- `classifier_model` (text, default `'gemini-2.5-flash-lite'`) — модель для классификатора

Режим `auto` = текущее поведение (Google ключи → Lovable Gateway), но с добавлением OpenRouter как третьего fallback.

### Шаг 2. Обновить edge function — классификатор через OpenRouter

**Файл:** `supabase/functions/chat-consultant/index.ts`

В функции `classifyProductName()`:
- Прочитать `classifier_provider` и `classifier_model` из настроек
- Если `classifier_provider === 'openrouter'` — использовать OpenRouter API с ключом из `openrouter_api_key` и указанной моделью
- Если `auto` — цепочка: Google API → OpenRouter (если ключ есть) → Lovable Gateway
- Модель для OpenRouter по умолчанию: `google/gemini-2.5-flash-lite:free` (бесплатный Gemini Flash через OpenRouter)

### Шаг 3. Обновить UI настроек

**Файл:** `src/pages/Settings.tsx`

Добавить секцию "Модель классификатора" в настройках AI:
- Выпадающий список провайдера: Auto / Google / OpenRouter
- Выпадающий список модели: курированные лёгкие/быстрые модели для классификации (Gemini 2.5 Flash Lite, Gemma 3 27B, Qwen3 Next 80B и др.)
- Пояснение: классификатор — быстрая микро-LLM для определения типа запроса, нужна лёгкая и дешёвая модель

### Шаг 4. Деплой

Передеплоить edge function.

---

## Техническая сводка

| Компонент | Что меняется |
|---|---|
| Миграция БД | 2 новые колонки в `app_settings` |
| `chat-consultant/index.ts` | `classifyProductName()` — добавить OpenRouter fallback (~20 строк) |
| `Settings.tsx` | Секция настроек классификатора (~40 строк) |

**Результат:** классификатор сможет работать через OpenRouter (бесплатные модели), даже если Google ключи не настроены. Основная и микро-LLM настраиваются независимо.

