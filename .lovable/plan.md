
# План: Lexicon-модуль + системные правки спецификации v2 (по итогам консилиума)

Консилиум из трёх ролей (Архитектор, Senior Search/NLP-инженер, Продуктовый инженер) изучил всю спецификацию (1843 строки) и реальный товар:

**Лампа LED CORN капсула 3,5Вт 230В 4000К керамика G4 ИЭК**
URL: https://220volt.kz/catalog/svetotexnika/lampyi/lampa-led-corn-kapsula-3,5vt-230v-4000k-keramika-g4-iek
Артикул: LLE-**CORN**-4-230-40-G4

Ключевая фактология (подтверждено фетчем сайта):
- Слово **"CORN"** живёт **только в `name` и в артикуле**, и пишется заглавными внутри русского названия.
- Слова **"кукуруза"** в каталоге **нет нигде** — это народный синоним.
- В характеристике "Форма колбы" значение — **"капсула"** (не "corn", не "кукуруза"). У других corn-ламп бывает "цилиндр".
- Категория "Лампы" — слишком широкая, тысячи SKU.

---

## Часть A. Новый модуль: Lexicon Resolver (§9.2b)

Встраиваем **между** Category Resolver (§9.2a) и Facet Matcher (§9.3). Цель: канонизировать бытовые / переводные / опечаточные термины ДО фасетного матчинга, без LLM-вызова на лету.

### A.1. Хранилище словаря — `app_settings.lexicon_json`

Решение единогласное у всех трёх экспертов: in-memory кэш в Edge-функции, источник — JSON в `app_settings` (hot-reload каждые 60s, без редеплоя).

Структура одной записи (гибрид: и canonical token, и расширение трейтов — закрывает оба варианта использования):

```json
{
  "version": 1,
  "entries": [
    {
      "match": ["кукуруз\\w*", "corn"],
      "canonical_token": "CORN",
      "trait_expansion": ["капсула"],
      "domain_categories": ["lampyi"],
      "confidence": 1.0,
      "type": "name_modifier",
      "comment": "лампа кукуруза → CORN (в name) + капсула (в форме колбы)"
    },
    {
      "match": ["груш\\w*"],
      "canonical_token": null,
      "trait_expansion": ["A60"],
      "domain_categories": ["lampyi"],
      "confidence": 1.0,
      "type": "facet_alias"
    },
    {
      "match": ["миньон\\w*"],
      "trait_expansion": ["E14"],
      "domain_categories": ["lampyi"],
      "confidence": 1.0,
      "type": "facet_alias"
    }
  ]
}
```

Поля:
- `match` — массив RegEx-паттернов (учёт морфологии: кукуруза/кукурузу/кукурузой).
- `canonical_token` — токен для инжекта в `?query=` (если он реально живёт в `name`/`артикуле` товара). `null` — не инжектить.
- `trait_expansion` — добавляется к `user_traits` для Facet Matcher (если синоним мапится на значение характеристики).
- `domain_categories` — список `pagetitle` категорий, где синоним применим (защита от ложных срабатываний: «кукуруза» в разделе кухонной техники не сработает).
- `confidence` — 0..1 (используется при пороговых решениях).
- `type` — `name_modifier` | `facet_alias` | `bilingual_pair`.

### A.2. Контракт модуля (TypeScript)

```typescript
interface LexiconInput {
  user_traits: string[];            // из Intent Classifier
  resolved_category: Category;      // из Category Resolver, с .pagetitle
}

interface LexiconOutput {
  expanded_traits: string[];        // user_traits + trait_expansion
  canonical_tokens: string[];       // токены для ?query= (только high-confidence, type=name_modifier)
  applied_aliases: AppliedAlias[];  // для логирования и для Composer.soft_matches
}

interface AppliedAlias {
  user_term: string;          // "кукуруза"
  matched_pattern: string;    // "кукуруз\\w*"
  canonical_token?: string;   // "CORN"
  trait_expansion: string[];  // ["капсула"]
  source: "lexicon";          // источник для трассы
}
```

### A.3. Алгоритм (детерминированный, ~1-3 ms)

