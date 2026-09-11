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

  // 切换快捷键提示：Mac 新装默认 ⌘⇧K（manifest suggested_key.mac），其余平台 Alt+R；
  // 已有安装升级不会重映射，故启动时向后台查一次真实生效的绑定，避免提示与实际不符
  let toggleHint = /Mac/i.test(navigator.platform || '') ? '⌘⇧K' : 'Alt+R';

  function refreshToggleHint() {
    try {
      chrome.runtime.sendMessage({ type: 'NR_GET_SHORTCUT' }, (resp) => {
        if (!NR.extAlive()) return; // 孤儿脚本：上下文已失效，保留平台默认提示
        const s = resp && resp.shortcut;
        if (s) {
          toggleHint = s;
          if (floatBtn && floatBtn.isConnected) {
            floatBtn.title = '进入小说阅读模式（' + toggleHint + '）';
          }
        }
      });
    } catch (e) {
      /* chrome.* 孤儿同步抛错：吞掉，保留平台默认提示 */
    }
  }

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
    btn.title = '进入小说阅读模式（' + toggleHint + '）';
    btn.textContent = '📖';
    btn.style.cssText =
      'position:fixed;right:calc(20px + env(safe-area-inset-right, 0px));bottom:calc(24px + env(safe-area-inset-bottom, 0px));' +
      'width:44px;height:44px;border-radius:50%;' +
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
    refreshToggleHint();
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
   * 快速跳转落地：目录跳转 / popup 续读 / 返回上一章写入 po:<目标URL> 标记后导航到本页，
   * 内容脚本启动时只消费自己命中的条目 → 自动进入阅读模式（配合进度记录恢复到上次位置）。
   * 每个目标 URL 一条独立 key：两个标签页同时跳不同章节互不覆盖、互不误删；
   * 启动时顺带清理过期条目（10 分钟）与旧版单值 pendingOpen。
   */
  async function checkPendingOpen() {
    try {
      const store = await chrome.storage.local.get(null);
      const now = Date.now();
      const TTL = 10 * 60 * 1000;
      const here = location.href.split('#')[0];
      const doomed = [];
      let mine = null;
      for (const k of Object.keys(store)) {
        if (k === 'pendingOpen') {
          // 旧版单值标记：按原语义消费/清理
          const po = store[k];
          if (!po || !po.url) {
            doomed.push(k);
            continue;
          }
          const samePage = po.url.split('#')[0] === here;
          if (samePage || now - (po.ts || 0) > TTL) doomed.push(k);
          if (samePage && now - (po.ts || 0) <= TTL) mine = po;
        } else if (k.indexOf('po:') === 0) {
          const po = store[k];
          if (!po || !po.url) {
            doomed.push(k);
            continue;
          }
          if (now - (po.ts || 0) > TTL) {
            doomed.push(k);
            continue;
          }
          if (po.url.split('#')[0] === here) {
            mine = po;
            doomed.push(k); // 只删除自己命中的条目，别的标签页的标记不动
          }
        }
      }
      if (doomed.length) chrome.storage.local.remove(doomed).catch(() => {});
      if (!mine) return;
      NR._autoOpenIntent = mine.intent === 'resume' ? 'resume' : 'jump'; // 传给 reader.open 决定是否恢复位置/提示
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
        // open() 失败必须也回话，否则发送方（popup/测试）会一直等响应
        NR.reader.open()
          .then((ok) => sendResponse({ ok, open: ok }))
          .catch(() => {
            try { sendResponse({ ok: false, open: false }); } catch (e) { /* 通道已关 */ }
          });
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
