/**
 * service-worker.js — MV3 后台
 * 1. 快捷键 / 工具栏触发阅读模式：优先向活动标签页发消息；接收不到时按需注入内容脚本后重试
 * 2. 会话级 DNR 广告拦截：阅读模式打开时，仅对当前站点生效；关闭时移除
 *
 * 跨浏览器：Chrome 走 service_worker（此处用 importScripts 载入域名表）；
 * Firefox（含 Android）走 manifest.background.scripts，域名表已随脚本数组先载入。
 */
if (typeof importScripts === 'function' && typeof self.AD_DOMAINS === 'undefined') {
  importScripts('ad-domains.js');
}

// 与 manifest content_scripts 保持一致（兜底注入用）
const CONTENT_SCRIPT_FILES = [
  'src/lib/purify.min.js',
  'src/lib/Readability.js',
  'src/lib/Readability-readerable.js',
  'src/content/detector.js',
  'src/content/cleaner.js',
  'src/content/extractor.js',
  'src/content/next-chapter.js',
  'src/content/settings-panel.js',
  'src/content/reader-view.js',
  'src/content/main.js'
];

const SESSION_RULE_BASE_ID = 9000;

async function toggleReaderInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'NR_TOGGLE' });
  } catch (e) {
    // 内容脚本尚未注入（扩展刚安装/刷新、页面早于扩展加载）→ 手动注入后重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: CONTENT_SCRIPT_FILES
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'NR_TOGGLE' });
    } catch (e2) {
      // chrome:// 等不可注入页面，忽略
    }
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-reader') {
    toggleReaderInActiveTab();
  }
});

// 允许 popup 等转发切换请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'NR_TOGGLE_ACTIVE_TAB') {
    toggleReaderInActiveTab();
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'NR_DNR_SESSION') {
    setSessionRules(msg.enable, msg.host).catch(() => {});
    return false; // fire-and-forget
  }
  return false;
});

// ---------------- 会话级 DNR 规则 ----------------

async function setSessionRules(enable, host) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ours = existing.filter((r) => r.id >= SESSION_RULE_BASE_ID);
  const removeRuleIds = ours.map((r) => r.id);

  if (!enable || !host || !self.AD_DOMAINS) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
    return;
  }

  const addRules = self.AD_DOMAINS.map((domain, i) => ({
    id: SESSION_RULE_BASE_ID + i,
    priority: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: '||' + domain + '^',
      initiatorDomains: [host],
      resourceTypes: ['script', 'image', 'sub_frame', 'xmlhttprequest', 'other', 'media']
    }
  }));

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}
