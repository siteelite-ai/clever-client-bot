/*
 * 220volt AI widget loader.
 *
 * ВАЖНО: этот файл — тонкий и стабильный загрузчик. Логика виджета живёт в widget.js.
 * После одноразового обновления URL этого загрузчика он получает актуальную версию
 * через HTML-bootstrap. Lovable отдаёт HTML с обязательной ревалидацией, тогда как
 * статические JS/JSON-файлы может эвристически кешировать браузер. Сам widget.js
 * подключается по content-hash версии и поэтому безопасно кешируется навсегда.
 *
 * Меняйте этот файл только при крайней необходимости.
 */
(function () {
  'use strict';

  var LOADER_VERSION = '2026-09-04-loader-2';
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

  // Последний фолбэк: 5-минутные бакеты не дают навсегда зафиксировать один URL,
  // даже если оба источника версии временно недоступны.
  function fallbackVersion() {
    return 't' + Math.floor(Date.now() / 300000);
  }

  var done = false;
  var bootstrapFrame = null;
  var manifestTimer = null;
  var channel = createChannel();

  function createChannel() {
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var bytes = new Uint32Array(4);
        window.crypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (value) { return value.toString(16); }).join('-');
      }
    } catch (e) {}
    return String(Date.now()) + '-' + String(Math.random()).slice(2);
  }

  function isReleaseVersion(value) {
    return /^widget-[a-f0-9]{16}$/.test(String(value || ''));
  }

  function cleanup() {
    window.removeEventListener('message', onBootstrapMessage);
    if (manifestTimer) clearTimeout(manifestTimer);
    if (bootstrapFrame && bootstrapFrame.parentNode) bootstrapFrame.parentNode.removeChild(bootstrapFrame);
  }

  function finish(version, source) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cleanup();
    inject(version, source);
  }

  function onBootstrapMessage(event) {
    var data = event && event.data;
    if (!bootstrapFrame || event.source !== bootstrapFrame.contentWindow) return;
    if (!data || data.type !== 'volt-widget-version' || data.channel !== channel) return;
    if (!isReleaseVersion(data.version)) return;
    finish(String(data.version), 'html-bootstrap');
  }

  function loadLegacyManifest() {
    if (done) return;
    var m = document.createElement('script');
    m.src = base + '/widget-version.js?ts=' + Date.now();
    m.async = true;
    m.onload = function () {
      var v = window.__voltWidgetVersion;
      finish(isReleaseVersion(v) ? String(v) : fallbackVersion(), isReleaseVersion(v) ? 'manifest-fallback' : 'manifest-empty');
    };
    m.onerror = function () { finish(fallbackVersion(), 'manifest-error'); };
    (document.head || document.documentElement).appendChild(m);
  }

  // Primary source: a sandboxed HTML document. Lovable serves HTML with
  // `Cache-Control: no-cache, must-revalidate, max-age=0`, so an already opened
  // browser profile receives the new content hash without clearing its cache.
  window.addEventListener('message', onBootstrapMessage);
  bootstrapFrame = document.createElement('iframe');
  bootstrapFrame.setAttribute('sandbox', 'allow-scripts');
  bootstrapFrame.setAttribute('aria-hidden', 'true');
  bootstrapFrame.tabIndex = -1;
  bootstrapFrame.style.display = 'none';
  bootstrapFrame.src = base + '/widget-bootstrap.html?ts=' + Date.now() +
    '&parentOrigin=' + encodeURIComponent(location.origin) + '#' + encodeURIComponent(channel);
  (document.body || document.head || document.documentElement).appendChild(bootstrapFrame);

  // CSP may prohibit third-party frames. Preserve the proven script-manifest path
  // as a delayed fallback without letting a stale cached manifest win the race.
  manifestTimer = setTimeout(loadLegacyManifest, 1800);
  var timer = setTimeout(function () { finish(fallbackVersion(), 'timeout-fallback'); }, 4000);
})();
