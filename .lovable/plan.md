
# Реализованные оптимизации chat-consultant v4.3

## Dialog Slots — структурированная слот-память (v4.3)
- Клиент хранит `dialogSlots` — объект с активными интентами (price_extreme, product_search)
- Каждый слот содержит: `intent`, `price_dir`, `base_category`, `refinement`, `status`, `turns_since_touched`
- При ценовом уточнении (>50 товаров) создаётся pending слот
- Короткие ответы пользователя ("кемпинговый") резолвятся как refinement к pending слоту
- Боковые вопросы (погода, анекдоты) не сбрасывают слот
- Автоочистка: pending слот закрывается после 4 ходов без обращения
- Макс 3 активных слота, серверная валидация и санитизация
- `embed.js`: слоты + история сохраняются в `sessionStorage` (переживают навигацию)
- Стабильный `conversationId` на сессию (вместо `Date.now()` на каждый запрос)
- Обратная совместимость: без `dialogSlots` в body — работает как раньше (legacy fallback)

## Микро-LLM классификатор (gemini-2.5-flash-lite)
- Определяет: конкретное название товара, ценовой интент (most_expensive/cheapest), категорию
- Timeout: 3 секунды, при неуспехе — fallback на обычный pipeline
- Принимает последние 4 сообщения истории диалога для восстановления контекста

## Ценовой интент (handlePriceIntent) — v4.2
- **Multi-candidate search**: При запросе «самый дорогой/дешёвый X»:
  - `generatePriceSynonyms` генерирует 4-8 вариантов запроса
  - Все варианты ищутся параллельно, результаты мерджатся и дедуплицируются
  - Финальная сортировка: desc для most_expensive, asc для cheapest
- Пробный запрос (per_page=1) → узнаём pagination.total
  - total ≤ 50: забираем все через multi-candidate fetch, сортируем локально
  - total > 50: бот просит уточнить подкатегорию → создаётся dialog slot

## Title-first short-circuit
- Если классификатор извлёк название → прямой API-запрос → ответ без LLM 1

## Fallback pipeline оптимизации
- AbortController timeout 10с на каждый API-запрос
- English fallback пропускается при ≥ 1 результате
- Pass 2 пропускается при отсутствии технических фильтров
