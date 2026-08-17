# Project Memory

## Core
**Про QA-кейсы — ВСЕГДА сначала `SELECT FROM chat_request_logs` (mem://process/debug-via-logs).** Не отвечать по памяти про конкретный прогон.
Real-time catalog API only. Do not sync catalog to local DB.
**Expert Orchestrator V3 (mem://features/expert-v3-orchestrator) = LLM-first Pipeline.** Вся логика поиска и релаксации внутри модели.
**Legacy V1 (`chat-consultant`)** — сохраняется как справочная система.
**LLM via OpenRouter.** `deepseek/deepseek-v4-flash` = основная модель для V3.
**Spec = data-agnostic (§0).** НИКАКИХ примеров с реальными товарами в спецификации.
HARD BAN на товары с `price=0`.
**V3 Anti-Hallucination:** Цены, ссылки, единицы измерения и контакты — ТОЛЬКО через инструменты. Текстовый гард блокирует утечки фактов без рендера.
**Истина — рассуждение AI (mem://features/v3-criteria-reasoning):** направление подбора берём из прозы модели, а не из сырого числа клиента.
**Числа, названные клиентом, неприкосновенны** — модель не может снизить порог под каталог (mem://features/v3-criteria-consistency).

## Memories
- [Debug via Logs](mem://process/debug-via-logs) — `chat_request_logs` как источник истины.
- [Expert Orchestrator V3](mem://features/expert-v3-orchestrator) — LLM-first архитектура и таймауты.
- [V3 Tools](mem://features/expert-v3-tools) — Логика подбора аналогов и жаргон.
- [V3 Search Refinement](mem://features/v3-search-refinement) — Правила релаксации и управления контекстом.
- [V3 Criteria Gate](mem://features/v3-criteria-gate) — Сверка озвученных числовых критериев с карточками, флаг `v3_criteria_gate_enabled`.
- [V3 Criteria Self-Requery](mem://features/v3-criteria-self-requery) — формулировка модели уходит в каталог как текстовый запрос.
- [V3 Criteria Reasoning](mem://features/v3-criteria-reasoning) — Слой 5: оператор критерия выравнивается по прозе модели, strict-неравенства.
- [V3 Criteria Strict Threshold](mem://features/v3-criteria-strict-threshold) — порог, равный числу клиента, = строгое неравенство (зазор обязателен).
- [V3 Criteria Consistency](mem://features/v3-criteria-consistency) — числа клиента неприкосновенны, авто-возврат ослабленных порогов.
- [V3 Criteria Dead End](mem://features/v3-criteria-dead-end) — пустой self-requery = честный выход вместо таймаута; многословные критерии не идут в текстовый запрос.
- [V3 System Invariants](mem://constraints/expert-v3-invariants) — Жесткие контракты и анти-галлюцинации.
- [Knowledge Base](mem://features/knowledge-base) — RAG и обработка больших файлов.
- [Единица измерения цены](mem://features/price-unit) — `unit` из каталога, «Цена: X ₸/м», для «шт» без суффикса.
- [Widget Features](mem://features/widget) — Настройки и SSE транспорт.
- [Widget Cache Loader](mem://constraints/widget-cache-loader) — embed.js = загрузчик, widget.js = код, версия в widget-version.js (обновлять при каждом изменении).
