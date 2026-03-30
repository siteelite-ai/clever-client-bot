

# Консилиум: верификация плана исправления слотов

## Привлечённые роли

- **Edge Functions Stability Auditor (#4)** — надёжность серверной передачи
- **Integration & Deployment Auditor (#10)** — корректность SSE-протокола клиент-сервер
- **System Architect** (надроль) — целостность архитектуры

---

## Текущий план: оценка

План из `.lovable/plan.md` описывает 3 бага. Проверяю каждый по коду:

### Баг 1: «Слоты не передаются с клиента» — ПОДТВЕРЖДЁН, но root cause другой

**Фактическая причина**: слоты не ПОЛУЧАЮТСЯ клиентом, а не не отправляются.

Код сервера (строки 3049-3051, 3126-3128): `slot_update` отправляется **после** того, как upstream reader вернул `done=true`. Но upstream LLM уже отправил `data: [DONE]\n\n` в своих chunks, и сервер проксирует их как есть (строка 3091: `controller.enqueue(encoder.encode(text))`).

Хронология:
```text
1. LLM отправляет chunks с контентом       → сервер проксирует → клиент читает
2. LLM отправляет "data: [DONE]\n\n"       → сервер проксирует → клиент видит [DONE], ставит done=true, ВЫХОДИТ
3. reader.read() возвращает done=true       → сервер отправляет slot_update → КЛИЕНТ УЖЕ НЕ ЧИТАЕТ
```

В `embed.js` строки 684-686: `[DONE]` → `done = true; break;` → выход из цикла. Final flush (строки 725-747) обрабатывает только то, что уже в `textBuffer`, но `slot_update` ещё не прочитан из reader.

В `ChatWidget.tsx` строки 103-106: та же проблема.

### Баг 2: `price_intent: "none" ≠ null` — УЖЕ ИСПРАВЛЕН

Строка 799-800 содержит `&& classificationResult.price_intent !== 'none'`. Этот баг уже был починен в предыдущей итерации.

### Баг 3: Legacy regex — СРЕДНИЙ, но не основной

Regex по-прежнему работает как fallback, но без слотов это единственный механизм. Исправление слотов сделает его второстепенным.

---

## Вердикты ролей

### Edge Functions Stability Auditor (#4): НЕ ОДОБРЯЕТ текущий план

План предлагает «починить SSE-парсер в ChatWidget» и «добавить логи», но **не решает корневую проблему**: сервер отправляет `slot_update` после `[DONE]`, а клиент уже не читает.

**Правильное решение** — одно из двух:
- **Вариант A (сервер)**: перехватить `[DONE]` из upstream, отправить `slot_update` ДО `[DONE]`, затем отправить `[DONE]` вручную
- **Вариант B (клиент)**: после `[DONE]` продолжить читать reader до `chunk.done === true` (drain loop)

Вариант B проще — 5 строк в двух файлах, не требует редеплоя edge function.

### Integration & Deployment Auditor (#10): ОДОБРЯЕТ Вариант B

Вариант B — минимальное изменение, не ломает SSE-протокол, обратно совместим. Клиент просто продолжает дочитывать stream после `[DONE]`.

### System Architect (надроль): ОДОБРЯЕТ с рекомендацией

Архитектура слотов корректна. Проблема чисто транспортная — `slot_update` приходит после `[DONE]`. После drain-fix:
- Клиент получит `slot_update` → обновит `dialogSlots` state
- Следующий запрос отправит слоты на сервер → `resolveSlotRefinement` заработает
- Баг 2 уже исправлен → refinement будет резолвиться

Рекомендация: **реализовать оба варианта** для надёжности:
1. Вариант B на клиенте (drain loop) — сейчас
2. Вариант A на сервере (slot_update до [DONE]) — для будущих клиентов

---

## Скорректированный план

### Шаг 1. Drain loop в ChatWidget.tsx (строки 103-127)

После `streamDone = true; break;` — НЕ выходить из `while(!streamDone)`, а добавить drain-loop:

```javascript
// После основного while(!streamDone) цикла:
// Drain remaining data from reader (slot_update comes after [DONE])
while (true) {
  const { done: readerDone, value: extraValue } = await reader.read();
  if (readerDone) break;
  textBuffer += decoder.decode(extraValue, { stream: true });
}
```

Затем final flush (строки 130-152) обработает `slot_update` из `textBuffer`.

### Шаг 2. Drain loop в embed.js (строки 684-722)

Аналогично — после `done = true; break;`:

```javascript
// Drain remaining stream data after [DONE]
while (true) {
  var extra = await reader.read();
  if (extra.done) break;
  textBuffer += decoder.decode(extra.value, { stream: true });
}
```

Final flush (строки 725-747) уже обрабатывает `slot_update`.

### Шаг 3 (рекомендация). Сервер: slot_update до [DONE]

В `index.ts` (оба streaming пути): перехватить `[DONE]` из upstream текста, вырезать его, отправить `slot_update`, затем отправить `data: [DONE]\n\n` вручную. Это гарантирует работу с любым клиентом.

### Файлы для изменения
1. `src/components/widget/ChatWidget.tsx` — drain loop (3-5 строк)
2. `public/embed.js` — drain loop (3-5 строк)
3. `supabase/functions/chat-consultant/index.ts` — slot_update до [DONE] (опционально, для надёжности)

### Что НЕ трогаем
- Логика слотов на сервере — работает корректно
- `resolveSlotRefinement` — баг с `"none"` уже исправлен
- RAG/эмбеддинги/knowledge base — не затронуты
- Legacy regex — оставляем как fallback

---

## Ожидаемый результат

После drain-fix клиент получит `slot_update`, обновит state, и при следующем запросе отправит слоты на сервер. Лог будет:

```text
[Widget] Received slot_update: {"slot_1":{"intent":"price_extreme","price_dir":"most_expensive","base_category":"фонарь","status":"pending",...}}
[Widget] Sending dialogSlots: {"slot_1":{...}}   ← следующий запрос
[Chat] Dialog slots received: 1 slot(s)           ← сервер видит слот
[Chat] Slot-resolved: intent=most_expensive, query="кемпинговый фонарь"
```

