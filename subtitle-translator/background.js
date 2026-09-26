/*
 * Service worker：唯一发 DeepSeek 请求的地方。
 *
 * 为什么必须在这里发：content script 的 fetch 受页面 CORS 约束，而 api.deepseek.com
 * 不返回 Access-Control-Allow-Origin，在页面里请求必定 Failed to fetch。
 * service worker 的跨域请求由 host_permissions 授权，不受页面 CORS 限制。
 *
 * 另外 DeepSeek 的 thinking 模式默认是开的，字幕翻译必须显式关掉，
 * 否则每次都要先吐一段推理，延迟和费用都翻倍。
 */

importScripts('shared/settings.js');

var ENDPOINT = '/chat/completions';
var TIMEOUT_MS = 30000;

function baseUrl(s) {
  var u = String((s && s.baseUrl) || DS_DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  return u || DS_DEFAULTS.baseUrl;
}

function systemPrompt(target) {
  return [
    '你是影视字幕译者。用户会给你一组带序号的字幕原文，逐条翻译成' + target + '。',
    '',
    '硬性要求：',
    '1. 输出行数必须与输入完全一致。每条以「序号|」开头，序号与输入一一对应，不得新增、遗漏、合并或拆分。',
    '2. 只输出译文，不要任何解释、注释、原文对照、引号、Markdown 代码块或空行。',
    '3. 译文口语化、简短，适合观众一眼扫完；不逐词硬译，不补充原文没有的信息。',
    '4. 人名、地名、品牌使用通行译名或保留原文；技术缩写保留原文。',
    '5. 单条尽量不超过 20 个汉字，原文很短时也跟着短。',
    '6. 原文破碎或明显是自动识别结果时，按语境还原成通顺中文，但不得编造内容。',
    '7. 如果某条原文只是语气词或噪声，输出最接近的中文语气词，不要留空。'
  ].join('\n');
}

function userPrompt(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push((i + 1) + '|' + lines[i]);
  return out.join('\n');
}

function parseNumbered(text, count) {
  var out = new Array(count);
  for (var i = 0; i < count; i++) out[i] = '';
  var matched = 0;
  var src = String(text === null || text === undefined ? '' : text);
  var lines = src.replace(/\r\n?/g, '\n').split('\n');
  var re = /^\s*(\d+)\s*[|｜:：]\s*(.*)$/;
  for (var j = 0; j < lines.length; j++) {
    var m = lines[j].match(re);
    if (!m) continue;
    var idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= count) continue;
    out[idx] = m[2].trim();
    matched++;
  }
  return { lines: out, matched: matched };
}

async function readSettings() {
  var stored = await chrome.storage.local.get(null).catch(function () { return null; });
  return dsMergeSettings(stored);
}

function rememberError(msg) {
  try {
    chrome.storage.local.set({
      ds_last_error: msg ? { msg: String(msg), at: Date.now() } : null
    });
  } catch (e) {}
}

async function callDeepSeek(settings, messages) {
  var url = baseUrl(settings) + ENDPOINT;
  var body = {
    model: settings.model || DS_DEFAULTS.model,
    messages: messages,
    thinking: { type: 'disabled' },
    stream: false,
    max_tokens: 4096
  };

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  var started = Date.now();
  var res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    var m = (e && e.message) || String(e);
    if (/abort/i.test(m)) throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
    throw new Error('网络请求失败：' + m);
  }
  clearTimeout(timer);
  var elapsed = Date.now() - started;

  var raw = await res.text();
  var data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }

  if (!res.ok) {
    var detail = (data && data.error && (data.error.message || data.error.type)) ||
      (raw ? raw.slice(0, 300) : ('HTTP ' + res.status));
    if (res.status === 401) throw new Error('API Key 无效或已过期（401）');
    if (res.status === 402) throw new Error('账户余额不足（402）');
    if (res.status === 429) throw new Error('触发限流，请稍后重试（429）');
    throw new Error('接口返回 ' + res.status + '：' + detail);
  }
  if (!data || !data.choices || !data.choices[0]) {
    throw new Error('接口返回了无法解析的内容：' + String(raw).slice(0, 300));
  }

  var msg = data.choices[0].message || {};
  return {
    content: msg.content || '',
    usage: data.usage || null,
    elapsedMs: elapsed,
    model: data.model || body.model
  };
}

chrome.runtime.onInstalled.addListener(function (details) {
  readSettings().then(function (s) {
    if (!s.apiKey) {
      try {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#D85A30' });
      } catch (e) {}
      if (details && details.reason === 'install') {
        try { chrome.runtime.openOptionsPage(); } catch (e) {}
      }
    }
  }).catch(function () {});
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.apiKey) return;
  var has = !!(changes.apiKey.newValue);
  try {
    chrome.action.setBadgeText({ text: has ? '' : '!' });
  } catch (e) {}
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'dssub-keepalive') return;
  port.onMessage.addListener(function () { /* 收到 ping 就是在续命 */ });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'ds-ping') {
    sendResponse({ ok: true, at: Date.now() });
    return;
  }

  if (msg.type === 'ds-test') {
    readSettings().then(async function (s) {
      if (!s.apiKey) throw new Error('还没有填 API Key');
      var out = await callDeepSeek(s, [
        { role: 'system', content: '你是字幕翻译引擎。严格按用户要求的行数输出，不要任何多余内容。' },
        { role: 'user', content: '把下面 3 条字幕翻译成' + s.targetLang + '，每条以「序号|」开头：\n1|Hello, how are you?\n2|This is a test.\n3|See you tomorrow.' }
      ]);
      var parsed = parseNumbered(out.content, 3);
      rememberError(null);
      sendResponse({
        ok: true,
        model: out.model,
        elapsedMs: out.elapsedMs,
        usage: out.usage,
        matched: parsed.matched,
        sample: parsed.lines
      });
    }).catch(function (e) {
      rememberError(e && e.message);
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    });
    return true;
  }

  if (msg.type === 'ds-translate') {
    var lines = Array.isArray(msg.lines) ? msg.lines : [];
    if (!lines.length) { sendResponse({ ok: true, results: [] }); return; }

    readSettings().then(async function (s) {
      if (!s.apiKey) throw new Error('未配置 API Key');
      var out = await callDeepSeek(s, [
        { role: 'system', content: systemPrompt(s.targetLang) },
        { role: 'user', content: userPrompt(lines) }
      ]);
      var parsed = parseNumbered(out.content, lines.length);
      if (parsed.matched === 0) {
        throw new Error('译文格式无法解析，原始返回：' + String(out.content).slice(0, 200));
      }
      rememberError(null);
      sendResponse({
        ok: true,
        results: parsed.lines,
        matched: parsed.matched,
        elapsedMs: out.elapsedMs,
        usage: out.usage
      });
    }).catch(function (e) {
      rememberError(e && e.message);
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    });
    return true;
  }
});
