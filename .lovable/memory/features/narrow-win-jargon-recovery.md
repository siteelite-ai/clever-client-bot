---
name: QFv2 Narrow-Win Jargon Recovery
description: При qfv2_win с finalFiltered ∈ {1,2} пробуем jargon-fallback на whole query; замещаем только если alt-novel и altCount ≥ max(5, current*2). Решает Defect 2 (нестабильный noun-extractor: «выключатель» vs «автоматический выключатель»). branchTag=qfv2_jargon_narrow_win.
type: feature
---

# Триггер
- `branchTag === 'qfv2_win'` (т.е. resolvedFilters > 0, final > 0)
- `finalFiltered.length ∈ {1, 2}` (NARROW_MAX = 2 — безопасный порог; меняли с {<5} на {≤2} 2026-06-16)

# Алгоритм
1. Вызов `tryJargonFallback({originalQuery: userMessage, productNoun: noun})`.
2. ASCII-fold сравнение `noun` vs `matchedAlternative`:
   - `altIsNovel = altFolded ≠ nounFolded && не подстрока в обе стороны`.
   - Если alt = substring noun ИЛИ noun = substring alt → НЕ замещаем (документированный компромисс: безопасность > покрытие).
3. Порог: `altCount ≥ max(5, finalFiltered.length * 2)`.
4. При срабатывании: `branchTag='qfv2_jargon_narrow_win'`, `totalCollectedBranch='jargon-fallback'`.
5. `pendingJargonClarify` НЕ выставляем (выдача и так не пустая).

# Что НЕ делаем
- Не триггерим при final ≥ 3 (не наш кейс — выдача нормальная).
- Не триггерим при final = 0 (ловят honest-empty + canonical-jargon ветки выше).
- Не вводим словарей категория↔жаргон.
- Не замещаем если alt — подстрока noun («выключ» vs «выключатель»): тот же термин.

# Метрики
- `logAddStep('qfv2-jargon-narrow-win')` — успех, с oldCount/newCount/threshold/alt.
- `logAddStep('qfv2-jargon-narrow-win-skip')` — пропуск, с reason ∈ {alt_not_novel, below_threshold, error}.

# Стоимость
+1 Claude Sonnet 4.5 вызов (~3-4с) только когда finalFiltered ∈ {1,2}. Редкий случай.

# Связанные файлы
- `supabase/functions/chat-consultant/index.ts` ~9168 (внутри `if (finalFiltered.length > 0)` после `branchTag='qfv2_win'`).
- `supabase/functions/chat-consultant/narrow-win-jargon_test.ts` — 9 тестов.

# История
- 2026-06-16: реализовано как Шаг 2.5 после Шага 2 (escalate-skip). Defect 2 из консилиума «автомат 25А для квартиры».
