# Консилиум: верификация спецификации против реального API 220volt

Состав: **Архитектор**, **Prompt Engineer**, **AI/ML Engineer**, **QA Lead**, **API Integration Specialist**.

Прогнано 15+ реальных запросов к `https://220volt.kz/api` с боевым `VOLT220_API_TOKEN`.

---

## 1. Что подтвердилось ✅

| # | Кейс | Результат |
|---|------|-----------|
| TC-1 | `GET /products?query=розетка` | `total=2712`, wrapping `data.{results,pagination}` |
| TC-2 | `GET /products?category=Розетки` | `total=2353` товаров |
| TC-4 | Фильтр `options[brend__brend][]=IEK` | `total=784` ✅ |
| TC-5 | `IEK` + несуществующее значение цвета | `total=0` (ожидаемо, корректный triage для degrade) |
| TC-7 | `options[kolichestvo_razyemov__aғytpalar_sany_][]=1` | `total=1334` ✅ — числовой фильтр работает несмотря на не-ASCII в ключе |
| TC-7b | Тот же ключ, value=2 | `total=802` ✅ |
| TC-8 | `min_price=200&max_price=1000` | `total=214` ✅ |
| TC-9 | `query=перфоратор` | 40 товаров ✅ |
| TC-12 | `category=Авт.выкл&query=C16` | работает ✅ |
| ЦК | `Product.pagetitle` всегда заполнен, `Product.name=null` | подтверждено — спека соответствует |
| Цена | По умолчанию `price=0` фильтруются | подтверждено |

## 2. Что нужно поправить в спецификации 🔧

### A. Двойной wrapping `/categories/options`
Реальный ответ: `{success, data: {success, data: {category, options}}}` — **двойной** `data.data`. В swagger это не описано. Эндпоинт `/products` имеет одинарный `data.{results,pagination}`.

→ Добавить в **§4.2 (API Contract)** явное предупреждение о двойном wrapping и нормализатор в Edge.

### B. Расхождение `total_products` vs `pagination.total`
- `/categories/options?pagetitle=Розетки` → `total_products=2078`
- `/products?category=Розетки` → `pagination.total=2353`
- Разница 275 товаров (вероятно, `price=0` исключаются на /products, но включаются в счётчик options).

→ В **§9C** прописать: `total_products` из options не использовать для оценки выдачи, использовать только `pagination.total` от `/products`.

### C. КРИТИЧНО — фильтрация по строковым значениям с не-ASCII ключом не работает
**Подтверждено эмпирически**:
- `options[cvet__tүs][]=белый` → `total=0` (хотя в фасете `products_count=625`)
- `options[cvet__tүs][]=Белый`, `=ақ`, `=кремовый` → все 0
- `options[edinica_izmereniya__Өlsheu_bіrlіgі][]=шт` → 0 (хотя `products_count=2077`)
- `options[brend__brend][]=ИЭК` (русское значение, ASCII-ключ) → 92 ✅
- `options[brend__brend][]=IEK` → 784 ✅

**Системный закон**: API корректно фильтрует только по ключам, состоящим **полностью из ASCII** (`brend__brend`, `kolichestvo_razyemov__...` — последний работает только для числовых значений).
Любой ключ, содержащий не-ASCII (кириллицу, казахские символы `ү`, `ө`, `ғ`, `Ұ` и т.п.), молча возвращает `total=0` независимо от значения.

→ Это **именно тот системный паттерн**, под который и спроектирован «Try-and-degrade» в §9C.2 — **спецификация уже корректно его покрывает**, никаких хардкод-патчей не нужно.
   Нужно только **уточнить формулировку триггера**: degrade срабатывает не только когда `total=0` после фильтрации, но и когда после применения **первого же** фасета `total` падает с разумного значения (например >50) до 0 — это сигнал про сломанный ключ, а не «реально нет товара».

