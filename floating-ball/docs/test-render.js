// 正文 markdown 渲染的单测：直接从 panel.js 里抠出真的函数跑（不复制逻辑）。
//
//   node docs/test-render.js
//
// 抠的是 esc → mdToHtml 这一段 —— 它们在 panel.js 里是连续的。
// 改了渲染相关的代码就跑一下它。
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', 'panel.js');
const src = fs.readFileSync(P, 'utf8');
const a = src.indexOf('function esc(');
const b = src.indexOf('  // 把文字放进剪贴板');
if (a < 0 || b < 0 || b < a) {
  console.error('✗ 在 panel.js 里定位不到渲染函数（是不是把 esc/mdToHtml 挪走了？）');
  process.exit(1);
}
// 面板文案在 i18n.js 里（中英两份）。这里取中文那份 —— 断言看的是结构，但用真词表能顺带
// 验证"{name}"这类占位符没写错（写成两遍会把花括号原样漏到界面上）。
const i18nWin = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8'))(i18nWin);
const ZH = (i18nWin.DS_I18N || {}).zh || {};
function tr(k, vars, dflt) {
  const v = ZH[k];
  if (typeof v !== 'string') { return typeof dflt === 'string' ? dflt : k; }
  return String(v).replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] != null) ? String(vars[x]) : m);
}
const titleText = c => (!c || !c.title || c.title === '新对话') ? tr('p.newChat') : c.title;

const M = new Function('tr', src.slice(a, b) + '\nreturn {esc:esc, mdToHtml:mdToHtml, mdToText:mdToText, dw:dw};')(tr);

let bad = 0;
function t(name, md, must, mustNot) {
  const html = M.mdToHtml(md);
  const miss = (must || []).filter(s => html.indexOf(s) < 0);
  const hit = (mustNot || []).filter(s => html.indexOf(s) >= 0);
  const ok = !miss.length && !hit.length;
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + name);
  if (!ok) {
    if (miss.length) console.log('    缺: ' + JSON.stringify(miss));
    if (hit.length) console.log('    多: ' + JSON.stringify(hit));
    console.log('    实际: ' + html.slice(0, 400));
  }
  return html;
}

console.log('=== 1. 表格渲染（当初截图里报的那个问题）===');
const shot = [
  '| 项 | 内容 |',
  '|---|----|',
  '| 强缓存 | 由 Cache-Control 决定，不发请求 |',
  '| 协商缓存 | 由 ETag 决定，发个问询再定 |',
  '| 命中缓存 | 直接用本地那份，很快 |',
  '| 没命中 | 服务器回 304，不用重传正文 |',
  '| 常见坑 | 改了文件但文件名没变 |',
].join('\n');
const h1 = t('表格被渲染成真 table', shot,
  ['<div class="tablewrap"><table>', '<thead>', '<th>项</th>', '<th>内容</th>',
   '<td>由 Cache-Control 决定，不发请求</td>', '<td>改了文件但文件名没变</td>', '</tbody>'],
  ['|---|', '| 项 |']);

console.log('\n=== 2. 标题 / 列表 / 引用 / 分隔线 / 加粗 / 行内代码 ===');
t('标题 → h1..h3，井号不再露出来',
  '# 一级\n## 二级\n### 三级',
  ['<h1>一级</h1>', '<h2>二级</h2>', '<h3>三级</h3>'], ['# 一级']);
t('无序列表（含嵌套）',
  '- 第一项\n- 第二项\n  - 嵌套的\n- 第三项',
  ['<ul><li>第一项</li><li>第二项<ul><li>嵌套的</li></ul></li><li>第三项</li></ul>'], ['- 第一项']);
t('有序列表不会因为中间插了字而重新从 1 数',
  '1. 先这样\n   这句是上一项的续行\n2. 再那样',
  ['<ol><li>先这样<br>这句是上一项的续行</li><li>再那样</li></ol>'], ['1. 先这样']);
t('引用 + 分隔线',
  '> 引用一句\n\n---',
  ['<blockquote>引用一句</blockquote>', '<hr>'], ['&gt; 引用一句']);

console.log('\n=== 3. 表格的花样 ===');
t('对齐语法 :---: 生效',
  '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |',
  ['text-align:left', 'text-align:center', 'text-align:right'], []);
