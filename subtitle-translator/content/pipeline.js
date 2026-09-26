/*
 * 翻译流水线：缓存去重 + 批量合并 + 并发闸门 + 失败退避。
 *
 * 设计要点：
 *   - 缓存按「原文文本」而不是「cue 序号」做键。整片里重复出现的短句、以及换源
 *     后同一句字幕重新下发，都能直接命中，省掉一次往返。
 *   - 同一批里的句子一次性发出去，模型按「序号|」对齐返回。批内靠后的句子
 *     等于提前拿到了译文，这是把"逐句往返"摊薄的关键。
 *   - 失败指数退避，避免接口挂了以后疯狂重试把配额烧光。
 */

var DS_PIPELINE = (function () {

  var CACHE_LIMIT = 30000;

  var textCache = Object.create(null);
  var cacheCount = 0;

  var inflight = 0;
  var maxInflight = 2;
  var backoffUntil = 0;
  var failStreak = 0;

  var port = null;
  var heartbeat = 0;

  var stats = {
    requests: 0, ok: 0, fail: 0, lines: 0,
    lastError: '', lastLatency: 0, cacheHits: 0
  };

  function ensurePort() {
    if (port) {
      try { port.postMessage({ type: 'ds-ping' }); return; } catch (e) { port = null; }
    }
    try {
      port = chrome.runtime.connect({ name: 'dssub-keepalive' });
      port.onDisconnect.addListener(function () {
        port = null;
        if (heartbeat) { clearInterval(heartbeat); heartbeat = 0; }
      });
    } catch (e) {
      port = null;
      return;
    }
    if (!heartbeat) {
      heartbeat = setInterval(function () {
        try { if (port) port.postMessage({ type: 'ds-ping' }); } catch (e) { port = null; }
      }, 20000);
    }
  }

  function setOptions(s) {
    if (!s) return;
    var n = parseInt(s.concurrency, 10);
    maxInflight = isFinite(n) ? Math.max(1, Math.min(4, n)) : 2;
  }

  function cacheGet(text) {
    var v = textCache[text];
    return typeof v === 'string' ? v : null;
  }

  function cachePut(text, zh) {
    if (!text || !zh) return;
    if (typeof textCache[text] === 'undefined') cacheCount++;
    textCache[text] = zh;
    if (cacheCount > CACHE_LIMIT) {
      textCache = Object.create(null);
      cacheCount = 0;
    }
  }

  function canSend() {
    if (Date.now() < backoffUntil) return false;
    return inflight < maxInflight;
  }

  function send(lines, cb) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      cb(new Error('后台无响应，可能扩展已重新加载'));
    }, 45000);

    try {
      chrome.runtime.sendMessage({ type: 'ds-translate', lines: lines }, function (resp) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          cb(new Error(chrome.runtime.lastError.message || '消息通道异常'));
          return;
        }
        if (!resp) { cb(new Error('后台未返回结果')); return; }
        if (!resp.ok) { cb(new Error(resp.error || '翻译失败')); return; }
        cb(null, resp);
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cb(new Error('扩展上下文已失效，请刷新页面'));
      }
    }
  }

  function note(err, resp) {
    inflight--;
    if (err) {
      failStreak++;
      stats.fail++;
      stats.lastError = err.message;
      var wait = Math.min(15000, 700 * Math.pow(2, Math.min(failStreak, 4)));
      backoffUntil = Date.now() + wait;
      return;
    }
    failStreak = 0;
    stats.ok++;
    stats.lastError = '';
    if (resp && resp.elapsedMs) stats.lastLatency = resp.elapsedMs;
  }

  /*
   * cues: [{ text }]  调用方自己的对象，这里只读 .text
   * cb(err, results[]) results 与 cues 等长，未成功的位置是 ''
   */
  function submit(cues, cb) {
    if (!cues || !cues.length) { cb(null, []); return; }
    ensurePort();

    var out = new Array(cues.length);
    var missing = [];
    for (var i = 0; i < cues.length; i++) {
      var hit = cacheGet(cues[i].text);
      if (hit !== null) { out[i] = hit; stats.cacheHits++; }
      else { out[i] = ''; missing.push(i); }
    }

    if (!missing.length) { cb(null, out); return; }

    var lines = [];
    for (var j = 0; j < missing.length; j++) lines.push(cues[missing[j]].text);

    inflight++;
    stats.requests++;
    stats.lines += lines.length;

    send(lines, function (err, resp) {
      note(err, resp);
      if (!err) {
        for (var k = 0; k < missing.length; k++) {
          var zh = (resp.results && resp.results[k]) || '';
          if (!zh) continue;
          out[missing[k]] = zh;
          cachePut(cues[missing[k]].text, zh);
        }
      }
      cb(err, out);
    });
  }

  function reset() {
    textCache = Object.create(null);
    cacheCount = 0;
    backoffUntil = 0;
    failStreak = 0;
  }

  function snapshot() {
    return {
      inflight: inflight,
      cache: cacheCount,
      requests: stats.requests,
      ok: stats.ok,
      fail: stats.fail,
      lines: stats.lines,
      cacheHits: stats.cacheHits,
      lastError: stats.lastError,
      lastLatency: stats.lastLatency,
      backoffMs: Math.max(0, backoffUntil - Date.now())
    };
  }

  return {
    setOptions: setOptions,
    canSend: canSend,
    submit: submit,
    reset: reset,
    snapshot: snapshot,
    cacheGet: cacheGet
  };
})();