1. Нормализовать каждый трейт: `lowercase` + `ё→е` + Unicode `NFKC`.
2. Для каждого трейта прогнать по `entries[].match` (regex).
3. Если совпадение И `entry.domain_categories` содержит текущий `resolved_category.pagetitle` (или массив пуст = универсально):
   - добавить `trait_expansion` в `expanded_traits`;
   - если `canonical_token != null` И `type = "name_modifier"` И `confidence ≥ 0.9` — добавить в `canonical_tokens`.
4. Передать в Facet Matcher именно `expanded_traits` (а не оригинальные `user_traits`).
5. `canonical_tokens.join(' ')` уходит в `?query=` параметр API строго БЕЗ unresolved-трейтов.

### A.4. Изменение инварианта §4.5

Текущий инвариант: *«unresolved_traits НИКОГДА не инжектятся в ?query=»* — **сохраняется**.

Дополнение: *«В ?query= допускается инжект только `canonical_tokens` из Lexicon Resolver (тип `name_modifier`, confidence ≥ 0.9). Других источников у `?query=` нет»*.

### A.5. Bootstrap словаря

- **Seed (вручную)**: ~50–100 записей по топ-категориям света/электрики (corn/кукуруза, A60/груша, G45/шарик, C37/свеча, E14/миньон, ВЦ/улитка, шестнарик/16А, и т.д.). Архитектор и Продуктовый предлагают это — короткий путь к MVP.
- **Continuous enrichment (Post-MVP)**: cron-задача раз в сутки агрегирует `unresolved_traits` из `chat_traces` с frequency > 5, пропускает через batch-LLM (single большой prompt, не на лету), записывает кандидатов в админку для модерации.

---

## Часть B. Системные правки спецификации (10 пунктов)

Найденные при ревью противоречия и пробелы — все правки в `docs/chat-consultant-v2-spec.md`.

### B.1. Восстановить отсутствующий §9B (Facet Schema Dedup & Alias Collapse)

§9.3 ссылается на §9B, которого в документе физически нет. Создать раздел: алгоритм дедупликации фасетов с одинаковыми caption/key (`brend__brend`, `Brand`, `Бренд`) + отбрасывание `count: 0` и `values.length > 200` (защита от мусорных SEO-полей и токенового взрыва).

### B.2. Persona Guard L1 + SSE — буферизация первого чанка

§12.2 предписывает regex-фильтр приветствий по первому чанку, но при SSE первый чанк может быть «Зд» (2 символа). Добавить правило: **буферизовать первые 30 символов потока перед сбросом клиенту** для безопасного срабатывания regex.

### B.3. Soft Fallback при `pending_clarification` (правка §11.2a)

Текущая логика: `pending_clarification → запрет показа товаров`. NLP-инженер показал UX-провал: «дай графитовую розетку 16А» — резолвлены `розетка` и `16А`, но цвет «графитовый» отсутствует → бот блокирует выдачу.

Новое правило: **если `resolved.length ≥ 2` И есть `unresolved` → выполнить strict search по resolved, показать товары + дописать `"Графитовых нет, показал ближайшие чёрные. Доступные цвета: ..."`**. Полная блокировка только при `resolved.length < 2`.

### B.4. Сброс `pending_clarification` при смене темы

Если intent = `small_talk` / `info_request` / `sku_lookup` (новый артикул) → немедленно очистить `pending_clarification` и закрыть текущий слот. Иначе бот залипает после 15 минут молчания.

### B.5. Pagination — добавить интент `next_page` и поле `Slot.page_number`

В §13.1 `Slot` нет `page_number`, в §7 нет интента `show_more / next_page`. Пользователь застрянет на первых 7 товарах из 154. Расширить контракт.

### B.6. Сортировка по цене — не локальная, а через API

§9.7 описывает `price_asc/desc` как локальную сортировку первой страницы — это даёт min/max только среди 50 товаров, а не среди 3000. Передавать параметр сортировки **в API каталога** (проверить swagger). Если API не поддерживает — описать probe-стратегию явным образом.

### B.7. Маппинг `category.id → category.title` для UI

