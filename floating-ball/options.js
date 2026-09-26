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
  var el = {};

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

  // ---------- 样式 ----------
  var CSS = [
    '.dsopt{max-width:660px;margin:0 auto;padding:34px 22px 60px;',
    'font:14px/1.68 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#1b1d20}',
    '.dsopt h1{font-size:20px;font-weight:600;margin:0 0 10px}',
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
    '.dsopt .legacy{border-color:rgba(217,119,6,.35);background:rgba(217,119,6,.05)}',
    '.dsopt .legacy b{font-size:13.5px}',
    '.dsopt .legacy p{font-size:12.5px;color:#5b6169;margin:6px 0 0}',
    '.dsopt .foot{font-size:12.5px;color:#6a7076;margin-top:22px}',
    '.dsopt a{color:#3f5ae0}',
    '@media (prefers-color-scheme: dark){',
    '.dsopt{color:#eceef1}',
    '.dsopt .lead,.dsopt .st,.dsopt .cur,.dsopt .foot,.dsopt .legacy p{color:#a6abb3}',
    '.dsopt code{background:rgba(255,255,255,.12)}',
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
      + '<h1>' + esc(cfg.assistant && cfg.assistant.name ? cfg.assistant.name : 'DeepSeek') + ' 悬浮球 · 设置</h1>'
      + '<p class="lead">API Key 只存在这台电脑的浏览器里（<code>chrome.storage.local</code>），'
      + '网页读不到它；只有发请求那一刻才拿出来放进 <code>Authorization</code> 头，'
      + '直接发给 <code>api.deepseek.com</code>，不经过任何第三方。代码里不会有它。</p>'

      + '<div class="card">'
      + '  <label for="dso-key">API Key</label>'
      + '  <div class="row">'
      + '    <input id="dso-key" type="password" spellcheck="false" autocomplete="off" placeholder="sk-……">'
      + '    <button class="btn ghost" id="dso-show" type="button">显示</button>'
      + '  </div>'
      + '  <div class="row2">'
      + '    <button class="btn" id="dso-save" type="button">保存</button>'
      + '    <button class="btn ghost" id="dso-test" type="button">测试连接</button>'
      + '    <button class="btn ghost danger" id="dso-clear" type="button">清空</button>'
      + '  </div>'
      + '  <p class="st" id="dso-st"></p>'
      + '  <p class="cur" id="dso-cur"></p>'
      + '</div>'

      + '<div class="card legacy" id="dso-legacy" hidden>'
      + '  <b>config.js 里还留着一串旧 key</b>'
      + '  <p>它是 <code id="dso-legacy-val"></code>。现在不用写在文件里了 —— '
      + '点下面「搬进浏览器」，再去把 config.js 里 <code>apiKey:</code> 那行清空（或整行删掉）就干净了。</p>'
      + '  <div class="row2"><button class="btn" id="dso-move" type="button">搬进浏览器</button></div>'
      + '</div>'

      + '<p class="foot">申请 / 管理 Key：'
      + '<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">'
      + 'platform.deepseek.com/api_keys</a>'
      + '　·　模型和思考强度在面板底部那两个下拉框里改，跟这里没关系。</p>';

    document.body.appendChild(root);

    el = {
      key: root.querySelector('#dso-key'),
      show: root.querySelector('#dso-show'),
      save: root.querySelector('#dso-save'),
      test: root.querySelector('#dso-test'),
      clear: root.querySelector('#dso-clear'),
      st: root.querySelector('#dso-st'),
      cur: root.querySelector('#dso-cur'),
      legacy: root.querySelector('#dso-legacy'),
      legacyVal: root.querySelector('#dso-legacy-val'),
      move: root.querySelector('#dso-move')
    };

    el.show.addEventListener('click', function () { toggleShow(); });
    el.save.addEventListener('click', function () { save(); });
    el.test.addEventListener('click', function () { test(); });
    el.clear.addEventListener('click', function () { clear(); });
    el.move.addEventListener('click', function () { moveLegacy(); });
    el.key.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function say(msg, kind) {
    el.st.className = 'st' + (kind ? ' ' + kind : '');
    el.st.textContent = msg || '';
  }

  function toggleShow() {
    var hidden = el.key.type === 'password';
    el.key.type = hidden ? 'text' : 'password';
    el.show.textContent = hidden ? '隐藏' : '显示';
  }

  function refresh() {
    return readKey().then(function (k) {
      el.cur.textContent = k
        ? '当前已配置：' + mask(k) + '（存在浏览器里，代码里没有）'
        : '当前还没配 Key —— 配好之前，面板里发消息会提示你去配。';
      var lg = legacyKey();
      el.legacy.hidden = !lg;
      if (lg) { el.legacyVal.textContent = mask(lg); }
      // 纯"旧写法"状态（浏览器里没存、config.js 里有）：直接把值填进框里，
      // 这样你只需要点一下「保存」，不用去把那一长串复制一遍
      if (!k && lg && !el.key.value) { el.key.value = lg; }
      return k;
    });
  }

  function save() {
    var v = norm(el.key.value);
    if (!v) { say('还没填内容。', 'bad'); el.key.focus(); return Promise.resolve(false); }
    return writeKey(v).then(function (ok) {
      if (!ok) { say('存不进去：这个页面没跑在扩展里（要用扩展详情页的「扩展选项」打开）。', 'bad'); return false; }
      say(/^sk-/.test(v)
        ? '已保存。Key 现在在浏览器里了，代码里没有。'
        : '已保存 —— 不过它不以 sk- 开头，DeepSeek 的 Key 一般是 sk- 开头，确认一下没粘错。',
        /^sk-/.test(v) ? 'ok' : 'warn');
      return refresh().then(function () { return true; });
    });
  }

  function clear() {
    if (!window.confirm('清空后要重新填才能用，确定？')) { return Promise.resolve(false); }
    return dropKey().then(function () {
      el.key.value = '';
      say('已清空。', 'warn');
      return refresh();
    });
  }

  function moveLegacy() {
    var lg = legacyKey();
    if (!lg) { return Promise.resolve(false); }
    return writeKey(lg).then(function () {
      say('旧 key 已搬进浏览器。接下来把 config.js 里 apiKey 那行清空，代码里就彻底没有了。', 'ok');
      return refresh();
    });
  }

  // 测试连接：拿你填的这串真打一次接口。只看状态码 —— 200 说明 Key 是活的，
  // 不需要它真答出内容来（max_tokens 给 1，最省）。
  function test() {
    var v = norm(el.key.value);
    if (!v) { say('先把 Key 填进上面那个框。', 'bad'); el.key.focus(); return Promise.resolve(null); }
    var base = String(cfg.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    var model = cfg.model || 'deepseek-flash';
    say('正在测（拿 ' + model + ' 打一次接口）…');
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
      if (r.ok) { say('✓ 通了，Key 是活的。', 'ok'); return r.status; }
      var why = r.status === 401 ? 'Key 不对（401）'
        : r.status === 402 ? '余额不足（402）'
        : r.status === 429 ? '请求太频繁（429），等一下再试'
        : '接口返回 HTTP ' + r.status;
      say('✗ ' + why, 'bad');
      return r.status;
    }).catch(function (e) {
      say('✗ 连不上：' + ((e && e.message) || e) + '（检查网络 / 代理）', 'bad');
      return null;
    });
  }

  build();
  refresh();

  // 给自检页用（也给以后想从面板里直接改 Key 留个口子）
  window.__dsOptions = {
    save: save, test: test, clear: clear, refresh: refresh,
    moveLegacy: moveLegacy, mask: mask,
    els: function () { return el; }
  };
})();
