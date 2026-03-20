

## Проблема

Cache-busting IIFE (строки 1-11) удаляет `<script>` и подгружает новый, но `return` выходит только из этой IIFE. Основной код виджета (строка 13+) продолжает выполняться. Когда новый скрипт загрузится — виджет инициализируется повторно. Два контейнера, конфликтующие обработчики → клик не работает.

## Решение

**Файл: `public/embed.js`** — одно изменение:

Обернуть весь файл в единую IIFE, где cache-busting `return` прервёт выполнение всего кода, включая виджет:

```javascript
(function() {
  // Cache-busting
  var s = document.querySelector('script[src*="embed.js"]');
  if (s && !s.src.includes('_v=')) {
    var n = document.createElement('script');
    n.src = s.src + (s.src.includes('?') ? '&' : '?') + '_v=' + Math.floor(Date.now() / 300000);
    s.parentNode.removeChild(s);
    document.body.appendChild(n);
    return; // ← теперь прерывает ВСЁ
  }

  // === Весь остальной код виджета (без своей обёртки IIFE) ===
  'use strict';
  const CONFIG = { ... };
  // ...
})();
```

По сути: убираем две отдельные IIFE, делаем одну общую. `return` внутри неё останавливает всё.

## Файлы
1. `public/embed.js` — объединить две IIFE в одну

