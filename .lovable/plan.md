## Цель

Лечить корневую причину: в accessory_for-ветке нет шага «извлечь ось совместимости из реальных данных». Добавить ОДНУ вставку в `chat-consultant/index.ts` между resolve anchor и существующим каскадом (collection → brand → all). Classifier, Family-Guard, остальные ветки — не трогаем.

## Правило (data-agnostic)

Для пары (anchor, probe(target_category)) ключ K из `anchor.options[]` считается **осью совместимости** ⇔:

1. K присутствует у анкера с непустым `value_ru` = V_a.
2. K присутствует в options товаров probe.
3. K — **partition-axis** в probe: число уникальных `value_ru` по этому K ≤ `max(8, 0.3 * probe.length)`. Цвет/мощность/материал/габариты дают много значений → отсеиваются автоматически. Цоколь/коллекция/тип патрона дают ≤ 6–10 значений → проходят.
4. V_a встречается среди значений probe[].options[K] хотя бы у одного товара (anti-mismatch).

Никаких списков ключей, категорий, брендов. Никаких regex по доменным терминам. Только статистика probe.

## Алгоритм вставки

После строки 7758 (`const probe = await tryFetch(undefined, 'probe-target-schema');`) и ДО блока Family-Guard:

```text
1. Если probe.length < 5 → skip (статистика недостоверна), идём в существующий каскад.
2. K_anchor = { o.key : anchor.options }  где value_ru непустой.
3. Для каждого K ∈ K_anchor:
   - собрать values_probe[K] = Set(probe[i].options[K].value_ru)
   - если |values_probe[K]| == 0 → не ось
   - если |values_probe[K]| > max(8, floor(0.3 * probe.length)) → не ось (continuous attribute)
   - V_a = anchor.options[K].value_ru
   - если V_a ∉ values_probe[K] (case-insensitive) → не ось (family-mismatch по K, оставляем Family-Guard разобраться)
   - иначе → K — ось совместимости, добавить в compatAxes с V_a
4. Если compatAxes пустой → skip, идём в существующий каскад.
5. Попытка `compat-all`: tryFetch с options-фильтром по ВСЕМ compatAxes одновременно.
6. Если |result| > 0 → foundProducts = top-15, attemptLabel='compat-all', выход.
7. Если 0 → попытка `compat-strongest`: tryFetch только по ОДНОЙ оси с наименьшим |values_probe[K]| (самая «дискретная» = самая значимая для совместимости).
8. Если |result| > 0 → foundProducts = top-15, attemptLabel='compat-strongest', выход.
9. Если 0 → silent fallback в существующий каскад (collection → Family-Guard → brand → all). Ничего не сломано.
```

Исключения: ключи `brend__*` и `kollekciya__*` пропускаем в этом шаге — collection уже обрабатывает существующий каскад до probe, brand зарезервирован под brand-fallback. Это единственная «оптика», не словарь.

## Метрики (logAddStep.meta)

- `compat_probe_size` — размер probe.
- `compat_keys_considered` — все ключи K_anchor.
- `compat_axes_selected` — массив `{key, anchor_value, target_uniq_count}`.
- `compat_attempt` — 'compat-all' | 'compat-strongest' | 'skipped' | 'fallback'.
- `compat_hit` — bool.

Это позволит за неделю по логам увидеть: какие ключи реально становятся осями для каких пар категорий, нужен ли тюнинг порога.

## Тест-кейсы (.lovable/fixtures/accessory-for-cases-2026-06-02.md)

Дописать новый раздел «Кейсы partition-axis фильтра» с двумя позитивными:

**Кейс 12. Лампа к светильнику с цоколем GX53 в имени модели**
- Запрос: `Какая лампа подходит к этому светильнику: Светильник NGX-R1-001-GX53 белый 71 277 Navigator`
- Classifier: `sub_intent='accessory_for'`, `anchor_product='Светильник NGX-R1-001-GX53 белый 71 277 Navigator'`, `product_category='лампа'`, `critical_modifiers=[]`.
- Branch: anchor.options содержит `tsokol_*=GX53`. Probe ламп: ось `tsokol_*` имеет ≤ 6 уникальных значений, GX53 присутствует → ось выбрана. compat-all возвращает только GX53-лампы.
- Acceptance: `compat_axes_selected` содержит `tsokol_*` с anchor_value='GX53'. В карточках только лампы GX53. `attemptLabel='compat-all'` или `'compat-strongest'`.

**Кейс 13. Negative: цвет светильника НЕ становится осью**
- Тот же запрос. Анкер белый, но probe ламп показывает десятки значений цвета → ось `cvet_*` отброшена по правилу 3, в `compat_axes_selected` её нет.
- Acceptance: фильтр по цвету не применяется; результат не схлопывается в 0 из-за личного предпочтения по якорю.

**Регрессия (Кейс 1, существующий, без изменений):** рамки к розетке NLST — probe рамок мал/коллекций мало, NLST отсутствует в значениях коллекций → правило 4 отклоняет коллекцию как ось → silent fallback → существующий Family-Guard срабатывает как раньше → `accessory-for-incompatible-collection` сохраняется.

## Что НЕ делаем

- Не трогаем classifier, `critical_modifiers`, `anchor_product`-промпт.
- Не трогаем Family-Guard, brand-fallback, collection-attempt, Soft-404 интро.
- Не трогаем QFv2, jargon, price, similar, replacement, knowledge.
- Не вводим словари ключей, категорий, брендов.
- Не меняем порядок существующего каскада — partition-axis шаг строго ДО него, с silent fallback при 0.

## Риски и почему они малы

- **Слишком строгий compat-all → 0**: предусмотрен compat-strongest (только самая дискретная ось). Если и он 0 — silent fallback в существующий каскад. Хуже, чем сейчас, быть не может.
- **Probe маленький (<5)**: skip, поведение = текущее.
- **Хардкод порога `max(8, 0.3*N)`**: единственная гиперконстанта, документирована в коде, тюнится по метрикам без правок логики.

## Файлы

- `supabase/functions/chat-consultant/index.ts` — одна вставка ~50 строк после 7758.
- `.lovable/fixtures/accessory-for-cases-2026-06-02.md` — два новых кейса + пометка про регрессию №1.
- `mem://features/accessory-for` — апдейт описания (после успешной проверки в проде).

Жду ОК — реализую.
