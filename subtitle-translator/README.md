# 字幕实时翻译 · DeepSeek

抓网页视频自带的英文字幕轨，提前翻译成中文，叠在画面上。

不是"边播边翻"。字幕轨一抓到就是完整的一份，所以可以提前把未来几十秒的台词送去翻译，
播到那一句的时候译文已经在缓存里了——这是它和"逐句即时翻译"最大的区别。

---

## 装

1. Chrome 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选这个目录（`subtitle-translator`）
4. 首次安装会自动弹出设置页；没弹的话点扩展图标 → 「更多设置」

## 填 API Key（就在设置页第一格）

设置页顶部第一张卡片就是 **API Key**：

- 粘贴 DeepSeek 的 Key → 点「测试连接」验证 → 点「保存设置」
- 扩展图标点开的弹窗里也有一个同样的输入框，改完点「保存」即刻生效，不用进设置页
- Key 只写进本机浏览器的 `chrome.storage.local`，不上传第三方，也不出现在任何源码文件里
  （自检里有一项断言专门扫这件事）

其他几格：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 模型 | `deepseek-flash` | DeepSeek-V4.1-Flash。也可选 `deepseek-v4-pro` |
| 目标语言 | 简体中文 | |
| 预取提前量 | 45 秒 | 调大更不容易"慢半拍"，但请求发得更早 |
| 每批条数 | 8 | 一次请求翻几句。批内靠后的句子等于提前拿到译文 |
| 并发请求数 | 2 | |
| 字幕字号倍率 | 1 | 覆盖层字号跟着视频高度走，这是额外倍率 |

## 用

**关键一步：先在播放器里把字幕（CC）打开。**

扩展抓的是播放器自己下载的那份字幕文件。不开 CC，播放器就不会去请求它，也就没东西可抓。
这是设计使然，不是 bug。

打开字幕后，中文会自动叠在画面下方。点扩展图标能看到当前用的是哪一级字幕源。

## 它是怎么找到字幕的

按「能不能拿到完整字幕轨」分成三级，高的盖掉低的：

| 级别 | 手段 | 能拿到完整轨 | 能预取 |
| --- | --- | --- | --- |
| L1 | 拦截页面的 `fetch` / `XMLHttpRequest`，认出字幕文件 | 能 | 能 |
| L2 | 读 `video.textTracks` 里的原生字幕轨 | 能 | 能 |
| L3 | 监听页面上字幕文本的变化（兜底，默认关） | 不能，只有当前一句 | 不能 |

L1 顺带解决了一个麻烦：YouTube 这类站点的字幕接口带签名令牌校验，自己拼 URL 会拿空响应；
但**拦截页面自己发出的请求**不受这个限制——令牌是现成的。

支持的字幕格式：WebVTT、SRT、TTML/DFXP、以及常见的 JSON 形状（含 YouTube 的 `json3`）。

## 已知限制

- **必须先在播放器里开字幕**，理由见上。
- **L3 兜底会慢半拍**。拿不到完整轨就没法预取，这是结构性的，调参数救不了。
- **加密下发的字幕拿不到**。部分订阅制流媒体对字幕做加密，通用手段没戏。
- **画中画（PiP）窗口里不显示**。PiP 是独立窗口，扩展画不上去。
- **本地 `file://` 视频**需要在扩展详情页手动打开「允许访问文件网址」。
- 扩展会在所有网页注入一个抓取脚本（要 patch `fetch`）。它只做 URL 和内容特征匹配，
  命中不了就直接放行，但仍然是个全局改动，介意的话可以把它改成只在特定站点启用。

## 文件结构

