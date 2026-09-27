// DeepSeek 悬浮球：可拖动，松手带惯性，鼠标碰到球时放大一点。
(function () {
  var HOST_ID = '__ds_float_ball__';
  if (document.getElementById(HOST_ID)) return;

  var ICON_PATH = 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45';

  var SIZE = 53;          // 球的直径（比上一版小 5%）
  var EDGE = 6;           // 与屏幕边缘的最小间距
  var FRICTION = 0.90;    // 惯性摩擦：每帧速度乘以它（越小滑得越短）
  var BOUNCE = 0.45;      // 撞墙后垂直分量保留的速度比例
  var MIN_SPEED = 0.3;    // 低于此速度就停下（px/帧）
  var MAX_SPEED = 45;     // 甩出去的速度上限（px/帧）
  var CAPTURE_SPEED = 8;  // 垂直撞边缘的速度达到它，才算"被丢到旁边"，才会吸住
  var MAX_BOUNCES = 3;    // 吸住后，弹够 3 次就彻底贴住
  var EDGE_PULL = 0.35;   // 吸住后朝那条边的拉力（px/帧²）
  var DBL_TAP_MS = 500;   // 两次轻点间隔小于它算双击（Windows 默认双击间隔就是 500ms）
  var STICK_SCALE = 0.94; // 吸死时收拢到几倍
  var TOUCH_SCALE = 1.15; // 鼠标碰到球时放大到几倍
  var TOUCH_MS = 140;     // 放大 / 缩回的过渡时长

  var x = Math.max(EDGE, window.innerWidth - SIZE - 24);
  var y = Math.round(window.innerHeight * 0.6);
  var vx = 0, vy = 0;
  var raf = null;
  var dragging = false;
  var pointerId = null;
  var grabX = 0, grabY = 0;
  var samples = [];
  var hovered = false;
  var hidden = false;     // 面板打开时把球藏起来
  var lastDown = 0;       // 上一次轻点的时间，用来判定双击
  var lastWasTap = false; // 上一次是"轻点"还是"拖动"
  var pressX = 0, pressY = 0, movedFar = false;
  var bounces = 0;        // 被边缘吸住后已经弹了几次
  var edge = null;        // 当前被哪条边吸着（null = 自由状态）
  var attached = null;    // 弹够次数后吸死在边上
  var saveTimer = null;

  // ---------- DOM ----------
  var host = document.createElement('div');
  host.id = HOST_ID;
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('left', '0', 'important');
  host.style.setProperty('top', '0', 'important');
  host.style.setProperty('width', '0', 'important');
  host.style.setProperty('height', '0', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');

  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent =
    '.ball{position:fixed;left:0;top:0;width:' + SIZE + 'px;height:' + SIZE + 'px;' +
    'transform-origin:center;will-change:transform;pointer-events:auto;touch-action:none;' +
    'user-select:none;-webkit-user-select:none;cursor:grab;transition:opacity .16s ease}' +
    '.ball.hidden{opacity:0;pointer-events:none}' +
    '.ball.dragging{cursor:grabbing}' +
    '.inner{width:100%;height:100%;border-radius:50%;background:#4D6BFE;' +
    'display:flex;align-items:center;justify-content:center;' +
    'box-shadow:0 8px 20px rgba(77,107,254,.42),0 2px 6px rgba(0,0,0,.22);' +
    'transition:transform ' + TOUCH_MS + 'ms cubic-bezier(.34,1.56,.64,1)}' +
    '.ball.stuck .inner{transform:scale(' + STICK_SCALE + ');' +
    'box-shadow:0 4px 10px rgba(77,107,254,.34),0 1px 3px rgba(0,0,0,.2)}' +
    '.ball.touched .inner{transform:scale(' + TOUCH_SCALE + ')}' +
    '.ball.drop .inner{transform:scale(1.14);' +
    'box-shadow:0 0 0 3px rgba(77,107,254,.4),0 8px 20px rgba(77,107,254,.45)}' +
    '.icon{width:28px;height:28px;color:#fff}' +
    '.icon svg{width:100%;height:100%;display:block;fill:currentColor}' +
    // 划词后的一行小动作。host 是 pointer-events:none，所以这里要显式打开。
    // position:fixed 相对视口 —— 和 getBoundingClientRect() 是同一套坐标。
    // 菜单自带深色底 + 白字：网页有深有浅，靠"跟随网页"必然有一半看不清。
    '.selbar{position:fixed;display:none;align-items:center;gap:2px;padding:3px;z-index:2;' +
    'pointer-events:auto;border-radius:10px;background:rgba(28,29,32,.95);' +
    'box-shadow:0 6px 18px rgba(0,0,0,.3);flex-wrap:wrap;max-width:92vw;' +
    'font:12px/1.4 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif}' +
    '.selbtn{border:0;background:transparent;color:#fff;cursor:pointer;white-space:nowrap;' +
    'font:inherit;padding:3px 8px;border-radius:7px}' +
    '.selbtn:hover{background:rgba(255,255,255,.16)}' +
    '.selbtn:first-child{background:rgba(77,107,254,.9)}' +
    '.selbtn:first-child:hover{background:#4D6BFE}';

  var ball = document.createElement('div');
  ball.className = 'ball';

  var inner = document.createElement('div');
  inner.className = 'inner';

  var icon = document.createElement('div');
  icon.className = 'icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="' + ICON_PATH + '"/></svg>';

  inner.appendChild(icon);
  ball.appendChild(inner);
  root.appendChild(style);
  root.appendChild(ball);

  // ---------- 工具 ----------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function maxX() { return Math.max(EDGE, window.innerWidth - SIZE - EDGE); }
  function maxY() { return Math.max(EDGE, window.innerHeight - SIZE - EDGE); }

  function applyPos() {
    ball.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  }

  function updateTouch() {
    ball.classList.toggle('touched', hovered || dragging);
  }

  // 鼠标尖碰到球就放大：按圆形范围判定，而不是方形外框
  function checkTouch(e) {
    if (hidden) return;   // 面板开着的时候球是藏起来的，不参与判定
    var dx = e.clientX - (x + SIZE / 2);
    var dy = e.clientY - (y + SIZE / 2);
    var r = SIZE / 2;
    var hit = dx * dx + dy * dy <= r * r;
    if (hit === hovered) return;
    hovered = hit;
    updateTouch();
  }

  function leaveTouch() {
    if (!hovered) return;
    hovered = false;
    updateTouch();
  }

  function savePos() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        chrome.storage.local.set({
          dsBallPos: { rx: x / window.innerWidth, ry: y / window.innerHeight }
        });
      } catch (e) { /* 权限被收回时忽略 */ }
    }, 200);
  }

  // ---------- 惯性 ----------
  function snapToEdge(edge) {
    if (edge === 'left') x = EDGE;
    else if (edge === 'right') x = maxX();
    else if (edge === 'top') y = EDGE;
    else if (edge === 'bottom') y = maxY();
    x = clamp(x, EDGE, maxX());
    y = clamp(y, EDGE, maxY());
    applyPos();
  }

  function stick(edge) {
    vx = 0;
    vy = 0;
    attached = edge;
    ball.classList.add('stuck');
    snapToEdge(edge);
    updateTouch();
    raf = null;
    savePos();
  }

  function tick() {
    if (attached) { raf = null; return; }

    // 一旦被某条边吸住，之后每帧都朝那条边拉，所以它跑不掉、只会越贴越紧
    if (edge === 'left') vx -= EDGE_PULL;
    else if (edge === 'right') vx += EDGE_PULL;
    else if (edge === 'top') vy -= EDGE_PULL;
    else if (edge === 'bottom') vy += EDGE_PULL;

    x += vx;
    y += vy;
    vx *= FRICTION;
    vy *= FRICTION;

    var hitX = x <= EDGE ? -1 : (x >= maxX() ? 1 : 0);
    var hitY = y <= EDGE ? -1 : (y >= maxY() ? 1 : 0);
    if (hitX) x = hitX < 0 ? EDGE : maxX();
    if (hitY) y = hitY < 0 ? EDGE : maxY();

    if (hitX || hitY) {
      var vxAbs = Math.abs(vx), vyAbs = Math.abs(vy);
      // 撞得最狠的那个轴说了算：它决定这次算"丢过去"还是"擦着走"
      var useX = !!hitX && (!hitY || vxAbs >= vyAbs);
      var name = useX ? (hitX < 0 ? 'left' : 'right') : (hitY < 0 ? 'top' : 'bottom');
      var speed = useX ? vxAbs : vyAbs;

      if (edge || speed >= CAPTURE_SPEED) {
        // 被丢到旁边：进入吸附（或者已经在吸附中）
        if (edge && bounces >= MAX_BOUNCES) {   // 弹够了，这次不再回弹，直接吸死
          stick(name);
          return;
        }
        edge = name;
        bounces++;
      }

      // 不管吸不吸，都只反转垂直分量，沿边的那一份惯性保留下来
      if (useX) vx = -vx * BOUNCE;
      else vy = -vy * BOUNCE;
    }

    if (!edge) {   // 自由状态下才会自然停住；吸住状态由拉力接管
      if (Math.abs(vx) < MIN_SPEED) vx = 0;
      if (Math.abs(vy) < MIN_SPEED) vy = 0;
    }

    applyPos();

    if (!edge && vx === 0 && vy === 0) {
      raf = null;
      savePos();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function startInertia() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function velocityFromSamples() {
    if (samples.length < 2) return { vx: 0, vy: 0 };
    var now = performance.now();
    var last = samples.length - 1;
    // 只取「松手前 90ms 内」的采样，i 停在窗口里最老的那一个
    var i = last;
    while (i > 0 && now - samples[i - 1].t < 90) i--;
    var a = samples[i];
    var b = samples[last];
    var dt = (b.t - a.t) || 16;
    return {
      vx: clamp((b.x - a.x) / dt * 16, -MAX_SPEED, MAX_SPEED),
      vy: clamp((b.y - a.y) / dt * 16, -MAX_SPEED, MAX_SPEED)
    };
  }

  // ---------- 拖动 ----------
  function onDown(e) {
    if (e.button !== 0) return;

    // 双击判定必须自己做：上面调了 preventDefault()，Chrome 就不会再派发
    // click / dblclick 这类兼容鼠标事件，挂 dblclick 监听永远不会触发。
    // 而且只认"轻点"——上一次如果是拖动，再快也不算双击。
    var now = performance.now();
    if (lastWasTap && now - lastDown < DBL_TAP_MS) {
      lastDown = 0;
      lastWasTap = false;
      if (window.__dsPanel) {
        window.__dsPanel.toggle();
      } else {
        console.error('[DeepSeek 悬浮球] 面板脚本没有加载：去 chrome://extensions 看本扩展有没有"错误"，' +
          '并且确认这个页面按过 F5（扩展刷新后，旧标签页不会自动补注入）');
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    lastDown = now;
    lastWasTap = false;
    pressX = x;
    pressY = y;
    movedFar = false;

    dragging = true;
    pointerId = e.pointerId;
    ball.classList.add('dragging');
    bounces = 0;              // 重新抓起来，弹跳次数和被吸附状态一并重置
    edge = null;
    attached = null;
    ball.classList.remove('stuck');
    updateTouch();
    // 布局原点就是 (x, y)，缩放发生在子元素上，所以不用读 getBoundingClientRect
    grabX = e.clientX - x;
    grabY = e.clientY - y;
    samples = [{ t: performance.now(), x: x, y: y }];
    vx = 0; vy = 0;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    try { ball.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    x = clamp(e.clientX - grabX, EDGE, maxX());
    y = clamp(e.clientY - grabY, EDGE, maxY());
    if (!movedFar && (Math.abs(x - pressX) > 4 || Math.abs(y - pressY) > 4)) movedFar = true;
    samples.push({ t: performance.now(), x: x, y: y });
    if (samples.length > 12) samples.shift();
    applyPos();
    e.preventDefault();
    e.stopPropagation();
  }

  function onUp(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    ball.classList.remove('dragging');
    // 记下这次是轻点还是拖动：只有轻点才有资格参与双击判定
    lastDown = performance.now();
    lastWasTap = !movedFar;
    checkTouch(e);
    updateTouch();
    var v = velocityFromSamples();
    vx = v.vx; vy = v.vy;
    if (Math.abs(vx) > 0.4 || Math.abs(vy) > 0.4) startInertia();
    else savePos();
  }

  ball.addEventListener('pointerdown', onDown);
  ball.addEventListener('pointermove', onMove);
  ball.addEventListener('pointerup', onUp);
  ball.addEventListener('pointercancel', onUp);
  ball.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  ball.addEventListener('click', function (e) { e.stopPropagation(); });

  // 给面板用：图标路径 + 球当前的位置 + 开合面板时藏/显示球
  window.__DS_ICON_PATH = ICON_PATH;
  window.__DS_BALL = function () { return { x: x, y: y, size: SIZE }; };
  window.__DS_BALL_VISIBLE = function (v) {
    hidden = !v;
    ball.classList.toggle('hidden', hidden);
    if (hidden) { hovered = false; }
    updateTouch();
  };

  // ---------- 把文件 / 文字 / 图片拖到球上 ----------
  // 拖进来就开小窗提问（面板会自己判断尺寸）
  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
    ball.classList.add('drop');
  }
  function onDragLeave() {
    ball.classList.remove('drop');
  }
  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    ball.classList.remove('drop');
    if (window.__dsPanel && window.__dsPanel.openWithDrop) {
      // dataTransfer 只在事件同步阶段能读，里面必须立刻取数据
      window.__dsPanel.openWithDrop(e.dataTransfer);
    }
  }
  ball.addEventListener('dragenter', onDragOver);
  ball.addEventListener('dragover', onDragOver);
  ball.addEventListener('dragleave', onDragLeave);
  ball.addEventListener('drop', onDrop);

  // 鼠标在页面任何位置移动都要判断有没有碰到球，所以监听 window
  window.addEventListener('pointermove', checkTouch, true);
  window.addEventListener('pointerdown', checkTouch, true);
  window.addEventListener('blur', leaveTouch);
  document.addEventListener('mouseleave', leaveTouch);

  window.addEventListener('resize', function () {
    if (attached) snapToEdge(attached);   // 被吸住时换窗口大小，仍然贴着那条边
    x = clamp(x, EDGE, maxX());
    y = clamp(y, EDGE, maxY());
    applyPos();
    savePos();
  });

  // ---------- 挂载 ----------
  (document.body || document.documentElement).appendChild(host);

  // ---------- 划词提问 ----------
  // 选中网页上的文字，旁边冒一行小动作，点一下把它送进面板的 chips 区 ——
  // **显示成蓝色小块，不把正文灌进输入框**（选一段长文时，输入框得留给你自己写字）。
  // 发送那一刻才拼进消息，见 panel.js 的 askSelection / send()。
  // 动作列表在 config.js 的 selectionActions 里；挂成 chip 后**不自动发送**，你还能补一句。
  var selBar = null;
  var selAskName = (window.DS_CONFIG && window.DS_CONFIG.assistant && window.DS_CONFIG.assistant.name) || 'AI';
  // 列表容错：允许只写字符串（当按钮文字用，不带提示词），也允许 {label, prompt}
  var selActions = (function () {
    var list = (window.DS_CONFIG && window.DS_CONFIG.selectionActions) || [];
    if (!Array.isArray(list)) { return []; }
    var out = [];
    list.forEach(function (a) {
      if (!a) { return; }
      var label = String((typeof a === 'string' ? a : a.label) || '').trim();
      if (!label) { return; }
      out.push({ label: label, prompt: String((typeof a === 'string' ? '' : a.prompt) || '') });
    });
    return out;
  })();

  function selText() {
    try {
      var s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) { return ''; }
      return String(s.toString() || '').trim();
    } catch (e) { return ''; }
  }

  function hideSel() {
    if (selBar) { selBar.style.display = 'none'; }
  }

  // 在面板自己的输入框里选字不该弹这个（那是编辑，不是提问）。
  // 面板在另一个 shadow 里，所以只能顺着 getRootNode() 找到它的宿主来判断。
  function insidePanel() {
    try {
      var s = window.getSelection();
      var n = s && s.anchorNode;
      var el0 = n && (n.nodeType === 1 ? n : n.parentNode);
      var rt = el0 && el0.getRootNode ? el0.getRootNode() : null;
      return !!(rt && rt.host && rt.host.id === '__ds_float_panel__');
    } catch (e) { return false; }
  }

  // 刚点完的一小段时间内不许再弹：点了就该消失，别过几十毫秒又冒回来
  var selMute = 0;
  // 弹菜单时就把文字记下来。点击时优先用记下的这份 ——
  // 有些网站（在线文档、PDF 阅读器）会自己处理 mousedown，选区可能已经被清掉，
  // 那时候再去读 window.getSelection() 就是空的，表现同样是"点了没反应"。
  var selCache = '';

  // 判断事件是不是落在"划词菜单"上。
  //
  // 这里**不能**直接写 e.target === selBar：菜单在球的 shadow DOM 里，
  // 事件冒到 document 时 target 会被重定向成宿主（__ds_float_ball__），
  // 所以那个判断永远为假 —— 一按下就把菜单 display:none 了，mouseup 落空、
  // click 不触发，表现就是"看得见菜单但点不动"。必须用 composedPath()，
  // 而且菜单是**容器**（里面若干小按钮），所以判断要覆盖整棵子树。
  function isSelBar(e) {
    if (!selBar) { return false; }
    if (e.target === selBar) { return true; }
    var p = e.composedPath ? e.composedPath() : null;
    return !!(p && p.indexOf(selBar) >= 0);
  }

  // 按下去就拦住：否则这一下会先把选区清掉，菜单自己也跟着被隐藏
  function stopPress(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function runSelAction(label, prompt) {
    var t = selText() || selCache;
    selMute = Date.now() + 400;      // 点了就别再自己冒回来
    hideSel();
    if (!t) { return; }
    // 交给面板挂一枚蓝色 chip（**不往输入框里灌正文** —— 选一段长文时那会把输入框糊满）。
    // 真正拼进消息是发送那一刻做的：提示词 + 选中的文字。
    try {
      if (window.__dsPanel && window.__dsPanel.askSelection) {
        window.__dsPanel.askSelection({ label: label, prompt: prompt, text: t });
        return;
      }
    } catch (err) { /* 面板没起来，走下面的兜底 */ }
    // 兜底：面板没跑起来（扩展刚更新过之类），至少把文字给你留在剪贴板里
    try { navigator.clipboard.writeText(t); } catch (err) {}
  }

  function addSelAction(label, prompt, title) {
    var b = document.createElement('button');
    b.className = 'selbtn';
    b.type = 'button';
    b.textContent = label;
    b.title = title || label;
    b.addEventListener('mousedown', stopPress);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      runSelAction(label, prompt);
    });
    selBar.appendChild(b);
    return b;
  }

  function ensureSelBar() {
    if (selBar) { return selBar; }
    selBar = document.createElement('div');
    selBar.className = 'selbar';
    // 点在菜单的空白处（按钮之间的缝）也别把选区清了
    selBar.addEventListener('mousedown', stopPress);
    // 第一颗固定是「问 X」：只把选中的文字填进去、不加提示词 ——
    // 想自己组织问题的人走这颗，后面那些快捷动作只是省打字。
    addSelAction('问 ' + selAskName, '', '把选中的文字挂成一块 chip，不加提示词（自己想怎么问就怎么问）');
    selActions.forEach(function (a) { addSelAction(a.label, a.prompt, a.prompt || a.label); });
    root.appendChild(selBar);
    return selBar;
  }

  function showSel() {
    if (Date.now() < selMute) { hideSel(); return; }
    var t = selText();
    // 注意：这里**不能**因为"面板开着"（hidden 为真）就跳过 —— 面板是浮动的，
    // 用户很可能一边看着回答、一边回网页上再选一段来追问，那正是这个菜单最该出现的时候。
    if (!t || t.length < 2 || dragging || insidePanel()) { hideSel(); return; }
    var r = null;
    try {
      var s = window.getSelection();
      var rect = s.getRangeAt(s.rangeCount - 1).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) { r = rect; }
    } catch (e) {}
    if (!r) { hideSel(); return; }

    var bar = ensureSelBar();
    selCache = t;                  // 记下来，点击时用（见 selCache 的说明）
    bar.style.display = 'flex';
    var bw = bar.offsetWidth || 220, bh = bar.offsetHeight || 26;
    // 居中在选区上方（一整行比原来那颗小按钮宽得多，右对齐会偏出去）
    var left = r.left + (r.width - bw) / 2;
    left = Math.min(Math.max(6, left), Math.max(6, window.innerWidth - bw - 6));
    var top = r.top - bh - 6;
    if (top < 6) { top = Math.min(r.bottom + 6, Math.max(6, window.innerHeight - bh - 6)); }
    bar.style.left = Math.round(left) + 'px';
    bar.style.top = Math.round(top) + 'px';
  }

  document.addEventListener('mouseup', function () {
    // mouseup 那一刻选区还没定下来，挪到下一轮事件循环再看
    setTimeout(showSel, 0);
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (isSelBar(e)) { return; }
    hideSel();
  }, true);
  document.addEventListener('scroll', hideSel, true);
  window.addEventListener('resize', hideSel);

  // ---------- 快捷键：把选中的文字送进面板（background.js 转发过来）----------
  // 跟"点划词菜单第一颗（问 Nova）"**同一条路** —— 直接复用 runSelAction，
  // 别在这儿再写一遍读选区的逻辑（那种重复迟早两边不一致）。
  try {
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (m, sender, respond) {
        if (!m || m.type !== 'ds-ask-selection') { return; }
        var t = selText() || selCache;
        if (!t) {
          // 没选中就别静默：把面板叫出来 + 给一句话，总比"按了没反应"强
          try {
            if (window.__dsPanel && window.__dsPanel.open) { window.__dsPanel.open(); }
            if (window.__dsPanel && window.__dsPanel.toast) {
              window.__dsPanel.toast('没有选中文字 —— 先在网页上选一段，再按这个键');
            }
          } catch (e) { /* 面板没起来就算了 */ }
          respond({ ok: false, reason: 'no-selection' });
          return true;
        }
        runSelAction('问 ' + selAskName, '');
        respond({ ok: true, chars: t.length });
        return true;
      });
    }
  } catch (e) { /* 老环境没有这个 API */ }

  ball.title = '双击打开对话';
  applyPos();

  try {
    chrome.storage.local.get('dsBallPos', function (d) {
      var p = d && d.dsBallPos;
      if (!p || typeof p.rx !== 'number' || typeof p.ry !== 'number') return;
      x = clamp(p.rx * window.innerWidth, EDGE, maxX());
      y = clamp(p.ry * window.innerHeight, EDGE, maxY());
      applyPos();
    });
  } catch (e) { /* 忽略 */ }
})();