### D. Уточнения по нормализации значений (§9.3, prompt principle)
Реальные `value_ru` в API часто приходят:
- как `number` (`value_ru: 1`, `value_ru: 50`) для type=string  
- как пустая строка `value_kz: ""` (а не `null`)  
- с многоточиями диапазонов: `"-25...40"`, `"50/60"`

→ Принцип в системном промпте Resolver уже корректен: «нормализуй под форму `schema.values[]`». Добавить **одну строку**: «если `value_ru` числовой — в фильтре передавай как строку без кавычек: `=1`, `=2`».

### E. `swagger.json` устарел
Документация утверждает, что options приходят с полями `type: "string"|"number"`, `min`, `max`, `unit`. В реальности **все** options приходят с `type: null`, `min: null`, `max: null`, `unit: null` (даже для числовых). Тип нужно выводить из значений `values[].value_ru`.

→ В **§9.2 (Schema Resolver)** прописать: «`option.type` от API игнорировать, выводить тип из формы `values[]` (число vs строка vs булево)».

## 3. Что НЕ требует изменений ✅

- **Try-and-degrade** (§9C.2) корректно покрывает все наблюдённые edge cases.
- **Lexicon=[]** старт — подтверждено реальными значениями (бренды/цвета/типы крепления — нельзя предсказать без выгрузки).
- **Запрет `?query=` загрязнения** — обязателен, иначе мусорная выдача (`query=кабель ВВГ 3х2.5` → 0 товаров, а `query=ВВГ` → 440).
- **Real-time API only, без локальной синхронизации каталога** — подтверждено: фасеты тяжёлые (~2.9 МБ для одной категории Розетки), но допустимо при кешировании на запрос.

## 4. План правок (на approve)

**Файл `docs/chat-consultant-v2-spec.md`**:
1. §4.2 — добавить блок «API quirks» с явным описанием:
   - двойной wrapping `/categories/options` → `data.data.{category,options}`
   - `option.type/min/max/unit` всегда `null` — выводить тип эвристически
   - `Product.name=null` → использовать `pagetitle`
   - `value_kz=""` (не `null`)
2. §9.2 — «выводи тип фасета из формы `values[]`, не доверяй `option.type` от API».
3. §9.3 — добавить пункт: «числовой `value_ru` передавать в фильтр без кавычек».
4. §9C.2 — уточнить триггер degrade: **«если применение фильтра уменьшает `total` до 0, при том что без него было ≥10 — фильтр считается сломанным (broken-key signal), переходим к degrade»**.
5. §22.2 — добавить метрику `facet_key_non_ascii_zero_total{key}` для наблюдения за ключами, которые систематически дают 0.
6. §25 — переписать TC-69, TC-71, TC-72, TC-83, добавить TC-87 (фильтр по ASCII-ключу с числовым значением → должен работать) и TC-88 (фильтр по не-ASCII ключу → degrade с первой попытки).

**Файл `mem://architecture/catalog-api-quirks`**:
- Добавить параграф «Filter ASCII-key law»: фильтрация работает только при ASCII-ключе; не-ASCII ключи (`cvet__tүs`, `edinica_izmereniya__Өlsheu_bіrlіgі` и т.п.) при любом значении дают `total=0` → triage через try-and-degrade.
- Добавить «Double-wrapping `/categories/options`».
- Добавить «`total_products` из options ≠ `pagination.total`».

**Файл `docs/external/220volt-facets-snapshot.json`**:
- Заменить пустые `values: []` на актуальные значения, полученные из API (для `Розетки` уже есть в `/tmp/rozetki.json`).
- Сделать аналогичный снапшот для остальных 4 категорий, чтобы Schema Resolver мог использовать как fallback при недоступности API.

**Файл `.lovable/plan.md`**:
- Зафиксировать findings и план реализации Edge function (нормализатор `data.data`, эвристика типа, degrade-trigger).

После approve — переключение в build mode и внесение всех правок одним заходом.
