---
name: Advisor Intro
description: При явном «подбери/посоветуй» перед детерминистичным списком карточек добавляется 1 предложение-обоснование от Claude Sonnet 4.5
type: feature
---

V1, 2026-06-16.

## Что
Перед детерминистичным рендером карточек (buildDeterministicShortCircuitContent) добавляется одно короткое предложение: «для какой задачи и по какому ключевому критерию подобрано». Карточки остаются полностью детерминистичными (URL/цены/бренды — без LLM). Intro — отдельный независимый LLM-вызов, не касается карточек.

## Когда (триггер)
Только когда `isAdvisorIntent(userMessage) === true`. Data-agnostic regex:
```
/(подбер|посовет|посоветуй|что\s+(купить|выбрать|взять)|какой\s+(купить|выбрать|взять|лучше)|помоги.*(выбрать|подобрать)|что\s+(лучше|подойд[её]т)|реком)/i
```
Простой поиск товара по названию/артикулу — БЕЗ intro.

## Не применяется (skip)
- `renderReason === 'price-facet-clarify'` (там уже свой уточняющий вопрос)
- `unfulfilledSplit` (split-рендер имеет собственный дисклеймер)
- `qfBrandUnavailable` (brand-unavailable prefix вместо intro)
- `compareMissingAnchors.length > 0` (compare-disclaimer)
- `foundProducts.length === 0`
- ошибка/таймаут LLM (silent skip → carry on без intro)

## Контракт intro
- Ровно 1 предложение, ≤ 25 слов
- БЕЗ названий товаров, брендов, цен, ссылок, артикулов, моделей
- Можно: тип товара (родовой noun), 1-2 ключевых критерия из запроса
- Заканчивается двоеточием (далее идут карточки)
- БЕЗ приветствий, «вот варианты», «выберите подходящий», «надеюсь поможет»

## Технические детали
- Файл: `supabase/functions/_shared/advisor-intro.ts`
- Модель: `anthropic/claude-sonnet-4.5` через OpenRouter
- Timeout: 4 сек
- max_tokens: 120, temperature: 0.3
- Логи: `advisor_intro.ok | http_error | no_content | empty | too_long | error`

## Интеграция
`supabase/functions/chat-consultant/index.ts` — точка вставки прямо перед `const finalContent = contentWithMissing;` в детерминистичном short-circuit (~line 12292). Intro кэширования НЕТ.

## Advisor rescue
Если явный «подбери/посоветуй» содержит контекст задачи, который не является фасетом каталога (например назначение/мощность нагрузки), и QFv2 нашёл валидный noun-pool, нельзя уходить в text-only Soft-404 только из-за `resolvedFilters={}`. После jargon-last-chance показываем реальные карточки из pool (`qfv2_advisor_context_pool`) с advisor intro. `price=0` всё равно фильтруется через `pickDisplayWithTotal`.
