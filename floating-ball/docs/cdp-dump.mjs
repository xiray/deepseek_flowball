// 用 DevTools 协议读自检结果 + 截图。
//
// 什么时候需要它：Chrome 的 `--dump-dom` / `--screenshot` / `--print-to-pdf` 突然一条都不执行了
// （2026-10-12 遇到：进程起得来、profile 目录也建全，就是零输出；换 Edge 一样）。
// 那时候别去调参数，改走协议 —— `--remote-debugging-port` 这条路是好的。
//
//   node docs/cdp-dump.mjs <页面 URL 里的一段> <结果写到哪> [截图写到哪]
//   node docs/cdp-dump.mjs selftest.html  ./r1.json  ./s1.png
//
// 它会等每个报告块（#report / #report2 / #repA/#repB/#repC）出现收尾语再收工，最多等 60 秒。
// 结果是一个 JSON：{"report": "...", ...}，直接读文本就行。
//
// ⚠ 启动 Chrome 的那条命令**必须和调用它写在同一个 shell 命令里** ——
//   后台任务会在工具调用结束时被整棵回收，留一个 Chrome 在那儿等下一次调用是不可能的。
//   完整用法见 README 的「改完自己验」一节。
import fs from 'node:fs';

const PORT = Number(process.env.DS_CDP_PORT || 9333);
const urlFrag = process.argv[2];
const outTxt = process.argv[3];
const outPng = process.argv[4] || '';

if (!urlFrag || !outTxt) {
  console.error('用法：node cdp-dump.mjs <URL 里的一段> <结果写哪> [截图写哪]');
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.indexOf(urlFrag) >= 0);
if (!t) {
  console.error('没找到页面 target。现有：\n' + list.map(x => '  ' + x.type + '  ' + x.url).join('\n'));
  process.exit(2);
}

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
function send(method, params) {
  const i = ++id;
  return new Promise((res, rej) => {
    pend.set(i, { res: res, rej: rej });
    ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
  });
}
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    if (m.error) { p.rej(new Error(m.error.message)); } else { p.res(m.result); }
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

const EXPR = '(function(){var o={};' +
  'document.querySelectorAll("[id]").forEach(function(e){' +
  'if(/^(report\\d*|rep[ABC])$/.test(e.id)){o[e.id]=e.textContent;}});' +
  'return JSON.stringify(o);})()';

const TERM = /全部通过|没过|发现问题/;      // 三个自检页的收尾语
let last = '{}';
for (let i = 0; i < 40; i++) {
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  last = (r.result && r.result.value) || '{}';
  let o = {};
  try { o = JSON.parse(last); } catch (e) {}
  const keys = Object.keys(o);
  if (keys.length && keys.every(k => TERM.test(o[k]))) { break; }
  await new Promise(r2 => setTimeout(r2, 1500));
}
fs.writeFileSync(outTxt, last, 'utf8');

if (outPng) {
  const m = await send('Page.getLayoutMetrics');
  const sz = m.cssContentSize || m.contentSize || { height: 1200 };
  const h = Math.max(400, Math.ceil(sz.height) + 40);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1300, height: h, deviceScaleFactor: 1, mobile: false });
  await new Promise(r2 => setTimeout(r2, 800));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
}

ws.close();
console.log('ok  ' + outTxt + (outPng ? '  + ' + outPng : ''));
process.exit(0);
