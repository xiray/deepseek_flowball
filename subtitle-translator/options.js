/* 设置页逻辑。所有字段都写 chrome.storage.local，不碰任何远端。 */

(function () {

  var ids = [
    'apiKey', 'baseUrl', 'model', 'targetLang', 'prefetchAhead',
    'batchSize', 'concurrency', 'fontScale', 'showMode',
    'autoEnableTracks', 'domFallback', 'screenReader',
    'screenRegion', 'screenInterval', 'debug'
  ];

  function $(id) { return document.getElementById(id); }

  function fillSelect(sel, items, value) {
    sel.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var o = document.createElement('option');
      o.value = items[i].id !== undefined ? items[i].id : items[i];
      o.textContent = items[i].label !== undefined ? items[i].label : items[i];
      sel.appendChild(o);
    }
    sel.value = value;
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function load() {
    dsLoadSettings(function (s) {
      for (var i = 0; i < ids.length; i++) {
        var el = $(ids[i]);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!s[ids[i]];
        else el.value = s[ids[i]];
      }
      if (!s.apiKey) {
        setStatus($('testOut'), '还没有填 Key。粘贴后点「测试连接」验证一下，再保存。', 'err');
      } else {
        setStatus($('testOut'), 'Key 已保存（' + mask(s.apiKey) + '）。可以点「测试连接」确认仍然有效。');
      }
      renderError(s.ds_last_error);
    });
  }

  function mask(k) {
    k = String(k || '');
    if (k.length <= 10) return k.replace(/.(?=.)/g, '*');
    return k.slice(0, 6) + '...' + k.slice(-4);
  }

  function renderError(rec) {
    var card = $('errorCard');
    if (!rec || !rec.msg) { card.hidden = true; return; }
    card.hidden = false;
    var when = rec.at ? new Date(rec.at).toLocaleString('zh-CN') : '';
    $('errorText').textContent = when + '\n' + rec.msg;
  }

  function collect() {
    var out = {};
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (!el) continue;
      var key = ids[i];
      if (el.type === 'checkbox') out[key] = el.checked;
      else if (el.type === 'number') {
        var n = parseFloat(el.value);
        out[key] = isFinite(n) ? n : DS_DEFAULTS[key];
      } else out[key] = el.value.trim();
    }
    if (!out.baseUrl) out.baseUrl = DS_DEFAULTS.baseUrl;
    out.prefetchAhead = Math.max(5, Math.min(180, out.prefetchAhead));
    out.batchSize = Math.max(1, Math.min(20, Math.round(out.batchSize)));
    out.concurrency = Math.max(1, Math.min(4, Math.round(out.concurrency)));
    out.fontScale = Math.max(0.6, Math.min(2, out.fontScale));
    if (!isFinite(out.screenRegion)) out.screenRegion = DS_DEFAULTS.screenRegion;
    out.screenRegion = Math.max(0.1, Math.min(1, out.screenRegion));
    if (!isFinite(out.screenInterval)) out.screenInterval = DS_DEFAULTS.screenInterval;
    out.screenInterval = Math.max(500, Math.min(10000, Math.round(out.screenInterval)));
    return out;
  }

  function save(silent) {
    var data = collect();
    dsSaveSettings(data, function () {
      var st = $('saveStatus');
      st.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN');
      st.className = 'status ok';
      if (!silent) setTimeout(function () { st.textContent = ''; }, 3600);
    });
  }

  $('toggleKey').addEventListener('click', function () {
    var el = $('apiKey');
    var showing = el.type === 'text';
    el.type = showing ? 'password' : 'text';
    this.textContent = showing ? '显示' : '隐藏';
  });

  $('saveBtn').addEventListener('click', function () { save(false); });

  $('testBtn').addEventListener('click', function () {
    var btn = this;
    var out = $('testOut');
    var data = collect();

    if (!data.apiKey) {
      setStatus(out, '先把 API Key 填上。', 'err');
      $('apiKey').focus();
      return;
    }

    btn.disabled = true;
    setStatus(out, '正在请求 DeepSeek…', 'busy');

    dsSaveSettings(data, function () {
      chrome.runtime.sendMessage({ type: 'ds-test' }, function (resp) {
        btn.disabled = false;
        if (chrome.runtime.lastError) {
          setStatus(out, '扩展后台没响应：' + chrome.runtime.lastError.message, 'err');
          return;
        }
        if (!resp || !resp.ok) {
          setStatus(out, '失败：' + ((resp && resp.error) || '未知错误'), 'err');
          renderError({ msg: (resp && resp.error) || '未知错误', at: Date.now() });
          return;
        }
        var sample = (resp.sample || []).filter(function (x) { return x; }).join(' / ');
        setStatus(out,
          '通了。模型 ' + resp.model + '，往返 ' + resp.elapsedMs + 'ms，' +
          '对齐 ' + resp.matched + '/3。译文：' + sample,
          'ok');
        $('errorCard').hidden = true;
      });
    });
  });

  /* 现场画一张带英文句子的图，走真实的图像接口跑一遍。
     比「点一下看通不通」更有意义 —— 它验证的是 vision 链本身能不能用。 */
  function makeTestImage() {
    try {
      var c = document.createElement('canvas');
      c.width = 720;
      c.height = 140;
      var x = c.getContext('2d');
      x.fillStyle = '#000000';
      x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#ffffff';
      x.font = 'bold 36px Georgia, "Times New Roman", serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText('The quick brown fox jumps over the lazy dog.', c.width / 2, c.height / 2);
      return c.toDataURL('image/jpeg', 0.85);
    } catch (e) { return ''; }
  }

  $('testVision').addEventListener('click', function () {
    var btn = this;
    var out = $('visionOut');
    var data = collect();

    if (!data.apiKey) {
      setStatus(out, '先把 API Key 填上。', 'err');
      $('apiKey').focus();
      return;
    }

    var img = makeTestImage();
    if (!img) {
      setStatus(out, '这台机器上生成测试图失败，读屏功能可能也用不了。', 'err');
      return;
    }

    btn.disabled = true;
    setStatus(out, '正在把测试图发给视觉接口…', 'busy');

    dsSaveSettings(data, function () {
      chrome.runtime.sendMessage({ type: 'ds-translate-image', image: img }, function (resp) {
        btn.disabled = false;
        if (chrome.runtime.lastError) {
          setStatus(out, '扩展后台没响应：' + chrome.runtime.lastError.message, 'err');
          return;
        }
        if (!resp || !resp.ok) {
          setStatus(out, '失败：' + ((resp && resp.error) || '未知错误'), 'err');
          return;
        }
        if (!resp.found) {
          setStatus(out, '接口是通的，但模型说这张图里没读到文字。实际画面里字幕更清楚，可以先开着试。', 'busy');
          return;
        }
        setStatus(out,
          '通了。识别「' + String(resp.src).slice(0, 40) + '」→ 译文「' +
          String(resp.zh).slice(0, 24) + '」，' + resp.elapsedMs + 'ms',
          'ok');
      });
    });
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(false); }
  });

  fillSelect($('model'), DS_MODELS, DS_DEFAULTS.model);
  fillSelect($('targetLang'), DS_LANGS, DS_DEFAULTS.targetLang);
  /* 非扩展环境（例如把 options.html 当普通网页打开）里 chrome.runtime.getManifest
     不存在。不能让它把后面的 load() 一起带崩——那样整页会停在默认的空状态。 */
  try {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    $('ver').textContent = 'v1.0.0';
  }
  load();
})();