```
manifest.json          清单。MAIN world 抓取脚本 + ISOLATED 主脚本 + service worker
background.js          唯一发 DeepSeek 请求的地方（service worker 不受页面 CORS 限制）
shared/settings.js     默认值的唯一副本，三处共用
content/capture.js     MAIN world：patch fetch/XHR 抓字幕文件
content/parse.js       字幕解析（VTT/SRT/TTML/JSON），纯函数
content/pipeline.js    缓存去重 + 批量合并 + 并发闸门 + 失败退避
content/overlay.js     中文覆盖层（Shadow DOM，全屏会重新挂载）
content/main.js        编排：找视频 → 收轨 → 预取 → 渲染
options.html/js/css    设置页（含 API Key 输入）
popup.html/js/css      弹窗：总开关 + API Key + 运行状态
docs/                  自检页、图标生成脚本
```

## 自检

改完代码想确认没写坏，跑这个：

```bash
# 起个本地静态服务器（自检页要靠 HTTP 加载 .vtt 才能验证 L1 抓取）
python -m http.server 8788 --bind 127.0.0.1 --directory .

# 无头跑一遍，断言结果直接输出成文本
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --no-proxy-server \
  --user-data-dir="$TEMP/dssub-selftest" \
  --window-size=1180,1400 --virtual-time-budget=30000 \
  --dump-dom --screenshot="$TEMP/result.png" \
  "http://127.0.0.1:8788/docs/selftest.html"
```

自检页加载的是**真实的源码文件**，只把 `chrome.*` 换成桩，覆盖 119 项断言：

- A 解析层：四种格式、时码换算、缺 end 补位、滚动字幕去重、二分查找
- B 后台：请求是否打到正确端点、带没带凭证、**thinking 有没有关掉**、401/402/格式错乱的处理
- C 覆盖层：定位对齐、能否点穿、双语/单语切换、全屏重挂载、detach 清理
- D 流水线：批量对齐、缓存命中不发请求、失败退避、并发闸门
- E 抓取：真 `.vtt` 能抓到、**URL 像字幕但内容不是 → 必须拒绝**、重复请求不重复上报
- F 端到端：造一个视频 + 投一份字幕 → 断言真的发了翻译请求、译文回填、覆盖层出字、播完自动隐藏
- G 契约：JS 里引用的元素 id 在 HTML 里都存在、源码里没有明文 Key、manifest 关键字段正确
- H 设置页 / 弹窗：把真实的 `options.html` / `popup.html` markup 注入进页面，
  **真的加载 `options.js` / `popup.js` 跑一遍**——断言默认值被填进界面、显示/隐藏切换、
  保存真的写进 storage、测试连接的成功与失败两条路径都渲染出结果、弹窗回填时 Key 是打码的

> G 和 H 的区别很关键：G 只是**静态**检查"js 里写的 id 在 html 里存不存在"，
> 它证明不了那个 js 真能跑。曾经就出现过 G 全绿、但设置页其实一打开就抛异常的情况。
> 涉及 UI 的改动，一定要有 H 这种**真的执行一遍**的断言。

### 还有一步：装没装上，只能人眼看

自检证明的是**代码逻辑**，证明不了「扩展在 Chrome 里真能装上、内容脚本真会注入」。
而这一步在本机没法自动验：正式版 Chrome 会静默忽略 `--load-extension`，
换 Chrome for Testing 又被安全软件拦掉。

所以留了 `docs/extcheck.html`：**装好扩展后**打开它（服务同上，
地址 `http://127.0.0.1:8788/docs/extcheck.html`），它会轮询 2 秒，然后报出四项：

- MAIN world 的抓取脚本注入没有
- 隔离世界的内容脚本注入没有（看覆盖层宿主节点在不在）
- 内容脚本有没有认出页面里的 `<video>`
- 页面自己的 `fetch` 有没有被 patch 弄坏

横幅变绿 = 装好了。灰着不动 = 扩展没装上，或者没给这个站点注入权限。

## 隐私

- API Key 存在本机 `chrome.storage.local`
- 发给 DeepSeek 的只有字幕文本本身，不含 URL、页面内容或任何标识
- 没有其他任何网络请求
