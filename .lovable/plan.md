# Итоговый план: Data-Agnostic Spec + Query Expansion

## Статус: ВЫПОЛНЕНО (частично)

### Что сделано

1. **§0 Data-Agnostic Spec Doctrine** — вставлен как нормативный приоритет. Демаркация «контракт vs whitelist». Критерий: если артефакт зависит от ассортимента 220volt — это whitelist, ему не место в спеке.

2. **§9.2a Category Resolver** — добавлены инварианты C1–C4: pagetitle только из живого `/api/categories`, запрет translit/эвристик/ручных таблиц, cron-сверка.

3. **§9.2b Query Expansion Resolver** (заменил Lexicon Resolver) — multi-attempt pipeline: `as_is_ru → lexicon_canonical → en_translation → kk_translation`. Все каталог-зависимые примеры entries убраны. Lexicon остаётся как одна из стратегий, но без иллюстративных записей в спеке.

4. **§9.2c Strict Search Multi-Attempt + Word-Boundary Post-Filter** — новый раздел. Цикл по query_attempts, word-boundary regex `\b<token>\b` (флаги `iu`), price>0 post-filter.

5. **§11.5 Cross-sell** — убран иллюстративный абзац «E27 + диммеры». Оставлены инварианты CS1–CS6 + отрицательный контракт.

6. **§17.3** — переписан в BNF/плейсхолдер-нотацию. Убран пример с «Розетка белая 16А / Schneider / Legrand / ABB».

7. **§17.7** — переписан в BNF. Убран пример с «цоколь E27, мощность, цветовая температура».

8. **§11.6 SIM7** — убрана конкретная иллюстрация, заменена на `<critical_traits_csv>`.

### Что осталось (следующая итерация)

- **§25 Test Cases** — переписать TC-69..TC-103 в формате `state → input → expected pipeline trace` на синтетических моках (без реальных категорий/товаров). Legacy-кейсы с «розетки», «лампы E27», «Schneider» → абстрагировать в `<CatA>`, `<FacetKey1>`, `<BrandX>`.
- **§22 метрики** — добавить `query_expansion_*` и `category_hallucination_total` (контракты уже описаны в §9.2b/c).
- **§9.4, §9.5 Domain Guard** — убрать конкретные группы (`power_socket`, `telecom`, `lighting_indoor/outdoor`) или пометить как «non-normative illustration per §0.4».
- **§9B value_aliases** — пример `"schneider electric" → "Schneider"` — API-контракт (допустим per §0.2), но пометить.
- **Реализация в `index.ts`** — Query Expansion, word-boundary filter, Category Resolver с live snapshot — отдельный PR после approval спеки.

### Архитектурные принципы (закреплены)

- Спека = законы (контракты, инварианты, алгоритмы, BNF). Не состояние каталога.
- Грязные примеры → `.lovable/fixtures/` (вне спеки).
- Lexicon наполняется через cron + human-in-the-loop, стартует пустым.
- Перевод (EN/KK) — внутри Intent-LLM tool-call, не отдельный round-trip.
- Word-boundary post-filter — защита от substring-matching API.
