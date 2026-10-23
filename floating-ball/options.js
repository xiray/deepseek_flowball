// ============================================================
//  DeepSeek 悬浮球 · 设置页：API Key 在这儿配，**不写在代码里**
//  两个入口：面板右上角 ⚙ / chrome://extensions → 本扩展 → 扩展选项
//
//  Key 存在 chrome.storage.local —— 只在本机这个浏览器里，网页读不到；
//  只有发请求那一刻才取出来放进 Authorization 头，直接发给 api.deepseek.com。
//
//  界面由本文件自己建（options.html 只是个空壳），和 panel.js 一个路子。
//  这样自检页（docs/selftest-key.html）能直接加载它、真点按钮跑断言。
// ============================================================
(function () {
  'use strict';

  var cfg = window.DS_CONFIG || {};
  var K_KEY = '__ds_key__';
  var K_LANG = '__ds_lang__';        // 'zh' | 'en'，只换这个设置页的文案
  var el = {};
  var lang = 'zh';                   // 默认中文（这扩展本来就是中文优先，英文是给需要的人切的）
  var NAME = (cfg.assistant && cfg.assistant.name) || 'DeepSeek';
  // 最近一条状态提示 / 快捷键提示：切语言时要按新语言重画一遍。
  // 存的是**词表 key + 参数**，不是拼好的字符串 —— 存字符串的话切过去还是老语言。
  var lastSay = null;
  var lastKeySt = null;

  // ---------- 存储 ----------
  function hasStore() {
    try { return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local; }
    catch (e) { return false; }
  }
  function kv(k, v) { var o = {}; o[k] = v; return o; }
  function norm(v) { return typeof v === 'string' ? v.trim() : ''; }

  function readKey() {
    return new Promise(function (res) {
      try {
        if (hasStore()) { chrome.storage.local.get(K_KEY, function (d) { res(norm(d && d[K_KEY])); }); return; }
      } catch (e) { /* 上下文失效就当没配 */ }
      res('');
    });
  }
  function writeKey(v) {
    return new Promise(function (res) {
      try {
        if (hasStore()) { chrome.storage.local.set(kv(K_KEY, v), function () { res(true); }); return; }
      } catch (e) { /* 下面返回 false */ }
      res(false);
    });
  }
  function dropKey() {
    return new Promise(function (res) {
      try {
        if (hasStore() && chrome.storage.local.remove) {
          chrome.storage.local.remove(K_KEY, function () { res(true); });
          return;
        }
      } catch (e) { /* 下面返回 false */ }
      res(false);
    });
  }

  // config.js 里那条 apiKey 是**旧写法**，留作兼容；这儿负责把它一秒钟搬过来
  function legacyKey() { return norm(cfg.apiKey); }

  // 显示用：只露头和尾。别把整串铺在屏幕上 —— 截个图就漏了
  function mask(k) { return k.length <= 12 ? k.slice(0, 4) + '…' : (k.slice(0, 6) + '…' + k.slice(-4)); }

  // ---------- 界面语言 ----------
  // 词表在 i18n.js（window.DS_I18N），这里只负责「现在是哪个语言 + 怎么画上去」。
  // 选过的语言存在 chrome.storage.local，下次打开还是这个语言。
  function dict() {
    var all = window.DS_I18N || {};
    return all[lang] || all.zh || {};
  }
  function t(k, vars) {
    var s = dict()[k];
    if (s == null) { s = ((window.DS_I18N || {}).zh || {})[k]; }   // 缺了就回落中文，别把 key 露出去
    if (s == null) { s = k; }
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, n) {
        return vars[n] == null ? '' : vars[n];
      });
    }
    return s;
  }
  function readLang() {
    return new Promise(function (res) {
      try {
        if (hasStore()) {
          chrome.storage.local.get(K_LANG, function (d) {
            res(d && d[K_LANG] === 'en' ? 'en' : 'zh');
          });
          return;
        }
      } catch (e) { /* 落到下面 */ }
      res('zh');
    });
  }
  function writeLang(v) {
    try {
      if (hasStore()) { chrome.storage.local.set(kv(K_LANG, v)); }
    } catch (e) { /* 存不进去就只在这一次生效，不影响用 */ }
  }
  function setLang(v) {
    lang = (v === 'en') ? 'en' : 'zh';
    writeLang(lang);
    applyLang();
    return Promise.resolve(lang);
  }
  // 把当前语言画到界面上：写死的文案走 data-i18n（纯文本）/ data-i18n-html（带标签），
  // 算出来的那几块（显示/隐藏、状态行、快捷键）各自重画一次 —— 它们不是静态文本。
  function applyLang() {
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    document.title = t('page.title', { name: NAME });
    var root = el.root;
    if (root && root.querySelectorAll) {
      root.querySelectorAll('[data-i18n]').forEach(function (n) {
        n.textContent = t(n.getAttribute('data-i18n'), { name: NAME });
      });
      root.querySelectorAll('[data-i18n-html]').forEach(function (n) {
        n.innerHTML = t(n.getAttribute('data-i18n-html'), { name: NAME });
      });
      root.querySelectorAll('[data-i18n-ph]').forEach(function (n) {
        n.setAttribute('placeholder', t(n.getAttribute('data-i18n-ph')));
      });
    }
    if (el.lang) { el.lang.value = lang; }
    syncShowBtn();
    renderSay();
    renderKeySt();
    // 「当前已配置」「快捷键」两行也是文案，重读重画一遍（异步，但渲染时读的是新 lang）
    refresh();
  }

  // ---------- 样式 ----------
  var CSS = [
    '.dsopt{max-width:660px;margin:0 auto;padding:34px 22px 60px;',
    'font:14px/1.68 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#1b1d20}',
    '.dsopt h1{font-size:20px;font-weight:600;margin:0 0 10px}',
    // 标题 + 语言下拉排在一行；窗口窄了就换行，别让下拉被挤出去
    '.dsopt .head{display:flex;align-items:center;justify-content:space-between;gap:14px;',
    'flex-wrap:wrap;margin:0 0 8px}',
    '.dsopt .head h1{margin:0}',
    '.dsopt .langpick{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:#5b6169}',
    '.dsopt .langpick select{font:inherit;font-size:12.5px;padding:5px 8px;border-radius:8px;',
    'border:1px solid rgba(0,0,0,.18);background:#fff;color:inherit;outline:0;cursor:pointer}',
    '.dsopt .langpick select:focus{border-color:#4D6BFE;box-shadow:0 0 0 3px rgba(77,107,254,.13)}',
    '.dsopt .langnote{color:#6a7076;font-size:12px;margin:0 0 16px}',
    '.dsopt .lead{color:#5b6169;font-size:13px;margin:0 0 22px}',
    '.dsopt code{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12.5px;',
    'background:rgba(0,0,0,.06);padding:1px 5px;border-radius:5px}',
    '.dsopt .card{background:#fff;border:1px solid rgba(0,0,0,.09);border-radius:14px;',
    'padding:16px 18px;margin-bottom:16px;box-shadow:0 2px 10px rgba(20,25,40,.04)}',
    '.dsopt label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px}',
    '.dsopt .row{display:flex;gap:8px;align-items:center}',
    '.dsopt .row2{display:flex;gap:8px;flex-wrap:wrap;margin-top:11px}',
    '.dsopt input{flex:1;min-width:0;border:1px solid rgba(0,0,0,.18);border-radius:10px;',
    'padding:9px 11px;font:inherit;font-size:13.5px;outline:0;background:#fff;color:inherit}',
    '.dsopt input:focus{border-color:#4D6BFE;box-shadow:0 0 0 3px rgba(77,107,254,.13)}',
    '.dsopt .btn{border:0;border-radius:10px;padding:9px 15px;font:inherit;font-size:13px;cursor:pointer;',
    'background:#4D6BFE;color:#fff}',
    '.dsopt .btn:hover{background:#3f5ae0}',
    '.dsopt .btn.ghost{background:rgba(0,0,0,.06);color:inherit}',
    '.dsopt .btn.ghost:hover{background:rgba(0,0,0,.11)}',
    '.dsopt .btn.danger{color:#c0392b}',
    '.dsopt .st{font-size:12.5px;margin:10px 0 0;min-height:1.4em;color:#5b6169}',
    '.dsopt .st.ok{color:#0f6e56}',
    '.dsopt .st.bad{color:#c0392b}',
    '.dsopt .st.warn{color:#b45309}',
    '.dsopt .cur{font-size:12.5px;margin:4px 0 0;color:#5b6169}',
    '.dsopt .kbd{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;',
    'background:rgba(0,0,0,.07);padding:2px 7px;border-radius:6px}',
    '.dsopt .hint{font-size:12.5px;color:#5b6169;margin:8px 0 0}',
    '.dsopt .legacy{border-color:rgba(217,119,6,.35);background:rgba(217,119,6,.05)}',
    '.dsopt .legacy b{font-size:13.5px}',
    '.dsopt .legacy p{font-size:12.5px;color:#5b6169;margin:6px 0 0}',
    '.dsopt .foot{font-size:12.5px;color:#6a7076;margin-top:22px}',
    '.dsopt a{color:#3f5ae0}',
    '@media (prefers-color-scheme: dark){',
    '.dsopt{color:#eceef1}',
    '.dsopt .lead,.dsopt .st,.dsopt .cur,.dsopt .foot,.dsopt .legacy p,.dsopt .hint,',
    '.dsopt .langnote{color:#a6abb3}',
    '.dsopt .langpick{color:#a6abb3}',
    '.dsopt .langpick select{background:#1c1d20;border-color:rgba(255,255,255,.2)}',
    '.dsopt code{background:rgba(255,255,255,.12)}',
    '.dsopt .kbd{background:rgba(255,255,255,.12)}',
    '.dsopt .card{background:#232428;border-color:rgba(255,255,255,.14);box-shadow:none}',
    '.dsopt input{background:#1c1d20;border-color:rgba(255,255,255,.2)}',
    '.dsopt .btn.ghost{background:rgba(255,255,255,.1)}',
    '.dsopt .btn.ghost:hover{background:rgba(255,255,255,.17)}',
    '.dsopt .st.ok{color:#9FE1CB}',
    '.dsopt .st.bad{color:#f3a09a}',
    '.dsopt .st.warn{color:#f0bf7a}',
    '.dsopt a{color:#8fa8ff}',
    '}'
  ].join('');

  // ---------- 界面 ----------
  function build() {
    var st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);

    var root = document.createElement('div');
    root.className = 'dsopt';
    root.innerHTML = ''
      + '<div class="head">'
      + '  <h1 data-i18n="page.h1"></h1>'
      + '  <label class="langpick"><span data-i18n="lang.label"></span>'
      + '    <select id="dso-lang"><option value="zh">中文</option><option value="en">English</option></select>'
      + '  </label>'
      + '</div>'
      + '<p class="langnote" data-i18n="lang.hint"></p>'
      + '<p class="lead" data-i18n-html="page.lead"></p>'

      + '<div class="card">'
      + '  <label for="dso-key" data-i18n="key.label"></label>'
      + '  <div class="row">'
      + '    <input id="dso-key" type="password" spellcheck="false" autocomplete="off" data-i18n-ph="key.placeholder">'
      + '    <button class="btn ghost" id="dso-show" type="button"></button>'
      + '  </div>'
      + '  <div class="row2">'
      + '    <button class="btn" id="dso-save" type="button" data-i18n="btn.save"></button>'
      + '    <button class="btn ghost" id="dso-test" type="button" data-i18n="btn.test"></button>'
      + '    <button class="btn ghost danger" id="dso-clear" type="button" data-i18n="btn.clear"></button>'
      + '  </div>'
      + '  <p class="st" id="dso-st"></p>'
      + '  <p class="cur" id="dso-cur"></p>'
      + '</div>'

      + '<div class="card legacy" id="dso-legacy" hidden>'
      + '  <b data-i18n="legacy.title"></b>'
      // ⚠ 那个 <code id="dso-legacy-val"> 必须留在被翻译的 span **外面**：
      //   它会往 innerHTML 里塞，整段重写的话这个节点就换了，el 里抓着的是旧的那个（显示不出来）
      + '  <p><span data-i18n="legacy.pre"></span> <code id="dso-legacy-val"></code>'
      + '<span data-i18n-html="legacy.post"></span></p>'
      + '  <div class="row2"><button class="btn" id="dso-move" type="button" data-i18n="btn.move"></button></div>'
      + '</div>'

      + '<div class="card">'
      + '  <label data-i18n="keys.label"></label>'
      + '  <p class="cur" id="dso-key-now" data-i18n="keys.reading"></p>'
      + '  <div class="row2"><button class="btn ghost" id="dso-keys" type="button" data-i18n="btn.keys"></button></div>'
      + '  <p class="st" id="dso-key-st"></p>'
      + '  <p class="hint" data-i18n-html="keys.hint"></p>'
      + '  <p class="hint" data-i18n="keys.limit"></p>'
      + '</div>'

      + '<p class="foot" data-i18n-html="foot"></p>';

    document.body.appendChild(root);

    el = {
      root: root,
      lang: root.querySelector('#dso-lang'),
      key: root.querySelector('#dso-key'),
      show: root.querySelector('#dso-show'),
      save: root.querySelector('#dso-save'),
      test: root.querySelector('#dso-test'),
      clear: root.querySelector('#dso-clear'),
      st: root.querySelector('#dso-st'),
      cur: root.querySelector('#dso-cur'),
      legacy: root.querySelector('#dso-legacy'),
      legacyVal: root.querySelector('#dso-legacy-val'),
      move: root.querySelector('#dso-move'),
      keyNow: root.querySelector('#dso-key-now'),
      keySt: root.querySelector('#dso-key-st'),
      keys: root.querySelector('#dso-keys')
    };

    el.show.addEventListener('click', function () { toggleShow(); });
    // 换语言：不重建 DOM（重建会把已经粘进输入框、还没保存的 Key 抹掉），
    // 只把文字重画一遍 —— 输入框里打的东西原样留着。
    el.lang.addEventListener('change', function () { setLang(el.lang.value); });
    el.save.addEventListener('click', function () { save(); });
    el.test.addEventListener('click', function () { test(); });
    el.clear.addEventListener('click', function () { clear(); });
    el.move.addEventListener('click', function () { moveLegacy(); });
    el.keys.addEventListener('click', function () { openKeys(); });
    el.key.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
  }

  // ---------- 唤起快捷键（manifest 里的 commands.toggle-panel） ----------
  // 键名表也跟着语言走（在 i18n.js 的 keyNames 里）：中文「空格」/ 英文「Space」。
  // 只翻 Chrome 允许出现在快捷键里的那几个特殊键，字母数字原样。
  function keyNames() {
    var all = window.DS_I18N || {};
    var d = all[lang] || {};
    return d.keyNames || (all.zh && all.zh.keyNames) || {};
  }
  function keyLabel(s) {
    var names = keyNames();
    return String(s || '').split('+').map(function (p) {
      var k = p.trim();
      return k ? (names[k] || k) : '';
    }).filter(Boolean).join(' + ');
  }

  // 我们自己声明的那两条（name 要和 manifest 里的 commands 对齐；label 是词表 key）
  var OUR_KEYS = [
    { name: 'toggle-panel', label: 'keys.openPanel' },
    { name: 'ask-selection', label: 'keys.sendSel' }
  ];

  // 读当前快捷键。返回：{命令名: 键位}（''=没设）/ null = 这个环境读不到。
  // 要能区分"没设"和"读不到" —— 自检页和很老的浏览器都没有 chrome.commands。
  function readShortcuts() {
    return new Promise(function (res) {
      try {
        if (chrome.commands && chrome.commands.getAll) {
          chrome.commands.getAll(function (list) {
            var by = {};
            (list || []).forEach(function (c) { if (c && c.name) { by[c.name] = String(c.shortcut || ''); } });
            var out = {};
            OUR_KEYS.forEach(function (k) { out[k.name] = (k.name in by) ? by[k.name] : ''; });
            res(out);
            return;
          });
          return;
        }
      } catch (e) { /* 落到下面 */ }
      res(null);
    });
  }

  // 去 Chrome 自己的快捷键页。**扩展没有改快捷键的权限**（Chrome 的安全限制），
  // 所以"设置页里可自定义"只能是"给个入口 + 告诉你现在绑的是哪个键"。
  function openKeys() {
    try {
      if (chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        setKeySt('keys.opened', 'ok');
        return true;
      }
    } catch (e) { /* 落到下面 */ }
    setKeySt('keys.openFail', 'warn');
    return false;
  }

  function syncKeys() {
    return readShortcuts().then(function (sc) {
      if (!el.keyNow) { return sc; }
      if (sc === null) {
        el.keyNow.textContent = t('keys.noApi');
        return sc;
      }
      // ⚠ label 要先 t() 再 esc()：直接 esc(key) 会把词表 key 原样印在页面上
      el.keyNow.innerHTML = OUR_KEYS.map(function (k) {
        var v = sc[k.name];
        return t('keys.line', {
          label: esc(t(k.label)),
          value: v ? '<b class="kbd">' + esc(keyLabel(v)) + '</b>' : t('keys.unset')
        });
      }).join('<br>');
      return sc;
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 状态提示存的是「词表 key + 参数」，不是拼好的句子 —— 存句子的话，切语言之后这条
  // 还是老语言挂在那儿，看着像没切成功。
  function say(key, kind, vars) {
    lastSay = { key: key, kind: kind || '', vars: vars || null };
    renderSay();
  }
  function renderSay() {
    if (!el.st) { return; }
    if (!lastSay) { el.st.className = 'st'; el.st.textContent = ''; return; }
    el.st.className = 'st' + (lastSay.kind ? ' ' + lastSay.kind : '');
    el.st.textContent = t(lastSay.key, lastSay.vars);
  }
  function setKeySt(key, kind) {
    lastKeySt = { key: key, kind: kind || '' };
    renderKeySt();
  }
  function renderKeySt() {
    if (!el.keySt) { return; }
    if (!lastKeySt) { el.keySt.className = 'st'; el.keySt.textContent = ''; return; }
    el.keySt.className = 'st' + (lastKeySt.kind ? ' ' + lastKeySt.kind : '');
    el.keySt.textContent = t(lastKeySt.key);
  }

  function toggleShow() {
    var hidden = el.key.type === 'password';
    el.key.type = hidden ? 'text' : 'password';
    syncShowBtn();
  }
  function syncShowBtn() {
    if (el.show) { el.show.textContent = t(el.key.type === 'password' ? 'btn.show' : 'btn.hide'); }
  }

  function refresh() {
    return readKey().then(function (k) {
      el.cur.textContent = k ? t('cur.on', { v: mask(k) }) : t('cur.off');
      var lg = legacyKey();
      el.legacy.hidden = !lg;
      if (lg) { el.legacyVal.textContent = mask(lg); }
      // 纯"旧写法"状态（浏览器里没存、config.js 里有）：直接把值填进框里，
      // 这样你只需要点一下「保存」，不用去把那一长串复制一遍
      if (!k && lg && !el.key.value) { el.key.value = lg; }
      return k;
    }).then(function (k) {
      return syncKeys().then(function () { return k; });
    });
  }

  function save() {
    var v = norm(el.key.value);
    if (!v) { say('msg.empty', 'bad'); el.key.focus(); return Promise.resolve(false); }
    return writeKey(v).then(function (ok) {
      if (!ok) { say('msg.noStore', 'bad'); return false; }
      var looksGood = /^sk-/.test(v);
      say(looksGood ? 'msg.saved' : 'msg.savedOdd', looksGood ? 'ok' : 'warn');
      return refresh().then(function () { return true; });
    });
  }

  function clear() {
    if (!window.confirm(t('msg.confirmClear'))) { return Promise.resolve(false); }
    return dropKey().then(function () {
      el.key.value = '';
      say('msg.cleared', 'warn');
      return refresh();
    });
  }

  function moveLegacy() {
    var lg = legacyKey();
    if (!lg) { return Promise.resolve(false); }
    return writeKey(lg).then(function () {
      say('msg.moved', 'ok');
      return refresh();
    });
  }

  // 测试连接：拿你填的这串真打一次接口。只看状态码 —— 200 说明 Key 是活的，
  // 不需要它真答出内容来（max_tokens 给 1，最省）。
  function test() {
    var v = norm(el.key.value);
    if (!v) { say('msg.needKey', 'bad'); el.key.focus(); return Promise.resolve(null); }
    var base = String(cfg.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    var model = cfg.model || 'deepseek-flash';
    say('msg.testing', '', { model: model });
    return fetch(base + (cfg.apiPath || '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + v },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
    }).then(function (r) {
      if (r.ok) { say('msg.testOk', 'ok'); return r.status; }
      var byCode = r.status === 401 ? 'msg.test401'
        : r.status === 402 ? 'msg.test402'
        : r.status === 429 ? 'msg.test429' : '';
      if (byCode) { say(byCode, 'bad'); } else { say('msg.testHttp', 'bad', { code: r.status }); }
      return r.status;
    }).catch(function (e) {
      say('msg.testFail', 'bad', { err: (e && e.message) || e });
      return null;
    });
  }

  // 先按中文把界面建出来（万一是读存储失败，页面也不该是空的），再把存过的语言画上去。
  // 顺序反过来也能用，但"空白等存储回调"在扩展页里会有一下闪空，不值当。
  build();
  applyLang();                       // 里面会 refresh() 一次
  readLang().then(function (l) {
    if (l !== lang) { lang = l; applyLang(); }
  });

  // 给自检页用（也给以后想从面板里直接改 Key 留个口子）
  window.__dsOptions = {
    save: save, test: test, clear: clear, refresh: refresh,
    moveLegacy: moveLegacy, mask: mask,
    keyLabel: keyLabel, syncKeys: syncKeys, openKeys: openKeys, readShortcuts: readShortcuts,
    setLang: setLang, getLang: function () { return lang; },
    els: function () { return el; }
  };
})();
