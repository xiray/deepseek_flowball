/* 弹窗：总开关 + API Key 输入 + 当前页运行状态。 */

(function () {

  var $ = function (id) { return document.getElementById(id); };
  var settings = null;
  var pollTimer = 0;

  function setTip(text, cls) {
    var el = $('keyTip');
    el.textContent = text;
    el.className = 'tip' + (cls ? ' ' + cls : '');
  }

  function mask(k) {
    k = String(k || '');
    if (k.length <= 12) return '已保存';
    return k.slice(0, 6) + '…' + k.slice(-4);
  }

  function load() {
    dsLoadSettings(function (s) {
      settings = s;
      $('enabled').checked = !!s.enabled;
      if (s.apiKey) {
        $('apiKey').value = s.apiKey;
        setTip('已保存 ' + mask(s.apiKey) + '，改完点保存即生效。');
      } else {
        setTip('粘上 DeepSeek 的 API Key，点保存。只存本机浏览器，不进代码。', 'err');
      }
      refresh();
    });
  }

  function renderStatus(r) {
    var state = $('stState'), source = $('stSource'),
        prog = $('stProgress'), lat = $('stLatency'),
        errLine = $('stErrLine'), err = $('stErr'), title = $('stTitle');

    if (!settings || !settings.enabled) {
      state.textContent = '已暂停';
      source.textContent = '—';
      prog.textContent = '—';
      lat.textContent = '—';
      errLine.hidden = true;
      title.textContent = '';
      return;
    }

    if (!r) {
      state.textContent = '此页面未注入';
      source.textContent = '—';
      prog.textContent = '—';
      lat.textContent = '—';
      errLine.hidden = true;
      title.textContent = '刷新页面后重试';
      return;
    }

    if (!r.hasVideo) {
      state.textContent = '未检测到视频';
      source.textContent = '—';
      prog.textContent = '—';
      title.textContent = '';
    } else {
      var p = r.pipeline || {};
      if (r.total === 0) {
        state.textContent = '等字幕轨';
        source.textContent = r.source || '尚未捕获';
        prog.textContent = '0 条';
      } else {
        state.textContent = r.playing ? '运行中' : '已暂停播放';
        source.textContent = r.source || '—';
        prog.textContent = r.done + ' / ' + r.total + ' 条';
      }
      lat.textContent = p.lastLatency ? (p.lastLatency + ' ms') : '—';
      title.textContent = r.title || '';
    }

    var e = (r.pipeline && r.pipeline.lastError) || '';
    if (e) { errLine.hidden = false; err.textContent = e; }
    else errLine.hidden = true;
  }

  function refresh() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id) { renderStatus(null); return; }
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'ds-status' }, function (resp) {
          if (chrome.runtime.lastError) { renderStatus(null); return; }
          renderStatus(resp || null);
        });
      } catch (e) {
        renderStatus(null);
      }
    });
  }

  $('saveKey').addEventListener('click', function () {
    var btn = this;
    var v = $('apiKey').value.trim();
    btn.disabled = true;
    dsSaveSettings({ apiKey: v }, function () {
      btn.disabled = false;
      settings = settings || {};
      settings.apiKey = v;
      setTip(v ? '已保存 ' + mask(v) + '。' : 'Key 已清空。', v ? 'ok' : 'err');
      refresh();
    });
  });

  $('apiKey').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('saveKey').click();
  });

  $('enabled').addEventListener('change', function () {
    var on = this.checked;
    dsSaveSettings({ enabled: on }, function () {
      if (settings) settings.enabled = on;
      refresh();
    });
  });

  $('openOpts').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  load();
  pollTimer = setInterval(refresh, 1200);

  window.addEventListener('unload', function () {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