§11.2a требует фразы «Ищу в категории *{category_hint}*». В контракте есть только `pagetitle` (slug). Добавить в кэш дерева категорий маппинг `id → human_title`, использовать в Composer.

### B.8. Двуязычие RU/KK как Tuple в фасетах

Composer на `user_locale='kk'` будет галлюцинировать переводы. Обязать Facet Matcher и `CategoryOptionsResponse` выдавать `caption: {ru, kk}` и `value: {ru, kk}` как обязательную структуру. Composer берёт нужный язык по `user_locale` без LLM-перевода.

### B.9. Валидация ссылок на товары на стороне виджета

LLM Composer может галлюцинировать URL. Виджет ОБЯЗАН перед рендерингом markdown-ссылки `[Название](url)` сверять `productId` с массивом `event: products`. Если нет — скрыть ссылку, показать только название. Дописать в §17.3.

### B.10. Решения по открытым вопросам §28.2

Консенсус трёх экспертов:

| # | Вопрос | Решение |
|---|---|---|
| 28.1 | Где хранить активный слот | **sessionStorage** (stateless edge) |
| 28.2 | Сохранять LLM-ответы | **Нет** (только traces + метрики) |
| 28.3 | Прогрев `category_options` top-50 | **Lazy cache** (TTL 1h) |
| 28.4 | Стриминг | **SSE** (требуется для L2 thinking) |
| 28.5 | Макс. слотов в сессии | **1** (мульти-слот ломает FSM) |
| 28.6 | Логирование `chat_traces` | **Через тоггл** (debug-only, иначе пул соединений) |
| 28.7 | Контакты эскалации | **`app_settings` JSON** |
| 28.8 | Резервная LLM | **Flash + Flash Lite fallback** |
| 28.9 | Источник thinking-фраз | **`app_settings` JSON** (маркетинг меняет) |
| 28.10 | `Product.warehouses` для геолокации | **Да**, приоритет ближайшего города |
| 28.11 | Swagger drift-check в CI | **Да, обязательно** (220volt API нестабилен) |
| 28.12 | Прогрев категорий | **Lazy** (TTL 1h, ~200ms холодный старт) |
| 28.13 | Пороги confidence (0.4/0.7) | **В JSON `app_settings`** для hot-reload первые 2 недели |

---

## Часть C. Golden Tests (расширение §25)

Добавить новый раздел `TC-75 — TC-82` (Lexicon coverage):

- **TC-75** «лампочки кукурузы 220 вольт» → форма «капсула», `?query=CORN`, в выдаче IEK CORN G4.
- **TC-76** «обычная лампа груша E27» → форма `A60`, цоколь `E27`.
- **TC-77** «светодиодные шарики 5 Вт» → форма `G45`, мощность `5`.
- **TC-78** «миньоны тёплый свет» → цоколь `E14`, цв.температура `2700-3000K`.
- **TC-79** «свеча на ветру» → форма `CA37`.
- **TC-80** «автомат шестнарик» → категория `avtomaticheskie-vyiklyuchateli`, ток `16А`.
- **TC-81 (NEGATIVE)** «есть аппарат варить кукурузу?» → НЕ показать лампы (Domain Guard через Category Resolver: `pagetitle ≠ lampyi` ⇒ lexicon-entry с `domain_categories=['lampyi']` не активируется).
- **TC-82 (NEGATIVE)** «нужна груша для воды (резиновая)» → НЕ показать лампы A60.

---

## Что ИЗМЕНЯЕТСЯ в файлах

### `docs/chat-consultant-v2-spec.md` (правки):

