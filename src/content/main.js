/**
 * main.js — 内容脚本入口：悬浮按钮、消息处理、站点黑名单、设置热更新
 * 仅在顶层窗口运行；iframe 中不注入任何东西。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  if (window.top !== window) return; // iframe 不处理
  if (!/^https?:$/.test(location.protocol)) return;

  NR._blacklist = [];
  NR._blacklisted = false;

  let floatBtn = null;

  // ---------------- 站点黑名单 ----------------

  async function refreshBlacklist() {
    try {
      const store = await chrome.storage.local.get('blacklist');
      NR._blacklist = Array.isArray(store.blacklist) ? store.blacklist : [];
    } catch (e) {
      NR._blacklist = [];
    }
    const host = location.hostname;
    NR._blacklisted = NR._blacklist.some((h) => host === h || host.endsWith('.' + h));
  }

  // ---------------- 悬浮按钮 ----------------

  function createFloatButton() {
    const btn = document.createElement('div');
    btn.id = 'novel-reader-float-btn';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.title = '进入小说阅读模式（Alt+R）';
    btn.textContent = '📖';
    btn.style.cssText =
      'position:fixed;right:20px;bottom:24px;width:44px;height:44px;border-radius:50%;' +
      'background:rgba(30,30,36,.88);color:#fff;font-size:20px;line-height:44px;text-align:center;' +
      'cursor:pointer;z-index:2147483646;box-shadow:0 4px 14px rgba(0,0,0,.28);' +
      'user-select:none;-webkit-user-select:none;opacity:.55;transition:opacity .2s,transform .2s;';
    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.08)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '.55';
      btn.style.transform = 'scale(1)';
    });
    btn.addEventListener('click', () => {
      NR.reader.open();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        NR.reader.open();
      }
    });
    return btn;
  }

  function updateFloatButton() {
    const want =
      NR.settings &&
      NR.settings.floatingButton &&
      !NR._blacklisted &&
      !(NR.reader && NR.reader.isOpen) &&
      NR.isNovelLike(document);
    if (want && !floatBtn && document.body) {
      floatBtn = createFloatButton();
      document.body.appendChild(floatBtn);
    } else if ((!want || !document.body) && floatBtn) {
      floatBtn.remove();
      floatBtn = null;
    }
  }

  // ---------------- 启动 ----------------

  async function boot() {
    await Promise.all([NR.getSettings().catch(() => {}), refreshBlacklist()]);
    NR.loadSiteRules().then(updateFloatButton).catch(() => {});
    updateFloatButton();
    checkPendingOpen();

    // 页面完全加载后再检测一次（部分站点正文异步渲染）
    if (document.readyState !== 'complete') {
      window.addEventListener('load', () => setTimeout(updateFloatButton, 1200), { once: true });
    }
    // 兜底：站点脚本清掉了按钮或 SPA 切页后重判
    setInterval(() => {
      if (floatBtn && !floatBtn.isConnected) floatBtn = null;
      updateFloatButton();
    }, 10000);
  }

  /**
   * 快速跳转落地：目录跳转 / popup 续读 / 返回上一章写入 pendingOpen 标记后导航到本页，
   * 内容脚本启动时消费标记 → 自动进入阅读模式（配合进度记录恢复到上次位置）。
   */
  async function checkPendingOpen() {
    try {
      const store = await chrome.storage.local.get('pendingOpen');
      const po = store.pendingOpen;
      if (!po || !po.url) return;
      const samePage = po.url.split('#')[0] === location.href.split('#')[0];
      const expired = Date.now() - (po.ts || 0) > 10 * 60 * 1000; // 10 分钟有效期
      if (expired) {
        chrome.storage.local.remove('pendingOpen');
        return;
      }
      if (!samePage) return; // 是给别的页面写的，留着不碰
      chrome.storage.local.remove('pendingOpen');
      NR._autoOpenIntent = po.intent === 'resume' ? 'resume' : 'jump'; // 传给 reader.open 决定是否恢复位置/提示
      await NR.reader.open();
    } catch (e) {
      /* 自动打开失败不影响正常使用 */
    }
  }

  document.addEventListener('novelreader:opened', updateFloatButton);
  document.addEventListener('novelreader:closed', updateFloatButton);

  // ---------------- 设置热更新 ----------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      NR.settings = Object.assign({}, NR.DEFAULT_SETTINGS, changes.settings.newValue || {});
      NR.applySettings();
      updateFloatButton();
    } else if (area === 'local' && changes.blacklist) {
      NR._blacklist = Array.isArray(changes.blacklist.newValue) ? changes.blacklist.newValue : [];
      refreshBlacklist().then(updateFloatButton);
    }
  });

  // ---------------- 消息处理 ----------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'NR_TOGGLE') {
      if (NR.reader.isOpen) {
        NR.reader.close();
        sendResponse({ ok: true, open: false });
      } else {
        NR.reader.open().then((ok) => sendResponse({ ok, open: ok }));
      }
      return true; // 异步响应
    }
    if (msg.type === 'NR_STATUS') {
      sendResponse({ open: NR.reader.isOpen, novelLike: NR.isNovelLike(document) });
      return false;
    }
    if (msg.type === 'NR_GET_PAGE_INFO') {
      sendResponse({
        host: location.hostname,
        novelLike: NR.isNovelLike(document),
        blacklisted: NR._blacklisted
      });
      return false;
    }
    return false;
  });

  boot();
})();
