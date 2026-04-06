

# Архитектор — Аудит плана «Category-First + генерация синонимов через микро-LLM»

---

## Текущая архитектура (что есть)

```text
Сообщение пользователя
  │
  ├─ Article/SiteID regex → articleShortCircuit ✅
  │
  ├─ Micro-LLM classifyProductName() → classification
  │     │
  │     ├─ price_intent? → handlePriceIntent() ✅
  │     ├─ has_product_name? → title-first search ✅
  │     ├─ is_replacement? → двухэтапный поиск аналогов ✅
  │     └─ product_category (без price/name)? → ❌ ИГНОРИРУЕТСЯ
  │
  └─ Fallback: generateSearchCandidates() (основная LLM)
       → searchProductsMulti() → показ
```

**Проблема**: Ветка `product_category` без `price_intent` и `has_product_name` — мертвая зона. Классификатор корректно определяет категорию («двухместная розетка»), но результат выбрасывается. Управление падает на основную LLM, которая генерирует длинные 3-словные запросы, и API 220volt возвращает 0.

---

## Оцениваемый план

1. **Category-first branch**: Если `product_category` есть, но `has_product_name=false` и нет `price_intent` — искать по категории через API
2. **generateCategorySynonyms()**: Новая микро-LLM функция для генерации вариантов написания (двухместная → 2-местная)
3. **Правило ≤7/>7**: Жесткий запрет уточнений при ≤7 товарах

---

## Вердикт по каждому пункту

### 1. Category-first branch — ОДОБРЕНО с оговоркой

**Архитектурно корректно.** Это заполнение реальной дыры. Паттерн идентичен существующим веткам (`price_intent`, `title-first`, `is_replacement`). Вставка после строки 2879 (после title-first, перед replacement) — правильная позиция.

**Оговорка: порядок с is_replacement.** Сейчас replacement проверяется после title-first. Если добавить category-first между ними, то при запросе «покажи аналог двухместной розетки» (`is_replacement=true`, `product_category="двухместная розетка"`) — category-first сработает РАНЬШЕ replacement и установит `articleShortCircuit=true`. Replacement branch не выполнится.

**Решение**: Добавить в условие category-first проверку `&& !classification?.is_replacement`. Это уже было в предыдущем плане — убедиться, что осталось.

### 2. generateCategorySynonyms() через микро-LLM — ОДОБРЕНО с рисками

**Архитектурно верно и системно.** Не хардкод, а LLM-генерация — соответствует принципу проекта.

**Риск 1: Дополнительная латентность.**
Это второй вызов микро-LLM в рамках одного запроса (первый — classifyProductName). При таймауте 8 сек на каждый — worst case +16 сек. Но:
- Реально микро-LLM отвечает за 300-800мс
- Синонимы нужны ТОЛЬКО когда category-first сработал (не каждый запрос)
- Можно задать таймаут 3-4 сек (задача проще классификации)

**Риск 2: Микро-LLM вернет мусор.**
Если промпт плохой, модель может вернуть несуществующие варианты. Fallback: использовать простой word-reorder (`generatePriceSynonyms` уже делает это — можно переиспользовать).

**Решение**: При ошибке/таймауте синонимов — использовать `generatePriceSynonyms(effectiveCategory)` как fallback. Эта функция уже умеет переставлять слова и добавлять синонимы из словаря.

### 3. Правило ≤7/>7 — УЖЕ РЕАЛИЗОВАНО

Смотрю код строки 3210-3234: правило **уже в продакшене**. `fewProducts = productCount <= 7` → абсолютный запрет уточнений. `else` → разрешен 1 уточняющий вопрос. Этот пункт можно убрать из плана.

---

## Выявленные риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| Category-first перехватывает replacement | Средняя | Высокое — сломает аналоги | `!classification?.is_replacement` в условии |
| Синонимы добавляют латентность | Низкая | Среднее — +300-800мс | Таймаут 4 сек, fallback на `generatePriceSynonyms` |
| Микро-LLM вернет мусор вместо синонимов | Низкая | Низкое — лишние запросы к API | JSON-валидация + fallback |
| Category-first найдет слишком общие результаты | Средняя | Низкое | Основная LLM отфильтрует по контексту сообщения |
| Двойной вызов микро-LLM при каскадном retry | Низкая | Среднее — потенциально 4 вызова | Для синонимов retry НЕ нужен — при ошибке просто fallback на `generatePriceSynonyms` |

---

## Что НЕ сломается

- **Article/SiteID short-circuit** — проверяется ДО category-first, не затронут
- **Price intent** — проверяется ДО category-first, не затронут  
- **Title-first** — проверяется ДО category-first, не затронут
- **Replacement** — защищен условием `!is_replacement`
- **Fallback pipeline** (generateSearchCandidates) — сработает если category-first не нашел ничего
- **База знаний / контакты** — параллельные запросы, независимы
- **Правило ≤7/>7** — уже работает для всех `articleShortCircuit` путей

---

## Итоговая архитектура после изменений

```text
Сообщение пользователя
  │
  ├─ Article/SiteID regex → articleShortCircuit ✅
  │
  ├─ Micro-LLM classifyProductName() → classification
  │     │
  │     ├─ price_intent? → handlePriceIntent() ✅
  │     ├─ has_product_name? → title-first search ✅
  │     ├─ product_category (без price/name/replacement)?  ← НОВОЕ
  │     │     └─ generateCategorySynonyms() → searchProductsMulti()
  │     │         └─ найдено > 0? → articleShortCircuit ✅
  │     └─ is_replacement? → двухэтапный поиск аналогов ✅
  │
  └─ Fallback: generateSearchCandidates() (основная LLM)
```

---

## Итоговый план реализации (одобрен архитектором)

### Файл: `supabase/functions/chat-consultant/index.ts`

**a) Функция `generateCategorySynonyms()`** (~30 строк)
- Вызов микро-LLM с простым промптом: «Сгенерируй 3-5 вариантов написания категории для поиска в каталоге»
- Таймаут: 4 секунды
- Fallback при ошибке: `generatePriceSynonyms(category)` (уже существует)
- JSON-валидация ответа

**b) Ветка category-first** (~20 строк, после строки 2879)
- Условие: `!articleShortCircuit && effectiveCategory && !classification?.has_product_name && !classification?.is_replacement && !effectivePriceIntent`
- Генерация синонимов → `searchProductsMulti()` по всем вариантам
- Если найдено > 0 → `articleShortCircuit = true`, `foundProducts = results`

**c) Правило ≤7/>7** — не требуется, уже реализовано (строки 3210-3234)

### Объем: ~50 строк нового кода, 0 строк удалено, 0 существующих путей затронуто