t('不带首尾竖线的表格（模型常这么写）',
  '项 | 内容\n---|---\n强缓存 | 不发请求直接用本地那份',
  ['<table>', '<th>项</th>', '<th>内容</th>', '<td>不发请求直接用本地那份</td>'], ['---|---']);
t('只有一列的表格',
  '| 项 |\n|---|\n| a |\n| b |',
  ['<table>', '<td>a</td>', '<td>b</td>'], []);
t('格子里的加粗 / 行内代码照样解析',
  '| 项 | 值 |\n|---|---|\n| **重点** | `code` |',
  ['<strong>重点</strong>', '<code>code</code>'], ['**重点**']);
t('行数不齐时补空格子，不吞内容',
  '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |',
  ['<td>1</td><td></td>', '<td>3</td>'], []);

console.log('\n=== 4. 不能改坏的东西 ===');
t('代码块里的 markdown 原样保留（不解析）',
  '说明\n\n```js\nconst a = [1,2];  // | 表格竖线 | 也不该变\n# 这不是标题\n```\n完了',
  ['<pre><code>const a = [1,2];  // | 表格竖线 | 也不该变',
   '# 这不是标题', '<p>完了</p>'],
  ['<h1>这不是标题</h1>', '<table>']);
t('HTML 被转义（表格格子里也一样）',
  '| 危险 |\n|---|\n| <script>alert(1)</script> |',
  ['&lt;script&gt;alert(1)&lt;/script&gt;'], ['<script>']);
t('乘号别被当成斜体',
  '2*3*4 = 24，还有 a*b*c',
  ['2*3*4 = 24', 'a*b*c'], ['<em>']);
t('单独的 --- 是分隔线，不是表格',
  '上面\n\n---\n\n下面',
  ['<hr>'], ['<table>']);
t('链接变可点的 a（只认 http/https/mailto）',
  '见 [文档](https://example.com/x) 和 [假的](javascript:alert(1))',
  ['<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">文档</a>'],
  ['href="javascript']);
t('普通多行文字仍按段落 + 换行渲染',
  '第一行\n第二行\n\n新段落',
  ['<p>第一行<br>第二行</p>', '<p>新段落</p>'], []);

console.log('\n=== 5. 空输入 ===');
t('空字符串不炸', '', [], ['<p></p>']);
t('纯空白不炸', '   \n\n  ', [], ['<p></p>']);

console.log('\n=== 6. 「复制」复制出去的东西（mdToText：好读的纯文本）===');
function tt(name, md, must, mustNot) {
  const txt = M.mdToText(md);
  const miss = (must || []).filter(s => txt.indexOf(s) < 0);
  const hit = (mustNot || []).filter(s => txt.indexOf(s) >= 0);
  const ok = !miss.length && !hit.length;
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + name);
  if (!ok) {
    if (miss.length) console.log('    缺: ' + JSON.stringify(miss));
    if (hit.length) console.log('    多: ' + JSON.stringify(hit));
    console.log('    实际:\n' + txt);
  }
  return txt;
}

const txt1 = M.mdToText('## 网页缓存是怎么回事\n\n' + shot + '\n\n以上就是全部。');
{
  // 第 2 列在显示宽度上的起点：顺手用真的 dw 算，别在测试里再抄一份宽度逻辑
  const colAt = line => {
    const i = line.search(/ {2,}/);
    if (i < 0) return -1;
    return M.dw(line.slice(0, i)) + (line.slice(i).match(/^ +/)[0].length);
  };
  // 从表头那一行开始取（别写死下标：标题、空行都会让位置变）
  const all = txt1.split('\n');
  const t0 = all.findIndex(l => l.trim().indexOf('项') === 0);
  const rows = all.slice(t0, t0 + 6);             // 表头 + 5 行数据
  const at = [...new Set(rows.map(colAt))];
  const okAll = at.length === 1 && at[0] > 0;
  if (!okAll) bad++;
  console.log((okAll ? '✓ ' : '✗ ') + '表格按列对齐（每行第 2 列落在同一个显示位置）');
  console.log('   各行列起点 = ' + JSON.stringify(rows.map(colAt)) + '  →  第 2 列从显示宽度 ' + at.join('/') + ' 开始');
  if (!okAll) rows.forEach(r => console.log('   ' + r));

  tt('去掉井号 / 竖线 / |---|，但表头和数据都在',
    '## 网页缓存是怎么回事\n\n' + shot,
    ['网页缓存是怎么回事', '项', '内容', '由 Cache-Control 决定，不发请求', '改了文件但文件名没变'],
    ['|---|', '|', '#']);
}

