---
name: V3 Criteria Gate (контракт «обещал = показал»)
description: Серверная сверка озвученных числовых/диапазонных критериев с характеристиками карточек в render_products, флаг v3_criteria_gate_enabled.
type: feature
---

Проблема: фасеты каталога сравнивают строки строго по равенству, поэтому неравенства («не менее», «с запасом», «больше диаметра кабеля») не проверялись вообще — критерии жили только прозой в первом пузыре. Отсюда кейс термоусадки 12/6 при заявленном «нужен >12 мм».

Реализация (data-agnostic, без доменных словарей):
- `_shared/v3-tools/criteria-gate.ts` — парсер числа/диапазона из строки характеристики + вердикты `pass | fail | unknown`. `unknown` (характеристики нет) НИКОГДА не отсеивает. Отсев только по критериям уровня A с вердиктом `fail`. Юнит-тесты: `criteria-gate_test.ts` (14).
- `render_products` получил опциональный аргумент `criteria[]`: `{key, op: eq|min|max|range, value, unit?, level?}`.
- Промпт-блок `<criteria_contract>` в `schemas.ts` (подключается только при включённом флаге): каждое измеримое требование, названное словами, обязано дублироваться в `criteria[]`.
- Оркестратор (`chat-consultant-v3/index.ts`): перед вызовом `render_products` фильтрует `product_ids`; если всё отсеяно → короткое замыкание с `error_code="criteria_mismatch"` + `report`, чтобы модель переискала или честно ответила.
- Лог-шаги: `v3_guard_criteria_gate`, `v3_guard_criteria_gate_blocked`.

Флаг: `app_settings.v3_criteria_gate_enabled` (default `false`) — мгновенный откат без деплоя.
