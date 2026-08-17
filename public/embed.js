/*
 * 220volt AI widget loader.
 *
 * ВАЖНО: этот файл — тонкий и стабильный загрузчик. Логика виджета живёт в widget.js.
 * Даже если браузер/CDN клиента закэширует embed.js навсегда, загрузчик каждый раз
 * спрашивает актуальную версию (widget-version.json, cache: no-store) и подключает
 * widget.js?v=<версия>. Так деплой всегда доезжает до пользователя без ручных ?v=.
 *
 * Меняйте этот файл только при крайней необходимости.
 */
(function () {
  'use strict';

  var LOADER_VERSION = '2026-08-17-loader-1';
  var self = document.currentScript || (function () {
    var all = document.querySelectorAll('script[src*="embed.js"]');
    return all[all.length - 1] || null;
  })();

  // Базовый origin берём из src самого embed.js, чтобы работало и на custom domain.
  var base = 'https://clever-client-bot.lovable.app';
  try {
    if (self && self.src) base = new URL(self.src, location.href).origin + new URL(self.src, location.href).pathname.replace(/\/embed\.js.*$/, '');
  } catch (e) {}
  if (base.charAt(base.length - 1) === '/') base = base.slice(0, -1);

  if (window.__voltWidgetLoaderStarted) return;
  window.__voltWidgetLoaderStarted = true;

  function inject(version, source) {
    var s = document.createElement('script');
    s.src = base + '/widget.js?v=' + encodeURIComponent(version);
    s.async = true;
    s.onerror = function () {
      try { console.error('[Widget] не удалось загрузить widget.js (v=' + version + ')'); } catch (e) {}
    };
    (document.body || document.head || document.documentElement).appendChild(s);
    try {
      window.__voltWidgetLoader = { loader: LOADER_VERSION, version: version, source: source, base: base };
      console.info('[Widget] loader=' + LOADER_VERSION + ' widget=' + version + ' (' + source + ')');
    } catch (e) {}
  }

  // Фолбэк: 5-минутные бакеты — гарантируют обновление максимум через 5 минут,
  // даже если манифест недоступен.
  function fallbackVersion() {
    return 't' + Math.floor(Date.now() / 300000);
  }

  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    inject(fallbackVersion(), 'timeout-fallback');
  }, 2500);

  try {
    fetch(base + '/widget-version.json?ts=' + Date.now(), { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        inject((data && data.version) ? String(data.version) : fallbackVersion(), data && data.version ? 'manifest' : 'manifest-empty');
      })
      .catch(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        inject(fallbackVersion(), 'manifest-error');
      });
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); inject(fallbackVersion(), 'no-fetch'); }
  }
})();