tt('加粗 / 行内代码 / 删除线 / 引用号都去掉',
  '**重点**：用 `code` 就行 ~~别这样~~\n\n> 引用一句\n\n# 标题',
  ['重点：用 code 就行 别这样', '引用一句', '标题'],
  ['**', '`', '~~', '>', '#']);

tt('链接保留网址（不然点不了也不知道去哪）',
  '见 [文档](https://example.com/x)',
  ['见 文档 (https://example.com/x)'], ['[文档]', '](http']);

tt('列表保留 - 和编号（那是结构，不是记号）',
  '1. 先这样\n2. 再那样\n\n- 甲\n  - 乙',
  ['1. 先这样', '2. 再那样', '- 甲', '  - 乙'], []);

tt('代码块去掉围栏，代码本身一字不动',
  '这样写：\n\n```js\nconst a = 1;\n  if (a) { b(); }\n```\n完事。',
  ['const a = 1;\n  if (a) { b(); }', '这样写：', '完事。'],
  ['```']);

console.log('\n=== 5. 「推荐图片」：那段标记怎么被抠出来（splitReco）===');
// 第二段抠取：RECO_OPEN / RECO_CLOSE / RECO_SYS / splitReco 在 panel.js 里是连着的，单独切出来。
const ra = src.indexOf('var RECO_OPEN');
const rb = src.indexOf('function imgSearchUrl');
if (ra < 0 || rb < 0 || rb < ra) {
  console.error('✗ 在 panel.js 里定位不到「推荐图片」那一段（splitReco 挪位置了？）');
  process.exit(1);
}
const R2 = new Function(src.slice(ra, rb) + '\nreturn {splitReco:splitReco};')();
const sr = R2.splitReco;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + name);
  if (!ok) console.log('    期望 ' + JSON.stringify(want) + '\n    实际 ' + JSON.stringify(got));
}

eq('正常：正文 + 末尾一段标记',
  sr('这是正文。\n\n<img-reco>蓝色鲸鱼 扁平插画 | 深海 摄影</img-reco>'),
  { body: '这是正文。', keys: ['蓝色鲸鱼 扁平插画', '深海 摄影'] });

eq('标记夹在中间：两边的正文要接回来，不能丢',
  sr('前半<img-reco>鲸鱼</img-reco>后半'),
  { body: '前半后半', keys: ['鲸鱼'] });

eq('流式时还没闭合（只出来一半）：也要抠掉，不能把标签露给用户',
  sr('正文\n\n<img-reco>蓝色鲸鱼'),
  { body: '正文', keys: ['蓝色鲸鱼'] });

eq('标记后面还有正文（模型不听话放在中间了）：也接回来',
  sr('<img-reco>鲸鱼</img-reco>\n后面还有话'),
  { body: '后面还有话', keys: ['鲸鱼'] });

eq('模型没给标记：正文原样，一个词都没有（不硬凑）',
  sr('就是一段普通回答。'),
  { body: '就是一段普通回答。', keys: [] });

eq('空词和多余空格被丢掉',
  sr('<img-reco>  鲸鱼  ||  深海  </img-reco>'),
  { body: '', keys: ['鲸鱼', '深海'] });

eq('超过 60 字的不是关键词，丢掉',
  sr('<img-reco>' + 'x'.repeat(61) + ' | 好的词</img-reco>'),
  { body: '', keys: ['好的词'] });

eq('最多留 5 个，多出来的截掉',
  sr('<img-reco>a|b|c|d|e|f|g</img-reco>'),
  { body: '', keys: ['a', 'b', 'c', 'd', 'e'] });

