// ============================================================
//  DeepSeek 悬浮球 · 对话面板
//  和 content.js 一样是 content script，共用同一个隔离环境（所以能直接调
//  window.__dsPanel / window.__DS_BALL）。双击悬浮球打开，Esc 或右上角退出。
// ============================================================
(function () {
  'use strict';

  var cfg = window.DS_CONFIG || {};
  var A = cfg.assistant || {};
  var PANEL_ID = '__ds_float_panel__';
  var K_CHATS = '__ds_chats__';
  var K_CUR = '__ds_cur__';
  var K_MODEL = '__ds_model__';
  var K_EFFORT = '__ds_effort__';   // 思考强度（reasoning_effort：none / low / medium / high）
  var K_RECO = '__ds_imgreco__';    // 「推荐图片」开关（每轮回答末尾附几个配图搜索词）
  var K_SIZE = '__ds_size__';   // 面板几何：{ full:{w,h,left,top}, mini:{w,h,left,top} }
  var K_LANG = '__ds_lang__';   // 界面语言 'zh' / 'en'（设置页和面板共用这一个键）

  // ---------------- 界面语言 ----------------
  // 面板文案走 i18n.js 那份词表（设置页用的是同一份）。规矩和那边一样：
  //   · 中英各一份，某个 key 缺了就回落中文，**不会把 key 本身露到界面上**；
  //   · {name} 是占位符，调用方把值传进来替换；
  //   · 只翻"用户眼睛看得到的" —— 拼进请求体的那些标记（【附件 …】/【当前网页：…】）
  //     一律不动：它们是喂给模型的，跟着界面语言变会让模型看到中英混杂的上下文。
  var LANG = 'zh';
  function tr(key, vars, dflt) {
    var D = window.DS_I18N || {};
    var pack = (LANG === 'en' && D.en) ? D.en : (D.zh || {});
    var s = pack[key];
    if (typeof s !== 'string') { s = (D.zh || {})[key]; }   // 缺词回落中文
    if (typeof s !== 'string') {                            // 两边都缺：用调用方给的兜底文案
      return typeof dflt === 'string' ? dflt : String(key);
    }
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      var v = vars ? vars[k] : null;
      return v == null ? m : String(v);
    });
  }
  // 拉角能拉到多小（全窗 / 小窗），比默认尺寸小，但不能小到工具条挤成一团
  // 默认标题是**存储里的固定值**，用来判断"这条还没起名"。它不随界面语言变 ——
  // 变的话（比如英文下写成 "New chat"）老记录和判断逻辑都会对不上。
  var NEW_TITLE = '新对话';
  var MIN_W = { full: 300, mini: 240 };
  var MIN_H = { full: 320, mini: 240 };

  // 宿主模式：这个面板不是"画在网页上的浮窗"，而是跑在浏览器自己的容器里（比如侧边栏）。
  // 承载它的页面在 open() 之前设 window.__DS_HOST 就行（侧边栏那份就是 sidepanel.js 干的）。
  // 差别只有两点，别的一律不动：
  //   ① 一打开就铺满整个容器 —— 那儿没有"浮在网页上、能拖来拖去"这回事；
  //   ② 藏掉「全屏 ⛶」「退出 ✕」「应用网页」三个按钮 ——
  //      铺满了之后全屏没意义；"退出"只会退出一片空白（关侧栏该用浏览器自己的按钮）；
  //      「应用网页」读的是当前页面的 DOM，在侧边栏里读到的是侧边栏自己，等于没用。
  // 写成函数而不是顶部常量：面板脚本是共用一份的，宿主页面在它之后才设标记也来得及。
  function isHost() { return !!window.__DS_HOST; }
  var MAX_FILE = 512 * 1024;            // 文本附件上限（原 200KB）
  var MAX_TEXT_SENT = 200000;           // 单个文本附件真正发出去的上限（字符），超出截断
  var MAX_IMG_FILE = 40 * 1024 * 1024;  // 图片原图上限，选进来后会先压缩再发
  var IMG_MAX_SIDE = 1536;              // 压缩后最长边（官方会把图缩到约 1300×1300，压到这里不亏）
  var IMG_QUALITY = 0.85;               // 压缩成 JPEG 的质量
  var KEEP_PNG_BELOW = 2e6;             // 小于这个体积的 PNG 保留原样（可能有透明通道）
  // 图片快捷提示词（config.js）：按钮文字，以及要不要"图片一进附件就自动填"。
  // 英文界面下，**只有还用着默认那句**才换成词表里的英文 —— 用户自己改过 config 的那句
  // 一定原样保留（他写的就是他要的，我们没资格替他翻译）。
  var IMG_PROMPT_CFG = (typeof cfg.imagePrompt === 'string') ? cfg.imagePrompt : '这是什么？';
  var IMG_PROMPT = IMG_PROMPT_CFG;
  function syncImgPromptText() {
    IMG_PROMPT = (LANG === 'en' && IMG_PROMPT_CFG === '这是什么？') ? tr('p.imgPrompt') : IMG_PROMPT_CFG;
  }
  var IMG_PROMPT_AUTO = !!cfg.autoFillImagePrompt;
  var MAX_PAGE = 60000;                 // 抓网页正文的上限（字符），超出截断
  // 历史对话发给模型的预算（字符）。KEEP_RECENT 是硬下限：哪怕一条消息就吃满预算，
  // 最近这几条也一定带上，否则连"你刚才说的那个"都答不了。
  //
  // 为什么是 30 万（2026-10-08 改，依据官方现行文档）：
  //   ① 上下文上限其实是 **1M token**，30 万中文字符≈20 万 token，还留着 4 倍余量。
  //      原来那个 8 万离上限差 20 倍 —— 它根本没在防"上下文超长"报错，是白紧张。
  //   ② 更要命的是**缓存**：命中价 $0.003/M、未命中 $0.15/M，**差 50 倍**；
  //      而命中的条件是"前缀要完整匹配一个 cache unit"（官方 kv_cache 文档）。
  //      原来一超预算就从**头部**丢消息 → 前缀整体错位 → 此后每一轮**全按未命中价**计费。
  //      「砍历史」看着是省 token，实际把缓存打碎了，反而贵得多。
  //   ③ 代价只是请求体大一点：30 万字符≈0.9MB，本地上传不到一秒。
  var MAX_CTX_CHARS = 300000;
  // 超预算要从第几条开始带，算出来的下标再**按这个数取整**（见 ctxWindow）。
  //
  // 上面②只说了一半："从头部丢消息会让前缀错位"。真正难缠的是**持续性** ——
  // 对话一旦越过 MAX_CTX_CHARS，每轮都会新增长度，于是**每一轮都得再往前丢一点**，
  // 起始下标每轮都在动 → 请求前缀每轮都在变 → 缓存从那一刻起**永久 0 命中**，
  // 整段历史全按未命中价计费（和命中差 50 倍）。"砍历史"省下来的那点 token，
  // 远不如把缓存打碎亏得多。
  //
  // 取整就是解药：每轮下标只挪 1~2 条，取整到 8 的倍数之后**连续好几轮落在同一档**，
  // 这几轮的请求层层嵌套（上一轮的整个请求就是这一轮的前缀）→ 缓存整段命中；
  // 只有跨档那一轮要重来。代价是取整会多丢几条历史（最多 7 条），完全值。
  var CTX_CHUNK = 8;
  var KEEP_RECENT = 12;
  // 历史里**还带图**的消息条数上限。官方一张图最多算 1024 token，钱其实不多，
  // 但一张图压完也是几万字符的 data URL，每轮把老图重发一遍纯粹是在撑大请求体、拖慢上传。
  // 留最近这几条（连着看图追问够用了），更早的只发文字。
  var MAX_CTX_IMAGES = 3;
  // 「清理旧对话」默认删掉多少天前的（历史抽屉底部那个按钮）
  var CLEAN_DAYS = 30;
  var MAX_PAGE_IMAGES = 8;              // 页面最多带几张图
  var MAX_IMAGES_TOTAL = 12;            // 单次请求图片总数上限
  var MAX_DATA_URL = 1.5e6;             // 页面内 data: 图片的字符上限
  var TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|css|scss|less|html|htm|xml|yml|yaml|toml|ini|conf|log|csv|tsv|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|bat|ps1|sql|vue|svelte)$/i;

  var host = null, root = null, el = {};
  var mem = {};
  var state = {
    chats: [], cur: null,
    model: cfg.model || (modelList()[0] && modelList()[0].id) || 'deepseek-flash',
    effort: cfg.effort || (effortList()[0] && effortList()[0].id) || 'medium',
    atts: [], sending: false, ac: null, ready: false,
    sel: [],           // 划词送进来的：{ label, prompt, text } —— 显示成蓝色 chip，发送时拼进消息
    reading: 0,        // 正在读的图片文件数（FileReader 是异步的）
    compact: false,    // true = 小窗（拖拽进来时开的那个）
    pageMode: null,    // null=关 / 'full'=读整页 / 'view'=只读屏幕可见区
    ctxOmitted: 0,     // 上一次发出去时省略了多少条历史（只用来提示，不落库）
    ctxKept: 0,        // 上一次实际带上了多少条（不含系统提示词）
    pageCtx: null,     // 开启时记下显示信息：{ title, chars, images, mode }
    recoImg: false,    // 「推荐图片」开关：开了就在每轮回答末尾让模型给几个配图搜索词（存在浏览器里）
    dead: {},          // 本会话里删掉的对话 id。合并写盘时要把它们排除，否则会被磁盘版本"救回来"
    seen: {},          // 在存储里见过的对话 id（= 至少被写过一次）。用来判断"别处把它删了"
    syncPending: false,// 正在吐字时收到别的窗口的写入 → 先记下，等这一轮结束再对齐
    histIdx: -1,       // 输入框里按 ↑ 翻自己发过的话，翻到第几条（-1 = 没在翻）
    histDraft: '',     // 开始翻历史之前输入框里那半句话，翻回底部时原样还给你
    fs: false,         // 是否全屏（每次打开都从非全屏开始）
    preFs: null,       // 进全屏前的大小，退出时还原
    size: null         // 存在本地存储里的自定义尺寸
  };

  // 模型列表：config.js 里既能写字符串，也能写 { label, id, vision }。
  // label 只用于显示，id 才是发给接口的 model 字段，vision 表示能不能看图。
  function modelList() {
    var raw = (cfg.models && cfg.models.length) ? cfg.models : ['deepseek-flash', 'deepseek-v4-pro'];
    return raw.map(function (m) {
      if (typeof m === 'string') { return { label: m, id: m, vision: true }; }
      return { label: m.label || m.id, id: m.id, vision: m.vision !== false };
    });
  }

  // 当前模型能不能看图（config 里没写就按"能"处理）
  function canSeeImages() {
    var cur = modelList().filter(function (m) { return m.id === state.model; })[0];
    return cur ? cur.vision !== false : true;
  }

  // 思考强度列表（config.js 的 efforts）。跟模型一样：label 显示用，id 是发给接口的值。
  // 接口认的是 reasoning_effort：none = 完全不思考，low/medium/high 越想越多。
  function effortList() {
    var raw = (cfg.efforts && cfg.efforts.length)
      ? cfg.efforts
      : ['none', 'low', 'medium', 'high'];
    return raw.map(function (m) {
      if (typeof m === 'string') { return { label: m, id: m }; }
      return { label: m.label || m.id, id: m.id };
    });
  }

  // ---------------- 存储 ----------------
  function hasStore() {
    try { return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local; }
    catch (e) { return false; }
  }
  // 在 chrome://extensions 里点过"刷新"之后，已经打开的页面里那份旧脚本会失去扩展上下文，
  // 之后任何 chrome.* 调用都会抛 "Extension context invalidated"。这里统一兜住。
  function ctxAlive() {
    try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }
  function kv(k, v) { var o = {}; o[k] = v; return o; }
  function load(k) {
    return new Promise(function (res) {
      try {
        if (hasStore()) { chrome.storage.local.get(k, function (d) { res(d ? d[k] : undefined); }); return; }
      } catch (e) { /* 上下文已失效，退回到内存 */ }
      res(mem[k]);
    });
  }
  function save(k, v) {
    mem[k] = v;
    try { if (hasStore()) chrome.storage.local.set(kv(k, v)); } catch (e) {}
    return Promise.resolve();
  }
  // 存之前必须剥掉挂在消息上的 DOM 引用（$body / $think），
  // 否则 chrome.storage 序列化会失败。
  function plainChats() {
    return state.chats.map(function (c) {
      return {
        id: c.id,
        title: c.title,
        // 「回到某条之前」留下的截断标记（见 mergedMessages）。没有就不写这两个字段。
        cutAt: (typeof c.cutAt === 'string') ? c.cutAt : undefined,
        cutTs: c.cutAt ? c.cutTs : undefined,
        updatedAt: c.updatedAt,
        messages: (c.messages || []).map(function (m) {
          return {
            mid: m.mid,          // 消息的身份：两个窗口合并时靠它认"这条是不是同一条"
            role: m.role,
            ts: m.ts,            // 什么时候说的（一个数字，比 reasoning 还小）
            content: m.content,
            show: m.show,
            reasoning: m.reasoning,
            attachments: m.attachments,
            usage: m.usage     // 这一轮的用量（几个数字，比 reasoning 还小）：重开面板还能看见"当时花了多少"
          };
        })
      };
    });
  }

  // ---------------- 多窗口 / 多标签页的同步 ----------------
  // 面板可能同时在两个地方开着（两个标签页，或者网页上的浮窗 + 侧边栏），两边各有一份内存。
  // 要解决两件事：
  //   ① 写盘别把对方盖掉 —— 写之前先把磁盘那份读回来，按**对话**合并，再按**消息**合并；
  //   ② 别处改的这边要能看见 —— 收到 onChanged 就把变化并进内存，正在看的对话当场重画。
  // 消息用 mid 认身份（建的时候就发一个），所以两边同时往一个对话里打字也不会互相吃掉；
  // 更早的（存量的）消息没有 mid，退化成"角色 + 正文"当指纹 —— 只影响这种边界情况的先后顺序，
  // 不会丢东西。
  function msgKey(m) {
    if (m && m.mid) { return 'i' + m.mid; }
    return 'c' + String((m && m.role) || '') + '\u0000' + String((m && (m.show || m.content)) || '').slice(0, 160);
  }
  function lenOf(m) { return String((m && m.show) || '').length + String((m && m.content) || '').length; }

  // 同一个对话的两份消息合成一份：以条数多的那份为底（顺序最接近真实推进），
  // 另一份里"底上没有的"补在后面；同一条两边都有时**取更完整的那份** ——
  // 流式写到一半的版本和最终版就是靠这个挑对的。
  function mergeMessages(mine, theirs) {
    var a = mine || [], b = theirs || [];
    var base = a.length >= b.length ? a : b;
    var other = (base === a) ? b : a;
    var byKey = {};
    other.forEach(function (m) { byKey[msgKey(m)] = m; });
    var used = {}, out = [];
    base.forEach(function (m) {
      var k = msgKey(m);
      used[k] = 1;
      var o = byKey[k];
      if (!o) { out.push(m); return; }
      if (lenOf(o) > lenOf(m)) {
        // 用对方那份（更完整），但图片只在内存里 —— 顺手把本地那份的带过来，别弄丢
        if (m.apiContent) { o.apiContent = m.apiContent; }
        out.push(o);
      } else {
        out.push(m);
      }
    });
    other.forEach(function (m) {
      var k = msgKey(m);
      if (!used[k]) { used[k] = 1; out.push(m); }
    });
    return out;
  }
  // 「回到某条之前」是**故意**删掉后面那些的。两边合消息时，对方那份里还留着的旧尾巴
  // 不能再救回来 —— 所以截断过的那份会在存储里留一条 cutAt（保留到哪条为止，存的是那一条的 key）。
  // 谁的截断更新听谁的。
  // stale=true 表示"有一方还不知道这次截断"，那一方手里的旧尾巴要裁；
  // stale=false 表示**两边都知道**这次截断（同一时刻的那次），谁都不用裁 ——
  // 不然锚点之后就永远长不出新消息了（截断完再问一轮，那一轮会被当成"旧尾巴"裁掉）。
  function pickCut(a, b) {
    var aa = (a && typeof a.cutAt === 'string') ? a : null;
    var bb = (b && typeof b.cutAt === 'string') ? b : null;
    if (!aa && !bb) { return null; }
    if (!aa) { return { at: bb.cutAt, owner: 'b', stale: true }; }
    if (!bb) { return { at: aa.cutAt, owner: 'a', stale: true }; }
    var ta = Number(aa.cutTs) || 0, tb = Number(bb.cutTs) || 0;
    if (ta === tb) { return { at: aa.cutAt, owner: 'a', stale: false }; }
    return tb > ta ? { at: bb.cutAt, owner: 'b', stale: true } : { at: aa.cutAt, owner: 'a', stale: true };
  }
  // 按锚点裁掉后面那些；锚点是空串 = 截成了空对话。
  // 锚点找不到就原样返回 —— 宁可留着，也别删错东西。
  function trimByCut(msgs, at) {
    var list = msgs || [];
    if (at === '') { return []; }
    for (var i = 0; i < list.length; i++) {
      if (msgKey(list[i]) === at) { return list.slice(0, i + 1); }
    }
    return list;
  }
  // 两份消息合成的统一入口：先按"故意截断"裁掉**对方**那份的旧尾巴，再并集。
  // 只裁对方：持有截断的那一方，在那之后新加的消息（对方没有的）得留着。
  function mergedMessages(a, b) {
    var cut = pickCut(a, b);
    var ma = a.messages || [], mb = b.messages || [];
    if (cut && cut.stale) {                 // 只裁"还不知道这次截断"的那一方
      if (cut.owner === 'a') { mb = trimByCut(mb, cut.at); }
      else { ma = trimByCut(ma, cut.at); }
    }
    return mergeMessages(ma, mb);
  }

  function mergeChats(mine, theirs) {
    var byId = {};
    var dead = state.dead || {};
    (mine || []).forEach(function (c) { if (c && c.id && !dead[c.id]) { byId[c.id] = c; } });
    (theirs || []).forEach(function (c) {
      if (!c || !c.id || dead[c.id]) { return; }            // 本会话删过的，别再收回来
      var m = byId[c.id];
      if (!m) { byId[c.id] = c; return; }                   // 对方新建的 → 直接收下
      var mt = Number(m.updatedAt) || 0, tt = Number(c.updatedAt) || 0;
      // 标题取"后动过的那份"；**正文取两边的并集** ——
      // 以前是整条二选一，所以两个窗口都往同一个对话里打字时，后写的那份会把对方刚说的吃掉。
      var title = tt > mt ? (c.title || m.title) : (m.title || c.title);
      if (!title || title === NEW_TITLE) {
        var alt = (m.title && m.title !== NEW_TITLE) ? m.title
          : ((c.title && c.title !== NEW_TITLE) ? c.title : '');
        if (alt) { title = alt; }
      }
      var out = {
        id: c.id,
        title: title,
        messages: mergedMessages(m, c),
        updatedAt: Math.max(mt, tt)
      };
      var cut = pickCut(m, c);
      if (cut) {
        out.cutAt = cut.at;
        out.cutTs = cut.owner === 'a' ? (Number(m.cutTs) || 0) : (Number(c.cutTs) || 0);
      }
      byId[c.id] = out;
    });
    return Object.keys(byId).map(function (k) { return byId[k]; })
      .sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
  }

  // 删一个对话：除了从数组里拿掉，还要记进 dead 名单（见上面那段说明）。
  // 不记的话，下次 persist 合并时磁盘上那条会被当成"别的窗口新建的"又收回来。
  function dropChat(c) {
    if (!c) { return; }
    state.dead[c.id] = Date.now();
    var i = state.chats.indexOf(c);
    if (i >= 0) { state.chats.splice(i, 1); }
  }

  // 把存储里的版本并进内存。**就地改**（不换对象）—— state.cur 指着内存里那个对象，
  // 换成新对象的话，正在看的那条就跟界面脱钩了。
  // 返回：view = 正在看的这条内容变了（正文要重画）；history = 抽屉要重画；
  //       stale = 正在吐字、当前这条先没动，这一轮结束后要补一次（见 syncPending）。
  // dropMissing=true（收到别的窗口的写入）时，存储里已经没有、但这边**见过**的对话也删掉 ——
  // 用 state.seen 判"见过"，所以本窗口刚建、还没写过的空对话不会被误删。
  function adoptFromStorage(merged, dropMissing) {
    var dead = state.dead || {};
    if (!state.seen) { state.seen = {}; }
    var theirs = {}, added = 0, removed = 0, view = false, meta = false, stale = false;

    (merged || []).forEach(function (c) {
      if (!c || !c.id || dead[c.id]) { return; }
      theirs[c.id] = c;
      state.seen[c.id] = 1;
    });

    if (dropMissing) {
      var gone = {};
      state.chats.forEach(function (c) {
        if (theirs[c.id] || dead[c.id] || !state.seen[c.id]) { return; }
        gone[c.id] = 1;
      });
      if (Object.keys(gone).length) {
        var wasCur = !!(state.cur && gone[state.cur.id]);
        state.chats = state.chats.filter(function (c) {
          if (gone[c.id]) { removed++; return false; }
          return true;
        });
        if (wasCur) {          // 正在看的这条被别处删了 → 换一条，别停在一条已经不存在了的对话上
          state.cur = state.chats[0] || newChat();
          if (state.chats.indexOf(state.cur) < 0) { state.chats.unshift(state.cur); }
          view = true;
        }
      }
    }

    var byId = {};
    state.chats.forEach(function (c) { byId[c.id] = c; });
    (merged || []).forEach(function (c) {
      if (!c || !c.id || dead[c.id]) { return; }
      var mine = byId[c.id];
      if (!mine) {                                    // 对方新建的
        state.chats.push(c); byId[c.id] = c; added++;
        if (state.cur && c.id === state.cur.id) { view = true; }
        return;
      }
      if (mine.title !== c.title) { meta = true; }
      if (Number(c.updatedAt) > (Number(mine.updatedAt) || 0)) { mine.updatedAt = c.updatedAt; meta = true; }
      mine.title = c.title || mine.title;

      var old = mine.messages || [];
      var list = mergedMessages(mine, c);
      // 先看"到底变没变"：自己的写入回声、或别处只改了别的对话时，这里会返回"没变"，就什么都不用做
      var same = (list.length === old.length) &&
        !list.some(function (m, i) { return m !== old[i]; });
      if (same) { return; }
      // 正在吐字：先别换掉当前这条的消息数组 —— send() 手里攥着那个流式气泡的对象引用，
      // 换掉之后它后面写进去的字就没人看得见了。记一笔，等这一轮结束再对齐。
      if (state.sending && state.cur === mine) { stale = true; return; }
      mine.messages = list;
      var cut2 = pickCut(mine, c);
      if (cut2) {
        mine.cutAt = cut2.at;
        if (cut2.owner === 'b') { mine.cutTs = Number(c.cutTs) || 0; }
      }
      meta = true;
      if (state.cur === mine) { view = true; }
    });
    if (added || removed || meta) {
      state.chats.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
    }
    return { added: added, removed: removed, view: view, history: !!(added || removed || meta), stale: stale };
  }

  // 写 chats 前先把磁盘那份读回来合并（见 mergeChats）。多这一次读很小，
  // 换来的是"另一个窗口里聊的对话不会被这边盖掉"。
  var chatSaveBusy = false;
  function saveChatsMerged() {
    // 上一次还没写完就先不写：两次"读回来 → 合并 → 写回"叠在一起没有意义，还容易互相压
    if (chatSaveBusy) { return Promise.resolve(); }
    chatSaveBusy = true;
    var done = function (r) { chatSaveBusy = false; return r; };
    return load(K_CHATS).then(function (raw) {
      var merged = mergeChats(plainChats(), normalizeChats(raw));
      adoptFromStorage(merged);
      return save(K_CHATS, merged);
    }).then(done, done);
  }

  // 把存储重新读一遍并进内存（吐字结束后补做的那次对齐用）
  function syncNow() {
    return load(K_CHATS).then(function (raw) {
      var r = adoptFromStorage(normalizeChats(raw), true);
      if (state.ready) {
        if (r.view) { renderAll(); }
        if (r.history) { renderHistory(); }
      }
      return r;
    });
  }

  // ---------------- API Key ----------------
  // Key **不写在代码里**：在设置页（面板右上角 ⚙）填一次，存进 chrome.storage.local，
  // 只有本机这个浏览器里有，网页读不到；发请求时才取出来放进 Authorization 头。
  // 每次发送前都重读一遍（很便宜），这样你在另一个标签页里的设置页改完，这边立刻就用上了。
  var K_KEY = '__ds_key__';
  var keyCache = null;    // { key, from } —— from: 'store' 浏览器里配的 / 'config' config.js 里的旧写法
  function loadKey() {
    return load(K_KEY).then(function (v) {
      var stored = typeof v === 'string' ? v.trim() : '';
      // config.js 里的 apiKey 是**旧写法**，留作兼容（也能帮老配置一秒钟搬过来），正常应该留空
      var legacy = String(cfg.apiKey || '').trim();
      keyCache = { key: stored || legacy, from: stored ? 'store' : (legacy ? 'config' : '') };
      return keyCache;
    });
  }
  function apiKey() { return keyCache ? keyCache.key : ''; }
  // 「推荐图片」按钮的状态：开着就点亮（跟「应用网页」那套一致，一眼能看出开没开）
  function syncReco() {
    if (!el.reco) { return; }
    el.reco.classList.toggle('on', !!state.recoImg);
    el.reco.title = state.recoImg ? tr('p.recoOn') : tr('p.recoOff');
  }
  // 没配 Key 时把 ⚙ 点亮，不然用户只会在按发送的那一刻才知道缺东西
  function syncKeyHint() {
    if (!el.set) { return; }
    var missing = cfg.requireKey !== false && !apiKey();
    el.set.classList.toggle('warn', missing);
    el.set.title = missing ? tr('p.settingsWarn') : tr('p.settings');
  }
  function openSettings() {
    try {
      if (chrome.runtime && chrome.runtime.openOptionsPage) {
        // 新 Chrome 里它返回 Promise：失败了别静默 —— 这条是配 Key 的唯一入口
        var p = chrome.runtime.openOptionsPage();
        if (p && p.catch) {
          p.catch(function () { toast(tr('p.settingsFail')); });
        }
        return;
      }
    } catch (e) { /* 下面兜底 */ }
    toast(tr('p.settingsAlt'));
  }
  // ---------------- 账户余额 ----------------
  // 官方有个只读接口：GET /user/balance，返回
  //   { is_available: true, balance_infos: [{ currency:'CNY', total_balance:'59.89',
  //                                          granted_balance:'0.00', topped_up_balance:'59.89' }] }
  // 不消耗 token、不花钱，所以可以随便点。字段是按官方文档 + 2026-09-25 实测写的。
  function fmtMoney(v) {
    var n = Number(v);
    return isFinite(n) ? n.toFixed(2) : String(v == null ? '' : v);
  }
  function symOf(cur) {
    var c = String(cur || 'CNY').toUpperCase();
    return c === 'USD' ? '$' : (c === 'CNY' ? '¥' : c + ' ');
  }
  function fetchBalance() {
    var base = String(cfg.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    var key = apiKey();
    if (!key) {
      toast(tr('p.needKey'));
      return Promise.resolve(null);
    }
    return fetch(base + '/user/balance', { headers: { 'Authorization': 'Bearer ' + key } })
      .then(function (res) {
        if (!res.ok) {
          var why = res.status === 401 ? tr('p.bal401')
            : res.status === 404 ? tr('p.bal404')
            : '';
          throw new Error('HTTP ' + res.status + ' ' + why);
        }
        return res.json();
      })
      .then(function (j) {
        var infos = (j && j.balance_infos) || [];
        if (!infos.length) { throw new Error(tr('p.balNoData')); }
        return { available: !(j && j.is_available === false), infos: infos };
      })
      .catch(function (e) {
        toast(tr('p.balFail', { err: (e && e.message) || e }));
        return null;
      });
  }

  function showBalance(btn) {
    if (btn) { btn.disabled = true; }
    toast(tr('p.balChecking'));
    fetchBalance().then(function (b) {
      if (btn) { btn.disabled = false; }
      if (!b) { return; }
      var parts = b.infos.map(function (i) { return symOf(i.currency) + fmtMoney(i.total_balance); });
      var extra = [];
      var first = b.infos[0] || {};
      var g = Number(first.granted_balance), t = Number(first.topped_up_balance);
      if (isFinite(t) && t > 0) { extra.push(tr('p.balTopup', { v: symOf(first.currency) + fmtMoney(first.topped_up_balance) })); }
      if (isFinite(g) && g > 0) { extra.push(tr('p.balGranted', { v: symOf(first.currency) + fmtMoney(first.granted_balance) })); }
      toast(tr('p.balLine', { v: parts.join(' / ') }) +
        (extra.length ? tr('p.balExtra', { v: extra.join(' · ') }) : '') +
        (b.available ? '' : tr('p.balUnavailable')));
    });
  }

  // 设置页在**另一个标签页**里，改完 Key 这边不会自己知道 —— 监听存储变化补上这一下：
  // ⚙ 的提醒状态和 apiKey() 立刻跟着变，不用等到你下次按发送。
  // 同一个监听顺便管多窗口：别的窗口聊出新对话，这边把"我还没有的那几条"并进来。
  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes) { return; }
        if (changes[K_KEY]) { loadKey().then(syncKeyHint); }
        // 在设置页换了界面语言：已经建过面板就当场重建（没建过的话，下次打开自然就是新语言）
        if (changes[K_LANG]) {
          applyLang(changes[K_LANG].newValue === 'en' ? 'en' : 'zh');
        }
        if (changes[K_CHATS]) {
          var ch = changes[K_CHATS] || {};
          // newValue 不是数组就当没收到（存储里那条被整个清掉了，别当成"别处把对话全删了"）
          if (!Array.isArray(ch.newValue)) { return; }
          // dropMissing=true：别的窗口删掉的对话，这边也删（否则界面留着一条幽灵，还会被写回去）
          var r = adoptFromStorage(normalizeChats(ch.newValue), true);
          if (!state.ready) { return; }        // 面板还没建过：内存对齐就够了，没有界面要画
          if (r.stale) { state.syncPending = true; }        // 正在吐字，等这轮结束再对齐
          else if (r.view) { renderAll(); }                 // 正在看的这条变了 → 正文当场重画
          if (r.history) { renderHistory(); }
        }
      });
    }
  } catch (e) { /* 老环境没有这个 API，忽略 */ }

  function persist() {
    if (state.cur) state.cur.updatedAt = Date.now();
    return Promise.all([
      saveChatsMerged(),
      save(K_CUR, state.cur ? state.cur.id : ''),
      save(K_MODEL, state.model)
    ]);
  }

  // ---------------- 工具 ----------------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // ---- 消息正文的 markdown 渲染 ----
  // 模型答出来的都是标准 markdown：表格、标题、列表、引用、行内代码……
  // 只转义不解析的话，表格会原样显示成 |---|---|（看着就是一串乱码），标题会带着 # 号。
  // 这里做**够用**的解析：块级（代码块 / 表格 / 标题 / 列表 / 引用 / 分隔线），
  // 行内（行内代码 / 加粗 / 斜体 / 删除线 / 链接）。不追求完整 CommonMark。
  function inlineMd(line) {
    return esc(line)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  // 表格的"分隔行"（第二行那种 |---|:--:|）。
  // 至少要有一个竖线 —— 单独一行 --- 是分隔线，不能被当成表格。
  // 只要求 1 个（不是 2 个）：模型经常写成不带首尾竖线的表格，那种只有中间那一个。
  function isTableSep(line) {
    var t = String(line).trim();
    if (!t || !/^[|\s:\-]+$/.test(t)) { return false; }
    if (t.indexOf('-') < 0) { return false; }
    return t.indexOf('|') >= 0;
  }

  function splitRow(line) {
    return String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
      .split('|').map(function (c) { return c.trim(); });
  }

  function rowAlign(line) {
    return splitRow(line).map(function (c) {
      var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      return l && r ? 'center' : (r ? 'right' : (l ? 'left' : ''));
    });
  }

  function cellHtml(tag, text, align, k) {
    var a = align && align[k] ? ' style="text-align:' + align[k] + '"' : '';
    return '<' + tag + a + '>' + inlineMd(text) + '</' + tag + '>';
  }

  // 一段普通文字（代码块以外的部分）→ HTML。按行扫：先认块级结构，剩下的按段落拼。
  function mdBlocks(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    var n = lines.length, i = 0, out = '';
    var para = [], quote = [], stack = [];      // stack：打开的列表层级 [{tag, indent}]

    function flushPara() {
      if (!para.length) { return; }
      out += '<p>' + para.map(inlineMd).join('<br>') + '</p>';
      para = [];
    }
    function flushQuote() {
      if (!quote.length) { return; }
      out += '<blockquote>' + quote.map(inlineMd).join('<br>') + '</blockquote>';
      quote = [];
    }
    function flushList() {
      // 逐层收：每层把自己的 </li> 和列表标签一起闭上，所以顺序是对的
      while (stack.length) { out += '</li></' + stack.pop().tag + '>'; }
    }
    function flushAll() { flushPara(); flushQuote(); flushList(); }

    while (i < n) {
      var line = lines[i];

      if (!line.trim()) { flushAll(); i++; continue; }      // 空行：收掉手上所有块

      // 表格：本行有竖线，且下一行是分隔行
      if (line.indexOf('|') >= 0 && i + 1 < n && isTableSep(lines[i + 1])) {
        flushAll();
        var head = splitRow(line), align = rowAlign(lines[i + 1]);
        var rows = [], j = i + 2;
        while (j < n && lines[j].trim() && lines[j].indexOf('|') >= 0) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        i = j;
        out += '<div class="tablewrap"><table><thead><tr>' +
          head.map(function (c, k) { return cellHtml('th', c, align, k); }).join('') +
          '</tr></thead>';
        if (rows.length) {
          // 行里的格子数可能和表头不一致（模型偶尔会漏或多写一个竖线）：
          // 少的补空，多的保留 —— 宁可贵一点也别把内容吞掉。
          out += '<tbody>' + rows.map(function (r) {
            var cells = r.slice();
            while (cells.length < head.length) { cells.push(''); }
            return '<tr>' + cells.map(function (c, k) {
              return cellHtml('td', c, align, k);
            }).join('') + '</tr>';
          }).join('') + '</tbody>';
        }
        out += '</table></div>';
        continue;
      }

      var h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);         // 标题
      if (h) {
        flushAll();
        var lv = h[1].length;
        out += '<h' + lv + '>' + inlineMd(h[2]) + '</h' + lv + '>';
        i++;
        continue;
      }

      // 分隔线。必须放在表格判断**之后**：表格的分隔行长得跟它很像。
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        out += '<hr>';
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {                             // 引用
        flushPara(); flushList();
        quote.push(line.replace(/^\s*>\s?/, ''));
        i++;
        continue;
      }

      var li = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);   // 列表（支持嵌套）
      if (li) {
        flushPara(); flushQuote();
        var indent = li[1].replace(/\t/g, '    ').length;
        var tag = /\d/.test(li[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) {
          out += '</li></' + stack.pop().tag + '>';
        }
        if (!stack.length) {
          out += '<' + tag + '><li>';
          stack.push({ tag: tag, indent: indent });
        } else if (indent > stack[stack.length - 1].indent) {
          out += '<' + tag + '><li>';                       // 缩进变深 → 开一层
          stack.push({ tag: tag, indent: indent });
        } else if (stack[stack.length - 1].tag !== tag) {
          out += '</li></' + stack.pop().tag + '>' + '<' + tag + '><li>';   // 同层换了类型
          stack.push({ tag: tag, indent: indent });
        } else {
          out += '</li><li>';
        }
        out += inlineMd(li[3]);
        i++;
        continue;
      }

      // 列表项的续行（比当前这层缩进深）：接着上一项写。
      // 不这么处理的话，列表会被一行普通文字截成两段，有序列表还会从 1 重新数。
      var keep = stack.length &&
        /^[ \t]/.test(line) &&
        (line.replace(/\t/g, '    ').match(/^ */)[0].length >= stack[stack.length - 1].indent);
      if (keep) {
        out += '<br>' + inlineMd(line.trim());
        i++;
        continue;
      }

      flushQuote(); flushList();
      para.push(line);
      i++;
    }
    flushAll();
    return out;
  }

  function mdToHtml(s) {
    var parts = String(s).split(/```/), out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i].replace(/^[a-zA-Z0-9_+.#-]*\r?\n/, '');
        // 代码块套一层 wrapper：复制按钮相对它定位，这样 pre 自己横向滚动时不带着按钮跑。
        // 按钮不在这里绑事件（这函数每次渲染都重跑）——统一由 root 上的委托处理。
        out += '<div class="codewrap"><button class="cp cp-code" type="button" title="' +
          tr('p.codeCopyTitle') + '">' + tr('p.copy') + '</button>'
             + '<pre><code>' + esc(code.replace(/\s+$/, '')) + '</code></pre></div>';
      } else {
        out += mdBlocks(parts[i]);
      }
    }
    return out;
  }

  // ---- markdown → 人能直接读的纯文本（点「复制」拿到的就是这个）----
  // 为什么不直接复制 markdown 原文：表格那一行 |---|---| 粘到聊天窗口里就是一串竖线，
  // 用户要的是"能看懂"，不是"能再喂给 markdown 编辑器"。
  // 规则：** 星号 / # 井号 / ` 反引号 / > 引用号 一律去掉；
  //      列表的 - 和 1. 保留（那是结构，读起来本来也自然）；
  //      表格去掉分隔行、按列对齐。
  // 注意这套是**面向等宽字体**对齐的，所以中文要按两格算宽（见 dw）。
  function dw(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += (c >= 0x1100 && (
        c <= 0x115f || c === 0x2329 || c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
        (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
    }
    return n;
  }

  function sp(n) { return n > 0 ? new Array(n + 1).join(' ') : ''; }

  function mdTextBlocks(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    var n = lines.length, i = 0, out = [];

    function inlineText(line) {
      return String(line)
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/\[([^\]\n]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, '$1 ($2)');
    }

    while (i < n) {
      var line = lines[i];

      // 表格 → 按列对齐的纯文本。表头那一行保留（它是有用的），只去掉 |---|---|
      if (line.indexOf('|') >= 0 && i + 1 < n && isTableSep(lines[i + 1])) {
        var head = splitRow(line), rows = [], j = i + 2;
        while (j < n && lines[j].trim() && lines[j].indexOf('|') >= 0) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        i = j;
        var cols = head.length;
        rows.forEach(function (r) { if (r.length > cols) { cols = r.length; } });
        var w = [], all = [head].concat(rows);
        for (var k = 0; k < cols; k++) {
          var mx = 0;
          all.forEach(function (r) {
            mx = Math.max(mx, dw(inlineText(r[k] || '')));
          });
          w.push(mx);
        }
        all.forEach(function (r) {
          var s = '';
          for (var k = 0; k < cols; k++) {
            var c = inlineText(r[k] || '');
            s += (k === cols - 1) ? c : (c + sp(w[k] - dw(c) + 2));
          }
          out.push(s.replace(/\s+$/, ''));
        });
        continue;
      }

      var h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*$/.exec(line);
      if (h) { out.push(inlineText(h[1])); i++; continue; }

      var q = /^\s*>\s?(.*)$/.exec(line);
      if (q) { out.push(inlineText(q[1])); i++; continue; }

      var li = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        out.push(li[1] + (/\d/.test(li[2]) ? li[2] : '-') + ' ' + inlineText(li[3]));
        i++;
        continue;
      }

      out.push(inlineText(line));
      i++;
    }
    return out.join('\n');
  }

  function mdToText(s) {
    var parts = String(s == null ? '' : s).split(/```/), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // 代码块：围栏去掉、内容原样（缩进和空行都留着）。
        // 只想要代码本身的话用代码块自己那个「复制」，那个连围栏都没有。
        out.push(parts[i].replace(/^[a-zA-Z0-9_+.#-]*\r?\n/, '').replace(/\s+$/, ''));
      } else {
        out.push(mdTextBlocks(parts[i]).replace(/^\n+|\n+$/g, ''));
      }
    }
    return out.filter(function (x) { return x !== ''; }).join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }
  // 把文字放进剪贴板。优先用异步接口（它是"安全上下文"才给用，http 页面会直接抛），
  // 所以备一条老路：隐藏的 textarea + execCommand。两条都不行就明说，别假装复制成功了。
  function copyText(text, btn) {
    text = String(text == null ? '' : text);
    function flash(ok) {
      if (!btn) { return; }
      btn.classList.toggle('done', !!ok);
      btn.textContent = ok ? tr('p.copied') : tr('p.copyFail');
      clearTimeout(btn._cpT);
      btn._cpT = setTimeout(function () {
        btn.classList.remove('done');
        btn.textContent = tr('p.copy');
      }, 1400);
    }
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        if (ta.parentNode) { ta.parentNode.removeChild(ta); }
        return ok;
      } catch (e) { return false; }
    }
    if (!text) { flash(false); toast(tr('p.copyNothing')); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flash(true);
      }).catch(function () {
        var ok = legacy();
        flash(ok);
        if (!ok) { toast(tr('p.copyManual')); }
      });
      return;
    }
    var ok2 = legacy();
    flash(ok2);
    if (!ok2) { toast(tr('p.copyManual')); }
  }

  function toast(msg) {
    if (!el.toast) { return; }
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, 3400);
  }
  function fmtTime(ts) {
    var d = new Date(ts), n = new Date();
    function p(x) { return x < 10 ? '0' + x : '' + x; }
    if (d.toDateString() === n.toDateString()) return p(d.getHours()) + ':' + p(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function newChat() {
    return { id: uid(), title: NEW_TITLE, messages: [], updatedAt: Date.now() };
  }

  // 对话在界面上显示的名字：空标题 / 默认标题都按当前语言取词。
  // 存的是固定值（见 NEW_TITLE），只在这里换 —— 否则英文界面里会冒出一句中文。
  function titleText(c) {
    var v = c && c.title ? String(c.title) : '';
    return (!v || v === NEW_TITLE) ? tr('p.newChat') : v;
  }

  // 从存储里读回来的对话，字段不一定齐（手改过、或者旧版本写的），
  // 补齐再进内存——不然一条缺 messages 的记录就能把整个面板弄崩。
  function normalizeChat(c) {
    if (!c || typeof c !== 'object') { return null; }
    var msgs = [];
    if (Array.isArray(c.messages)) {
      c.messages.forEach(function (m) {
        if (!m || typeof m !== 'object') { return; }
        if (m.role !== 'user' && m.role !== 'assistant') { return; }
        var o = { role: m.role, show: typeof m.show === 'string' ? m.show : '', content: typeof m.content === 'string' ? m.content : '' };
        if (typeof m.mid === 'string' && m.mid) { o.mid = m.mid; }
        if (typeof m.ts === 'number' && m.ts) { o.ts = m.ts; }
        if (typeof m.reasoning === 'string') { o.reasoning = m.reasoning; }
        if (Array.isArray(m.attachments)) { o.attachments = m.attachments; }
        if (m.usage && typeof m.usage === 'object') { o.usage = m.usage; }
        msgs.push(o);
      });
    }
    var out = {
      id: typeof c.id === 'string' && c.id ? c.id : uid(),
      title: (typeof c.title === 'string' && c.title) ? c.title : NEW_TITLE,
      messages: msgs,
      updatedAt: (typeof c.updatedAt === 'number' && c.updatedAt) ? c.updatedAt : Date.now()
    };
    if (typeof c.cutAt === 'string') { out.cutAt = c.cutAt; out.cutTs = Number(c.cutTs) || 0; }
    return out;
  }

  function normalizeChats(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      var n = normalizeChat(c);
      if (n) { out.push(n); }
    });
    return out;
  }

  var ICONS = {
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.6v4.8l3 1.8"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.6 7V4.8h4.8V7M6.6 7l.95 12.2h8.9L17.4 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 11.5l-7.5 7.5a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 1 1 4.4 4.4l-7.8 7.8a1.6 1.6 0 0 1-2.2-2.2l7.1-7.1"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5.8M6.5 11.3L12 5.8l5.5 5.5"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7.6" y="7.6" width="8.8" height="8.8" rx="2"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 4.6H4.6v4.6M14.8 4.6h4.6v4.6M9.2 19.4H4.6v-4.6M14.8 19.4h4.6v-4.6"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 9.2h4.6V4.6M19.4 9.2h-4.6V4.6M4.6 14.8h4.6v4.6M19.4 14.8h-4.6v4.6"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.1 14.2a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V20a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 18.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H2a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 3.7 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H8.1a1.7 1.7 0 0 0 1.03-1.56V2a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H22a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"/></svg>',
    // 余额：一张卡 + 右下角一个点（别用 ¥ 字符，跟着字体跑、大小对不齐）
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6.2" width="18" height="12.4" rx="2.6"/><path d="M3 10.4h18"/><circle cx="16.8" cy="14.6" r="1.15" fill="currentColor" stroke="none"/></svg>'
  };

  // ---------------- 样式 ----------------
  var CSS = [
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.wrap{position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;color:#1b1d20;',
    'font:14px/1.65 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;',
    'border:1px solid rgba(0,0,0,.10);border-radius:16px;overflow:hidden;',
    'box-shadow:0 24px 60px rgba(0,0,0,.26),0 4px 12px rgba(0,0,0,.12);',
    'opacity:0;transform:scale(.965);transition:opacity .16s ease,transform .16s cubic-bezier(.34,1.4,.64,1)}',
    '.wrap.in{opacity:1;transform:scale(1)}',
    // 全屏：铺满视口，去掉圆角/边框/阴影
    '.wrap.fs{border-radius:0;border:0;box-shadow:none}',
    // 全屏时不要拉手
    '.wrap.fs .grip{display:none}',
    // 右下角拉手：拖动改大小
    '.wrap .grip{position:absolute;right:1px;bottom:1px;width:18px;height:18px;cursor:nwse-resize;z-index:6;touch-action:none}',
    '.wrap .grip::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;',
    'border-right:2px solid rgba(0,0,0,.22);border-bottom:2px solid rgba(0,0,0,.22);border-radius:0 0 2px 0}',
    '.grip:hover::after,.wrap.rsz .grip::after{border-color:rgba(77,107,254,.8)}',
    '.wrap.rsz{user-select:none;-webkit-user-select:none;cursor:nwse-resize}',
    '.wrap.rsz .box,.wrap.rsz .list{pointer-events:none}',
    // 顶部拖动：整条顶栏当把手（按钮除外）
    '.wrap .bar{cursor:move;touch-action:none}',
    '.wrap .bar .ib{cursor:pointer}',
    '.wrap.fs .bar{cursor:default}',
    '.wrap.moving{user-select:none;-webkit-user-select:none}',
    '.bar{display:flex;align-items:center;gap:2px;padding:7px 8px 7px 6px;border-bottom:1px solid rgba(0,0,0,.07);flex:0 0 auto}',
    '.wrap.mini #history,.wrap.mini #del,.wrap.mini #models{display:none}',
    '.wrap.mini .ttl{justify-content:flex-start;padding-left:2px}',
    '.wrap.mini .note{display:none}',
    '.wrap.mini .list{padding:10px 9px 6px}',
    '.wrap.mini .box{margin:0 8px}',
    '.ib{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:9px;',
    'background:transparent;color:inherit;cursor:pointer;opacity:.75;flex:0 0 auto}',
    '.ib:hover{background:rgba(0,0,0,.06);opacity:1}',
    '.ib svg{width:18px;height:18px}',
    '.ib.small{width:28px;height:28px}',
    '.ib.small svg{width:17px;height:17px}',
    // 还没配 API Key 时，⚙ 亮成琥珀色 —— 免得你按了发送才知道缺东西
    '.ib.warn{color:#d97706;opacity:1}',
    '.ttl{flex:1;display:flex;align-items:baseline;gap:6px;justify-content:center;min-width:0}',
    '.ttl b{font-weight:500}',
    '.ttl span{font-size:11px;opacity:.45}',
    '.list{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding:14px 12px 8px}',
    '.row{display:flex;margin-bottom:12px}',
    '.row.me{justify-content:flex-end}',
    '.bubble{position:relative;max-width:88%;padding:9px 13px;border-radius:16px;background:#f1f2f4;word-break:break-word;overflow-wrap:anywhere}',
    '.row.ai .bubble{max-width:96%;background:rgba(0,0,0,.035);border:1px solid rgba(0,0,0,.06);border-radius:14px}',
    '.body{font-size:13.5px;line-height:1.62}',
    // 正文里的块级结构（模型答的都是标准 markdown，不排版就会是一坨）
    '.body p{margin:0 0 8px}',
    '.body p:last-child{margin-bottom:0}',
    '.body h1,.body h2,.body h3,.body h4,.body h5,.body h6{margin:11px 0 6px;font-weight:700;line-height:1.35}',
    '.body h1:first-child,.body h2:first-child,.body h3:first-child,.body h4:first-child{margin-top:0}',
    '.body h1{font-size:16px}',
    '.body h2{font-size:15.2px}',
    '.body h3{font-size:14.4px}',
    '.body h4,.body h5,.body h6{font-size:13.5px}',
    '.body ul,.body ol{margin:0 0 8px;padding-left:20px}',
    '.body li{margin:3px 0}',
    '.body li>ul,.body li>ol{margin:3px 0 0}',
    '.body blockquote{margin:8px 0;padding:1px 0 1px 10px;border-left:3px solid rgba(0,0,0,.15);opacity:.88}',
    '.body hr{border:0;border-top:1px solid rgba(0,0,0,.12);margin:10px 0}',
    '.body a{color:#3f5ae0}',
    // 表格：窄了就横向滚，别把气泡撑破
    '.tablewrap{overflow-x:auto;margin:8px 0}',
    '.tablewrap:last-child{margin-bottom:0}',
    '.tablewrap table{border-collapse:collapse;font-size:12.5px}',
    '.tablewrap th,.tablewrap td{border:1px solid rgba(0,0,0,.13);padding:4px 9px;vertical-align:top}',
    '.tablewrap th{background:rgba(0,0,0,.055);font-weight:600;white-space:nowrap}',
    '.bubble pre{background:rgba(0,0,0,.055);border-radius:8px;padding:8px 10px;overflow-x:auto;margin:7px 0}',
    '.bubble code{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12.5px}',
    // 行内代码：段落、列表项、表格格子里都会出现，所以挂在 .body 上而不是 .bubble p
    '.body code{background:rgba(0,0,0,.06);padding:1px 4px;border-radius:4px}',
    '.bubble pre code{background:none;padding:0;border-radius:0}',
    // ---- 复制按钮（回答级 + 代码块级）----
    // 默认透明，鼠标移到那条回答/那段代码上才显形：不打扰，位置固定，用两次就有肌肉记忆。
    '.cp{position:absolute;right:6px;top:6px;border:0;border-radius:6px;padding:2px 7px;font:inherit;font-size:11px;line-height:1.5;cursor:pointer;color:#5b5f66;background:rgba(0,0,0,.09);opacity:0;transition:opacity .12s ease}',
    '.bubble:hover .cp-msg,.codewrap:hover .cp-code{opacity:.75}',
    '.cp:hover{opacity:1 !important;background:rgba(0,0,0,.18)}',
    '.cp.done{opacity:1;color:#0f6e56;background:rgba(29,158,117,.2)}',
    '.cp-msg{top:7px;right:9px}',
    // 「重试」挨着「复制」摆——**写在 .cp-msg 后面**才生效：两条选择器权重一样，
    // 谁在后面谁说了算。right:52px 正好让两个小按钮并排不打架。
    '.cp-retry{top:7px;right:52px}',
    // 「回到这里」用同一套：浮在用户气泡右上角，hover 才显形
    '.cp-back{top:7px;right:9px}',
    // 回滚的二次确认：丢消息不可逆，用面板自己的确认层。
    // **不用 window.confirm** —— content script 里那个是页面的 confirm，页面能改写它（改写后永远返回 true），
    // 拿来做"不可逆操作"的把关不可靠。
    '.cfm{position:absolute;inset:0;z-index:9;display:none;flex-direction:column;align-items:center;',
    'justify-content:center;gap:13px;padding:18px;background:rgba(12,13,15,.88);text-align:center}',
    '.cfm.show{display:flex}',
    '.cfm .t{color:#fff;font-size:13.5px;font-weight:500}',
    '.cfm .m{color:#d7d9dd;font-size:12.5px;line-height:1.65;max-width:100%}',
    '.cfm .m em{color:#F09595;font-style:normal}',
    '.cfm .btns{display:flex;gap:8px}',
    '.cfm button{border:0;border-radius:8px;padding:6px 13px;font:inherit;font-size:12.5px;cursor:pointer;',
    'background:rgba(255,255,255,.16);color:#fff}',
    '.cfm button:hover{background:rgba(255,255,255,.27)}',
    '.cfm button.danger{background:#c0392b}',
    '.cfm button.danger:hover{background:#d2452f}',
    // 代码块的包裹层：按钮相对它定位，这样 pre 自己横向滚动时按钮不会跟着跑
    '.codewrap{position:relative;margin:7px 0}',
    '.codewrap pre{margin:0}',
    '.codewrap:last-child{margin-bottom:0}',
    '.think{font-size:12px;opacity:.62;margin-bottom:6px}',
    '.think summary{cursor:pointer}',
    '.think .tt{white-space:pre-wrap;padding-top:5px}',
    '.atts{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}',
    '.atts span{font-size:11px;padding:2px 7px;border-radius:7px;background:rgba(0,0,0,.06)}',
    // 「推荐图片」那一行（在气泡底部）：一个「配图」+ 几个可点的搜索词。
    // 默认 display:none —— 模型没给词时它根本不该占位置（renderReco 里判断后才显示）。
    '.reco{display:none;flex-wrap:wrap;align-items:center;gap:5px;margin-top:9px}',
    '.usage{font-size:11px;opacity:.5;margin-top:7px;letter-spacing:.2px;cursor:default}',
    // 气泡底部那行时间：比用量更轻，因为它只是"什么时候"，不承载信息
    '.time{font-size:11px;opacity:.32;margin-top:5px;letter-spacing:.2px;cursor:default}',
    '.reco-lab{font-size:11px;opacity:.5}',
    '.reco-k{font-size:11.5px;line-height:1.7;padding:1px 9px;border-radius:9px;text-decoration:none;',
    'background:rgba(77,107,254,.12);color:#3b58d6;white-space:nowrap;max-width:100%;overflow:hidden;',
    'text-overflow:ellipsis}',
    '.reco-k:hover{background:rgba(77,107,254,.22)}',
    '.empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;opacity:.5;text-align:center;padding:0 20px}',
    '.empty .mark{width:42px;height:42px;border-radius:50%;background:#4D6BFE;color:#fff;display:flex;align-items:center;justify-content:center}',
    '.empty .mark svg{width:23px;height:23px}',
    '.empty p{font-size:12.5px;line-height:1.8}',
    '.caret{display:inline-block;width:7px;height:13px;background:currentColor;opacity:.45;vertical-align:-2px;animation:blink 1s steps(1) infinite}',
    '@keyframes blink{50%{opacity:0}}',
    '.box{flex:0 0 auto;margin:0 10px;border:1px solid rgba(0,0,0,.15);border-radius:14px;padding:8px 9px 6px;display:flex;flex-direction:column;gap:5px;background:#fff}',
    '.chips{display:flex;flex-wrap:wrap;gap:5px}',
    // 输入框上面那一行：功能类按钮（应用网页、图片提示词）放这儿，
    // 底下的工具条就只留输入相关的（附件、提示词、模型、强度、发送），不会被挤成一团。
    '.toprow{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
    '.toprow:empty{display:none}',
    '.chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:3px 5px 3px 8px;border-radius:8px;background:rgba(77,107,254,.12);color:#3b58d6;max-width:100%}',
    '.chip b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.chip button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0 3px}',
    // 图片附件：chip 上带个缩略图，双击铺开看（发之前确认贴对了没有）
    '.chip.viewable{cursor:zoom-in}',
    '.chip img.th{width:20px;height:20px;border-radius:4px;object-fit:cover;flex:0 0 auto;background:rgba(0,0,0,.08)}',
    // 预览层：盖住整个面板，点哪儿都能关
    '.viewer{position:absolute;inset:0;z-index:9;display:none;flex-direction:column;align-items:center;',
    'justify-content:center;gap:10px;padding:16px;background:rgba(12,13,15,.88);cursor:zoom-out}',
    '.viewer.show{display:flex}',
    '.viewer img{max-width:100%;max-height:calc(100% - 44px);object-fit:contain;border-radius:6px;background:#fff}',
    '.viewer .cap{color:#fff;font-size:12px;opacity:.85;text-align:center;word-break:break-all;max-width:100%}',
    'textarea{width:100%;border:0;outline:0;resize:none;background:transparent;color:inherit;font:inherit;font-size:13.5px;',
    'line-height:1.6;max-height:120px;padding:2px 3px}',
    '.tools{display:flex;align-items:center;gap:4px}',
    '.pill{border:0;border-radius:9px;background:rgba(0,0,0,.05);color:inherit;font:inherit;font-size:12px;',
    'padding:5px 9px;cursor:pointer;opacity:.75;flex:0 0 auto;white-space:nowrap}',
    '.pill:hover{opacity:1}',
    '.pill.on{background:rgba(77,107,254,.15);color:#3b58d6;opacity:1}',
    // 提示词按钮窄的时候可以让位（文字太长也不撑破工具条）
    '#imgprompt{flex:0 1 auto;min-width:0;max-width:118px;overflow:hidden;text-overflow:ellipsis}',
    'select{border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:12px;opacity:.68;cursor:pointer;padding:4px 2px;max-width:150px;min-width:0}',
    // 思考强度那个下拉比模型窄一点：两个并排，别把工具条挤爆（面板最窄只有 300px）
    '#effort{max-width:82px}',
    '.send{margin-left:auto;width:29px;height:29px;border-radius:50%;border:0;background:#4D6BFE;color:#fff;display:inline-flex;',
    'align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}',
    '.send svg{width:16px;height:16px}',
    '.send[disabled]{opacity:.45;cursor:default}',
    '.note{flex:0 0 auto;text-align:center;font-size:11px;opacity:.4;padding:6px 0 8px}',
    '.drawer{position:absolute;left:0;top:0;bottom:0;width:74%;max-width:290px;background:#fff;border-right:1px solid rgba(0,0,0,.08);',
    'transform:translateX(-103%);transition:transform .2s ease;display:flex;flex-direction:column;box-shadow:8px 0 28px rgba(0,0,0,.10)}',
    '.drawer.open{transform:none}',
    '.dhead{display:flex;align-items:center;justify-content:space-between;padding:12px 12px 10px;font-size:13px;font-weight:500;border-bottom:1px solid rgba(0,0,0,.06)}',
    '.tb{border:0;background:rgba(77,107,254,.13);color:#3b58d6;font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer}',
    // 历史搜索：对话攒多了以后，靠一条条往下滚是找不到东西的。过滤是纯前端的（数据本来就在内存里）
    '.dsearch{padding:0 10px 9px}',
    '.dsearch input{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:6px 10px;border-radius:8px;',
    'border:1px solid rgba(0,0,0,.13);background:rgba(0,0,0,.03);color:inherit;outline:none}',
    '.dsearch input:focus{border-color:rgba(77,107,254,.55);background:rgba(77,107,254,.05)}',
    '.dsearch input::placeholder{opacity:.42}',
    '.dlist{flex:1;overflow-y:auto;padding:6px}',
    // 抽屉底部：导出 / 清理。平时不打扰，需要的时候就在手边。
    '.dfoot{display:flex;gap:6px;padding:9px 10px;border-top:1px solid rgba(0,0,0,.06)}',
    '.hitem{display:flex;align-items:center;gap:6px;padding:8px 9px;border-radius:9px;cursor:pointer;font-size:13px}',
    '.hitem:hover{background:rgba(0,0,0,.05)}',
    '.hitem.on{background:rgba(77,107,254,.11)}',
    '.hitem .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hitem .d{font-size:11px;opacity:.42}',
    '.hitem .x{border:0;background:transparent;color:inherit;opacity:0;cursor:pointer;font-size:14px;line-height:1}',
    '.hitem:hover .x{opacity:.45}',
    '.toast{position:absolute;left:50%;bottom:104px;transform:translate(-50%,8px);background:rgba(28,29,32,.94);color:#fff;',
    'font-size:12.5px;padding:8px 14px;border-radius:10px;opacity:0;pointer-events:none;max-width:86%;text-align:center;',
    'transition:opacity .18s ease,transform .18s ease}',
    '.toast.show{opacity:1;transform:translate(-50%,0)}',
    '@media (prefers-color-scheme: dark){',
    '.wrap{background:#1c1d20;color:#eceef1;border-color:rgba(255,255,255,.12)}',
    '.bar{border-bottom-color:rgba(255,255,255,.09)}',
    '.ib:hover{background:rgba(255,255,255,.08)}',
    '.bubble{background:#2a2c31}',
    '.row.ai .bubble{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}',
    '.bubble pre{background:rgba(255,255,255,.07)}',
    '.body code{background:rgba(255,255,255,.09)}',
    '.bubble pre code{background:none}',
    '.body blockquote{border-left-color:rgba(255,255,255,.22)}',
    '.body hr{border-top-color:rgba(255,255,255,.14)}',
    '.body a{color:#8fa8ff}',
    '.tablewrap th,.tablewrap td{border-color:rgba(255,255,255,.16)}',
    '.tablewrap th{background:rgba(255,255,255,.07)}',
    '.cp{color:#c9ccd2;background:rgba(255,255,255,.13)}',
    '.cp:hover{background:rgba(255,255,255,.24)}',
    '.cp.done{color:#9FE1CB;background:rgba(29,158,117,.3)}',
    '.box{background:#232428;border-color:rgba(255,255,255,.16)}',
    '.drawer{background:#1c1d20;border-right-color:rgba(255,255,255,.1)}',
    '.dhead{border-bottom-color:rgba(255,255,255,.08)}',
    '.dsearch input{border-color:rgba(255,255,255,.15);background:rgba(255,255,255,.06)}',
    '.dsearch input:focus{border-color:rgba(120,150,255,.65);background:rgba(77,107,254,.14)}',
    '.dfoot{border-top-color:rgba(255,255,255,.08)}',
    '.hitem:hover{background:rgba(255,255,255,.07)}',
    '.atts span{background:rgba(255,255,255,.09)}',
    '.reco-k{background:rgba(77,107,254,.26);color:#b3c0ff}',
    '.reco-k:hover{background:rgba(77,107,254,.4)}',
    '.pill{background:rgba(255,255,255,.09)}',
    '}'
  ].join('');

  // ---------------- 构建 DOM ----------------
  function build() {
    if (host) { return; }
    host = document.createElement('div');
    host.id = PANEL_ID;
    var s = host.style;
    s.setProperty('position', 'fixed', 'important');
    s.setProperty('left', '0', 'important');
    s.setProperty('top', '0', 'important');
    s.setProperty('z-index', '2147483646', 'important');
    s.setProperty('display', 'none', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('padding', '0', 'important');

    root = host.attachShadow({ mode: 'open' });

    var mark = window.__DS_ICON_PATH
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + window.__DS_ICON_PATH + '"/></svg>'
      : '';

    root.innerHTML = ''
      + '<style>' + CSS + '</style>'
      + '<div class="wrap">'
      + '  <div class="bar">'
      + '    <button class="ib" id="history" title="' + tr('p.history') + '">' + ICONS.history + '</button>'
      + '    <div class="ttl"><b>' + esc(A.name || 'DeepSeek') + '</b><span id="mtag"></span></div>'
      + '    <button class="ib" id="fs" title="' + tr('p.full') + '">' + ICONS.expand + '</button>'
      + '    <button class="ib" id="bal" title="' + tr('p.balance') + '">' + ICONS.wallet + '</button>'
      + '    <button class="ib" id="set" title="' + tr('p.settings') + '">' + ICONS.gear + '</button>'
      + '    <button class="ib" id="del" title="' + tr('p.delChat') + '">' + ICONS.trash + '</button>'
      + '    <button class="ib" id="exit" title="' + tr('p.exit') + '">' + ICONS.close + '</button>'
      + '  </div>'
      + '  <div class="list" id="list"></div>'
      + '  <div class="box">'
      + '    <div class="chips" id="chips"></div>'
      + '    <div class="toprow">'
      + '      <button class="pill" id="page" title="' + tr('p.pageOffTitle') + '">' + tr('p.page') + '</button>'
      + '      <button class="pill" id="imgprompt" title="' + tr('p.imgPromptTitle') + '"></button>'
      + '      <button class="pill" id="reco" title="' + tr('p.recoOff') + '">' + tr('p.recoLabel') + '</button>'
      + '    </div>'
      + '    <textarea id="input" rows="1" placeholder="' + tr('p.placeholder') + '" spellcheck="false"></textarea>'
      + '    <div class="tools">'
      + '      <label class="ib small" title="' + tr('p.attachTitle') + '"><input type="file" id="file" multiple hidden>' + ICONS.clip + '</label>'
      + '      <select id="effort" title="' + tr('p.effortTitle') + '"></select>'
      + '      <select id="models"></select>'
      + '      <button class="send" id="send" title="' + tr('p.send') + '">' + ICONS.send + '</button>'
      + '    </div>'
      + '  </div>'
      + '  <p class="note">' + tr('p.note') + '</p>'
      + '  <div class="drawer" id="drawer">'
      + '    <div class="dhead"><span>' + tr('p.history') + '</span><button class="tb" id="new">' + tr('p.newChat') + '</button></div>'
      + '    <div class="dsearch"><input id="dq" type="text" placeholder="' + tr('p.searchPh') + '" spellcheck="false"></div>'
      + '    <div class="dlist" id="dlist"></div>'
      + '    <div class="dfoot">'
      + '      <button class="tb" id="exp" title="' + tr('p.exportTitle') + '">' + tr('p.export') + '</button>'
      + '      <button class="tb" id="cln" title="' + tr('p.cleanTitle', { n: CLEAN_DAYS }) + '">' + tr('p.clean') + '</button>'
      + '    </div>'
      + '  </div>'
      + '  <div class="toast" id="toast"></div>'
      + '  <div class="viewer" id="viewer"><img id="vimg" alt=""><div class="cap" id="vcap"></div></div>'
      + '  <div class="cfm" id="cfm">'
      + '    <div class="t" id="cfm-t"></div><div class="m" id="cfm-m"></div>'
      + '    <div class="btns"><button class="danger" id="cfm-yes">' + tr('p.discard') + '</button>'
      + '    <button id="cfm-no">' + tr('p.cancel') + '</button></div>'
      + '  </div>'
      + '  <div class="grip" id="grip" title="' + tr('p.grip') + '"></div>'
      + '</div>';

    el = {
      wrap: root.querySelector('.wrap'),
      list: root.querySelector('#list'),
      input: root.querySelector('#input'),
      chips: root.querySelector('#chips'),
      send: root.querySelector('#send'),
      models: root.querySelector('#models'),
      effort: root.querySelector('#effort'),
      file: root.querySelector('#file'),
      page: root.querySelector('#page'),
      imgPrompt: root.querySelector('#imgprompt'),
      reco: root.querySelector('#reco'),
      fsBtn: root.querySelector('#fs'),
      bal: root.querySelector('#bal'),
      set: root.querySelector('#set'),
      grip: root.querySelector('#grip'),
      bar: root.querySelector('.bar'),
      drawer: root.querySelector('#drawer'),
      dq: root.querySelector('#dq'),
      dlist: root.querySelector('#dlist'),
      toast: root.querySelector('#toast'),
      tag: root.querySelector('#mtag'),
      viewer: root.querySelector('#viewer'),
      vimg: root.querySelector('#vimg'),
      vcap: root.querySelector('#vcap'),
      cfm: root.querySelector('#cfm'),
      cfmT: root.querySelector('#cfm-t'),
      cfmM: root.querySelector('#cfm-m'),
      cfmYes: root.querySelector('#cfm-yes'),
      cfmNo: root.querySelector('#cfm-no'),
      mark: mark
    };

    // 宿主模式（侧边栏）藏掉这两个：「全屏」铺满之后没意义，「退出」只会退出一片空白
    // （关侧栏该用浏览器自己的按钮）。「应用网页」**留着** —— 侧边栏里它会去读
    // 你正在看的那个标签页（见 grabContext），所以在那儿同样有用。
    if (isHost()) {
      ['#fs', '#exit'].forEach(function (sel) {
        var b = root.querySelector(sel);
        if (b) { b.style.display = 'none'; }
      });
    }

    fillModels();
    fillEfforts();

    // 「这是什么？」快捷提示词按钮（文字取 config.js 的 imagePrompt，留空就不显示这个按钮）
    if (IMG_PROMPT) { el.imgPrompt.textContent = IMG_PROMPT; }
    else { el.imgPrompt.style.display = 'none'; }

    // 面板内部的键盘 / 滚轮事件不要漏给网页
    ['keydown', 'keypress', 'keyup', 'pointerdown', 'mousedown', 'wheel', 'contextmenu'].forEach(function (t) {
      host.addEventListener(t, function (e) { e.stopPropagation(); }, false);
    });

    root.querySelector('#history').addEventListener('click', function () { el.drawer.classList.toggle('open'); });
    // 历史搜索：输入即过滤。数据本来就在内存里（state.chats），纯前端筛，不打接口。
    el.dq.addEventListener('input', function () { renderHistory(); });
    root.querySelector('#new').addEventListener('click', function () {
      state.cur = newChat();
      state.chats.unshift(state.cur);
      state.atts = [];
      state.histIdx = -1;          // 换对话了，↑ 翻历史的状态跟着归零
      // 同上：新对话的标题是"新对话"，留在过滤里它自己都显示不出来
      if (el.dq) { el.dq.value = ''; }
      persist();
      renderChips();
      renderAll();
      renderHistory();
      el.drawer.classList.remove('open');
      el.input.focus();
    });
    root.querySelector('#del').addEventListener('click', function () {
      if (!state.cur) { return; }
      var c = state.cur;
      // 空对话直接删（没什么可丢的）；有内容的走面板自己的确认层 ——
      // 不用 window.confirm：那是**页面的** confirm，页面能改写它（改成永远返回 true），
      // 拿它给不可逆操作把关不可靠。
      var go = function () {
        dropChat(c);
        state.cur = newChat();
        state.chats.unshift(state.cur);
        persist();
        renderAll();
        renderHistory();
        toast(tr('p.deleted'));
      };
      if (!c.messages.length) { go(); return; }
      askConfirm(tr('p.delQ'),
        tr('p.delBody', { t: titleText(c), n: c.messages.length }),
        tr('p.delDo'), go);
    });
    root.querySelector('#exp').addEventListener('click', function () { exportAll(); });
    root.querySelector('#cln').addEventListener('click', function () { askClean(); });
    root.querySelector('#exit').addEventListener('click', function () {
      close();
    });
    root.querySelector('#set').addEventListener('click', function () { openSettings(); });
    el.bal.addEventListener('click', function () { showBalance(el.bal); });
    el.fsBtn.addEventListener('click', function () { toggleFs(); });
    el.grip.addEventListener('pointerdown', onGripDown);
    el.bar.addEventListener('pointerdown', onBarDown);

    // 代码块的复制按钮：走事件委托（回答正文每帧都会重写 innerHTML，逐个绑会漏）。
    // 捕获阶段拦下来，免得被抽屉/关闭那类监听抢走。
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) { return; }
      var btn = t.closest('.cp-code');
      if (!btn) { return; }
      e.preventDefault();
      e.stopPropagation();
      var wrap = btn.parentNode;
      var codeEl = wrap ? wrap.querySelector('code') : null;
      copyText(codeEl ? codeEl.textContent : '', btn);
    }, true);

    el.send.addEventListener('click', function () { state.sending ? abort() : send(); });
    // 粘贴：剪贴板里有图/文件就进附件（纯文字不插手，见 onPaste）
    root.addEventListener('paste', onPaste);
    // 图片预览层：点哪儿都关（Esc 也能关，见下面那个 keydown）
    el.viewer.addEventListener('click', function () { closeViewer(); });
    // 回滚确认：只有"算了"和 Esc 能取消（点边上空白不关，免得手一滑把对话框撸掉）
    el.cfmNo.addEventListener('click', function () { closeConfirm(); });
    el.cfmYes.addEventListener('click', function () {
      var fn = cfmAction;
      closeConfirm();
      if (fn) { fn(); }
    });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
      // ↑ / ↓ 翻自己发过的话（像终端那样）。只在"光标在第一行 / 最后一行"时才接管 ——
      // 输入框是多行的，正在中间改字时按方向键，你要的是移动光标，不是翻历史。
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (recallHistory(e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); }
      }
    });
    el.input.addEventListener('input', function () {
      // 手打一个字就退出"翻历史"状态 —— 否则下一次按 ↑ 会从奇怪的偏移接着翻
      state.histIdx = -1;
      autoGrow();
    });
    el.file.addEventListener('change', function () { addFiles(el.file.files); el.file.value = ''; });
    el.page.addEventListener('click', function () {
      // togglePageCtx 现在是异步的（要等标签页回话）。这里兜一下，别让异常变成控制台里
      // 一条看不懂的 unhandled rejection。
      Promise.resolve(togglePageCtx()).catch(function (e) {
        state.pageMode = null;
        renderChips();
        toast(tr('p.pageCant', { why: (e && e.message) || e }));
      });
    });
    el.imgPrompt.addEventListener('click', function () { toggleImagePrompt(); });
    // 「推荐图片」：点一下开 / 关。开关本身存进浏览器（跟模型、思考强度一样），
    // 刷新页面、换标签页都还开着 —— 它表达的是"我习惯要配图建议"，不是"这一轮"的事。
    el.reco.addEventListener('click', function () {
      state.recoImg = !state.recoImg;
      syncReco();
      save(K_RECO, state.recoImg);
      toast(state.recoImg ? tr('p.recoOnToast') : tr('p.recoOffToast'));
    });
    el.models.addEventListener('change', function () {
      state.model = el.models.value;   // 这里是 id
      var o = el.models.options[el.models.selectedIndex];
      setModelTag(o ? o.textContent : state.model);
      save(K_MODEL, state.model);
    });
    el.effort.addEventListener('change', function () {
      state.effort = el.effort.value;   // 这里也是 id：none / low / medium / high
      save(K_EFFORT, state.effort);
    });

    (document.body || document.documentElement).appendChild(host);
  }

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
    syncImgPromptBtn();
  }

  function caretToEnd() {
    try { el.input.setSelectionRange(el.input.value.length, el.input.value.length); } catch (e) {}
  }

  // 输入框里按 ↑ / ↓ 翻自己发过的话（跟终端一个手感）。
  // 翻的是 `show` —— 也就是**你在气泡里看到的那句**。content 里塞着网页正文和附件全文，
  // 把那玩意儿填回输入框就没法看了。
  // 返回 true = "这一下我接管了"，调用方要 preventDefault 把光标移动挡掉；
  // 返回 false = 这一下让给光标（比如你在多行文字中间上下挪）。
  function recallHistory(dir) {
    if (!el.input) { return false; }
    var v = el.input.value;
    var caret = el.input.selectionStart;
    // 多行输入框的礼貌：↑ 只在**第一行**、↓ 只在**最后一行**时才翻历史，
    // 其余情况把方向键让给光标。不然在一个长段中间想上下移动就全乱了。
    if (dir < 0) { if (v.slice(0, caret).indexOf('\n') >= 0) { return false; } }
    else { if (v.slice(caret).indexOf('\n') >= 0) { return false; } }

    var mine = (state.cur ? state.cur.messages : []).filter(function (m) {
      return m.role === 'user' && (m.show || '').trim();
    }).map(function (m) { return m.show; });
    if (!mine.length) { return false; }

    var i = state.histIdx;
    if (dir < 0) {
      if (i < 0) {                 // 第一次按 ↑：先把草稿存起来，从最新一条往回翻
        state.histDraft = v;
        i = mine.length;
      }
      if (i === 0) { return true; }  // 已经翻到最早那条：吃掉这一下，什么都不做（别跳出到别的地方）
      i -= 1;
    } else {
      if (i < 0) { return false; }   // 没在翻历史 → ↓ 该正常移动光标
      if (i >= mine.length - 1) {    // 已经翻过最新一条 → 把刚才那半句还给你
        state.histIdx = -1;
        el.input.value = state.histDraft || '';
        caretToEnd();
        autoGrow();
        return true;
      }
      i += 1;
    }
    state.histIdx = i;
    el.input.value = mine[i];
    caretToEnd();
    autoGrow();
    return true;
  }

  // 输入框最后一行正好是那句提示词（按钮点亮 / 再点收回都以它为准）
  function promptPinned() {
    if (!IMG_PROMPT || !el.input) { return false; }
    var v = el.input.value.replace(/\s+$/, '');
    var lines = v.split('\n');
    return lines[lines.length - 1].trim() === IMG_PROMPT;
  }

  // 输入框里带着那句提示词时，把「这是什么？」按钮点亮
  // （所有改输入框的地方都会走 autoGrow，所以同步挂在那儿）
  function syncImgPromptBtn() {
    if (!el.imgPrompt) { return; }
    el.imgPrompt.classList.toggle('on', promptPinned());
  }

  // 「这是什么？」小按钮：点一下填进去，再点一下收回去
  function toggleImagePrompt() {
    if (!el.input || !IMG_PROMPT) { return; }
    var v = el.input.value.replace(/\s+$/, '');
    if (promptPinned()) {                // 已经填着了 → 把它这一行收回去
      var lines = v.split('\n');
      lines.pop();
      el.input.value = lines.join('\n').replace(/\s+$/, '');
    } else {                             // 没填 → 追加（自己写的字不动）
      el.input.value = v ? (v + '\n' + IMG_PROMPT) : IMG_PROMPT;
    }
    autoGrow();
    if (isOpen()) {
      try {
        el.input.focus();
        el.input.setSelectionRange(el.input.value.length, el.input.value.length);
      } catch (e) {}
    }
  }

  // 图片进附件后自动填提示词（config.js 的 autoFillImagePrompt 打开时才走这里）
  // 只在「输入框是空的」或「里面最后一行正是那句提示词」时才写，你自己打了一半的字不会被覆盖。
  function suggestImagePrompt() {
    if (!IMG_PROMPT_AUTO || !IMG_PROMPT || !el.input) { return; }
    var t = el.input.value.trim();
    if (t && !promptPinned()) { return; }
    if (promptPinned()) { return; }
    el.input.value = t ? (t.replace(/\s+$/, '') + '\n' + IMG_PROMPT) : IMG_PROMPT;
    autoGrow();
    if (isOpen()) {
      try {
        el.input.focus();
        el.input.setSelectionRange(el.input.value.length, el.input.value.length);
      } catch (e) {}
    }
  }

  // 下拉框显示 label，值（发给接口的）是 id。
  // 如果存储里那个模型已经不在 config 里（比如官方改名了），直接回落到配置默认值，
  // 并且把存储里的旧值改掉——不能让一个失效的名字继续挂在下拉框里。
  function fillModels() {
    var list = modelList();
    var has = function (id) { return list.some(function (m) { return m.id === id; }); };
    if (!has(state.model)) {
      state.model = has(cfg.model) ? cfg.model : list[0].id;
      save(K_MODEL, state.model);
    }
    el.models.textContent = '';
    list.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      o.title = m.id;
      el.models.appendChild(o);
    });
    el.models.value = state.model;
    var cur = list.filter(function (m) { return m.id === state.model; })[0];
    setModelTag(cur ? cur.label : state.model);
  }

  // 思考强度下拉框：档位取自 config.js 的 efforts，选中项存本地（下次打开还是它）
  function fillEfforts() {
    if (!el.effort) { return; }
    var list = effortList();
    var has = function (id) { return list.some(function (m) { return m.id === id; }); };
    // 先把老档位名（medium / xhigh 这类）换算成官方真值，否则会存着一个下拉框里根本没有的 id
    var mig = effortId(state.effort);
    if (mig !== state.effort) { state.effort = mig; save(K_EFFORT, mig); }
    if (!has(state.effort)) { state.effort = list[0].id; save(K_EFFORT, state.effort); }
    el.effort.textContent = '';
    list.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      // 文案默认取 config.js 的 label（用户可能自己改过）；只有英文界面才用词表顶替，
      // 词表里没有这个 id 时仍然回落 config 的写法。
      o.textContent = LANG === 'en' ? tr('p.effort.' + m.id, null, m.label) : m.label;
      o.title = m.id;
      el.effort.appendChild(o);
    });
    el.effort.value = state.effort;
  }

  // 把思考强度塞进请求体。
  // ⚠ 依官方现行文档（thinking mode），OpenAI 格式下有两个坑：
  //   ① reasoning_effort **只认 low / high / max**；「关思考」不是发 none（那个值不在合法
  //      列表里，会被**静默忽略**，模型照旧按默认档思考 —— 钱照花、还慢），
  //      正确写法是 thinking:{type:'disabled'}。
  //   ② thinking **默认就是开着的**：不传任何参数 = 默认 high，不等于"不思考"。
  //      而且档位映射表里 requested 的 medium / xhigh 都会被**归到 high** ——
  //      所以界面上不能摆一个叫"中"的档，那是在骗人（实际跑的是"高"）。
  function withEffort(body) {
    var e = effortId(state.effort);
    if (e === 'none') {
      body.thinking = { type: 'disabled' };
      return body;          // 关思考时不发 reasoning_effort：两个字段同时出现没有意义
    }
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = e;
    return body;
  }

  // 把存下来的档位名换算成官方真值（照官方映射表）。老配置里的 'medium' 实际就是按 high
  // 跑的，这里换算成 'high' —— 行为一点不变，只是下拉框里不再显示一个骗人的"中"。
  // 认不出来的原样返回，交给接口自己判断。
  function effortId(id) {
    var s = String(id || '');
    if (s === 'medium' || s === 'xhigh') { return 'high'; }
    if (s === 'minim') { return 'low'; }
    if (s === 'ultramax') { return 'max'; }
    return s || 'none';
  }

  function setModelTag(label) {
    el.tag.textContent = label;
    el.tag.title = state.model;
  }

  // ---------------- 「推荐图片」：把模型给的搜索词变成可点的小块 ----------------
  // 扩展自己不能生成图片，接口也不会返回图片 —— 所以能做的是"给几个能搜到配图的词"。
  // 开着这颗按钮时，请求里会多一段要求（RECO_SYS），让模型在回答末尾附上：
  //     <img-reco>蓝色鲸鱼 扁平插画 | 深海 摄影</img-reco>
  // 这里把这段从正文里抠出来（正文不留标记），渲染成一行可点的小块，点一下浏览器搜图。
  // 为什么不让模型直接给图片网址：它给的网址**一定是编的**，点了多半 404；搜索词才是真能用的。
  var RECO_OPEN = '<img-reco>';
  var RECO_CLOSE = '</img-reco>';
  var RECO_SYS = [
    '另外，在回答的最后另起一行，给出 2~3 个能搜到相关配图的**搜索关键词**，用下面的格式包起来：',
    RECO_OPEN + '关键词一 | 关键词二 | 关键词三' + RECO_CLOSE,
    '要求：每个词要具体、能直接拿去搜图（比如「蓝色鲸鱼 扁平插画」），不要写成句子，也不要给网址；',
    '这个标记只给程序看 —— 正文里不要解释它，也不要提到这件事。'
  ].join('\n');

  // 返回 { body: 去掉标记的正文, keys: [搜索词] }。
  // 流式输出时标记可能只出来一半（还没闭合）—— 那种情况也要抠掉，
  // 否则用户会看着这串标签一个字一个字地长出来。
  function splitReco(text) {
    var s = String(text || '');
    var a = s.indexOf(RECO_OPEN);
    if (a < 0) { return { body: s, keys: [] }; }
    var b = s.indexOf(RECO_CLOSE, a + RECO_OPEN.length);
    var inner = b < 0 ? s.slice(a + RECO_OPEN.length) : s.slice(a + RECO_OPEN.length, b);
    var body = s.slice(0, a) + (b < 0 ? '' : s.slice(b + RECO_CLOSE.length));
    var keys = inner.split('|').map(function (k) { return k.trim(); })
      .filter(function (k) { return k && k.length <= 60; })
      .slice(0, 5);
    // 两端空白去掉：标记在中间时（模型不听话），前后两段拼起来会多出空行
    return { body: body.replace(/^\s+|\s+$/g, ''), keys: keys };
  }

  function imgSearchUrl(q) {
    var tpl = String(cfg.imageSearch || '');
    if (tpl.indexOf('{q}') < 0) { tpl = 'https://image.baidu.com/search/index?tn=baiduimage&word={q}'; }
    return tpl.replace('{q}', encodeURIComponent(q));
  }

  // 气泡底部那一行。模型没给词就整行不显示 —— 不硬凑。
  function renderReco(m) {
    if (!m || !m.$reco) { return; }
    var keys = splitReco(m.show || '').keys;
    m.$reco.textContent = '';
    if (!keys.length) { m.$reco.style.display = 'none'; return; }
    m.$reco.style.display = 'flex';
    var lab = document.createElement('span');
    lab.className = 'reco-lab';
    lab.textContent = tr('p.recoLabel');
    m.$reco.appendChild(lab);
    m.$reco.appendChild(document.createTextNode(''));
    keys.forEach(function (k) {
      // 用真的 <a>：右键能"在新标签页打开 / 复制链接"，比 onclick 里 window.open 好用，
      // 也不吃 CSP —— 浏览器自己的导航行为，跟页面策略无关。
      var a = document.createElement('a');
      a.className = 'reco-k';
      a.textContent = k;
      a.href = imgSearchUrl(k);
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = tr('p.recoSearch', { q: k });
      m.$reco.appendChild(a);
    });
  }

  // ---------------- 渲染 ----------------
  function renderEmpty() {
    var d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = '<div class="mark">' + (el.mark || '') + '</div>'
      + '<p>' + tr('p.emptyLine').replace('{name}', esc(A.name || 'AI')) + '</p>';
    el.list.appendChild(d);
  }

  function syncThink(m) {
    if (!m.$think) { return; }
    if (m.reasoning) {
      m.$thinkText.textContent = m.reasoning;
      m.$think.style.display = '';
    } else {
      m.$think.style.display = 'none';
    }
  }

  // 把 token 数缩成好读的样子：1234 → 1.2k
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 1000) { return String(n); }
    if (n < 10000) { return (n / 1000).toFixed(1) + 'k'; }
    return Math.round(n / 1000) + 'k';
  }

  // 这一轮的实际用量：输入多少、其中缓存命中多少、输出多少、思考占了多少。
  // 为什么值得画出来：
  //   · 缓存命中和未命中**差 50 倍**（$0.003 vs $0.15 每百万 token），命中率是唯一值得盯的数；
  //   · 「思考」那一项是**关思考到底有没有生效的判据** —— 档位选"不思考"时它必须是 0，
  //     不是 0 就说明参数没被服务端认（官方文档：reasoning_effort 合法值只有 low/high/max）。
  // 没有 usage 就整行藏起来（老记录、请求失败、或者接口没给这字段）。
  function syncUsage(m) {
    if (!m.$usage) { return; }
    var u = m.usage;
    if (!u || typeof u !== 'object') { m.$usage.style.display = 'none'; return; }
    var hit = Number(u.prompt_cache_hit_tokens) || 0;
    var miss = Number(u.prompt_cache_miss_tokens) || 0;
    var pt = Number(u.prompt_tokens) || (hit + miss);
    var ct = Number(u.completion_tokens) || 0;
    var rs = (u.completion_tokens_details && Number(u.completion_tokens_details.reasoning_tokens)) || 0;
    var parts = [tr('p.inTok') + ' ' + fmtTok(pt)];
    if (hit || miss) { parts.push(tr('p.hitTok') + ' ' + fmtTok(hit)); }
    parts.push(tr('p.outTok') + ' ' + fmtTok(ct));
    if (rs) { parts.push(tr('p.thinkTok') + ' ' + fmtTok(rs)); }
    m.$usage.textContent = parts.join(' · ');
    m.$usage.title = tr('p.usageTip', {
      'in': pt, hit: hit, miss: miss, out: ct,
      think: rs ? tr('p.usageThink', { n: rs }) : ''
    });
    m.$usage.style.display = '';
  }

  function bubble(m, idx) {
    var row = document.createElement('div');
    row.className = 'row ' + (m.role === 'user' ? 'me' : 'ai');
    var b = document.createElement('div');
    b.className = 'bubble';

    if (m.role === 'user' && typeof idx === 'number' && idx >= 0) {
      // 「回到这里」：丢掉这条和后面所有内容，并把这条的文字放回输入框 ——
      // 也就是"这句我换个说法再问一次"，这正是反复试提示词时真正要做的动作。
      // 不用存任何快照：消息数组本来就是 append-only 的，回滚 = 保留前 N 条。
      var back = document.createElement('button');
      back.className = 'cp cp-back';
      back.type = 'button';
      back.title = tr('p.backTitle');
      back.textContent = tr('p.back');
      back.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        askRollback(idx);
      });
      b.appendChild(back);
    }

    if (m.role === 'assistant') {
      var think = document.createElement('details');
      think.className = 'think';
      var sum = document.createElement('summary');
      sum.textContent = tr('p.think');
      var tt = document.createElement('div');
      tt.className = 'tt';
      think.appendChild(sum);
      think.appendChild(tt);
      b.appendChild(think);
      m.$think = think;
      m.$thinkText = tt;
      syncThink(m);
      // 复制整条回答。面板在 Shadow DOM 里，手动框选跨边界很别扭、代码块还容易漏，
      // 所以这一下比看起来值。
      // 复制的是**好读的纯文本**（mdToText）：表格按列对齐、去掉 |---|---| 和 ** 这类记号。
      // 之前复制的是 markdown 原文，表格粘到聊天窗口里就是一串竖线 —— 那是"能再用"，
      // 不是"能看懂"，要的是后者。
      var cp = document.createElement('button');
      cp.className = 'cp cp-msg';
      cp.type = 'button';
      cp.title = tr('p.copyAnswerTitle');
      cp.textContent = tr('p.copy');
      cp.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        // 复制的是**正文**：不带「推荐图片」那段标记（那是给界面用的，混进去会像乱码）
        copyText(mdToText(splitReco(m.content || m.show || '').body), cp);
      });
      b.appendChild(cp);
      // 「重试」：看完一段回答觉得不对味时最顺手的动作 —— 问题不动，让它重答一遍。
      // 和「回到这里」是两件事：那个是**改问题**（文字放回输入框、消息删掉），
      // 这个是**换个答案**（问题原样留着，只把这条回答替换掉）。
      var rt = document.createElement('button');
      rt.className = 'cp cp-msg cp-retry';
      rt.type = 'button';
      rt.title = tr('p.retryTitle');
      rt.textContent = tr('p.retry');
      rt.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        retryMsg(m);
      });
      b.appendChild(rt);
    }
    if (m.attachments && m.attachments.length) {
      var atts = document.createElement('div');
      atts.className = 'atts';
      m.attachments.forEach(function (a) {
        var sp = document.createElement('span');
        sp.textContent = a.name;
        atts.appendChild(sp);
      });
      b.appendChild(atts);
    }
    var body = document.createElement('div');
    body.className = 'body';
    // 正文里不含「推荐图片」那段标记（见 splitReco）—— 那部分留给下面那一行小块
    body.innerHTML = mdToHtml(splitReco(m.show || '').body);
    b.appendChild(body);
    // 「推荐图片」那一行：模型给了搜索词才显示（历史消息重开面板也还在）
    var reco = document.createElement('div');
    reco.className = 'reco';
    b.appendChild(reco);
    m.$reco = reco;
    renderReco(m);
    // 这一轮花了多少 token（见 syncUsage）—— 只有看得见，才谈得上"省"
    if (m.role === 'assistant') {
      var us = document.createElement('div');
      us.className = 'usage';
      b.appendChild(us);
      m.$usage = us;
      syncUsage(m);
    }
    // 这条是什么时候说的。老记录（2026-10-13 之前存的）没有 ts —— 那就不显示，
    // 不拿"现在"去糊一个假时间。
    if (typeof m.ts === 'number' && m.ts) {
      var tm = document.createElement('div');
      tm.className = 'time';
      tm.textContent = fmtTime(m.ts);
      tm.title = new Date(m.ts).toLocaleString();
      b.appendChild(tm);
    }
    row.appendChild(b);
    m.$body = body;
    return row;
  }

  function renderAll() {
    el.list.textContent = '';
    var c = state.cur;
    if (!c || !c.messages.length) { renderEmpty(); return; }
    c.messages.forEach(function (m, i) { el.list.appendChild(bubble(m, i)); });
    scrollBottom();
  }

  function scrollBottom() {
    el.list.scrollTop = el.list.scrollHeight;
  }

  // ---------------- 导出 / 清理历史 ----------------
  // 为什么需要：chrome.storage.local 默认只有 10MB，聊天记录会一直长，撞上就是"写不进去"。
  // 抽屉里原来只能翻和单条删 —— 既看不见占了多少，也没法把东西拿出来。

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) {
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function hm(d) { return two(d.getHours()) + ':' + two(d.getMinutes()); }

  // 把所有对话拼成一份 markdown（纯函数，方便单测）。
  // 导出的是消息**显示的那份文本**（show，也就是你在气泡里看到的），不是发给模型的 content ——
  // content 里塞着整页网页正文、附件全文，导出来会变成一坨没法看的东西。
  // 「推荐图片」那段标记会剥掉（它是给界面用的）。
  function chatsToMd(chats, nowMs) {
    var now = new Date(nowMs || Date.now());
    var L = [tr('p.mdTitle', { name: A.name || 'Nova' }), '',
      tr('p.mdTime', { t: ymd(now) + ' ' + hm(now), n: (chats || []).length }), ''];
    (chats || []).forEach(function (c) {
      var t = new Date(Number(c.updatedAt) || Date.now());
      L.push('---', '', '## ' + titleText(c), '',
        tr('p.mdLast', { t: ymd(t) + ' ' + hm(t), n: (c.messages || []).length }), '');
      (c.messages || []).forEach(function (m) {
        L.push('**' + (m.role === 'user' ? (A.user || tr('p.mdMe')) : (A.name || 'Nova')) + '**', '');
        L.push(splitReco(m.show || '').body || tr('p.mdEmpty'));
        L.push('');
        if (m.attachments && m.attachments.length) {
          L.push(tr('p.mdAttach', {
            list: m.attachments.map(function (a) { return a.name; }).join(tr('p.mdSep'))
          }), '');
        }
      });
    });
    L.push('---', '');
    return L.join('\n');
  }

  function downloadText(name, text) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);        // 得真的在文档里才点得动
      a.click();
      a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 10000);
      return true;
    } catch (e) { return false; }
  }

  function exportAll() {
    var list = state.chats.filter(function (c) { return (c.messages || []).length; });
    if (!list.length) { toast(tr('p.exportNone')); return; }
    var d = new Date();
    var stamp = ymd(d).replace(/-/g, '') + '-' + two(d.getHours()) + two(d.getMinutes());
    var name = tr('p.fileName', { name: A.name || 'Nova', stamp: stamp }) + '.md';
    if (!downloadText(name, chatsToMd(list))) {
      toast(tr('p.exportFail'));
      return;
    }
    toast(tr('p.exported', { n: list.length, file: name }));
  }

  // 清理：只动「超过 CLEAN_DAYS 天」的，且**不碰你正在看的那个**。删之前先问一次。
  function askClean() {
    var now = Date.now();
    var curId = state.cur && state.cur.id;
    var old = state.chats.filter(function (c) {
      return c.id !== curId && (now - (Number(c.updatedAt) || 0)) > CLEAN_DAYS * 86400000;
    });
    if (!old.length) {
      var oldest = 0;
      state.chats.forEach(function (c) {
        var t = Number(c.updatedAt) || 0;
        if (c.id !== curId && t && (!oldest || t < oldest)) { oldest = t; }
      });
      toast(oldest
        ? tr('p.cleanNone', { d: CLEAN_DAYS, e: Math.max(1, Math.round((now - oldest) / 86400000)) })
        : tr('p.cleanNothing'));
      return;
    }
    var chars = 0;
    old.forEach(function (c) {
      (c.messages || []).forEach(function (m) {
        chars += String(m.content || '').length + String(m.show || '').length;
      });
    });
    askConfirm(tr('p.cleanQ'),
      tr('p.cleanBody', { n: old.length, d: CLEAN_DAYS, k: Math.round(chars / 1000) }),
      tr('p.cleanDo', { n: old.length }),
      function () {
        old.forEach(function (c) { dropChat(c); });
        persist();
        renderHistory();
        toast(tr('p.cleaned', { n: old.length }));
      });
  }

  // ---------------- 回到某条消息之前（最小版的"快照 / 回滚"） ----------------
  // 不存快照内容：消息数组本来就是 append-only 的（每轮 push user + assistant），
  // 所以"回滚到第 N 条"= 保留前 N 条 —— 那个下标就是全部的快照，零存储、也不会和主数据不同步。
  // 代价在确认层里写清楚：丢掉不可撤销、图片回滚不了（base64 不落库）、token 也不回滚。
  var cfmAction = null;        // 确认层点"确定"要干的事（回滚 / 清理旧对话…）
  function isConfirmOpen() { return !!(el.cfm && el.cfm.classList.contains('show')); }
  function closeConfirm() {
    cfmAction = null;
    if (el.cfm) { el.cfm.classList.remove('show'); }
  }

  // 确认层是公用的（回滚、清理旧对话都走它）。
  // **不用 window.confirm**：content script 里那个是页面的 confirm，页面能改写它
  // （改成永远返回 true），拿它给不可逆操作把关不可靠。
  function askConfirm(title, msg, yesLabel, fn) {
    cfmAction = fn;
    el.cfmT.textContent = title;
    el.cfmM.textContent = msg;
    el.cfmYes.textContent = yesLabel || tr('p.ok');
    el.cfm.classList.add('show');
  }

  function askRollback(idx) {
    var c = state.cur;
    if (!c || !c.messages[idx]) { return; }
    if (state.sending) { toast(tr('p.backBusy')); return; }
    var dropped = c.messages.length - idx;
    var chars = 0;
    for (var i = idx; i < c.messages.length; i++) { chars += String(c.messages[i].content || '').length; }
    var hadAtt = c.messages.slice(idx).some(function (x) { return x.attachments && x.attachments.length; });
    var hadInput = !!(el.input && el.input.value.trim());
    askConfirm(tr('p.backQ'),
      tr('p.backBody', { n: dropped, c: chars }) +
      (hadAtt ? tr('p.backAtt') : '') +
      (hadInput ? tr('p.backInput') : '') +
      tr('p.backKeep'),
      tr('p.discard'),
      function () { doRollback(idx); });
  }

  function doRollback(idx) {
    var c = state.cur;
    if (!c || typeof idx !== 'number' || idx < 0 || idx >= c.messages.length) { return; }
    var m = c.messages[idx];
    if (m.role !== 'user') { return; }
    var dropped = c.messages.length - idx;
    // 这条的文字放回输入框。附件/网页那几轮的"真身"本来就不落库（图片 base64 会撑爆配额），
    // 所以 show 是占位文案（"（见附件）"这种）时不填 —— 填个占位反而误导。
    var back = String(m.show || '').trim();
    if (/^（见/.test(back)) { back = ''; }
    c.messages.length = idx;                      // ← 截断就是"回滚"的全部
    // 记一笔"后面那些是我故意删的"。不记的话，写盘合并（见 mergedMessages）会把它们
    // 从另一个窗口那份里又救回来 —— 表现就是"回滚完，删掉的那几轮自己回来了"。
    c.cutAt = c.messages.length ? msgKey(c.messages[c.messages.length - 1]) : '';
    c.cutTs = Date.now();
    if (!c.messages.length) { c.title = NEW_TITLE; }
    el.input.value = back;
    autoGrow();
    persist();
    renderAll();
    renderHistory();
    try {
      el.input.focus();
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    } catch (e) {}
    toast(back
      ? tr('p.backDone', { n: dropped })
      : tr('p.backDoneNoText', { n: dropped }));
  }

  function renderChips() {
    el.chips.textContent = '';
    if (el.page) {
      var pm = state.pageMode;
      el.page.classList.toggle('on', !!pm);
      el.page.textContent = pm === 'full' ? tr('p.pageFull')
        : (pm === 'view' ? tr('p.pageVisible') : tr('p.page'));
      el.page.title = pm ? tr('p.pageOnTitle') : tr('p.pageOffTitle');
    }
    var hasAny = state.atts.length || state.pageCtx || state.sel.length;
    if (!hasAny) { el.chips.style.display = 'none'; return; }
    el.chips.style.display = 'flex';

    if (state.pageCtx) {
      var pc = document.createElement('div');
      pc.className = 'chip page';
      var pb = document.createElement('b');
      var pcN = state.pageCtx.images || 0;
      var pcPrefix = state.pageCtx.mode === 'view' ? tr('p.chipView') : tr('p.chipFull');
      pb.textContent = pcPrefix + state.pageCtx.title + (pcN ? tr('p.chipImgs', { n: pcN }) : '') +
        (state.pageCtx.reused ? tr('p.chipCached') : '');
      pb.title = state.pageCtx.title;
      var px = document.createElement('button');
      px.textContent = '×';
      px.title = tr('p.stopRead');
      px.addEventListener('click', function () { state.pageCtx = null; state.pageMode = null; renderChips(); });
      pc.appendChild(pb);
      pc.appendChild(px);
      el.chips.appendChild(pc);
    }

    // 划词带进来的选段：显示成和附件一样的蓝色小块，点 × 撤掉。
    // **不把正文灌进输入框** —— 选一段长文的时候那会把输入框糊满，没法接着写字。
    state.sel.forEach(function (s, i) {
      var c = document.createElement('div');
      c.className = 'chip sel';
      var b = document.createElement('b');
      b.textContent = tr('p.selChip', { label: s.label || tr('p.selText'), n: (s.text || '').length });
      b.title = (s.prompt ? s.prompt + '\n\n' : '') + (s.text || '');
      var x = document.createElement('button');
      x.textContent = '×';
      x.title = tr('p.selUndo');
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        state.sel.splice(i, 1);
        renderChips();
      });
      c.appendChild(b);
      c.appendChild(x);
      el.chips.appendChild(c);
    });

    state.atts.forEach(function (a, i) {
      var c = document.createElement('div');
      c.className = 'chip' + (a.image && a.dataUrl ? ' viewable' : '');
      // 图片附件：左边挂个缩略图 + 双击铺开看。
      // 只对"这次待发的东西"有效 —— 发出去之后 base64 不落库（会撑爆 storage），
      // 所以历史里的图本来也拿不到，不存在"点旧图看不了"这种落差。
      if (a.image && a.dataUrl) {
        var th = document.createElement('img');
        th.className = 'th';
        th.src = a.dataUrl;
        th.alt = '';
        c.appendChild(th);
        c.title = tr('p.viewImg');
      }
      var b = document.createElement('b');
      b.textContent = a.name;
      var x = document.createElement('button');
      x.textContent = '×';
      x.title = tr('p.remove');
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        state.atts.splice(i, 1);
        renderChips();
      });
      c.appendChild(b);
      c.appendChild(x);
      if (a.image && a.dataUrl) {
        c.addEventListener('dblclick', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openViewer(a);
        });
      }
      el.chips.appendChild(c);
    });
  }

  // ---------------- 图片预览 ----------------
  // 只服务"当前待发的附件"（`state.atts` 里 image=true 的那些）。
  // 为什么不新开标签页看：data: URL 在 Chrome 里 window.open / tabs.create 都被拦，
  // 所以在面板里盖一层看是最省事也最稳的做法。
  function fmtSize(n) {
    var b = Number(n) || 0;
    if (!b) { return ''; }
    if (b < 1024) { return b + ' B'; }
    if (b < 1024 * 1024) { return (b / 1024).toFixed(1) + ' KB'; }
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function isViewerOpen() { return !!(el.viewer && el.viewer.classList.contains('show')); }
  function openViewer(a) {
    if (!el.viewer || !a || !a.dataUrl) { return; }
    el.vimg.src = a.dataUrl;
    var sz = fmtSize(a.size);
    el.vcap.textContent = (a.name || tr('p.thumb')) + (sz ? ' · ' + sz : '') + tr('p.viewerHint');
    el.viewer.classList.add('show');
  }
  function closeViewer() {
    if (!el.viewer) { return; }
    el.viewer.classList.remove('show');
    // 用 removeAttribute 而不是 src=''：赋空字符串会被当成相对路径解析成**当前页面地址**，
    // 浏览器顺手又去加载一次页面，base64 也没真松开（自检里就是这么抓出来的）。
    el.vimg.removeAttribute('src');
  }

  // 一条对话是否命中搜索词：标题 + 每条消息的**显示文本**（show）。
  // 搜 show 不搜 content —— content 里塞着整页网页正文和附件全文，拿它来匹配
  // 会出现"这对话我明明没提过这个词，怎么搜出来了"的诡异结果。
  function chatHit(c, q) {
    if (!q) { return true; }
    if (String(c.title || '').toLowerCase().indexOf(q) >= 0) { return true; }
    return (c.messages || []).some(function (m) {
      return String((m && m.show) || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderHistory() {
    el.dlist.textContent = '';
    var raw = el.dq ? el.dq.value.trim() : '';
    var q = raw.toLowerCase();
    var list = state.chats.slice();
    if (q) { list = list.filter(function (c) { return chatHit(c, q); }); }
    if (!list.length) {
      var p = document.createElement('div');
      p.className = 'empty';
      p.style.fontSize = '12.5px';
      p.textContent = raw ? tr('p.noHit', { q: raw }) : tr('p.noHistory');
      el.dlist.appendChild(p);
      return;
    }
    list.sort(function (a, b) { return b.updatedAt - a.updatedAt; }).forEach(function (c) {
      var it = document.createElement('div');
      it.className = 'hitem' + (state.cur && c.id === state.cur.id ? ' on' : '');
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = titleText(c);
      var d = document.createElement('div');
      d.className = 'd';
      d.textContent = fmtTime(c.updatedAt);
      var x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = tr('p.delItem');
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        askConfirm(tr('p.delQ'),
          tr('p.delBody', { t: titleText(c), n: (c.messages || []).length }),
          tr('p.delDo'),
          function () {
            dropChat(c);
            if (state.cur === c) { state.cur = state.chats[0] || newChat(); if (state.chats.indexOf(state.cur) < 0) state.chats.unshift(state.cur); }
            persist(); renderAll(); renderHistory();
          });
      });
      it.appendChild(t);
      it.appendChild(d);
      it.appendChild(x);
      it.addEventListener('click', function () {
        state.cur = c;
        state.atts = [];
        state.histIdx = -1;        // 换对话了，↑ 翻历史的状态跟着归零
        // 选完就把搜索词清掉：不清的话下次打开抽屉还是那个过滤结果，
        // 看上去就像"我的对话全没了"。
        if (el.dq) { el.dq.value = ''; }
        persist(); renderChips(); renderAll(); renderHistory();
        el.drawer.classList.remove('open');
      });
      el.dlist.appendChild(it);
    });
  }

  // ---------------- 应用网页 ----------------
  // 把当前页面的正文抓成纯文本：先克隆一份，剔掉导航/脚本/表单这些噪声，
  // 再压掉多余空白。article / main 优先，没有就退到 body。
  function grabPage() {
    var title = '', url = '', text = '';
    try { title = document.title || ''; } catch (e) {}
    try { url = location.href || ''; } catch (e) {}
    try {
      // 优先 <main>；没有就把所有 <article> 合起来（列表页、带"相关阅读"的页面
      // 会有多个 article，只取第一个会漏内容）；再退到 body。
      var roots = [];
      var main = document.querySelector('main');
      if (main) {
        roots = [main];
      } else {
        var arts = document.querySelectorAll('article');
        if (arts.length) { roots = Array.prototype.slice.call(arts); }
        else if (document.body) { roots = [document.body]; }
      }
      if (roots.length) {
        var holder = document.createElement('div');
        roots.forEach(function (r) { holder.appendChild(r.cloneNode(true)); });
        var junk = holder.querySelectorAll(
          'script,style,noscript,svg,canvas,iframe,template,nav,footer,header,aside,form,button,select,input,textarea,' +
          '[role=navigation],[role=banner],[role=search],[aria-hidden=true]'
        );
        for (var i = 0; i < junk.length; i++) {
          if (junk[i].parentNode) { junk[i].parentNode.removeChild(junk[i]); }
        }
        text = holder.innerText || holder.textContent || '';
      }
    } catch (e) {
      try { text = document.body ? document.body.innerText : ''; } catch (e2) { text = ''; }
    }
    text = String(text).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    var cut = text.length > MAX_PAGE;
    if (cut) { text = text.slice(0, MAX_PAGE); }
    return { title: title, url: url, text: text, cut: cut, images: grabImages() };
  }

  // 收集页面里的图片。官方接口图片可以是公开 http(s) 链接（模型自己去下载）
  // 或 base64 data URL，所以这里只挑这两种，blob:/file: 之类的交给接口也拿不到。
  function grabImages() {
    var out = [];
    var imgs;
    try { imgs = document.querySelectorAll('img'); } catch (e) { return out; }
    for (var i = 0; i < imgs.length && out.length < MAX_PAGE_IMAGES; i++) {
      var im = imgs[i];
      var src = '';
      try { src = im.currentSrc || im.src || ''; } catch (e) { src = ''; }
      if (!src) { continue; }
      // 只收"真正解码出来、而且够大"的图：
      // naturalWidth 为 0 说明还没加载/加载失败（懒加载占位图就是这种），收进去没意义；
      // 小于 120px 的是图标和 1x1 埋点。
      var w = im.naturalWidth || 0;
      var h = im.naturalHeight || 0;
      if (w < 120 || h < 120) { continue; }
      if (/^data:image\//i.test(src)) {
        if (src.length > MAX_DATA_URL) { continue; }
      } else if (/^https?:/i.test(src)) {
        if (src.length > 8000) { continue; }   // 官方限制：URL ≤ 8192 字符
      } else {
        continue;
      }
      out.push({ url: src, alt: String(im.alt || '').slice(0, 120) });
    }
    return out;
  }

  function togglePageCtx() {
    // 三种状态循环：关 → 读整页 → 只读可见区 → 关
    if (!state.pageMode) {
      state.pageMode = 'full';
    } else if (state.pageMode === 'full') {
      state.pageMode = 'view';
    } else {
      state.pageMode = null;
    }

    if (!state.pageMode) {
      state.pageCtx = null;
      renderChips();
      toast(tr('p.pageClosed'));
      return Promise.resolve();
    }

    // 取内容**一律走 grabContext()**：网页上它读自己这一页，侧边栏里它去读当前标签页。
    // 这里以前图省事直接调 grabPage() —— 在侧栏里那读的是侧栏自己的 document，
    // 于是 chip 上挂着"侧边栏"这三个字、提示里写"0 字"（或侧栏自己那份文字的字数）。
    // 真正发出去的内容倒是对的（发送时走的是 grabContext），但点下去那一下的反馈是假的，
    // 一次两次之后就没人信这个按钮了。所以这一处必须和发送时用同一条路。
    return grabContext().then(function (g) {
      if (!g || !g.ok) {
        state.pageMode = null;
        state.pageCtx = null;
        renderChips();
        toast(tr('p.pageCant', { why: (g && g.error) || '' }));
        return;
      }

      if (state.pageMode === 'full') {
        var text = g.text || '';
        state.pageCtx = {
          title: g.title || tr('p.untitled'), chars: text.length,
          images: (g.images || []).length, mode: 'full'
        };
        renderChips();
        var msg = tr('p.pageFullToast', { n: text.length });
        if (state.pageCtx.images) { msg += tr('p.pageImgPart', { n: state.pageCtx.images }); }
        if (g.cut) { msg += tr('p.pageCut'); }
        if (state.pageCtx.images && !canSeeImages()) { msg += tr('p.pageNoVisionSuffix'); }
        toast(msg + tr('p.pageWillSend'));
        return;
      }

      var vt = g.visible || '';
      state.pageCtx = {
        title: g.title || tr('p.untitled'), chars: vt.length,
        images: 1, mode: 'view'    // 截图是发送那一刻才拍的，这里先按"有一张"计数
      };
      renderChips();
      toast(tr('p.pageViewToast', { n: vt.length }));
    });
  }

  // 只取当前视口内真正渲染出来的文字。
  //
  // 写法是**元素剪枝**：从 body 起做先序遍历，但把"元素"当作剪枝单位 —— 元素的
  // 位置框和视口不相交，整棵子树都不往里翻。老写法是按文本节点走、每个文本都拿
  // 父元素去量一次位置框，一个 3 万节点的页面要调 2.6 万次 getBoundingClientRect，
  // 实测约 44ms（点「引用当前网页」会顿一下）；换成剪枝后约 2000 次 / 3ms。
  //
  // 顺序仍是文档顺序：压栈时逆序压，弹出即先序 —— 同一个 <p> 里 "甲<b>乙</b>丙"
  // 收出来还是 甲/乙/丙，不会变成 甲/丙/乙。
  //
  // 一处**有意的取舍**：position:fixed 的元素（吸顶导航、浮动客服、回到顶部）的
  // 可见性不取决于祖先，所以祖先容器滚出视口时它会跟着被剪掉。这类元件上就几个字
  // （"在线客服"这种），对"引用正文"没有价值 —— 要救它只能少剪枝，成本立刻吃回去
  // （实测放行 body 的直接子元素只盖得住浅层的，真实的浮动元件往往嵌得很深）。
  function grabVisibleText() {
    var out = [], seen = {};
    var vw = window.innerWidth, vh = window.innerHeight;
    var root = document.body || document.documentElement;
    if (!root) { return ''; }
    var LIMIT = 600;
    var stack = [], c;
    // 从 root 的直接子节点起步（root 自己不判可见性，跟老写法一致）
    for (c = root.lastChild; c; c = c.previousSibling) { stack.push(c); }
    while (stack.length) {
      var n = stack.pop();
      if (n.nodeType === 3) {
        // 能走到这个文本，说明它祖先链上每个元素都被判定可见了 —— 不用再量一次
        var t = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (t.length < 2 || seen[t]) { continue; }
        seen[t] = 1;
        out.push(t);
        if (out.length >= LIMIT) { break; }
        continue;
      }
      if (n.nodeType !== 1) { continue; }
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') { continue; }
      var r;
      try { r = n.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || (!r.width && !r.height)) { continue; }   // display:none 这类：位置框是 0
      // 视口外 → 整块不翻（这就是快的地方）
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { continue; }
      for (c = n.lastChild; c; c = c.previousSibling) { stack.push(c); }
    }
    return out.join('\n');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 让后台脚本截当前可见的一屏。chrome.tabs.captureVisibleTab 只有扩展自己的
  // 上下文能调，content script 调不了，所以走 runtime.sendMessage 绕一道。
  // winId：侧边栏里要显式带上"哪个窗口"，否则后台只能猜"当前窗口"。
  function captureVisible(winId) {
    return new Promise(function (res) {
      var done = false;
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        res(null);
        return;
      }
      var msg = { type: 'ds-capture' };
      if (typeof winId === 'number') { msg.windowId = winId; }
      var timer = setTimeout(function () { if (!done) { done = true; res(null); } }, 5000);
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          if (done) { return; }
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError || !r || !r.ok) { res(null); return; }
          res(r.dataUrl);
        });
      } catch (e) {
        done = true;
        clearTimeout(timer);
        res(null);
      }
    });
  }

  // 取"当前网页"的内容 —— 网页上跑就读自己这一页，侧边栏里跑就回去问当前标签页。
  // 两边返回**同一个形状**，所以发送流程不用关心自己在哪儿：
  //   { ok, title, url, text, images:[url...], visible, cut, windowId, error }
  // 侧边栏里不能再读自己那个 document —— 那是侧边栏本身，不是用户在看的那篇文章。
  function grabContext() {
    if (!isHost()) {
      var p = grabPage();
      return Promise.resolve({
        ok: true,
        title: p.title || '',
        url: p.url || '',
        text: p.text || '',
        images: (p.images || []).map(function (x) { return x.url; }),
        visible: grabVisibleText(),
        cut: !!p.cut
      });
    }
    return new Promise(function (res) {
      function fail(msg) { res({ ok: false, error: msg || tr('p.pageCantShort') }); }
      try {
        if (!chrome.tabs || !chrome.tabs.query) { fail(tr('p.noTabs')); return; }
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          var tab = tabs && tabs[0];
          if (chrome.runtime.lastError || !tab || typeof tab.id !== 'number') { fail(tr('p.noActiveTab')); return; }
          chrome.tabs.sendMessage(tab.id, { type: 'ds-grab-page' }, function (r) {
            var err = chrome.runtime.lastError;
            if (err || !r || !r.ok) { fail((err && err.message) || (r && r.error)); return; }
            r.windowId = tab.windowId;
            res(r);
          });
        });
      } catch (e) {
        fail(String((e && e.message) || e));
      }
    });
  }

  // 把图片压到 IMG_MAX_SIDE 以内再发：官方本来就会把图缩到约 1300×1300，
  // 本地先压等于省带宽、省请求体，模型看到的内容不变。
  function shrinkImage(dataUrl, cb) {
    try {
      var isPng = /^data:image\/png/i.test(dataUrl);
      if (isPng && dataUrl.length < KEEP_PNG_BELOW) { cb(dataUrl); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) { cb(dataUrl); return; }
          var scale = Math.min(1, IMG_MAX_SIDE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = cw;
          cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';   // 透明通道转 JPEG 会变黑，先铺白底
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          var out = cv.toDataURL('image/jpeg', IMG_QUALITY);
          cb(out && out.length < dataUrl.length ? out : dataUrl);
        } catch (e) { cb(dataUrl); }
      };
      img.onerror = function () { cb(dataUrl); };
      img.src = dataUrl;
    } catch (e) { cb(dataUrl); }
  }

  // ---------------- 附件 ----------------
  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    var left = list.length;
    if (!left) { return; }
    list.forEach(function (f) {
      var isImg = (f.type && f.type.indexOf('image/') === 0) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name || '');
      if (isImg) {
        // 图片：选进来先压到 1536 长边以内，再交给能看图的模型
        if (f.size > MAX_IMG_FILE) {
          toast(tr('p.attTooBig', { name: f.name }));
          if (--left === 0) { renderChips(); }
          return;
        }
        if (!canSeeImages()) {
          toast(tr('p.attNoVision', { m: state.model }));
        }
        var fr = new FileReader();
        state.reading++;
        fr.onload = function () {
          shrinkImage(String(fr.result), function (dataUrl) {
            state.reading--;
            state.atts.push({ name: f.name, size: f.size, image: true, dataUrl: dataUrl });
            if (--left === 0) { renderChips(); }
            suggestImagePrompt();
          });
        };
        fr.onerror = function () {
          state.reading--;
          toast(tr('p.attReadFail', { name: f.name }));
          if (--left === 0) { renderChips(); }
        };
        fr.readAsDataURL(f);
        return;
      }
      if (f.size > MAX_FILE) {
        toast(tr('p.attTextTooBig', { name: f.name }));
        if (--left === 0) { renderChips(); }
        return;
      }
      if (f.type && f.type.indexOf('text/') !== 0 && !TEXT_EXT.test(f.name)) {
        toast(tr('p.attSkip', { name: f.name }));
        if (--left === 0) { renderChips(); }
        return;
      }
      var r = new FileReader();
      r.onload = function () {
        var txt = String(r.result);
        var cut = txt.length > MAX_TEXT_SENT;
        state.atts.push({ name: f.name, size: f.size, text: cut ? txt.slice(0, MAX_TEXT_SENT) : txt });
        if (cut) { toast(tr('p.attCut', { name: f.name, n: MAX_TEXT_SENT })); }
        if (--left === 0) { renderChips(); }
      };
      r.onerror = function () {
        toast(tr('p.attReadFail', { name: f.name }));
        if (--left === 0) { renderChips(); }
      };
      r.readAsText(f);
    });
  }

  // ---------------- 粘贴：截图直接进附件 ----------------
  // Win+Shift+S / Snipaste / 微信截图 都是把位图塞进剪贴板，以前得"另存为文件 → 再从 📎 里挑"。
  // 现在在面板里直接 Ctrl+V 就行。规矩：
  //   · 剪贴板里**有图** → 接管（preventDefault），别让浏览器再往输入框里塞一串文件名/HTML；
  //   · 只有文字 → 一个字都不碰，走浏览器默认粘贴（光标位置、换行都是原生行为，别自己实现）。
  // 监听挂在 root 上而不是 textarea 上：在面板任何地方按 Ctrl+V 都能生效（焦点通常就在输入框，
  // 但点过回答、点过 chip 之后焦点会跑掉，那种时候也别让它失灵）。
  function pasteFiles(dt) {
    var out = [];
    try {
      if (dt.files && dt.files.length) { out = Array.prototype.slice.call(dt.files); }
    } catch (e) { out = []; }
    if (!out.length && dt.items) {
      // 有些来源只把图片放在 items 里（kind='file'），files 是空的
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (!it || it.kind !== 'file' || String(it.type || '').indexOf('image/') !== 0) { continue; }
        var blob = null;
        try { blob = it.getAsFile(); } catch (e) { blob = null; }
        if (!blob) { continue; }
        // 剪贴板里的位图没有文件名，得给一个 —— 附件名就是拿它显示的
        var ext = String(blob.type || '').split('/')[1] || 'png';
        ext = ext.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
        try {
          out.push(new File([blob], tr('p.pastedImg') + '.' + ext, { type: blob.type }));
        } catch (e) {
          out.push(blob);   // 没有 File 构造器就直接用 Blob（名字会显示成"未命名"）
        }
      }
    }
    return out;
  }

  function onPaste(e) {
    var dt = e.clipboardData;
    if (!dt) { return; }
    var files = [];
    try { files = pasteFiles(dt); } catch (err) { files = []; }
    if (!files.length) { return; }        // 纯文字：不插手
    e.preventDefault();
    e.stopPropagation();
    addFiles(files);
    toast(files.length > 1 ? tr('p.pastedMany', { n: files.length }) : tr('p.pastedOne'));
  }

  // ---------------- 拖到球上 ----------------
  function nameFromUrl(abs) {
    try {
      var p = String(abs).split('?')[0].split('#')[0].split('/').pop();
      if (p && p.length < 40 && /\.(png|jpe?g|gif|webp|avif)$/i.test(p)) { return p; }
    } catch (e) {}
    return tr('p.dropImg');
  }

  function pushImage(name, dataUrl) {
    state.atts.push({ name: name, size: 0, image: true, dataUrl: dataUrl });
    renderChips();
    suggestImagePrompt();
  }

  // 拖进来的图片地址：data: 直接用；http(s) 先自己抓一份（有 <all_urls> 权限，
  // 不受 CORS 限制，也能带上页面的 cookie），抓不到就退回原始链接交给接口下载。
  function addImageUrl(url) {
    var abs;
    try { abs = new URL(url, location.href).href; } catch (e) { return false; }
    if (/^data:image\//i.test(abs)) { pushImage(tr('p.dropImg'), abs); return true; }
    if (!/^https?:/i.test(abs)) { return false; }

    var name = nameFromUrl(abs);
    state.reading++;
    fetch(abs).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.blob();
    }).then(function (blob) {
      if (blob.size > MAX_IMG_FILE) { throw new Error(tr('p.imgTooBig')); }
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result)); };
        fr.onerror = function () { rej(new Error(tr('p.readFail'))); };
        fr.readAsDataURL(blob);
      });
    }).then(function (dataUrl) {
      shrinkImage(dataUrl, function (out) {
        state.reading--;
        pushImage(name, out);
      });
    }).catch(function () {
      state.reading--;
      pushImage(name + tr('p.asLink'), abs);
    });
    return true;
  }

  // 开一条全新对话（拖拽进来时用：不接着前面的聊）
  function startNewChat() {
    resetTurnState();
    // 当前这条本来就是空的话就直接用它，免得堆出一串空对话
    if (state.cur && state.cur.messages && state.cur.messages.length) {
      state.cur = newChat();
      state.chats.unshift(state.cur);
      persist();
    }
    renderAll();
    renderHistory();
  }

  // 附件、应用网页状态清空（换对话/换场景时用）
  function resetTurnState() {
    state.atts = [];
    state.pageCtx = null;
    state.pageMode = null;
    if (el.chips) { renderChips(); }
    // 顺带把上一次自动填进去的快捷提示词清掉（你自己打的字不动）
    if (el.input && IMG_PROMPT && el.input.value.trim() === IMG_PROMPT) {
      el.input.value = '';
      autoGrow();
    }
  }

  // 拖进来的东西：文件→附件；图片→附件；文字→输入框
  // 注意：dataTransfer 只在 drop 事件的同步阶段可读，所以这里必须先取值再 await。
  function openWithDrop(dt) {
    var plain = '', html = '', uri = '', files = [];
    if (dt) {
      try { plain = dt.getData('text/plain') || ''; } catch (e) {}
      try { html = dt.getData('text/html') || ''; } catch (e) {}
      try { uri = dt.getData('text/uri-list') || ''; } catch (e) {}
      try { files = Array.prototype.slice.call(dt.files || []); } catch (e) {}
    }

    open(true);
    startNewChat();   // 小窗一律开新对话，不显示前面的内容

    if (files.length) {
      addFiles(files);
      toast(tr('p.droppedMany', { n: files.length }));
      return;
    }

    var img = '';
    if (html) {
      var m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
      if (m) { img = m[1]; }
    }
    if (!img && uri) {
      var first = uri.split(/[\r\n]+/)[0];
      if (/\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(first)) { img = first; }
    }
    if (img && addImageUrl(img)) {
      toast(tr('p.droppedImg'));
      return;
    }

    var t = String(plain || '').replace(/\s+$/, '');
    if (t.trim()) {
      var cur = el.input.value.replace(/\s+$/, '');
      el.input.value = cur ? (cur + '\n' + t) : t;
      autoGrow();
      try { el.input.focus(); } catch (e) {}
      toast(tr('p.droppedText'));
      return;
    }
    toast(tr('p.dropNone'));
  }

  // ---------------- 请求 ----------------
  function abort() {
    state.sending = false;
    if (state.ac) { try { state.ac.abort(); } catch (e) {} }
    setSend(false);
  }

  function setSend(sending) {
    state.sending = sending;
    el.send.innerHTML = sending ? ICONS.stop : ICONS.send;
    el.send.title = sending ? tr('p.stop') : tr('p.send');
  }

  // ---------------- 网页正文的增量缓存 ----------------
  // 「应用网页」原来每问一句就把整页正文重发一遍：同一篇文章问 5 句 = 5 倍 token、请求也更大更慢。
  // 做法：给正文算一个短指纹，随消息记下来（`msg.pageKey`）；下次发送前看**这次要发出去的窗口**里
  // 是不是已经有同一页、同一份正文 —— 有就只发一行"没变"的提示，正文本就在请求里，不用再来一遍。
  //
  // 为什么只看最近 KEEP_RECENT 条：这几十条是**无条件保留**的（见 buildMessages），
  // 必然出现在这一次的请求里，所以命中就一定安全。更早的即使有，也可能被预算挤掉 ——
  // 那时候必须重发全文，否则模型手里就没有正文了（宁可多花 token，也不要静静地丢上下文）。
  function hashText(s) {
    var str = String(s || '');
    var h = 5381, i = str.length;
    while (i) { h = ((h * 33) ^ str.charCodeAt(--i)) >>> 0; }
    return h.toString(16) + ':' + str.length;
  }
  // 附件正文的指纹：名字 + 长度 + 内容哈希。
  // 名字和长度挡掉"同名但不是同一个文件"，哈希挡掉"改了内容却长度一样"。
  function attSig(atts) {
    return atts.map(function (a) {
      var t = String(a.text || '');
      return (a.name || '') + ':' + t.length + ':' + hashText(t);
    }).join('\u0000');
  }
  // 窗口里已经出现过同一份附件正文吗？和 pageBlockInWindow 一个道理：
  // 只有那条消息落在最近 KEEP_RECENT 条之内，才能**证明**"这次请求里确实带着那份正文"
  // （那几条是无条件保留的）。证明不了就老实重发 —— 宁可多花 token，也不能让模型手里没有正文。
  function attInWindow(sig) {
    var msgs = (state.cur && state.cur.messages) || [];
    for (var n = 0, i = msgs.length - 1; i >= 0 && n < KEEP_RECENT; i--, n++) {
      var ak = msgs[i].attKey;
      if (ak && ak.sig === sig) { return true; }
    }
    return false;
  }

  function pageBlockInWindow(url, hash) {
    var msgs = (state.cur && state.cur.messages) || [];
    for (var n = 0, i = msgs.length - 1; i >= 0 && n < KEEP_RECENT; i--, n++) {
      var pk = msgs[i].pageKey;
      if (pk && pk.url === url && pk.hash === hash) { return true; }
    }
    return false;
  }

  // >>> ctxWindow —— 离线单测（docs/test-render.js）从这两行标记之间把这段抠出去跑，别动标记
  // 决定这次请求**实际带哪几条**历史。纯函数：没有外部依赖，全走参数，所以能离线测。
  //
  // 唯一要保证的事：**前缀要稳**（道理见 CTX_CHUNK）。
  //   · 没超预算 → 一条都不动，前缀和上一轮完全一致；
  //   · 超了 → 从后往前塞到预算用完，得到起始下标 k，再把 k **往上**取到 chunk 的整数倍。
  //     取整朝"多丢"那一侧，所以留下来的必然还在预算之内。
  // keepRecent 是硬下限：最近这几条无条件保留，哪怕预算已经负数 ——
  // 否则连"你刚才说的那个"都答不了。取整也不许吃掉这个下限（cap）。
  function ctxWindow(msgs, budget, keepRecent, chunk) {
    var total = 0, i, len;
    for (i = 0; i < msgs.length; i++) {
      total += (msgs[i] && typeof msgs[i].content === 'string') ? msgs[i].content.length : 0;
    }
    if (total <= budget) { return { kept: msgs.slice(), total: total, from: 0 }; }
    var acc = 0, k = msgs.length, must;
    for (i = msgs.length - 1; i >= 0; i--) {
      len = (msgs[i] && typeof msgs[i].content === 'string') ? msgs[i].content.length : 0;
      must = (msgs.length - i) <= keepRecent;
      if (!must && acc + len > budget) { break; }
      acc += len;
      k = i;
    }
    // 档位量化 + 不许越过"最近 keepRecent 条"这条线
    var cap = Math.max(0, msgs.length - keepRecent);
    if (chunk > 1) { k = Math.ceil(k / chunk) * chunk; }
    k = Math.min(k, cap);
    return { kept: msgs.slice(k), total: total, from: k };
  }
  // <<< ctxWindow

  function buildMessages() {
    var out = [];
    var sys = (A.prompt || '').trim();
    if (sys) { out.push({ role: 'system', content: sys }); }
    // 开着「推荐图片」时多追一条要求：让模型在回答末尾附几个配图搜索词（见 RECO_SYS）。
    // 单独一条 system 而不是塞进人设里 —— 人设是用户的，开关是界面上的，混在一起以后都不好改。
    // 每次请求都重新拼，所以点一下立刻生效，关了这一轮就不带。
    if (state.recoImg) { out.push({ role: 'system', content: RECO_SYS }); }
    // 先滤掉「还没生成出内容就中断」的空回答 —— 有些接口会因为空的 assistant 消息报错
    var msgs = state.cur.messages.filter(function (m) {
      return !(m.role === 'assistant' && !m.content);
    });
    // 该带哪几条交给 ctxWindow（纯函数，含档位量化；单测见 docs/test-render.js）
    var kept = ctxWindow(msgs, MAX_CTX_CHARS, KEEP_RECENT, CTX_CHUNK).kept;
    state.ctxOmitted = msgs.length - kept.length;    // 面板上要用它提示用户
    state.ctxKept = kept.length;
    // 带图的那几条（apiContent 是多模态数组，只在内存里活着）只保留**最近 MAX_CTX_IMAGES 条**，
    // 再往前的只发文字 content。官方一张图最多算 1024 token，钱其实不多，但一张图压完也是
    // 几万字符的 data URL —— 每轮把老图重发一遍，纯粹是在撑大请求体、拖慢上传。
    var imgIdx = [];
    for (var j = kept.length - 1; j >= 0 && imgIdx.length < MAX_CTX_IMAGES; j--) {
      if (kept[j] && kept[j].apiContent) { imgIdx.push(j); }
    }
    kept.forEach(function (k, idx) {
      var c = imgIdx.indexOf(idx) >= 0 ? k.apiContent : k.content;
      // 发给模型的回答里不带「推荐图片」那段标记。它是**给界面用的元信息**，
      // 留在历史里会变成"示范"：模型看到自己上两轮都写了 <img-reco>，即使这一轮
      // 没要求也照样写（关了开关还在写）。正文本来就完整，剥掉不影响理解。
      if (k.role === 'assistant' && typeof c === 'string' && c.indexOf(RECO_OPEN) >= 0) {
        c = splitReco(c).body;
      }
      out.push({ role: k.role, content: c });
    });
    return out;
  }

  async function callAPI(messages, onDelta) {
    var base = String(cfg.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    var path = cfg.apiPath || '/chat/completions';
    var headers = { 'Content-Type': 'application/json' };
    // 用 send() 里刚读出来的那份（见 loadKey）。这里不再读 cfg.apiKey —— 那份是旧写法。
    var key = apiKey();
    if (key) { headers['Authorization'] = 'Bearer ' + key; }
    if (cfg.headers && typeof cfg.headers === 'object') {
      Object.keys(cfg.headers).forEach(function (k) { headers[k] = cfg.headers[k]; });
    }
    state.ac = new AbortController();
    // stream_options.include_usage：流式下 usage 只在**最后一块**里给，而且要显式要。
    // 拿到它才知道这一轮花了多少 token、缓存命中多少 —— 不知道花了多少就谈不上省。
    var payload = withEffort({
      model: state.model,
      messages: messages,
      stream: true,
      stream_options: { include_usage: true }
    });
    var res = await fetch(base + path, {
      method: 'POST',
      signal: state.ac.signal,
      headers: headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      var t = '';
      try { t = await res.text(); } catch (e) {}
      // 这里**不再拼提示文案**了 —— 文案统一归 friendlyErr 管：它还得处理网络层错误、
      // AbortError、5xx 这些在 fetch 之后才看得见的情况，散在两处会互相打架。
      // 这一步只负责把状态码原样带出去。
      var err = new Error('HTTP ' + res.status + ' ' + t.slice(0, 300));
      err.status = res.status;
      err.body = t.slice(0, 300);
      throw err;
    }
    if (!res.body || !res.body.getReader) {
      var j = await res.json();
      if (j.usage) { onDelta({ usage: j.usage }); }
      onDelta({ content: j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '' });
      return;
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    while (true) {
      var r = await reader.read();
      if (r.done) { break; }
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('data:') !== 0) { continue; }
        var data = line.slice(5).trim();
        if (!data || data === '[DONE]') { continue; }
        try {
          var jj = JSON.parse(data);
          // 开了 include_usage 之后，最后一包**只带 usage、choices 是空数组** —— 先收 usage
          if (jj.usage) { onDelta({ usage: jj.usage }); }
          var d = jj.choices && jj.choices[0] && jj.choices[0].delta;
          if (d) { onDelta(d); }
        } catch (e) { /* 半包，等下一块 */ }
      }
    }
  }

  async function send() {
    if (state.sending) { return; }
    if (!ctxAlive()) {
      toast(tr('p.reloaded'));
      return;
    }
    var text = el.input.value.trim();
    if (!text && !state.atts.length && !state.sel.length && !state.pageMode) { return; }
    if (state.reading > 0) {
      toast(tr('p.imgReading'));
      return;
    }
    // Key 从浏览器里（设置页）读，不写在代码里。每次发送前重读一遍很小，但换来的是：
    // 你在另一个标签页里改完设置，这边**立刻**就用上了，不用刷新页面。
    var kc = await loadKey();
    syncKeyHint();
    if (cfg.requireKey !== false && !kc.key) {
      toast(tr('p.needKeyLong'));
      return;
    }
    if (!state.cur) {
      state.cur = state.chats[0] || newChat();
      if (state.chats.indexOf(state.cur) < 0) { state.chats.unshift(state.cur); }
    }

    var atts = state.atts.slice();
    var full = text;
    // 划词带进来的选段：提示词在上、正文用围栏包起来（让模型分得清"哪句是要求、哪段是材料"）。
    // 接在你打的字**后面** —— 你自己写的那句才是最新指令，放前面读着更顺。
    state.sel.forEach(function (s) {
      var blk = (s.prompt ? s.prompt + '\n\n' : '') + '```\n' + (s.text || '') + '\n```';
      full += (full ? '\n\n' : '') + blk;
    });
    // 文本附件。**做增量去重**（2026-10-13 补）—— 原来这里没有，是白花钱的大头：
    // 一个附件最多能带 20 万字符（MAX_TEXT_SENT），拖一份长文档追问 5 轮，
    // 那 20 万字就原样发 5 遍。网页正文早就有这套去重了，附件比它还贵，反而没有。
    // 命中条件跟 pageBlockInWindow 完全一致：同一份内容在最近 KEEP_RECENT 条里出现过。
    var attTexts = atts.filter(function (a) { return !a.image && a.text; });
    var attKey = null, attReused = 0;
    if (attTexts.length) {
      var aSig = attSig(attTexts);
      if (attInWindow(aSig)) {
        attReused = attTexts.reduce(function (n, a) { return n + a.text.length; }, 0);
        full += (full ? '\n\n' : '') + '【附件】' +
          attTexts.map(function (a) { return a.name; }).join('、') +
          '\n（内容和上面那条**完全相同**，不再重复发一遍 —— 接着看那份就行。）';
      } else {
        attTexts.forEach(function (a) {
          full += (full ? '\n\n' : '') + '【附件 ' + a.name + '】\n```\n' + a.text + '\n```';
        });
      }
      attKey = { sig: aSig };
    }

    // 图片：本地图片附件 + 页面上的图
    var images = atts.filter(function (a) { return a.image && a.dataUrl; })
      .map(function (a) { return a.dataUrl; });

    // 应用网页：'full' 读整页 DOM，'view' 只读屏幕可见区（文字 + 截图）
    // 两个分支都走 grabContext()：在网页上它读这一页，在侧边栏里它去读当前标签页，
    // 返回的形状一样，所以下面这段逻辑不用分情况写。
    var pageSnap = null;
    var g = null;
    var pageKey = null;          // 这轮给正文算的指纹，记到消息上，下一轮就不用重发
    var pageReused = 0;          // 被复用（没重发）的正文字数，用来提示"省了多少"
    if (state.pageMode) {
      g = await grabContext();
      if (!g.ok) {
        toast(tr('p.pageCant', { why: g.error || '' }));
        state.pageMode = null;
        renderChips();
      }
    }
    if (state.pageMode === 'full') {
      pageSnap = g;
      var fTitle = pageSnap.title || '', fUrl = pageSnap.url || '';
      var fText = pageSnap.text || '';
      var fImgs = pageSnap.images || [];
      // 指纹把图片列表也算进去：这样"命中缓存"就意味着正文和图**都**和上一条一样，跳过才严谨
      var fHash = hashText(fText + '\u0000' + fImgs.join('\n'));
      var fReuse = !!fText && pageBlockInWindow(fUrl, fHash);
      if (fText && !fReuse) {
        full += (full ? '\n\n' : '') + '【当前网页：' + fTitle + '】\n' + fUrl +
          '\n```\n' + fText + '\n```';
      } else if (fReuse) {
        full += (full ? '\n\n' : '') + '【当前网页：' + fTitle + '】' + fUrl +
          '\n（这一页的正文和上面那条**完全相同**，不再重复发一遍 —— 接着看那份就行。）';
        pageReused = fText.length;
      }
      if (!fReuse) { fImgs.forEach(function (u) { images.push(u); }); }
      pageKey = { url: fUrl, hash: fHash };
      state.pageCtx = {
        title: fTitle || tr('p.untitled'),
        chars: fText.length,
        images: fReuse ? 0 : fImgs.length,
        mode: 'full',
        reused: fReuse
      };
    } else if (state.pageMode === 'view') {
      var vTitle = g.title || '', vUrl = g.url || '';
      var vText = g.visible || '';
      var vHash = hashText(vText);
      var vReuse = !!vText && pageBlockInWindow(vUrl, vHash);
      var shot = null;
      // 网页上要把面板收起来，不然会拍进面板自己；侧边栏不用（截图只截标签页，截不到侧栏）
      var needHide = !isHost();
      if (needHide && host) { host.style.setProperty('display', 'none', 'important'); }
      if (needHide) { await sleep(180); }
      shot = await captureVisible(g.windowId);
      if (needHide && host) { host.style.setProperty('display', 'block', 'important'); }
      if (!shot) { toast(tr('p.shotFail')); }
      if (vReuse) {
        // 屏幕上那点文字和上一条一样 → 只发一行提示；**但截图照拍照发**（截图每轮都是新的，
        // 正是"可见区"模式的意义所在，省不得）。
        full += (full ? '\n\n' : '') + '【当前屏幕可见内容：' + vTitle + '】' + vUrl +
          '\n（屏幕里的文字和上面那条相同，不再重复；另附一张**新的**截图。）';
        pageReused = vText.length;
      } else {
        full += (full ? '\n\n' : '') + '【当前屏幕可见内容：' + vTitle + '】\n' + vUrl +
          '\n（屏幕里实际显示的文字）\n```\n' + vText + '\n```' +
          (shot ? '\n另附一张当前屏幕的截图。' : '');
      }
      pageKey = { url: vUrl, hash: vHash };
      if (shot) { images.push(shot); }
      state.pageCtx = {
        title: vTitle || tr('p.untitled'),
        chars: vText.length,
        images: shot ? 1 : 0,
        mode: 'view',
        reused: vReuse
      };
      renderChips();
    }
    // 正文被复用（没重发）时给一句反馈：不然用户不知道"省了多少"，会以为没生效。
    // 附件和网页可能同时命中，合成一句说，别连着弹两条。
    if (pageReused || attReused) {
      var reusedWho = [];
      if (attReused) { reusedWho.push(tr('p.reuseAtt')); }
      if (pageReused) { reusedWho.push(tr('p.reusePage')); }
      toast(tr('p.reuseToast', { who: reusedWho.join(tr('p.mdSep')), n: pageReused + attReused }));
    }

    // 去重 + 限总量
    var seen = {};
    images = images.filter(function (u) {
      if (!u || seen[u]) { return false; }
      seen[u] = 1;
      return true;
    }).slice(0, MAX_IMAGES_TOTAL);

    // 当前模型不支持视觉：图片丢掉，但把地址留在文本里，至少让模型知道有这些图
    if (images.length && !canSeeImages()) {
      full += (full ? '\n\n' : '') + '【图片清单】当前模型无法查看图片内容，这里只有地址：\n' +
        images.map(function (u, i) {
          var show = u.length > 200 ? u.slice(0, 120) + '…（' + u.length + ' 字符的数据，略）' : u;
          return (i + 1) + '. ' + show;
        }).join('\n');
      images = [];
      toast(tr('p.noVisionToast'));
    }

    // 有图就按官方的多模态格式发：content 用数组
    var apiContent = full;
    if (images.length) {
      apiContent = [{ type: 'text', text: full }];
      images.forEach(function (u) {
        apiContent.push({ type: 'image_url', image_url: { url: u } });
      });
    }

    var um = {
      mid: uid(),                 // 消息身份：两个窗口合并时靠它认"是不是同一条"
      role: 'user',
      ts: Date.now(),             // 这条是什么时候说的（气泡底部那行时间）
      // 这轮正文的指纹：下一轮如果还是同一页同一份内容，就不必重发（见 pageBlockInWindow）。
      // 不落库（plainChats 只挑固定字段），所以重开浏览器后一定会重发一次全文 —— 宁可多发，别丢上下文。
      pageKey: pageKey,
      // 附件的指纹，同理（见 attInWindow）。同样**不落库**：附件里的图只活在内存里
      // （apiContent），重开浏览器后老图回不来，那时候必须老老实实重发。
      attKey: attKey,
      show: text || (state.sel.length ? state.sel[0].text.slice(0, 200)
        : (pageSnap && pageSnap.text ? tr('p.seePage') : tr('p.seeAtt'))),
      content: full || tr('p.emptyMsg'),
      apiContent: apiContent,   // 只存在内存里，不落库（图片 base64 存进 storage 会撑爆配额）
      attachments: atts.map(function (a) { return { name: a.name, size: a.size }; })
        .concat(state.sel.map(function (s) {
          return { name: tr('p.selChip', { label: s.label || tr('p.selText'), n: (s.text || '').length }) };
        }))
        .concat(state.pageCtx ? [{
          name: (state.pageCtx.mode === 'view' ? tr('p.chipView') : tr('p.chipFull')) +
            (state.pageCtx.title || tr('p.untitled'))
        }] : [])
    };
    state.cur.messages.push(um);
    el.input.value = '';
    state.histIdx = -1;           // 发出去了，翻历史的状态归零（下一次 ↑ 从最新那条开始）
    state.histDraft = '';
    autoGrow();
    state.atts = [];
    state.sel = [];
    renderChips();
    if (state.cur.title === NEW_TITLE) {
      state.cur.title = (text || (atts[0] && atts[0].name) ||
        (state.pageCtx && state.pageCtx.title) || NEW_TITLE).slice(0, 24);
    }
    if (el.list.querySelector('.empty')) { el.list.textContent = ''; }
    el.list.appendChild(bubble(um, state.cur.messages.length - 1));
    scrollBottom();

    var am = { mid: uid(), role: 'assistant', ts: Date.now(), show: '', content: '' };
    state.cur.messages.push(am);
    el.list.appendChild(bubble(am));
    scrollBottom();
    await runAnswer(am);
  }

  // 空 assistant 气泡已经挂上去之后，真正发请求 + 流式写进去的那一段。
  // send()（新问一句）和 retryMsg()（换个答案）共用它 —— 两边唯一的差别是"上文是从哪来的"，
  // 所以下面这些（建请求、吐字重绘、收尾、同步）一行都不用重复写两遍。
  async function runAnswer(am) {
    setSend(true);
    persist();
    renderHistory();
    var lastSync = 0;          // 上一回把进度同步给别的窗口是什么时候（见下面 onDelta 里的节流）

    var dirty = false;
    function paint() {
      dirty = false;
      // 流式过程中也剥掉推荐词那段标记：它多半在最后一刻才出现，不剥用户就会看到标签往外长
      am.$body.innerHTML = mdToHtml(splitReco(am.show).body) + '<span class="caret"></span>';
      renderReco(am);
      syncThink(am);
      scrollBottom();
    }

    // 历史超预算时只带最近的一部分（见 buildMessages）。这种事得说出来 ——
    // 不然用户会觉得"它怎么把我刚说的话忘了"，其实是故意的。
    var sent = buildMessages();
    if (state.ctxOmitted > 0) {
      toast(tr('p.ctxTrim', { k: state.ctxKept, n: state.ctxOmitted }));
    }

    var failed = null;
    try {
      await callAPI(sent, function (d) {
        // 这一轮的实际用量（请求里开了 stream_options.include_usage 才有）：最后一包带回来。
        // 当场画出来 —— 省不省钱全看这几个数，尤其「思考」那一项（档位选"不思考"时它该是 0）。
        if (d.usage) { am.usage = d.usage; syncUsage(am); }
        if (d.reasoning_content) {
          am.reasoning = (am.reasoning || '') + d.reasoning_content;
        }
        if (d.content) {
          am.show += d.content;
          am.content += d.content;
        }
        if (!dirty) { dirty = true; requestAnimationFrame(paint); }
        // 边写边把进度同步出去：另一个窗口（或侧边栏）能看到答案在长，不用等这一轮结束。
        // 节流到 1.2 秒一次；saveChatsMerged 自己还有"上一次没写完就先不写"的闸。
        if (Date.now() - lastSync > 1200) { lastSync = Date.now(); saveChatsMerged(); }
      });
    } catch (e) {
      failed = e;
      var msg = friendlyErr(e);
      am.show += (am.show ? '\n\n' : '') + '> ' + msg;
      am.content += ' ' + msg;
    }

    if (!am.show.trim()) {
      // 流式跑完了却一个字都没有：多半是模型只吐了思考、正文被截断。
      // 标成 failed 才会在下面提示"可以重试" —— 干瞪眼是最没用的状态。
      am.show = tr('p.noContent');
      am.content = am.show;
      if (!failed) { failed = new Error('empty'); }
    }
    am.$body.innerHTML = mdToHtml(splitReco(am.show).body);
    renderReco(am);
    syncThink(am);
    scrollBottom();
    setSend(false);
    state.ac = null;
    persist();
    renderHistory();
    // 吐字期间收到过别的窗口的写入（当时不敢动正文，怕冲掉这半个气泡）→ 现在补一次对齐
    if (state.syncPending) { state.syncPending = false; syncNow(); }
    // 失败时再提一句：原因虽然写在气泡里了，但用户可能正滚在别处，看不到
    if (failed && failed.name !== 'AbortError') {
      toast(tr('p.turnFail'));
    }
  }

  // ---------------- 重试 ----------------
  // 「重试」= 把这条 assistant 回答连同它**后面**的内容一起丢掉，用同样的上文再生成一遍。
  // 和「回到这里」的分工：那个是改**问题**（文字放回输入框、消息删掉），
  // 这个是换**答案**（问题原样留着，只重生成这一条）。
  function retryMsg(m) {
    if (!ctxAlive()) {
      toast(tr('p.reloaded'));
      return;
    }
    var c = state.cur;
    var idx = c ? c.messages.indexOf(m) : -1;
    if (idx < 0 || m.role !== 'assistant') { return; }
    if (state.sending) { toast(tr('p.retryBusy')); return; }
    var extra = c.messages.length - idx - 1;      // 这条之后还有几条
    if (extra > 0) {
      // 会丢东西就得问一声 —— 和"回到这里"同一把尺子：不可逆的动作不静默执行
      askConfirm(tr('p.retryQ'),
        tr('p.retryBody', { n: extra }),
        tr('p.retryDo'), function () { doRetry(idx); });
      return;
    }
    doRetry(idx);
  }

  async function doRetry(idx) {
    var c = state.cur;
    if (!c || state.sending) { return; }
    // Key 每次重读（和 send 一样）：在另一个标签页里改完设置，这边立刻就用上
    var kc = await loadKey();
    syncKeyHint();
    if (cfg.requireKey !== false && !kc.key) {
      toast(tr('p.needKeyLong'));
      return;
    }
    c.messages.length = idx;                      // 截断 —— 和「回到这里」同一套路，append-only
    // 记一笔"后面那些是我故意删的"，不然写盘合并会把它们从另一个窗口那份里救回来
    c.cutAt = c.messages.length ? msgKey(c.messages[c.messages.length - 1]) : '';
    c.cutTs = Date.now();
    // DOM 也跟着截：把第 idx 行起的所有气泡删掉。比整个 renderAll() 便宜得多
    // （renderAll 会把前面每一条都重跑一遍 markdown，长对话里那是几十毫秒的顿挫）。
    while (el.list.children.length > idx) { el.list.removeChild(el.list.lastChild); }
    if (!el.list.children.length) { renderEmpty(); }
    var am = { mid: uid(), role: 'assistant', ts: Date.now(), show: '', content: '' };
    c.messages.push(am);
    el.list.appendChild(bubble(am));
    scrollBottom();
    await runAnswer(am);
  }

  // ---------------- 把接口错误翻译成"人话 + 下一步做什么" ----------------
  // 原来是把 e.message 原样贴出来，于是用户看到的是「Failed to fetch」「HTTP 401」这种 ——
  // 唯一的信息是"坏了"，不知道该点哪儿。下面每一条都是我们真踩过的坑，所以写的是**动作**。
  // 末尾一律保留原始报错：翻译错了的时候，原文是唯一的线索。
  function friendlyErr(e) {
    if (e && e.name === 'AbortError') { return tr('p.errStopped'); }
    var s = String((e && e.message) || e || '');
    var code = (e && e.status) || 0;
    if (!code) {
      var mm = s.match(/HTTP (\d{3})/);
      if (mm) { code = Number(mm[1]); }
    }
    if (code === 401) { return tr('p.err401'); }
    if (code === 402) { return tr('p.err402'); }
    if (code === 429) { return tr('p.err429'); }
    if (code === 400) { return tr('p.err400', { e: s }); }
    if (code >= 500) { return tr('p.err5xx', { code: code }); }
    if (code) { return tr('p.errHttp', { code: code, e: s }); }
    // 没有状态码 = 请求根本没到服务器。本机上最常见的原因就是代理。
    if (/Failed to fetch|NetworkError|Load failed|ERR_|net::/i.test(s)) { return tr('p.errNet'); }
    return tr('p.errGeneric', { e: s });
  }

  // ---------------- 开合 ----------------
  function modeKey() { return state.compact ? 'mini' : 'full'; }

  // compact=true 取小窗基准；size 是用户拉角拉过的大小，有就用它（再夹一次，别跑到屏幕外）
  function computeRect(compact, size) {
    var W = window.innerWidth, H = window.innerHeight;
    var k = compact ? 'mini' : 'full';
    // 先按全窗算出基准，小窗（拖拽进来时开的）取它的一半；
    // 但都有最小值兜着——再窄工具条上的按钮就挤成一团了。
    var fw = clamp(Math.round(W / 3), 360, 560);
    var fh = clamp(Math.round(H * 0.62), 420, 860);
    var w = compact ? clamp(Math.round(fw / 2), 280, 340) : fw;
    var h = compact ? clamp(Math.round(fh / 2), 300, 460) : fh;
    if (size && size.w > 0 && size.h > 0) { w = size.w; h = size.h; }
    w = clamp(w, MIN_W[k], Math.max(MIN_W[k], W - 24));
    h = clamp(h, MIN_H[k], Math.max(MIN_H[k], H - 24));
    var left, top;
    if (size && typeof size.left === 'number' && typeof size.top === 'number') {
      // 用户拖过顶栏，位置就用他放的地方（再夹一次，别跑到屏幕外）
      left = clamp(Math.round(size.left), 0, Math.max(0, W - w));
      top = clamp(Math.round(size.top), 0, Math.max(0, H - h));
    } else {
      // 没拖过：贴着球出现
      var b = (typeof window.__DS_BALL === 'function' ? window.__DS_BALL() : null) || { x: W - 80, y: H * 0.6, size: 53 };
      left = clamp(Math.round(b.x + b.size / 2 - w / 2), 12, Math.max(12, W - w - 12));
      top = clamp(Math.round(b.y + b.size / 2 - h / 2), 12, Math.max(12, H - h - 12));
    }
    return { w: Math.round(w), h: Math.round(h), left: left, top: top };
  }

  // 把当前的位置和大小记下来（拖动 / 拉角结束时都走这里）
  // 只记尺寸：面板的位置是"跟着球走"的（每次打开都按球重算），记了位置也不会被用上。
  function rememberGeom(k) {
    var s = host.style;
    state.size = state.size || {};
    state.size[k] = {
      w: parseInt(s.width, 10) || 0,
      h: parseInt(s.height, 10) || 0
    };
    save(K_SIZE, state.size);
  }

  function applyRect(r) {
    var s = host.style;
    s.setProperty('left', r.left + 'px', 'important');
    s.setProperty('top', r.top + 'px', 'important');
    s.setProperty('width', r.w + 'px', 'important');
    s.setProperty('height', r.h + 'px', 'important');
    s.setProperty('display', 'block', 'important');
  }

  function applyFs() {
    var s = host.style;
    s.setProperty('left', '0px', 'important');
    s.setProperty('top', '0px', 'important');
    s.setProperty('width', window.innerWidth + 'px', 'important');
    s.setProperty('height', window.innerHeight + 'px', 'important');
    s.setProperty('display', 'block', 'important');
  }

  function setFsBtnIcons() {
    if (!el.fsBtn) { return; }
    el.fsBtn.innerHTML = state.fs ? ICONS.shrink : ICONS.expand;
    el.fsBtn.title = state.fs ? tr('p.unfull') : tr('p.full');
  }

  function toggleFs() {
    if (!host) { return; }
    state.fs = !state.fs;
    el.wrap.classList.toggle('fs', state.fs);
    setFsBtnIcons();
    if (state.fs) {
      var r = host.getBoundingClientRect();
      // 记全一点：退出全屏时位置也要还原
      state.preFs = {
        w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), top: Math.round(r.top)
      };
      applyFs();
    } else {
      // 退出全屏：回到进全屏前那块地方（preFs 连位置一起还原，这是对的）
      var s1 = state.size && state.size[modeKey()];
      applyRect(computeRect(state.compact, state.preFs || (s1 ? { w: s1.w, h: s1.h } : null)));
    }
  }

  // 顶部拖动：按住顶栏（按钮以外）挪动面板
  function onBarDown(e) {
    if (state.fs || e.button !== 0) { return; }
    if (e.target && e.target.closest && e.target.closest('button')) { return; }  // 顶栏按钮不参与拖动
    e.preventDefault();
    e.stopPropagation();
    var r = host.getBoundingClientRect();
    var sx = e.clientX, sy = e.clientY, sl = r.left, stop_ = r.top;
    var w = r.width, h = r.height;
    var maxL = Math.max(0, window.innerWidth - w);
    var maxT = Math.max(0, window.innerHeight - h);
    el.wrap.classList.add('moving');
    try { el.bar.setPointerCapture(e.pointerId); } catch (err) {}

    function move(ev) {
      if (ev.pointerId !== e.pointerId) { return; }
      host.style.setProperty('left', Math.round(clamp(sl + (ev.clientX - sx), 0, maxL)) + 'px', 'important');
      host.style.setProperty('top', Math.round(clamp(stop_ + (ev.clientY - sy), 0, maxT)) + 'px', 'important');
    }
    function up(ev) {
      if (ev.pointerId !== e.pointerId) { return; }
      el.bar.removeEventListener('pointermove', move);
      el.bar.removeEventListener('pointerup', up);
      el.bar.removeEventListener('pointercancel', up);
      el.wrap.classList.remove('moving');
      try { el.bar.releasePointerCapture(e.pointerId); } catch (err) {}
      rememberGeom(modeKey());
    }
    el.bar.addEventListener('pointermove', move);
    el.bar.addEventListener('pointerup', up);
    el.bar.addEventListener('pointercancel', up);
  }

  // 右下角拉手：按住往右下拖就变大，往左上拖就变小（左上角固定不动）
  function onGripDown(e) {
    if (state.fs || e.button !== 0) { return; }
    e.preventDefault();
    e.stopPropagation();
    var r = host.getBoundingClientRect();
    var sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height;
    var r0 = { left: Math.round(r.left), top: Math.round(r.top) };
    var k = modeKey();
    var last = { w: Math.round(sw), h: Math.round(sh) };
    el.wrap.classList.add('rsz');
    try { el.grip.setPointerCapture(e.pointerId); } catch (err) {}

    function move(ev) {
      if (ev.pointerId !== e.pointerId) { return; }
      var maxW = Math.max(MIN_W[k], window.innerWidth - 24);
      var maxH = Math.max(MIN_H[k], window.innerHeight - 24);
      var w = Math.round(clamp(sw + (ev.clientX - sx), MIN_W[k], maxW));
      var h = Math.round(clamp(sh + (ev.clientY - sy), MIN_H[k], maxH));
      // 已经贴到屏幕右边/下边还想继续长大时，整个面板往左上挪一点，
      // 让光标压着的那个角跟手（只往左/上让，不让它反过来往右跑）。
      var left = Math.min(r0.left, Math.max(12, window.innerWidth - w - 12));
      var top = Math.min(r0.top, Math.max(12, window.innerHeight - h - 12));
      last = { w: w, h: h };
      host.style.setProperty('width', w + 'px', 'important');
      host.style.setProperty('height', h + 'px', 'important');
      host.style.setProperty('left', Math.round(left) + 'px', 'important');
      host.style.setProperty('top', Math.round(top) + 'px', 'important');
    }
    function up(ev) {
      if (ev.pointerId !== e.pointerId) { return; }
      el.grip.removeEventListener('pointermove', move);
      el.grip.removeEventListener('pointerup', up);
      el.grip.removeEventListener('pointercancel', up);
      el.wrap.classList.remove('rsz');
      try { el.grip.releasePointerCapture(e.pointerId); } catch (err) {}
      rememberGeom(k);              // 尺寸和位置都记住，下次打开还用
    }
    el.grip.addEventListener('pointermove', move);
    el.grip.addEventListener('pointerup', up);
    el.grip.addEventListener('pointercancel', up);
  }

  async function initData() {
    var chats = await load(K_CHATS);
    var curId = await load(K_CUR);
    var model = await load(K_MODEL);
    var effort = await load(K_EFFORT);
    var size = await load(K_SIZE);
    var reco = await load(K_RECO);
    await loadKey();          // Key 在浏览器里存着，读回来才知道 ⚙ 要不要点亮
    syncKeyHint();
    state.recoImg = !!reco;
    syncReco();
    state.chats = normalizeChats(chats);
    state.seen = {};                     // 从存储里读到的这些算"见过"（别处删掉时要跟着删）
    state.chats.forEach(function (c) { state.seen[c.id] = 1; });
    if (model) {
      state.model = model;
      fillModels();
    }
    if (effort) {
      state.effort = effort;
      fillEfforts();
    }
    // 上次拉角留下的尺寸存在本地，第一次打开时还没读出来，读到了再套用一次
    if (size && (size.full || size.mini)) {
      state.size = size;
      if (isOpen() && !state.fs) {
        var s0 = state.size[modeKey()];
        applyRect(computeRect(state.compact, s0 ? { w: s0.w, h: s0.h } : null));
      }
    }
    state.cur = state.chats.filter(function (c) { return c.id === curId; })[0] || state.chats[0] || newChat();
    if (state.chats.indexOf(state.cur) < 0) { state.chats.unshift(state.cur); }
    renderAll();
    renderHistory();
  }

  // ---------------- 界面语言：读取与热切换 ----------------
  // 面板的 DOM 是一次性 innerHTML 建出来的（build()），所以换语言最省事的做法就是**整块重建**：
  // 逐条改 textContent 得记住上百个节点，漏一个就是中英混着 —— 那比不切还难看。
  // 重建前把用户当下的状态（输入框里的字、抽屉开没开、搜索词、滚动位置）记下来，建完放回去。
  //
  // 两个触发点：① 脚本加载时读一次；② 在设置页切了语言（storage 变化广播过来）。
  function applyLang(v) {
    var want = (v === 'en') ? 'en' : 'zh';
    if (want === LANG) { return; }
    LANG = want;
    syncImgPromptText();
    relang();
  }

  function relang() {
    // 正在吐字时不动：这会儿重建会把 $body / $think 这些引用换成新的，
    // 流式写入还在往**已经离场**的旧节点上写。等这一轮结束、下次打开自然是新语言。
    if (!host || state.sending) { return; }
    var wasOpen = isOpen();
    var keep = {
      input: el.input ? el.input.value : '',
      drawer: !!(el.drawer && el.drawer.classList.contains('open')),
      dq: el.dq ? el.dq.value : '',
      scroll: el.list ? el.list.scrollTop : 0,
      fs: !!state.fs
    };
    try { host.remove(); } catch (e) {}
    host = null; root = null; el = {};
    build();
    if (el.input) { el.input.value = keep.input; autoGrow(); }
    if (keep.dq && el.dq) { el.dq.value = keep.dq; }
    renderChips();
    renderAll();
    renderHistory();
    if (wasOpen) {
      open(state.compact);
      if (keep.drawer) { el.drawer.classList.add('open'); }
      if (keep.fs) { state.fs = true; el.wrap.classList.add('fs'); applyFs(); setFsBtnIcons(); }
      if (el.list) { el.list.scrollTop = keep.scroll; }
    }
  }

  // 启动时读一次。异步，但用户双击球之前早就读完了；读不到就保持中文。
  function initLang() {
    try {
      if (!chrome.storage || !chrome.storage.local) { return; }
      chrome.storage.local.get(K_LANG, function (o) {
        var v = o && o[K_LANG];
        if (v === 'zh' || v === 'en') { applyLang(v); }
      });
    } catch (e) { /* 老环境：保持中文 */ }
  }

  function open(compact) {
    build();
    closeViewer();                          // 上次如果开着预览/确认层，重新打开时不该还盖在上面
    closeConfirm();
    state.compact = !!compact;
    el.wrap.classList.toggle('mini', state.compact);
    state.fs = false;                       // 每次打开都从非全屏开始
    el.wrap.classList.remove('fs');
    setFsBtnIcons();
    // 位置**每次按球算**（面板要跟着球走），只沿用记住的尺寸。
    // 以前是把记住的 left/top 也一起传进去，结果只要拖过一次面板（或拉过一次角），
    // 它就永远钉在那个位置 —— 球挪到哪儿都不跟，看起来就是"窗口和球对不上"。
    var sz = state.size && state.size[modeKey()];
    applyRect(computeRect(state.compact, sz ? { w: sz.w, h: sz.h } : null));
    el.wrap.classList.add('in');
    // 宿主里（侧边栏）一打开就铺满：那儿没有"浮在网页上"这回事
    if (isHost()) {
      state.fs = true;
      el.wrap.classList.add('fs');
      applyFs();
      setFsBtnIcons();
    }
    // 面板开了就把球收起来（位置上面已经算过了）
    if (window.__DS_BALL_VISIBLE) { window.__DS_BALL_VISIBLE(false); }
    if (!state.ready) {
      state.ready = true;
      // 以前这里把错误吞掉了，出问题时什么都看不到，留个日志
      initData().catch(function (e) {
        try { console.error('[悬浮球] 初始化失败：', e); } catch (x) {}
      });
    }
    setTimeout(function () { try { el.input.focus(); } catch (e) {} }, 40);
  }

  function close() {
    if (!host) { return; }
    el.wrap.classList.remove('in');
    el.drawer.classList.remove('open');
    closeViewer();                       // 预览层/确认层别留到下次打开
    closeConfirm();
    if (state.fs) {                      // 全屏状态下关掉，下次打开回到普通大小
      state.fs = false;
      el.wrap.classList.remove('fs');
      setFsBtnIcons();
    }
    host.style.setProperty('display', 'none', 'important');
    // 面板关了，球回来
    if (window.__DS_BALL_VISIBLE) { window.__DS_BALL_VISIBLE(true); }
  }

  function isOpen() {
    return !!host && host.style.display !== 'none';
  }

  // 划词：content.js 把「选中的文字 + 动作提示词」送进来。
  // **不往输入框里灌正文**，只挂一枚蓝色 chip —— 选一段长文时输入框还是干净的，能接着写字。
  // 真正拼进消息是在 send() 里做的（见那边的注释）。
  function askSelection(opt) {
    open();
    var o = opt || {};
    var t = String(o.text == null ? '' : o.text).trim();
    if (!t) { return; }
    if (t.length > 8000) {
      t = t.slice(0, 8000);
      toast(tr('p.selTooLong'));
    }
    var label = String(o.label || tr('p.selText'));
    var prompt = String(o.prompt || '');
    // 同一段文字 + 同一个动作点两次 → 不重复挂（不然手快点两下就两枚一样的 chip）
    var dup = state.sel.some(function (s) { return s.prompt === prompt && s.text === t; });
    if (dup) {
      toast(tr('p.selDup'));
    } else {
      state.sel.push({ label: label, prompt: prompt, text: t });
      renderChips();
    }
    try {
      el.input.focus();
      // 光标放末尾：接着写你自己那句
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    } catch (e) {}
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) {
      // 抽屉里挂着搜索词时，Esc 先清空它 —— 这个监听在**捕获阶段**（最后那个 true），
      // 所以抢在下面所有判断之前。不然打着字按一下 Esc，整块面板就被收走了。
      if (el.dq && el.dq.value && el.drawer.classList.contains('open')) {
        el.dq.value = '';
        renderHistory();
        return;
      }
      // 确认层 / 图片预览开着就先关它们（两种宿主里都这样，侧栏里也有这两层）
      if (isConfirmOpen()) { closeConfirm(); return; }
      if (isViewerOpen()) { closeViewer(); return; }
      // 侧边栏里 Esc 不关面板：关了只剩一条空白栏，而"关侧栏"该用浏览器自己的按钮
      if (isHost()) { return; }
      if (state.fs) { toggleFs(); return; }   // Esc 先退全屏，再按一次才关面板
      close();
    }
  }, true);

  // 窗口尺寸变了：全屏就重新铺满，普通状态就夹回可视区（尺寸尽量保留）
  window.addEventListener('resize', function () {
    if (!isOpen()) { return; }
    if (state.fs) { applyFs(); return; }
    var r = host.getBoundingClientRect();
    applyRect(computeRect(state.compact, {
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), top: Math.round(r.top)
    }));
  });

  // 网页这一侧的"取内容"服务：侧边栏里点「应用网页」时，侧栏没法读网页的 DOM
  // （它自己的 document 就是侧栏本身），所以回头问当前标签页 —— 而网页上跑的是
  // **同一份 panel.js**，手里已经有 grabPage / grabVisibleText，直接回给它就行，
  // 不用再写一份提取逻辑。
  // 只在网页里注册（宿主模式跳过：侧边栏自己不需要响应这种请求）。
  if (!isHost() && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    try {
      chrome.runtime.onMessage.addListener(function (m, sender, respond) {
        // 快捷键唤起（background.js 转发过来的）：开着就收，没开就开
        if (m && m.type === 'ds-toggle-panel') {
          try { if (isOpen()) { close(); } else { open(); } } catch (e) { }
          respond({ ok: true, open: isOpen() });
          return true;   // 保持通道打开
        }
        if (!m || m.type !== 'ds-grab-page') { return; }
        var out = { ok: true, title: '', url: '', text: '', images: [], visible: '', cut: false };
        try {
          var p = grabPage();
          out.title = p.title || '';
          out.url = p.url || '';
          out.text = p.text || '';
          out.images = (p.images || []).map(function (x) { return x.url; });
          out.visible = grabVisibleText();
          out.cut = !!p.cut;
        } catch (e) {
          out.ok = false;
          out.error = String((e && e.message) || e);
        }
        respond(out);
        return true;   // 保持通道打开
      });
    } catch (e) { /* 老环境没有这个 API，忽略 */ }
  }

  // 界面语言：脚本一加载就去读（不放在 open() 里 —— 那样第一次打开会先按中文建一遍）。
  initLang();

  window.__dsPanel = {
    open: open,
    close: close,
    isOpen: isOpen,
    openWithDrop: openWithDrop,
    askSelection: askSelection,    // 划词：content.js 把「选中的文字 + 动作提示词」送进来（只挂 chip，不填输入框）
    grabContext: grabContext,      // 取"当前网页"的内容（网页上读自己，侧栏里读当前标签页）
    toggle: function () { isOpen() ? close() : open(); },
    toast: toast                   // content.js 用：快捷键没选中文字时给一句提示
  };
})();
