---
name: Widget cache-busting loader
description: embed.js — тонкий загрузчик; логика виджета в widget.js, версия в widget-version.js
type: constraint
---
Архитектура доставки виджета (защита от кэша у заказчика):

- `public/embed.js` — ТОНКИЙ и СТАБИЛЬНЫЙ загрузчик. Не добавлять в него логику виджета.
  Он тянет `widget-version.js?ts=<now>` тегом `<script>` (кросс-доменно, без CORS, всегда свежий),
  затем подключает `widget.js?v=<version>`. Фолбэк — 5-минутные бакеты `t<epoch/300000>`.
- `public/widget.js` — весь код виджета (`WIDGET_VERSION` внутри).
- `public/widget-version.js` — единственный источник версии (`window.__voltWidgetVersion`).
  **При КАЖДОМ изменении widget.js обновлять `WIDGET_VERSION` и `widget-version.js` одинаковым значением**,
  иначе клиенты получат старый закэшированный `widget.js?v=...`.
- Клиентам давать сниппет БЕЗ `?v=`: `<script src=".../embed.js" async></script>`.
- Диагностика в консоли: `[Widget] loader=… widget=… (manifest|fallback)`, объект `window.__voltWidgetLoader`.
