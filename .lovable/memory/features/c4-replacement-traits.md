---
name: C4 Replacement Traits Enhanced
description: Numeric trait recovery + brand-exclude + pagetitle-leak guard в replacement-ветке
type: feature
---
**C4 (2026-06-15)**: replacement-traits.ts расширен тремя data-agnostic слоями:

1. **Numeric recovery в `extractMarkingTokens`**: разрешены физические единицы с цифрой (16А, 50Вт, 230В, 2.5мм², IP65). Отбрасываются только торговые (шт/пар/компл/упак/уп/м/см/мм/км/дм/мг/г/кг/т/л/мл/м²/м³). SI-список универсален, не зависит от 220volt. Решает регрессию: 16А автомат не должен подбираться как 25А.

2. **`extractOriginalBrand` + `applyBrandExclude`**: бренд читается из `options[brend__*]` → `vendor`. Кандидаты того же бренда исключаются (по options.brend ИЛИ по pagetitle.includes). Если бренд оригинала null → no-op. Никаких словарей брендов, рантайм-данные.

3. **`isOriginalByTitle`**: страховочный leak-guard когда `originalProduct.id` недоступен (anchor LVL2/LVL3 через query/category). Exact-match pagetitle (case+whitespace insensitive).

Интегрировано в обе ветки `chat-consultant/index.ts`: matcher (~9716) и legacy (~10012). Логи: `Replacement original-leak filter`, `Replacement brand-exclude "<X>"`.

Тесты: 25/25 в replacement-traits_test.ts.
