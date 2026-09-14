/**
 * service-worker.js — MV3 后台
 * 1. 快捷键 / 工具栏触发阅读模式：优先向活动标签页发消息；接收不到时按需注入内容脚本后重试
 * 2. 会话级 DNR 白名单拦截：阅读模式打开时对当前站点生效——只放行本站域名的请求，
 *    其余（广告/统计脚本、iframe、弹窗、跨站跳转 main_frame）一律拦截；关闭时移除
 *
 * 跨浏览器：Chrome 走 service_worker；Firefox（含 Android）由 tools/package.py
 * 注入 background.scripts 事件页字段加载本文件（无需 importScripts 任何依赖）。
 */

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

/**
 * 会话规则拦截的资源类型。逐项对照当前环境支持的 ResourceType 取交集而非写死全集：
 * 缺失枚举值（如 Firefox 无 POPUP）会让整批规则被拒，白名单完全失效。
 * main_frame 必须在内：广告脚本常在阅读模式开启前就已加载驻留，之后用定时器/触屏
 * 劫持强制 location 跳外域——网络层掐断这次导航请求，才不至于真的落到广告页。
 */
function blockableTypes() {
  const RT = (chrome.declarativeNetRequest && chrome.declarativeNetRequest.ResourceType) || {};
  return [
    'MAIN_FRAME', 'SUB_FRAME', 'SCRIPT', 'XMLHTTPREQUEST', 'IMAGE', 'MEDIA',
    'STYLESHEET', 'FONT', 'WEBSOCKET', 'OTHER', 'PING', 'POPUP'
  ]
    .map((k) => RT[k])
    .filter(Boolean);
}

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
      // 主世界键盘守卫单独特殊注入（隔离世界无法阻断站点脚本的 ←/→ 翻章监听）
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          files: ['src/content/kbd-guard.js'],
          world: 'MAIN',
          injectImmediately: true
        });
      } catch (e3) {
        /* world:MAIN 不可用的环境降级：仅失去按键隔离，不影响其余功能 */
      }
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
  if (msg && msg.type === 'NR_GET_SHORTCUT') {
    // 内容脚本无 chrome.commands 权限：代查当前真实生效的切换快捷键（用户可自行改绑/清除）
    chrome.commands
      .getAll()
      .then((cmds) => {
        const c = Array.isArray(cmds) && cmds.find((x) => x.name === 'toggle-reader');
        sendResponse({ shortcut: (c && c.shortcut) || '' });
      })
      .catch(() => sendResponse({ shortcut: '' }));
    return true; // 异步 sendResponse
  }
  if (msg && msg.type === 'NR_DNR_SESSION') {
    const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
    handleDnrSession(!!msg.enable, msg.host, tabId).catch(() => {});
    return false; // fire-and-forget
  }
  return false;
});

// ---------------- 会话级 DNR 规则 ----------------
// Chrome 的 session rules 是扩展级共享规则集，不是标签页私有状态：
// 必须按 sender.tab 记录"哪些标签页正在阅读哪个 host"，每次变化后由全部活跃
// host 重建一组规则。否则多标签页阅读时后开的一页会覆盖先开的一页，关闭先开
// 的一页又会清掉后一页的规则。

let readingTabs = new Map(); // tabId(字符串) -> host
let readingTabsLoaded = false;

/** SW 闲置回收后从 storage.session 恢复标签页状态（会话规则本身在浏览器会话内持久） */
async function ensureReadingTabs() {
  if (readingTabsLoaded) return;
  readingTabsLoaded = true;
  try {
    const { nrReadingTabs } = await chrome.storage.session.get('nrReadingTabs');
    if (nrReadingTabs && typeof nrReadingTabs === 'object') {
      readingTabs = new Map(Object.entries(nrReadingTabs));
    }
  } catch (e) {
    /* storage.session 不可用时退化为仅内存态 */
  }
}

async function persistReadingTabs() {
  try {
    await chrome.storage.session.set({ nrReadingTabs: Object.fromEntries(readingTabs) });
  } catch (e) {
    /* 同上 */
  }
}

async function handleDnrSession(enable, host, tabId) {
  await ensureReadingTabs();
  if (enable && host && tabId != null) {
    readingTabs.set(String(tabId), host);
  } else if (tabId != null) {
    readingTabs.delete(String(tabId));
  }
  await persistReadingTabs();
  await rebuildSessionRules();
}

/** 由所有活跃阅读标签页的 host 重建会话规则（同 host 多标签页只生成一组，每组一条） */
async function rebuildSessionRules() {
  const dnr = chrome.declarativeNetRequest;
  const existing = await dnr.getSessionRules();
  // 先删后建必须在同一次 updateSessionRules 里完成：分开会有拦截空窗，
  // 且重复 add 已存在的规则 ID 会报 Duplicate rule ID（整批被拒）
  const removeRuleIds = existing.filter((r) => r.id >= SESSION_RULE_BASE_ID).map((r) => r.id);
  const addRules = [...new Set(readingTabs.values())].map((host, hi) => ({
    id: SESSION_RULE_BASE_ID + hi,
    priority: 1,
    action: { type: 'block' },
    condition: {
      // 白名单式：拦"本站发起、目标域名不是本站"的全部请求。盗版站的弹窗/跳转广告
      // 脚本普遍用随机子域+高位端口动态下发，黑名单永远追不全，白名单一次覆盖。
      // 放行域含去 www. 的裸域（DNR 域名匹配自带子域展开，裸域条目即放行全部
      // 子域）；跨域镜像站的章节链接会被拦，属可接受代价（关闭
      // “阅读时只放行本站请求”设置即可恢复）
      initiatorDomains: [host],
      excludedRequestDomains: [...new Set([host, host.replace(/^www\./, '')])],
      resourceTypes: blockableTypes()
    }
  }));
  if (!removeRuleIds.length && !addRules.length) return;
  await dnr.updateSessionRules({ removeRuleIds, addRules });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabGone(String(tabId)).catch(() => {});
});

// 跨文档导航后旧阅读视图必然销毁： hostname 变了才清理该标签页状态
// （同源章节间 replaceState 也会触发 onUpdated，但 hostname 不变，不影响）
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  let host = '';
  try {
    host = new URL(info.url).hostname;
  } catch (e) {
    return;
  }
  handleTabNavigated(String(tabId), host).catch(() => {});
});

async function handleTabGone(tabId) {
  await ensureReadingTabs();
  if (!readingTabs.delete(tabId)) return;
  await persistReadingTabs();
  await rebuildSessionRules();
}

async function handleTabNavigated(tabId, host) {
  await ensureReadingTabs();
  if (!readingTabs.has(tabId) || readingTabs.get(tabId) === host) return;
  readingTabs.delete(tabId);
  await persistReadingTabs();
  await rebuildSessionRules();
}