| Раздел | Изменение |
|---|---|
| §2 Глоссарий | + термины `Lexicon`, `Canonical Token`, `Trait Expansion` |
| §3.1 Топология | + блок «Lexicon Cache (in-memory, hot-reload из app_settings)» |
| §4.5 Инварианты | переформулировать инвариант про `?query=`: разрешить только `canonical_tokens` из Lexicon |
| §6 Turn Pipeline | вставить новый шаг 6a.2.5 «Lexicon Resolve» между Category Resolver и Facet Matcher |
| §7 Intent Classifier | + интент `next_page` |
| §9.2b (новый) | **Lexicon Resolver**: контракт, алгоритм, примеры |
| §9.3 Facet Matcher | принимает `expanded_traits` вместо `user_traits` |
| §9B (создать) | Facet Schema Dedup & Alias Collapse |
| §9.7 | сортировка по цене — через API, не локально |
| §11.2a Composer | Soft Fallback при `resolved ≥ 2` |
| §11A | thinking-фраза для шага Lexicon: `"Уточняю термины..."` |
| §12.2 Persona Guard | буферизация первых 30 символов SSE |
| §13.1 Slot | + `page_number: number`, + `applied_aliases: AppliedAlias[]` |
| §13.1 Category | подтвердить `id, pagetitle, title` (mapping для UI) |
| §13.1 FacetCaption | сделать структуру `{ru: string, kk: string}` обязательной |
| §17.3 (Conv. Rules) | валидация ссылок виджетом против `event: products` |
| §22 Observability | логировать `applied_aliases` и `unresolved_traits` для cron-обогащения lexicon |
| §24 Конфигурация | + `app_settings.lexicon_json`, `confidence_thresholds_json` |
| §25 Golden Tests | TC-75 … TC-82 |
| §28 Открытые вопросы | закрыть §28.2 пп. 1–13 (см. таблицу B.10) |

### `mem://features/search-pipeline` (обновить):

Добавить шаг Lexicon Resolver в основной поток. Зафиксировать правило: `?query=` только из canonical_tokens, type=name_modifier, confidence≥0.9.

### `mem://features/search-logic` (обновить):

Добавить Soft Fallback при `resolved ≥ 2` + Lexicon-расширение трейтов + reset clarification при смене темы.

### `mem://index.md` (обновить):

Core-правило: «Lexicon-резолвинг бытовых/переводных синонимов: in-memory из app_settings, без LLM на лету. ?query= только из canonical_tokens (confidence≥0.9, type=name_modifier).»

### `.lovable/plan.md` (обновить статус этапов):

Финальный этап (4/4) был закрыт. Открывается **Этап 5 (Architectural Hardening)** — текущий план.

---

## Что НЕ делаем сейчас

- Файлы кода в `supabase/functions/` не трогаем — это всё ещё спека.
- LLM-резолвер на лету для синонимов — отвергнут единогласно (латентность).
- Continuous lexicon enrichment через cron + LLM — переносим в **Post-MVP-3**.
- Подход NLP-инженера с разделением на `strong_tokens` / `weak_traits` как первичной структурой — заменяется более простой моделью «expanded_traits + canonical_tokens» (компромисс по сложности).

---

## Открытые вопросы (требуют твоего решения, прежде чем вносить правки)

1. **Lexicon-стратегия**: какой из трёх вариантов канонизации брать?
   - **(A)** Архитектор: `canonical_token` → новое поле `name_modifiers`, инжект в `?query=`. **Чище архитектурно**, требует поддержки `?query=` параметра у API каталога.
   - **(B)** NLP: `strong_tokens` vs `weak_traits` на каждом запросе. **Самое мощное**, требует переработки контрактов всего пайплайна.
   - **(C)** Продуктовый: мутировать `user_traits` перед Facet Matcher (без `?query=`). **Самое простое**, но не работает когда токен живёт ТОЛЬКО в `name`, а не в характеристиках (наш случай с CORN).
   - **(D)** Гибрид (рекомендую): `trait_expansion` (как у Продуктового) + `canonical_token` для `?query=` (как у Архитектора). Описано в Части A.1 этого плана.
2. **Объём seed-словаря на старте**: 30 записей (только лампы) / 50–100 (свет + электроустановка) / 200+ (все домены 220volt)?
3. **Бюджет на §28.13**: вынести **все** confidence-пороги в JSON или только пороги Lexicon (0.9 / 0.85)?

---

## После одобрения

Перехожу в build-режим и вношу все правки одним проходом по `docs/chat-consultant-v2-spec.md` + три файла памяти + `.lovable/plan.md`. Оценка объёма: ~15 секций спеки + 3 файла памяти. Имплементация в `supabase/functions/` НЕ начинается, остаётся отдельным следующим шагом.
