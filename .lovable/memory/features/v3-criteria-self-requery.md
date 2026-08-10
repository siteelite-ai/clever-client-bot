---
name: V3 Criteria Self-Requery (Слой 3)
description: Формулировка критериев самой модели автоматически отправляется сервером в каталог как текстовый запрос (by_query) при срабатывании criteria gate.
type: feature
---

Принцип: рассуждение модели — это такой же запрос, как реплика клиента. Если модель вслух
сформулировала требование («внутренний диаметр не менее 40 мм»), сервер обязан обработать эту
формулировку ровно так же, как обработал бы её из чата — отправить в каталог по-текстовому.

Реализация:
- `_shared/v3-tools/criteria-gate.ts` → `buildCriteriaQuery(noun, criteria)`: чистая, data-agnostic
  сборка строки запроса (`noun` + «key от/до/диапазон value unit»), только критерии уровня A.
- `chat-consultant-v3/index.ts`: при `criteria_mismatch` (гейт отсеял всё) сервер сам вызывает
  `search_catalog {mode:"by_query", query: buildCriteriaQuery(...)}`, прогоняет результат через тот же
  гейт и кладёт в ответ тула `_self_requery_query`, `_self_requery_ids`, `_self_requery_total`,
  `_server_hint`. Найденное также становится `freshSearch` (`tool: "criteria_self_requery"`).
- `noun` = последний осмысленный `query` поиска (`lastSearchNoun`), иначе исходное сообщение клиента.
- Дедуп: `triedSelfRequeries` — один и тот же self-requery не повторяется в рамках диалога.
- Пусто → hint требует честного ответа + контактов менеджера, а не подстановки неподходящих карточек.
- Лог-шаг: `v3_criteria_self_requery` (`query`, `found`, `total`).

Флаг: тот же `app_settings.v3_criteria_gate_enabled`.
