/*
 * L4 读屏兜底：当 file / track / dom 三条路都拿不到字幕时，直接读画面像素。
 *
 * 这条路的代价必须摆在明面上：
 *   1. 截图会离开这台电脑，发往 api.deepseek.com（除它之外没有别的去处）。
 *   2. 只有 deepseek-flash 接受图像输入，所以这条链上的模型被强制为 flash，
 *      不受设置页「模型」那一项影响。
 *   3. 每次请求约几百 token，而且是持续发送的 —— 按小时计会产生真实费用。
 *   4. 拿不到完整字幕轨 = 无法预取，中文必然慢半拍。这是结构性的，调参救不了。
 *
 * ── 两个抓帧通道 ──────────────────────────────────────────────
 *   canvas  把 <video> 直接画进 canvas 再导出 JPEG。最准最快、不需要额外权限，
 *           但跨域视频会让 canvas 被「污染」，toDataURL 抛 SecurityError。
 *   tab     让 background 调 chrome.tabs.captureVisibleTab 截下当前可见区域，
 *           本模块按视口比例把视频那块裁出来。不受 CORS 影响，
 *           但只对「当前正在看的那个标签页」有效，后台标签页截不到。
 *           第一次 canvas 抛错后会永久切到这条通道。
 *
 * ── 怎么不烧钱 ────────────────────────────────────────────────
 *   每次抓帧都缩成 64×16 灰度图跟上一帧做差分，没变化就不发请求。字幕换句会带来
 *   明显跳变，而背景的缓慢变化越不过阈值。再叠两层保险：两次请求至少隔
 *   screenInterval，以及无论有没有变化、超过 3 秒都补发一次（防止检测发呆）。
 */

