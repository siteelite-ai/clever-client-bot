
# Реализованные оптимизации chat-consultant v4.0

## Микро-LLM классификатор (gemini-2.5-flash-lite)
- Определяет: конкретное название товара, ценовой интент (most_expensive/cheapest), категорию
- Timeout: 3 секунды, при неуспехе — fallback на обычный pipeline

## Ценовой интент (handlePriceIntent)
- При запросе «самый дорогой/дешёвый X»:
  - Пробный запрос (per_page=1) → узнаём pagination.total
  - total ≤ 50: забираем все per_page=50, сортируем локально, отвечаем
  - total > 50: бот просит уточнить подкатегорию
- Финальная сортировка: desc для most_expensive, asc для cheapest

## Title-first short-circuit
- Если классификатор извлёк название → прямой API-запрос → ответ без LLM 1

## Fallback pipeline оптимизации
- AbortController timeout 10с на каждый API-запрос
- English fallback пропускается при ≥ 1 результате
- Pass 2 пропускается при отсутствии технических фильтров
