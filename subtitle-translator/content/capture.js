/*
 * MAIN world 抓取脚本。
 *
 * 为什么要跑在 MAIN world：要 patch 页面的 fetch / XMLHttpRequest，代码必须和页面
 * 共用同一个 JS 上下文；隔离世界里的 patch 对页面发出的请求无效。
 *
 * 这里拿不到任何 chrome.* API，所以只能靠 window.postMessage 把抓到的字幕
 * 递给隔离世界的脚本。
 *
 * 顺带解决了一个大麻烦：YouTube 等站点的字幕接口带签名令牌校验，我们自己拼
 * URL 去请求会拿空响应。但拦截页面自己发出的请求不受这个限制——令牌是现成的。
 */
(function () {
  if (window.__dssub_capture_installed) return;
  window.__dssub_capture_installed = true;

  var MSG = '__dssub_capture_v1';
  var HELLO = '__dssub_hello_v1';
  var RESET = '__dssub_reset_v1';
  var MAX_BODY = 2 * 1024 * 1024;
  var MAX_BUFFER = 24;

  var buffer = [];
  var seen = Object.create(null);

  function looksLikeSubtitleUrl(u) {
    if (!u || typeof u !== 'string') return false;
    if (u.length > 4000) return false;
    if (u.indexOf('data:') === 0) return false;
    if (/\.(vtt|srt|ttml|dfxp|ass|ssa|sub|smi)(\?|#|$)/i.test(u)) return true;
    if (/(subtitle|caption|timedtext|subtitles|captions|closedcaption|webvtt)/i.test(u)) return true;
    return false;
  }

  function looksLikeSubtitleBody(t) {
    if (!t || t.length < 16 || t.length > MAX_BODY) return false;
    var head = t.slice(0, 600);
    if (/^\uFEFF?\s*WEBVTT/.test(head)) return true;
    if (head.indexOf('-->') >= 0) return true;
    if (/<tt[\s:>]/i.test(head)) return true;
    if (/^\s*[\[]/.test(head) && /"(start|from|begin|tStartMs|content|text)"/.test(head)) return true;
    if (/^\s*\{/.test(head) && /"(events|cues|body|subtitles|captions|segments)"\s*:/.test(head)) return true;
    return false;
  }

  function emit(url, body) {
    if (!body || body.length > MAX_BODY) return;
    var key = url + '\u0000' + body.length + '\u0000' + body.slice(0, 64);
    if (seen[key]) return;
    seen[key] = 1;

    var payload = { url: String(url), body: body, page: location.href };
    buffer.push(payload);
    if (buffer.length > MAX_BUFFER) buffer.shift();

    try {
      window.postMessage({ __dssub: MSG, data: payload }, '*');
    } catch (e) { /* 页面可能禁止 postMessage，忽略 */ }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (e) { url = ''; }

      var p = origFetch.apply(this, arguments);

      if (looksLikeSubtitleUrl(url)) {
        try {
          p.then(function (res) {
            try {
              var ct = (res.headers && res.headers.get('content-type')) || '';
              if (ct && !/json|text|xml|vtt|plain|octet/i.test(ct)) return;
              res.clone().text().then(function (t) {
                if (looksLikeSubtitleBody(t)) emit(url, t);
              }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
        } catch (e) {}
      }
      return p;
    };
  }

  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && OrigXHR.prototype) {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function (method, url) {
      try { this.__dssub_url = url; } catch (e) {}
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function () {
      var self = this;
      var url = '';
      try { url = self.__dssub_url || ''; } catch (e) {}

      if (looksLikeSubtitleUrl(url)) {
        try {
          self.addEventListener('load', function () {
            try {
              var t = '';
              var rt = self.responseType;
              if (rt === '' || rt === 'text') t = self.responseText || '';
              else if (rt === 'json' && self.response) t = JSON.stringify(self.response);
              if (looksLikeSubtitleBody(t)) emit(url, t);
            } catch (e) {}
          });
        } catch (e) {}
      }
      return origSend.apply(this, arguments);
    };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d) return;

    /* 让隔离世界能把缓冲清空。真实用途：页面换了路由、或用户手动「重新识别」时，
       旧字幕不该再被当成有效来源喂回来。 */
    if (d.__dssub === RESET) {
      buffer.length = 0;
      seen = Object.create(null);
      return;
    }

    if (d.__dssub !== HELLO) return;
    for (var i = 0; i < buffer.length; i++) {
      /* 只重放「属于当前页面」的那几条。
         缓冲是为了让晚加载的 content script 也能拿到早先抓到的字幕，但无脑全放会
         在单页应用换路由之后把上一页的字幕文件一直喂回来 —— main.js 于是永远认为
         「有字幕源」，L4 读屏兜底永远轮不上，用户看到的是上一页的旧字幕。 */
      var item = buffer[i];
      if (item && item.page && item.page !== location.href) continue;
      try { window.postMessage({ __dssub: MSG, data: item }, '*'); } catch (e) {}
    }
  });
})();
