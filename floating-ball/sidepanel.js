// 侧边栏宿主：告诉面板"你在浏览器自己的容器里跑"，然后把它打开、铺满整栏。
//
// 必须在 panel.js 之后加载 —— 要用它挂出来的 window.__dsPanel / window.__DS_HOST。
// 点工具栏图标就是靠这个页面：图标 → Chrome 打开侧栏 → 这里自动把面板铺满。
(function () {
  window.__DS_HOST = 'sidepanel';
  try {
    window.__dsPanel.open();
  } catch (e) {
    // 面板没起来的话，别留一片白 —— 说清楚是哪一步挂了
    document.body.style.cssText = 'padding:16px;font:13px/1.7 system-ui,"Microsoft YaHei";';
    document.body.textContent = '面板没起来：' + (e && e.message ? e.message : e);
  }
})();
