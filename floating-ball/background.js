// ============================================================
//  DeepSeek 悬浮球 · 后台脚本
//  三件事：① 替内容脚本截当前可见的那一屏
//          ② 点工具栏图标 → 打开右侧栏（不弹小窗）
//          ③ 还没配 API Key 的话，装/更新完顺手把设置页打开
//  chrome.tabs.captureVisibleTab 只有扩展自己的上下文（这里）能调，
//  网页里的 content script 调不了，所以必须绕这一道。
// ============================================================

// ① 工具栏图标 → 侧边栏
// 声明了 action 之后工具栏就有按钮了，但它默认什么也不做：
// 得用 setPanelBehavior 告诉 Chrome"点它就开侧栏"（Chrome 116+）。
// 想改成弹小窗的话：把 manifest 里的 action.default_popup 指到一个页面，
// 再把下面这两行删掉即可。
function useSidePanel() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(function () { /* 老版本 Chrome 没有这个 API，忽略 */ });
  } catch (e) { /* 同上 */ }
}
useSidePanel();                                   // 后台每次醒来都设一遍
chrome.runtime.onInstalled.addListener(useSidePanel);

// ③ 没配 Key 就把设置页打开。
// API Key 现在存在浏览器里（设置页填），不在代码里 —— 所以新装或更新完，
// 总得让人知道去哪儿填，不然他只会看到一个"发不出去"的面板。
// 配过之后再也不会打扰（每次扩展重载/更新只检查这一下）。
function openSettingsIfNoKey() {
  try {
    chrome.storage.local.get('__ds_key__', function (d) {
      if (chrome.runtime.lastError) { return; }
      var k = d && d.__ds_key__;
      if (typeof k === 'string' && k.trim()) { return; }
      if (chrome.runtime.openOptionsPage) { chrome.runtime.openOptionsPage(); }
    });
  } catch (e) { /* 拿不到就安静跳过 */ }
}
chrome.runtime.onInstalled.addListener(openSettingsIfNoKey);

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ds-capture') { return; }

  // 网页里调的时候可以用 sender.tab 推出来；从**侧边栏**调的时候没有 sender.tab
  // （侧栏不是一个标签页），所以要由调用方显式带上 windowId，否则只能靠"当前窗口"猜。
  var windowId = (msg && typeof msg.windowId === 'number') ? msg.windowId
    : ((sender && sender.tab && typeof sender.tab.windowId === 'number') ? sender.tab.windowId : null);

  try {
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }, function (dataUrl) {
      var err = chrome.runtime.lastError;
      if (err || !dataUrl) {
        sendResponse({ ok: false, error: String((err && err.message) || '截图没有返回数据') });
        return;
      }
      sendResponse({ ok: true, dataUrl: dataUrl });
    });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }

  return true;   // 保持通道打开，等异步回调
});