console.log('\n=== 6. 多窗口合并 / 导出 md（纯函数）===');
// 又抠两段：合并那三个函数是连着的；导出那两个也是。
// 它们引用的 state / splitReco / A 这些自由变量用形参注进去（new Function 的形参名对上就行）。
const ca = src.indexOf('// ---------------- 多窗口 / 多标签页的同步 ----------------');
const cb = src.indexOf('// 写 chats 前先把磁盘那份读回来合并');
const cc = src.indexOf('function two(n)');
const cd = src.indexOf('function askClean()');
if (ca < 0 || cb < 0 || cc < 0 || cd < 0 || cb < ca || cd < cc) {
  console.error('✗ 定位不到合并/导出那两段（挪位置了？）');
  process.exit(1);
}
const FS = { dead: {} };
const R3 = new Function('state', 'NEW_TITLE', src.slice(ca, cb) + '\nreturn {mergeChats:mergeChats, dropChat:dropChat};')(FS, '新对话');
const R4 = new Function('splitReco', 'A', 'tr', 'titleText', src.slice(cc, cd) + '\nreturn {chatsToMd:chatsToMd};')(sr, { user: '我', name: 'Nova' }, tr, titleText);

const me = (id, up, n, tag) => ({ id: id, title: tag || id, updatedAt: up,
  messages: Array.from({ length: n }, (_, i) => ({ role: 'user', show: 'm' + i })) });

eq('合并：对方新建的对话要收下，并按更新时间倒序',
  R3.mergeChats([me('a', 100, 1)], [me('b', 200, 1)]).map(c => c.id),
  ['b', 'a']);

eq('合并：两边都有、对方更新 → 用对方的',
  R3.mergeChats([me('a', 100, 1, '我的')], [me('a', 200, 1, '对方的')])[0].title,
  '对方的');

eq('合并：两边都有、我更新 → 用我的（别把我在写的这轮丢掉）',
  R3.mergeChats([me('a', 300, 1, '我的')], [me('a', 200, 1, '对方的')])[0].title,
  '我的');

eq('合并：时间一样时用条数多的（append-only，条数多 = 更完整）',
  R3.mergeChats([me('a', 100, 2)], [me('a', 100, 5)])[0].messages.length,
  5);

// ---- 消息级合并：两个窗口同时往一个对话里打字，谁的话都不能丢 ----
const m1 = { mid: 'm1', role: 'user', show: '第一句', content: '第一句' };
const mA = { mid: 'mA', role: 'user', show: 'A 说的', content: 'A 说的' };
const mB = { mid: 'mB', role: 'user', show: 'B 说的', content: 'B 说的' };

eq('合并：两边各加了一句 → 两句都在（以前是整条二选一，后写的会把对方吃掉）',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 100, messages: [m1, mA] }],
    [{ id: 'a', title: 't', updatedAt: 200, messages: [m1, mB] }]
  )[0].messages.map(function (x) { return x.show; }),
  ['第一句', 'A 说的', 'B 说的']);

eq('合并：一边多那几句照收，重复的不重复',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 300, messages: [m1, mA] }],
    [{ id: 'a', title: 't', updatedAt: 100, messages: [m1] }]
  )[0].messages.map(function (x) { return x.show; }),
  ['第一句', 'A 说的']);

eq('合并：同一条（mid 一样）→ 取更完整的那份（流式写到一半 vs 最终版）',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 100, messages: [{ mid: 'x', role: 'assistant', show: '半截', content: '半截' }] }],
    [{ id: 'a', title: 't', updatedAt: 200, messages: [{ mid: 'x', role: 'assistant', show: '半截 + 剩下的', content: '半截 + 剩下的' }] }]
  )[0].messages[0].show,
  '半截 + 剩下的');

eq('合并：本地那份更完整时，不会被对方的半截盖回去',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 300, messages: [{ mid: 'x', role: 'assistant', show: '完整答案', content: '完整答案' }] }],
    [{ id: 'a', title: 't', updatedAt: 100, messages: [{ mid: 'x', role: 'assistant', show: '半', content: '半' }] }]
  )[0].messages[0].show,
  '完整答案');

eq('合并：老消息没有 mid → 按"角色+正文"当指纹，同一条不会被算成两条',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 100, messages: [{ role: 'user', show: '一样的话' }] }],
    [{ id: 'a', title: 't', updatedAt: 200, messages: [{ role: 'user', show: '一样的话' }] }]
  )[0].messages.length,
  1);

