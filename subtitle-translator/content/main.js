/*
 * 主编排：找视频 → 收集字幕轨 → 按播放时间预取翻译 → 渲染覆盖层。
 *
 * 字幕来源按「能不能拿到完整轨」分三级，等级高的盖掉等级低的：
 *   3  file   拦截到的字幕文件（能预取，体验最好）
 *   2  track  video.textTracks 里的原生轨（同样能预取）
 *   1  dom    监听页面上字幕文本的变化（只有当前一句，没法预取，必然滞后）
 */

(function () {
  if (window.__dssub_main_installed) return;
  window.__dssub_main_installed = true;

  var CAP_MSG = '__dssub_capture_v1';
  var CAP_HELLO = '__dssub_hello_v1';
  var RANK = { none: 0, dom: 1, track: 2, file: 3 };

  var state = {
    settings: dsMergeSettings(null),
    video: null,
    videoKey: '',
    cues: [],
    sig: '',
    kind: 'none',
    sourceLabel: '',
    lastLang: null,
    lastHarvest: 0,
    dom: { obs: null, cues: [], last: '', timer: 0, pending: '', target: null }
  };

  function log() {
    if (!state.settings.debug) return;
    try { console.log.apply(console, ['[字幕翻译]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  /* ---------- 设置 ---------- */

  function applySettings(s) {
    var prevLang = state.lastLang;
    state.settings = s;
    if (prevLang !== null && prevLang !== s.targetLang) {
      DS_PIPELINE.reset();
      if (state.cues.length) {
        for (var i = 0; i < state.cues.length; i++) {
          state.cues[i].zh = '';
          state.cues[i].state = 'idle';
          state.cues[i].tries = 0;
        }
      }
    }
    state.lastLang = s.targetLang;

    DS_PIPELINE.setOptions(s);
    DS_OVERLAY.setOptions({
      fontScale: Number(s.fontScale) || 1,
      showMode: s.showMode || 'zh'
    });

    if (s.domFallback) startDomWatch(); else stopDomWatch();
    if (!s.enabled) { DS_OVERLAY.hide(); stopDomWatch(); }
  }

  chrome.storage.local.get(null, function (stored) {
    applySettings(dsMergeSettings(stored));
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    chrome.storage.local.get(null, function (s) { applySettings(dsMergeSettings(s)); });
  });

  /* ---------- 字幕源：写入 ---------- */

  function shortUrl(u) {
    try {
      var s = String(u);
      s = s.replace(/^https?:\/\//, '').split('?')[0];
      return s.length > 46 ? s.slice(0, 44) + '…' : s;
    } catch (e) { return '字幕文件'; }
  }

  function setCues(cues, kind, label) {
    if (!cues || cues.length < 2) return;
    if (RANK[kind] < RANK[state.kind]) return;

    var sig = cues.length + '|' + cues[0].start.toFixed(2) + ':' + cues[0].text.slice(0, 24) +
      '|' + cues[cues.length - 1].start.toFixed(2) + ':' + cues[cues.length - 1].text.slice(0, 24);
    if (sig === state.sig && RANK[kind] === RANK[state.kind]) return;

    var next = new Array(cues.length);
    for (var i = 0; i < cues.length; i++) {
      next[i] = {
        start: cues[i].start,
        end: cues[i].end,
        text: cues[i].text,
        zh: '',
        state: 'idle',
        tries: 0
      };
    }
    state.cues = next;
    state.sig = sig;
    state.kind = kind;
    state.sourceLabel = label || kind;
    log('字幕源更新', kind, cues.length, '条', label);
  }

  /* ---------- 字幕源：L1 拦截到的字幕文件 ---------- */

  function handleCapture(payload) {
    if (!payload || !payload.body) return;
    var parsed = DS_PARSE.parseSubtitle(payload.body, payload.url);
    if (!parsed.cues || parsed.cues.length < 2) return;
    setCues(parsed.cues, 'file', '字幕文件（' + parsed.format + '）· ' + shortUrl(payload.url));
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__dssub !== CAP_MSG || !d.data) return;
    try { handleCapture(d.data); } catch (e) { log('解析字幕失败', e && e.message); }
  });

  function askCapture() {
    try { window.postMessage({ __dssub: CAP_HELLO }, '*'); } catch (e) {}
  }

  /* ---------- 字幕源：L2 原生字幕轨 ---------- */

  function harvestTracks() {
    var v = state.video;
    if (!v || !v.textTracks) return;

    var best = null;
    for (var i = 0; i < v.textTracks.length; i++) {
      var tr = v.textTracks[i];
      if (!tr) continue;
      var kind = String(tr.kind || '').toLowerCase();
      if (kind !== 'subtitles' && kind !== 'captions') continue;

      var lang = String(tr.language || '').toLowerCase();
      if (/^zh/.test(lang)) continue;

      if (tr.mode === 'disabled') {
        if (!state.settings.autoEnableTracks) continue;
        if (lang && !/^en/.test(lang)) continue;
        try { tr.mode = 'hidden'; log('启用字幕轨', lang || '(无语言标记)'); } catch (e) {}
        continue;
      }

      var list = null;
      try { list = tr.cues; } catch (e) { list = null; }
      if (!list || !list.length) continue;
      if (!best || list.length > best.length) best = list;
    }
    if (!best) return;

    var cues = [];
    for (var j = 0; j < best.length; j++) {
      var c = best[j];
      if (!c) continue;
      var txt = DS_PARSE.cleanCueText(c.text);
      if (!txt) continue;
      cues.push({
        start: Number(c.startTime) || 0,
        end: Number(c.endTime) || 0,
        text: txt
      });
    }
    setCues(DS_PARSE.normalizeCues(cues), 'track', '原生字幕轨');
  }

  /* ---------- 字幕源：L3 DOM 兜底 ---------- */

  function commitDom(text) {
    var v = state.video;
    if (!v || !text) return;
    if (text === state.dom.last) return;

    var t = Number(v.currentTime) || 0;
    var arr = state.dom.cues;
    var prev = arr[arr.length - 1];
    if (prev) prev.end = Math.max(prev.end, t);

    arr.push({ start: t, end: t + 2.6, text: text });
    state.dom.last = text;
    if (arr.length > 400) arr.splice(0, arr.length - 400);
    setCues(DS_PARSE.normalizeCues(arr), 'dom', 'DOM 兜底（无预取）');
  }

  function scheduleDom(text) {
    state.dom.pending = text;
    if (state.dom.timer) clearTimeout(state.dom.timer);
    state.dom.timer = setTimeout(function () {
      state.dom.timer = 0;
      commitDom(state.dom.pending);
    }, 130);
  }

  function startDomWatch() {
    if (state.dom.obs || !document.body) return;
    state.dom.obs = new MutationObserver(function (muts) {
      var v = state.video;
      if (!v) return;
      var r;
      try { r = v.getBoundingClientRect(); } catch (e) { return; }
      if (r.height < 60) return;

      for (var i = 0; i < muts.length; i++) {
        var n = muts[i].target;
        var el = n && n.nodeType === 1 ? n : (n && n.parentElement);
        if (!el) continue;
        var txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 160) continue;

        var rr;
        try { rr = el.getBoundingClientRect(); } catch (e) { continue; }
        if (!rr || rr.width < 20 || rr.height < 8 || rr.height > 220) continue;
        if (rr.top < r.top + r.height * 0.5) continue;
        if (rr.bottom < r.top || rr.top > r.bottom + 40) continue;
        if (rr.right < r.left - 40 || rr.left > r.right + 40) continue;

        scheduleDom(txt);
        break;
      }
    });
    try {
      state.dom.obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      log('DOM 兜底已开启');
    } catch (e) { state.dom.obs = null; }
  }

  function stopDomWatch() {
    if (state.dom.obs) { state.dom.obs.disconnect(); state.dom.obs = null; }
    if (state.dom.timer) { clearTimeout(state.dom.timer); state.dom.timer = 0; }
  }

  /* ---------- 视频元素 ---------- */

  function pickVideo() {
    var vids = document.querySelectorAll('video');
    var best = null, bestArea = 0;

    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      var r;
      try { r = v.getBoundingClientRect(); } catch (e) { continue; }
      var area = Math.max(0, r.width) * Math.max(0, r.height);
      if (!best || area > bestArea) { bestArea = area; best = v; }
    }

    if (!best) {
      if (state.video) {
        state.video = null;
        DS_OVERLAY.detach();
        resetCues();
      }
      return;
    }

    var src = '';
    try { src = best.currentSrc || best.src || ''; } catch (e) {}
    var dur = 0;
    try { dur = isFinite(best.duration) ? Math.round(best.duration) : 0; } catch (e) {}
    var key = src + '#' + dur;

    if (best !== state.video) {
      state.video = best;
      DS_OVERLAY.attach(best);
      resetCues();
      state.videoKey = key;
      askCapture();
      log('锁定视频', key.slice(0, 80));
    } else if (key !== state.videoKey && dur > 0) {
      state.videoKey = key;
      resetCues();
      askCapture();
    }
  }

  function resetCues() {
    state.cues = [];
    state.sig = '';
    state.kind = 'none';
    state.sourceLabel = '';
    state.dom.cues = [];
    state.dom.last = '';
    DS_OVERLAY.hide();
  }

  /* ---------- 预取 ---------- */

  function prefetch(t) {
    if (!DS_PIPELINE.canSend()) return;
    var s = state.settings;
    var ahead = Number(s.prefetchAhead);
    if (!isFinite(ahead) || ahead < 5) ahead = 45;
    var batchSize = parseInt(s.batchSize, 10);
    if (!isFinite(batchSize) || batchSize < 1) batchSize = 8;
    if (batchSize > 20) batchSize = 20;

    var list = state.cues;
    var batch = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.state === 'done' || c.state === 'pending' || c.state === 'skip') continue;
      if (c.tries >= 3) { c.state = 'skip'; continue; }
      if (c.start > t + ahead) break;
      if (c.end < t - 2) { c.state = 'skip'; continue; }
      batch.push(c);
      if (batch.length >= batchSize) break;
    }
    if (!batch.length) return;

    for (var j = 0; j < batch.length; j++) batch[j].state = 'pending';

    DS_PIPELINE.submit(batch, function (err, results) {
      for (var k = 0; k < batch.length; k++) {
        var cue = batch[k];
        if (err) {
          cue.state = 'idle';
          cue.tries++;
          continue;
        }
        var zh = results && results[k];
        if (zh) { cue.zh = zh; cue.state = 'done'; }
        else { cue.state = 'idle'; cue.tries++; }
      }
      if (err) log('翻译失败', err.message);
    });
  }

  /* ---------- 主循环 ---------- */

  function tick() {
    pickVideo();

    if (!state.settings.enabled) { DS_OVERLAY.hide(); return; }

    var v = state.video;
    if (!v) { DS_OVERLAY.hide(); return; }

    var now = Date.now();
    if (now - state.lastHarvest > 1500) {
      state.lastHarvest = now;
      harvestTracks();
    }

    var t = Number(v.currentTime) || 0;
    var cue = DS_PARSE.cueAt(state.cues, t);

    if (cue && cue.zh) DS_OVERLAY.show(cue.zh, cue.text);
    else if (cue && state.settings.showMode === 'both') DS_OVERLAY.show('', cue.text);
    else DS_OVERLAY.hide();

    if (state.settings.apiKey) prefetch(t);
  }

  setInterval(tick, 250);
  setTimeout(askCapture, 400);
  setTimeout(askCapture, 2500);

  /* ---------- 状态查询（给 popup 用） ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'ds-status') return;
    var v = state.video;
    if (!v) {
      sendResponse({ ok: true, hasVideo: false });
      return;
    }
    var done = 0;
    for (var i = 0; i < state.cues.length; i++) if (state.cues[i].zh) done++;
    sendResponse({
      ok: true,
      hasVideo: true,
      kind: state.kind,
      source: state.sourceLabel,
      total: state.cues.length,
      done: done,
      playing: !v.paused,
      pipeline: DS_PIPELINE.snapshot(),
      title: String(document.title || '').slice(0, 140)
    });
  });
})();
