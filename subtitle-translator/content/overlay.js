/*
 * 译文覆盖层。只负责「把中文画在视频上」，不掺业务逻辑。
 *
 * 定位方案：一个 position:fixed、height:0 的容器，把 transform 原点放到
 * 「视频底部往上留一点」那条线上；内部 .stack 用 bottom:0 向上生长。
 * 这样字幕块天然从锚点往上堆，不会出现需要预先知道高度的问题。
 *
 * 两个容易翻车的点：
 *   1. 全屏时 body 不在 fullscreen 元素里，fixed 浮层会看不见 → 必须 re-parent。
 *   2. 视频尺寸随窗口/影院模式变化 → rAF 轮询 rect，避免漏掉 resize、滚动、布局抖动。
 */

var DS_OVERLAY = (function () {

  var HOST_ID = '__dssub_overlay_host__';

  var host = null;
  var shadow = null;
  var box = null;
  var lineZh = null;
  var lineEn = null;

  var target = null;
  var rafId = 0;
  var lastKey = '';
  var visible = false;
  var curZh = '';
  var curEn = '';

  var opts = { fontScale: 1, showMode: 'zh' };

  var STYLE = [
    ':host{all:initial}',
    '.wrap{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;',
    'pointer-events:none;opacity:0;transition:opacity .12s linear}',
    '.wrap.on{opacity:1}',
    '.stack{position:absolute;left:0;right:0;bottom:0;display:flex;',
    'flex-direction:column;align-items:center;gap:4px;text-align:center}',
    '.zh,.en{max-width:92%;box-sizing:border-box;padding:.28em .62em;border-radius:6px;',
    'white-space:pre-wrap;word-break:break-word;line-height:1.38;',
    'font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif}',
    '.zh{background:rgba(0,0,0,.66);color:#fff;font-weight:500;text-shadow:0 1px 2px rgba(0,0,0,.9)}',
    '.en{background:rgba(0,0,0,.42);color:#e8e8e8;font-weight:400}',
    '.zh.hide,.en.hide{display:none}'
  ].join('');

  function fullscreenHost() {
    var fe = document.fullscreenElement;
    if (fe) return fe;
    return document.documentElement;
  }

  function mount() {
    var h = fullscreenHost();
    if (host && host.parentNode !== h) h.appendChild(host);
  }

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-dssub', 'overlay');
    host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;';

    shadow = host.attachShadow({ mode: 'open' });

    var st = document.createElement('style');
    st.textContent = STYLE;
    shadow.appendChild(st);

    box = document.createElement('div');
    box.className = 'wrap';

    var stack = document.createElement('div');
    stack.className = 'stack';

    lineZh = document.createElement('span');
    lineZh.className = 'zh';
    lineEn = document.createElement('span');
    lineEn.className = 'en';

    stack.appendChild(lineZh);
    stack.appendChild(lineEn);
    box.appendChild(stack);
    shadow.appendChild(box);

    mount();
  }

  function syncRect() {
    if (!target || !box) return;

    var r;
    try { r = target.getBoundingClientRect(); } catch (e) { return; }
    if (!r || r.width < 40 || r.height < 30) {
      if (visible) { box.classList.remove('on'); visible = false; }
      return;
    }

    var gap = Math.max(8, Math.round(r.height * 0.055));
    var key = [r.left, r.top, r.width, r.height, gap].join(',');
    if (key !== lastKey) {
      lastKey = key;
      box.style.transform = 'translate(' + Math.round(r.left) + 'px,' +
        Math.round(r.top + r.height - gap) + 'px)';
      box.style.width = Math.round(r.width) + 'px';
    }

    var fs = typeof opts.fontScale === 'number' ? opts.fontScale : 1;
    var px = Math.max(13, Math.round(r.height * 0.036 * fs));
    if (lineZh.__px !== px) {
      lineZh.__px = px;
      lineZh.style.fontSize = px + 'px';
      lineEn.style.fontSize = Math.max(11, Math.round(px * 0.78)) + 'px';
    }
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    syncRect();
  }

  function paint() {
    if (!box) return;
    var wantZh = opts.showMode !== 'en';
    var wantEn = opts.showMode === 'both';

    var z = wantZh && curZh ? curZh : '';
    var e = wantEn && curEn ? curEn : '';

    if (lineZh.textContent !== z) lineZh.textContent = z;
    if (lineEn.textContent !== e) lineEn.textContent = e;
    lineZh.classList.toggle('hide', !z);
    lineEn.classList.toggle('hide', !e);

    var has = !!(z || e);
    if (has && !visible) { box.classList.add('on'); visible = true; }
    else if (!has && visible) { box.classList.remove('on'); visible = false; }
  }

  function attach(video) {
    ensure();
    if (target !== video) {
      target = video;
      lastKey = '';
    }
    if (!rafId) loop();
    return host;
  }

  function setOptions(o) {
    if (!o) return;
    if (typeof o.fontScale === 'number') opts.fontScale = o.fontScale;
    if (typeof o.showMode === 'string') opts.showMode = o.showMode;
    lastKey = '';
    paint();
  }

  function show(zh, en) {
    ensure();
    if (zh === curZh && en === curEn) return;
    curZh = zh || '';
    curEn = en || '';
    paint();
  }

  function hide() {
    if (!curZh && !curEn && !visible) return;
    curZh = '';
    curEn = '';
    paint();
  }

  function detach() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    curZh = ''; curEn = '';
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; shadow = null; box = null; lineZh = null; lineEn = null;
    target = null; lastKey = ''; visible = false;
  }

  document.addEventListener('fullscreenchange', function () {
    if (host) { mount(); lastKey = ''; }
  }, true);

  return {
    attach: attach,
    setOptions: setOptions,
    show: show,
    hide: hide,
    detach: detach,
    getTarget: function () { return target; },
    isMounted: function () { return !!(host && host.isConnected); }
  };
})();