eq('合并：别处把它改成"新对话"了，也不能把这边起好的名字顶掉',
  R3.mergeChats(
    [{ id: 'a', title: '网页缓存', updatedAt: 100, messages: [m1] }],
    [{ id: 'a', title: '新对话', updatedAt: 200, messages: [m1] }]
  )[0].title,
  '网页缓存');

// ---- 「回到某条之前」是故意删的：合并时不能被对方那份救回来 ----
eq('合并：回滚过的那份，对方那份的旧尾巴不会再被救回来',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 300, cutAt: 'im1', cutTs: 500, messages: [m1] }],
    [{ id: 'a', title: 't', updatedAt: 100, messages: [m1, mA, mB] }]
  )[0].messages.map(function (x) { return x.show; }),
  ['第一句']);

eq('合并：回滚之后新加的消息要留着（只裁对方那份的旧尾巴）',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 600, cutAt: 'im1', cutTs: 500, messages: [m1, mB] }],
    [{ id: 'a', title: 't', updatedAt: 100, messages: [m1, mA, mB] }]
  )[0].messages.map(function (x) { return x.show; }),
  ['第一句', 'B 说的']);

eq('合并：两边都知道这次截断（标记一模一样）→ 之后新加的要留着，不能再裁',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 600, cutAt: 'im1', cutTs: 500, messages: [m1, mB] }],
    [{ id: 'a', title: 't', updatedAt: 700, cutAt: 'im1', cutTs: 500, messages: [m1, mB, mA] }]
  )[0].messages.map(function (x) { return x.show; }),
  ['第一句', 'B 说的', 'A 说的']);

eq('合并：截断标记要跟着合并结果传下去（不然下一轮又被救回来）',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 300, cutAt: 'im1', cutTs: 500, messages: [m1] }],
    [{ id: 'a', title: 't', updatedAt: 100, messages: [m1, mA] }]
  )[0].cutAt,
  'im1');

eq('合并：锚点在对方那份里找不到 → 宁可原样留着，也别乱删',
  R3.mergeChats(
    [{ id: 'a', title: 't', updatedAt: 300, cutAt: 'i找不到的号', cutTs: 500, messages: [m1] }],
    [{ id: 'a', title: 't', updatedAt: 100, messages: [m1, mA] }]
  )[0].messages.map(function (x) { return x.show; }),
  ['第一句', 'A 说的']);

eq('合并：本会话删过的对话，不能被磁盘版本"救"回来',
  (function () {
    const s = { dead: { a: Date.now() } };
    const F = new Function('state', src.slice(ca, cb) + '\nreturn {mergeChats:mergeChats};')(s);
    return F.mergeChats([], [me('a', 100, 1)]).length;
  })(),
  0);

const expChat = {
  id: 'c1', title: '测试对话', updatedAt: new Date(2026, 8, 26, 10, 30).getTime(),
  messages: [
    { role: 'user', show: '写个 hello', content: '写个 hello' },
    { role: 'assistant', show: '好的：\n\n```js\nconsole.log(1);\n```\n\n<img-reco>鲸鱼 | 深海</img-reco>',
      content: '好的……（这段是发给模型的那份，不该出现在导出里）',
      attachments: [{ name: 'a.png', size: 12 }] }
  ]
};
const md = R4.chatsToMd([expChat], new Date(2026, 8, 26, 12, 0).getTime());
const chk = (name, cond) => { if (!cond) bad++; console.log((cond ? '✓ ' : '✗ ') + name); };
chk('导出：有标题和导出时间', md.indexOf('# Nova 对话记录') === 0 && md.indexOf('导出时间：2026-09-26 12:00') > 0);
chk('导出：对话标题 + 最后更新时间 + 条数', md.indexOf('## 测试对话') > 0 && md.indexOf('最后更新 2026-09-26 10:30') > 0 && md.indexOf('2 条') > 0);
chk('导出：双方身份标出来（我 / Nova）', md.indexOf('**我**') > 0 && md.indexOf('**Nova**') > 0);
chk('导出：正文保留原来的 markdown（代码块围栏还在）', md.indexOf('```js') > 0 && md.indexOf('console.log(1);') > 0);
chk('导出：剥掉「推荐图片」那段标记', md.indexOf('img-reco') < 0);
chk('导出：附件只留名字（不带全文）', md.indexOf('> 附件：a.png') > 0);
chk('导出：带的是显示文本，不是发给模型的那份 content',
  md.indexOf('这段是发给模型的那份') < 0);