var DS_VISION = (function () {

  var THUMB_W = 64;
  var THUMB_H = 16;

  var TICK_MS = 400;        // 抓帧比对节奏
  var MAX_GAP_MS = 3000;    // 无变化时的强制刷新间隔
  var HOLD_MS = 1300;       // 识别到「没有字幕」后，画面再撑这么久才消失
  var DIFF_THRESHOLD = 0.08;
  var MAX_WIDTH = 1280;     // 送出去的图最大宽度，控制 token

  var video = null;
  var running = false;
  var timer = 0;
  var generation = 0;

  var full = null, fullCtx = null;
  var prevFp = null;

  var inflight = false;
  var lastSentAt = 0;
  var lastDiff = -1;
  var backoffUntil = 0;
  var failStreak = 0;
  var mode = '';            // '' | 'canvas' | 'tab'

  var curZh = '', curEn = '';
  var clearAt = 0;

  var opts = { region: 0.34, minGap: 1500 };

  var stats = {
    grabs: 0, changes: 0, sent: 0, ok: 0, fail: 0, skipped: 0,
    mode: '', note: ''
  };

  function log() {
    if (!opts.debug) return;
    try { console.log.apply(console, ['[字幕翻译·读屏]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  /* ---------- 画布 ---------- */

  function ensureFull(w, h) {
    if (!full) {
      full = document.createElement('canvas');
      fullCtx = full.getContext('2d', { willReadFrequently: true });
    }
    if (full.width !== w || full.height !== h) { full.width = w; full.height = h; }
  }

  /* 指纹是逐点采样的，不需要那张家用的缩略图。 */

  /* 把视频底部 region 那一条画进 canvas。源坐标用视频固有像素，与元素布局无关，
     所以 drawImage 自带 letterbox 处理，不需要自己算黑边。 */
  function drawRegion(v) {
    var vw = v.videoWidth | 0;
    var vh = v.videoHeight | 0;
    if (!vw || !vh) return null;

    var sh = Math.max(8, Math.round(vh * opts.region));
    var outW = Math.min(MAX_WIDTH, vw);
    var outH = Math.max(8, Math.round(sh * outW / vw));

    ensureFull(outW, outH);
    fullCtx.clearRect(0, 0, outW, outH);
    fullCtx.drawImage(v, 0, vh - sh, vw, sh, 0, 0, outW, outH);
    return { w: outW, h: outH };
  }

  /* 64×16 灰度指纹，每格取该格内所有像素的平均亮度（box filter）。
     两种极端都不能用：
       - drawImage 缩图：它的平滑插值把「一行新字幕」摊薄成整块区域的微亮，
         逐格比下来一个都越不过阈值，换句检测不到。
       - 单点采样：采样点只有 1024 个，而字幕笔画往往只有几个像素宽，
         细横画会被整片漏掉，一样检测不到。
     分块平均两头兼顾：笔画贡献被保留在它所在的格子里，格子数又足够少、足够稳。 */
  function fingerprint() {
    var src;
    try { src = fullCtx.getImageData(0, 0, full.width, full.height).data; }
    catch (e) { return null; }

    var out = new Uint8Array(THUMB_W * THUMB_H);
    for (var ty = 0; ty < THUMB_H; ty++) {
      var y0 = Math.floor(ty * full.height / THUMB_H);
      var y1 = Math.max(y0 + 1, Math.floor((ty + 1) * full.height / THUMB_H));
      for (var tx = 0; tx < THUMB_W; tx++) {
        var x0 = Math.floor(tx * full.width / THUMB_W);
        var x1 = Math.max(x0 + 1, Math.floor((tx + 1) * full.width / THUMB_W));

        var sum = 0, n = 0;
        for (var y = y0; y < y1; y++) {
          var row = y * full.width;
          for (var x = x0; x < x1; x++) {
            var i = (row + x) * 4;
            sum += (src[i] * 77 + src[i + 1] * 150 + src[i + 2] * 29) >> 8;
            n++;
          }
        }
        out[ty * THUMB_W + tx] = n ? (sum / n) | 0 : 0;
      }
    }
    return out;
  }

  function diffRatio(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    var changed = 0;
    for (var i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 18) changed++;
    }
    return changed / a.length;
  }

  /* ---------- 抓帧：canvas 通道 ---------- */

  function grabViaCanvas() {
    var v = video;
    if (!v) return { error: new Error('no video') };

    var size;
    try { size = drawRegion(v); }
    catch (e) { return { error: e }; }
    if (!size) return { error: new Error('视频尺寸还没就绪') };

    var url;
    try { url = full.toDataURL('image/jpeg', 0.82); }
    catch (e) { return { error: e }; }   // 跨域污染：SecurityError
    if (!url || url.indexOf('data:image') !== 0) return { error: new Error('导出图像失败') };

    var fp = fingerprint();
    return { url: url, fp: fp, w: size.w, h: size.h };
  }

  /* ---------- 抓帧：标签页截图通道（异步） ---------- */

  function grabViaTab(cb) {
    var gen = generation;
    var v = video;
    if (!v) { cb(null); return; }

    var rect;
    try { rect = v.getBoundingClientRect(); } catch (e) { cb(null); return; }
    if (!rect || rect.width < 40 || rect.height < 30) { cb(null); return; }

    try {
      chrome.runtime.sendMessage({ type: 'ds-grab-tab' }, function (resp) {
        if (gen !== generation) { cb(null); return; }
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.dataUrl) { cb(null); return; }
        cropTabShot(resp.dataUrl, rect, cb);
      });
    } catch (e) { cb(null); }
  }

  /* 截图是「页面内容区的物理像素」，视频 rect 是 CSS 像素，两者差一个缩放系数。
     用 截图宽 / 文档可见宽 求出来，比信任 devicePixelRatio 更稳（页面缩放也算进去了）。 */
  function cropTabShot(dataUrl, rect, cb) {
    var img = new Image();
    var gen = generation;

    img.onload = function () {
      if (gen !== generation) { cb(null); return; }
      var v = video;
      if (!v) { cb(null); return; }

      var docW = document.documentElement.clientWidth || window.innerWidth || 1;
      var scale = img.width / docW;
      if (!isFinite(scale) || scale <= 0) scale = 1;

      var vw = v.videoWidth | 0, vh = v.videoHeight | 0;
      if (!vw || !vh) { cb(null); return; }

      /* 元素里画面是 contain 居中的，黑边要排掉，只裁真实画面那一块。 */
      var aspect = vw / vh;
      var cw = rect.width, ch = rect.height;
      if (aspect > cw / ch) ch = cw / aspect;
      else cw = ch * aspect;
      var cx = rect.left + (rect.width - cw) / 2;
      var cy = rect.top + (rect.height - ch) / 2;

      var sh = Math.max(8, Math.round(ch * opts.region));
      var outW = Math.min(MAX_WIDTH, Math.max(16, Math.round(cw * scale)));
      var outH = Math.max(8, Math.round(sh * scale * outW / Math.max(1, Math.round(cw * scale))));

      try {
        ensureFull(outW, outH);
        fullCtx.clearRect(0, 0, outW, outH);
        fullCtx.drawImage(
          img,
          Math.round(cx * scale), Math.round((cy + ch - sh) * scale),
          Math.round(cw * scale), Math.round(sh * scale),
          0, 0, outW, outH
        );
      } catch (e) { cb(null); return; }

      var url;
      try { url = full.toDataURL('image/jpeg', 0.82); } catch (e) { cb(null); return; }
      cb({ url: url, fp: fingerprint(), w: outW, h: outH });
    };
    img.onerror = function () { cb(null); };
    img.src = dataUrl;
  }

  function grab(cb) {
    if (mode === 'tab') { grabViaTab(cb); return; }

    var r = grabViaCanvas();
    if (r && r.url) { mode = 'canvas'; cb(r); return; }

    /* 只有「读不出像素」才值得退到标签页截图 —— 那说明 canvas 被跨域污染了。
       像「视频尺寸还没就绪」这种一时的问题退过去也没用：截图同样裁不出来，
       平白多一次 IPC。原样报回去，下一轮再试。 */
    var reason = r && r.error;
    if (!reason || reason.name !== 'SecurityError') { cb(null); return; }

    mode = 'tab';
    stats.note = '画面受跨域保护，改用标签页截图';
    log('canvas 被抓帧污染，切到标签页截图');
    grabViaTab(cb);
  }

  /* ---------- 发请求 ---------- */

  function send(imageUrl) {
    var gen = generation;
    inflight = true;
    lastSentAt = Date.now();
    stats.sent++;
    stats.note = '';

    try {
      chrome.runtime.sendMessage({ type: 'ds-translate-image', image: imageUrl }, function (resp) {
        inflight = false;
        if (gen !== generation) return;
        if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message || '消息通道异常'); return; }
        if (!resp) { fail('后台未返回结果'); return; }
        if (!resp.ok) { fail(resp.error || '读屏翻译失败'); return; }
        succeed(resp);
      });
    } catch (e) {
      inflight = false;
      fail('扩展上下文已失效，请刷新页面');
    }
  }

  function succeed(resp) {
    failStreak = 0;
    stats.ok++;
    stats.note = '';

    if (!resp.found || !resp.zh) {
      if (!clearAt) clearAt = Date.now() + HOLD_MS;
      return;
    }

    clearAt = 0;
    var en = String(resp.src || '');
    var zh = String(resp.zh);
    if (zh === curZh && en === curEn) return;

    curZh = zh;
    curEn = en;
    DS_OVERLAY.show(curZh, curEn);
    log('读屏命中', en.slice(0, 40), '→', zh.slice(0, 20));
  }

  function fail(msg) {
    stats.fail++;
    stats.note = String(msg);
    failStreak++;
    if (failStreak >= 3) {
      var wait = Math.min(20000, 1500 * Math.min(failStreak, 8));
      backoffUntil = Date.now() + wait;
    }
    log('读屏失败', msg);
  }

  /* ---------- 定时 ---------- */

  function holdOrClear(now) {
    if (!clearAt || now < clearAt) return;
    clearAt = 0;
    if (!curZh && !curEn) return;
    curZh = '';
    curEn = '';
    DS_OVERLAY.hide();
  }

  function step() {
    var v = video;
    if (!running || !v) return;

    var now = Date.now();
    holdOrClear(now);

    /* 读屏在顶上干活时，覆盖层归我管。主循环的 pickVideo() 一旦重新锁定视频就会
       resetCues() → DS_OVERLAY.hide()，把刚识别出来的那行中文抹掉。每当
       curZh 还在，就顺手把它按回去 —— 幂等，代价只是一次 shadow DOM 文本写入。 */
    if (curZh) DS_OVERLAY.show(curZh, curEn);

    if (v.paused || v.ended) return;        // 暂停时不发请求，画面上那行中文留着
    if (inflight) return;
    if (now < backoffUntil) return;

    grab(function (frame) {
      if (!running || video !== v) return;
      stats.grabs++;

      var changed = true;
      if (frame && frame.fp && prevFp) {
        lastDiff = diffRatio(frame.fp, prevFp);
        changed = lastDiff > DIFF_THRESHOLD;
      } else if (frame && frame.fp) {
        lastDiff = 1;
      }
      if (frame && frame.fp) prevFp = frame.fp;
      if (changed) stats.changes++;

      var gapOk = now - lastSentAt >= opts.minGap;
      var overdue = now - lastSentAt >= MAX_GAP_MS;
      if (!frame || !frame.url) { stats.skipped++; return; }
      if (!gapOk || (!changed && !overdue)) { stats.skipped++; return; }

      send(frame.url);
    });
  }

  /* ---------- 对外 ---------- */

  function setOptions(o) {
    if (!o) return;
    var r = parseFloat(o.region);
    if (isFinite(r) && r > 0.05 && r <= 1) opts.region = r;
    /* minGap 下限放到 0：真实使用不会调这么低（设置页限的是 500），
       但自检需要在「画面一直在变」时压到 0 才能观察「立刻重发」这个行为。
       下限设成 500 会让传进来的 300 / 0 被静默丢掉、退回 1500，
       测试量到的就完全是另一回事了 —— 这类「参数被悄悄吞掉」的坑最难查。 */
    var g = parseInt(o.minGap, 10);
    if (isFinite(g) && g >= 0) opts.minGap = g;
    if (typeof o.debug === 'boolean') opts.debug = o.debug;
  }

  /* 主循环每次 tick 调一次。幂等：已经在跑就只是更新 video 引用。 */
  function pump(v) {
    video = v;
    if (running) return;
    running = true;
    generation++;
    prevFp = null;
    lastSentAt = 0;
    backoffUntil = 0;
    failStreak = 0;
    inflight = false;
    timer = setInterval(step, TICK_MS);
    log('读屏兜底已启动');
  }

  function stop() {
    if (!running && !timer) return;
    running = false;
    generation++;                 // 让还在飞的响应回来后被丢弃
    if (timer) { clearInterval(timer); timer = 0; }
    prevFp = null;
    inflight = false;
    if (curZh || curEn) {
      curZh = '';
      curEn = '';
      DS_OVERLAY.hide();
    }
    clearAt = 0;
    log('读屏兜底已停止');
  }

  function snapshot() {
    return {
      active: running,
      mode: mode || '',
      grabs: stats.grabs,
      changes: stats.changes,
      sent: stats.sent,
      ok: stats.ok,
      fail: stats.fail,
      skipped: stats.skipped,
      note: stats.note,
      zh: curZh,
      en: curEn,
      inflight: inflight,
      backoffMs: Math.max(0, backoffUntil - Date.now()),
      /* 差分实测值：出问题时靠它区分「没抓到帧」和「抓到了但判定没变」 */
      lastDiff: lastDiff,
      /* 已收到「没有字幕」、正在防闪烁倒计时：0 表示没在倒计时 */
      holdMs: clearAt ? Math.max(0, clearAt - Date.now()) : 0
    };
  }

  /* 只给自检用：主动跑一轮抓帧。 */
  return {
    setOptions: setOptions,
    pump: pump,
    stop: stop,
    snapshot: snapshot,
    isRunning: function () { return running; },
    forceStep: step
  };
})();
