/*
 * 单一事实来源：默认配置。
 * 被三处加载：
 *   - background.js     通过 importScripts()
 *   - content scripts   通过 manifest 的 js 数组
 *   - options / popup   通过 <script src>
 * 所以这里只能用 var 声明全局，不要用 ES module 语法。
 */

var DS_DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  targetLang: '简体中文',

  enabled: true,
  prefetchAhead: 45,
  batchSize: 8,
  concurrency: 2,
  showMode: 'zh',
  autoEnableTracks: true,
  domFallback: false,
  fontScale: 1,
  debug: false
};

var DS_MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash（快，推荐）' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro（更准，更慢更贵）' }
];

var DS_LANGS = ['简体中文', '繁體中文', '日本語', '한국어', 'English'];

function dsMergeSettings(stored) {
  var out = {};
  for (var k in DS_DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DS_DEFAULTS, k)) out[k] = DS_DEFAULTS[k];
  }
  if (stored) {
    for (var k2 in stored) {
      if (stored[k2] !== undefined && stored[k2] !== null) out[k2] = stored[k2];
    }
  }
  return out;
}

function dsHasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

function dsLoadSettings(cb) {
  if (!dsHasChromeStorage()) { cb(dsMergeSettings(null)); return; }
  chrome.storage.local.get(null, function (s) { cb(dsMergeSettings(s)); });
}

function dsSaveSettings(patch, cb) {
  if (!dsHasChromeStorage()) { if (cb) cb(); return; }
  chrome.storage.local.set(patch, function () { if (cb) cb(); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DS_DEFAULTS: DS_DEFAULTS,
    DS_MODELS: DS_MODELS,
    DS_LANGS: DS_LANGS,
    dsMergeSettings: dsMergeSettings,
    dsLoadSettings: dsLoadSettings,
    dsSaveSettings: dsSaveSettings
  };
}