console.log('\n=== 7. 上下文预算：超了从第几条开始带（ctxWindow）===');
// 为什么单独抠出来测：这段决定了"每轮请求的前缀稳不稳"，而前缀一不稳，输入价就整段
// 从 1/50 的命中价掉回全价。算错一个下标是要花钱的，所以让它离线可测。
// 标记在 panel.js 里（// >>> ctxWindow / // <<< ctxWindow），挪动那段代码时别删标记。
const wa = src.indexOf('// >>> ctxWindow');
const wb = src.indexOf('// <<< ctxWindow');
if (wa < 0 || wb < 0 || wb < wa) {
  console.error('✗ 在 panel.js 里定位不到 ctxWindow（那两个标记被删了？）');
  process.exit(1);
}
const W = new Function(src.slice(wa, wb) + '\nreturn {ctxWindow:ctxWindow};')();

// 造消息：长度可控，且每条带 id 好认"起点是哪一条"
const mk = (...lens) => lens.map((n, i) => ({
  role: i % 2 ? 'assistant' : 'user', id: 'm' + i, content: 'x'.repeat(n)
}));
const win = (msgs, budget, keepRecent, chunk) => W.ctxWindow(msgs, budget, keepRecent, chunk || 8);
const from = (r) => r.from;
const lens = (r) => r.kept.map(m => m.content.length);

eq('没超预算：一条都不动（前缀和上一轮完全一致 → 缓存才可能命中）',
  from(win(mk(100, 100, 100), 1000, 2)), 0);
eq('正好卡在预算上：还是不动（== 不算超）',
  win(mk(500, 500), 1000, 1).kept.length, 2);

// 12 条 × 100 字 = 1200 > 1000。按字数算，第 2 条往后就装不下了（下标 2）；
// 但取整到 8 的倍数 → 起点落到 8。这就是"多丢几条换前缀稳定"。
eq('超预算：起点按 8 取整（不是"刚好压回线下"的下标 2）',
  from(win(mk(100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100), 1000, 2)), 8);
eq('  取整之后确实还在预算之内（留下的 4 条 = 400 字）',
  lens(win(mk(100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100), 1000, 2)), [100, 100, 100, 100]);

// ★ 这条是整段代码存在的理由：接着又聊了两轮，起点**必须还是 8**。
//   不取整的话这里会变成 4 —— 起点每轮都动 → 前缀每轮都变 → 缓存永久 0 命中。
const base12 = mk(100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100);
eq('★ 再聊两轮之后起点还是 8（同一个档 → 上一轮的请求整个成了这一轮的前缀）',
  from(win(base12.concat(mk(100, 100)), 1000, 2)), 8);
eq('  再多聊两轮也还在这一档',
  from(win(base12.concat(mk(100, 100, 100, 100)), 1000, 2)), 8);
// 一直聊到装不下 8 条尾巴了，才往上跳一整档（16），而不是一条一条挪
eq('装不下了才跳下一档：20 条 → 起点 16（跳一大步，不是挪一格）',
  from(win(mk(100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
             100, 100, 100, 100, 100, 100, 100, 100, 100, 100), 1000, 2)), 16);

eq('最近 keepRecent 条是硬下限：预算再小也得把它们留住（取整也不许吃掉它）',
  lens(win(mk(5000, 5000, 5000), 1000, 2)), [5000, 5000]);

// 取整的代价，写出来免得以后有人以为算错了：这里只超了 100 字，
// 但因为起点从 1 被取整到 8，最后只剩 1 条。多丢一点，换前缀稳定，值。
eq('取整会多丢几条（这是明码标价的代价）',
  lens(win(mk(100, 100, 100), 200, 1)), [100]);

console.log('\n' + (bad ? '★ 有 ' + bad + ' 项没过' : '全部通过 ✓'));
console.log('\n=== 截图那张表格实际渲染成什么（对话里显示的）===');
console.log(h1.slice(0, 300));
console.log('\n=== 同一个表格，点「复制」拿到的（粘到别处就是这样）===');
console.log(txt1);
process.exit(bad ? 1 : 0);
