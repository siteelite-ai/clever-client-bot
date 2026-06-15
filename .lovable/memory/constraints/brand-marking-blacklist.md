---
name: Brand=Marking Blacklist
description: Эвристика looksLikeMarking фильтрует ВВГ/ПВС/АВВГ из brend__brend и vendor (defect B2)
type: constraint
---

**Проблема:** 220volt каталог содержит «грязные» данные — в `Product.options[brend__brend]` для кабелей лежит сама маркировка («ВВГ»), и `vendor` тоже. В карточке получается `Бренд: ВВГ` — бессмысленно для пользователя.

**Решение (2026-06-15, data-agnostic):** `looksLikeMarking(s)` в `chat-consultant/index.ts` — regex `^[А-ЯЁ]{2,6}(нг)?[\s\-\d.,*хХx/]{0,8}$`. Срабатывает на ВВГ, ВВГнг, ПВС, АВВГ, ПУГВВ + цифро-сечения. Реальные бренды (IEK, ABB, Werkel, Эра) НЕ попадают — латиница или mixed-case.

**Применяется в:**
- `getBrandFromProduct()` — каскад option → vendor → '', оба проверяются.
- `extractBrandsFromProducts()` — фасет-агрегация чистится.

**ABSOLUTE BAN:** словари конкретных серий (ВВГ, NYM, ПВС, …) — нарушает Core «no synonyms/dictionaries».

**Сопутствующий fix (split-mode preposition leak):** в `Unfulfilled-QFv2` split-секциях и `Unfulfilled` post-jargon split-секциях modifiers фильтруются `length>=3` — отсекает служебные слова «на», «и», «с», «в», «у», «по», «к» что протекали из classifier `search_modifiers`. Е27/IP65/220В сохраняются.

**Verified cases:**
- «Кабель ВВГ 3*1,5» → карточка без «Бренд: ВВГ»
- «Лампа кукуруза на цоколь Е27» → split-секция «на(3)» не создаётся
