/**
 * popup.js — 工具栏弹窗：进入阅读模式、悬浮按钮开关、全局广告拦截、站点启停
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let currentTab = null;
  let pageInfo = null; // {host, novelLike, blacklisted}

  function timeAgo(ts) {
    const diff = Date.now() - (ts || 0);
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    const d = new Date(ts);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const md = (d.getMonth() + 1) + '/' + d.getDate();
    return sameYear ? md : d.getFullYear() + '/' + md;
  }

  /**
   * 最近阅读列表：每本书独立 storage key（p:<书键>），按时间倒序取前 8 条；
   * 兼容读取旧版整包 progress。点击写 po:<目标URL> 跳转标记后开新标签，
   * 落地自动进阅读模式（多标签页并发续读互不覆盖）。
   */
  async function loadRecent() {
    const listEl = $('recentList');
    let records = [];
    try {
      const all = await chrome.storage.local.get(null);
      const map = {};
      for (const k of Object.keys(all)) {
        if (k.indexOf('p:') === 0 && all[k] && all[k].url) map[k.slice(2)] = all[k];
      }
      const legacy = all.progress || {};
      for (const k of Object.keys(legacy)) {
        if (legacy[k] && legacy[k].url && !map[k]) map[k] = legacy[k];
      }
      records = Object.values(map)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 8);
    } catch (e) {
      /* fallthrough */
    }
    listEl.textContent = '';
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'recent-empty';
      empty.textContent = '暂无阅读记录，去读一章吧';
      listEl.appendChild(empty);
      return;
    }
    for (const r of records) {
      const item = document.createElement('div');
      item.className = 'recent-item';
      const info = document.createElement('div');
      info.className = 'r-info';
      const book = document.createElement('div');
      book.className = 'r-book';
      book.textContent = r.bookTitle || r.chapterTitle || '未命名书籍';
      const chapter = document.createElement('div');
      chapter.className = 'r-chapter';
      const pct = typeof r.chapterRatio === 'number' ? ' · ' + Math.round(r.chapterRatio * 100) + '%' : '';
      chapter.textContent = (r.bookTitle ? '读到：' : '') + (r.chapterTitle || r.url) + pct;
      info.appendChild(book);
      info.appendChild(chapter);
      const time = document.createElement('div');
      time.className = 'r-time';
      time.textContent = timeAgo(r.ts);
      const go = document.createElement('div');
      go.className = 'r-go';
      go.textContent = '续读 ›';
      item.appendChild(info);
      item.appendChild(time);
      item.appendChild(go);
      item.addEventListener('click', async () => {
        try {
          // resume 意图：落地后恢复到上次读到的章内位置（每目标 URL 独立 key）
          await chrome.storage.local.set({
            ['po:' + r.url.split('#')[0]]: { url: r.url, ts: Date.now(), intent: 'resume' }
          });
        } catch (e) {
          /* 标记失败也能打开，只是不自动进阅读模式 */
        }
        chrome.tabs.create({ url: r.url });
        closePopup();
      });
      listEl.appendChild(item);
    }
  }

  async function init() {
    // 活动标签页（打开 popup 已获得 activeTab 授权）
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab || null;

    // 全局设置
    const { settings } = await chrome.storage.sync.get('settings');
    const s = Object.assign(
      { floatingButton: true },
      settings || {}
    );
    $('floatingButton').checked = !!s.floatingButton;

    // 显示真实生效的切换快捷键：Mac 新装为 ⌘⌥R，已有安装可能仍是 Alt+R 或用户自定义
    try {
      const cmds = await chrome.commands.getAll();
      const cmd = Array.isArray(cmds) && cmds.find((c) => c.name === 'toggle-reader');
      const label = (cmd && cmd.shortcut) || '未设置';
      $('toggleKbd').textContent = label;
      $('toggleFootKbd').textContent = label;
    } catch (e) {
      /* 查询失败保留默认 Alt+R 文案 */
    }

    // 全局广告域名拦截（静态规则集开关）
    try {
      const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
      $('globalAdBlock').checked = enabled.includes('ad_domains');
    } catch (e) {
      $('globalAdBlock').disabled = true;
    }

    // 当前页面信息（内容脚本可能不存在于 chrome:// 等页面）
    if (currentTab && currentTab.id != null) {
      try {
        pageInfo = await chrome.tabs.sendMessage(currentTab.id, { type: 'NR_GET_PAGE_INFO' });
      } catch (e) {
        pageInfo = null;
      }
    }

    if (!pageInfo) {
      $('pageStatus').textContent = currentTab ? currentTab.url || '当前页面不可用' : '未找到活动标签页';
      if (!/^https?:/.test(currentTab && currentTab.url || '')) {
        $('openReader').disabled = true;
        $('siteEnabled').disabled = true;
      }
    } else {
      $('pageStatus').textContent = pageInfo.host + (pageInfo.novelLike ? ' · 识别到小说页' : ' · 未见小说特征');
      $('siteEnabled').checked = !pageInfo.blacklisted;
      if (!pageInfo.novelLike) {
        $('openReader').textContent = '仍要进入阅读模式';
      }
    }

    bindEvents();
    loadRecent();
  }

  /**
   * 确定性收起面板。旧实现先 await 内容脚本响应再 window.close()：
   * 内容脚本 open() 要等正文提取（可达数秒），open() reject 时 sendResponse
   * 永不回调 → window.close() 永不执行，面板"点击进入后不收起"。
   * 现在改为点击即收起；浏览器（如部分手机浏览器的扩展面板）忽略
   * window.close() 且无关闭 API 时，延迟给出可见反馈兜底，避免"点了没反应"。
   * 不走 chrome.windows.remove 兜底：扩展面板不是 windows API 意义上的窗口，
   * getCurrent 可能返回用户真实弹窗型浏览窗口，误删会连标签页一起带走。
   */
  function closePopup() {
    try { document.body.classList.add('nr-closing'); } catch (e) { /* 面板已不在 */ }
    try { window.close(); } catch (e) { /* 同上 */ }
    setTimeout(() => {
      try {
        if (!document.body || !document.body.isConnected) return; // 已成功收起
        const btn = document.getElementById('openReader');
        if (btn) {
          btn.textContent = '已进入阅读模式，可关闭此面板';
          btn.disabled = true;
        }
      } catch (e) { /* 面板已不在 */ }
    }, 300);
  }

  function sendToggle() {
    if (!currentTab || currentTab.id == null) return;
    const fallbackInject = () => {
      try {
        chrome.runtime.sendMessage({ type: 'NR_TOGGLE_ACTIVE_TAB' }, () => { void chrome.runtime.lastError; });
      } catch (e) { /* 后台不可达 */ }
    };
    try {
      chrome.tabs.sendMessage(currentTab.id, { type: 'NR_TOGGLE' }, () => {
        const err = chrome.runtime.lastError;
        if (!err) return; // 已送达，无需等响应（收起不等回程）
        // 仅"无接收者"（内容脚本未注入）才走后台兜底；响应通道中途断开
        // 不代表未送达，不得重复触发，否则开出的阅读器会被再次 toggle 关掉
        if (/Receiving end does not exist/i.test(String(err.message || ''))) fallbackInject();
      });
    } catch (e) {
      fallbackInject();
    }
  }

  function bindEvents() {
    $('openReader').addEventListener('click', () => {
      sendToggle();
      closePopup();
    });

    $('floatingButton').addEventListener('change', async (e) => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({
        settings: Object.assign({}, settings || {}, { floatingButton: e.target.checked })
      });
    });

    $('globalAdBlock').addEventListener('change', async (e) => {
      const enable = e.target.checked;
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets(
          enable ? { enableRulesetIds: ['ad_domains'] } : { disableRulesetIds: ['ad_domains'] }
        );
      } catch (err) {
        e.target.checked = !enable;
      }
    });

    $('siteEnabled').addEventListener('change', async (e) => {
      const enable = e.target.checked;
      const host = pageInfo && pageInfo.host;
      if (!host) {
        e.target.checked = !enable;
        return;
      }
      const { blacklist } = await chrome.storage.local.get('blacklist');
      let list = Array.isArray(blacklist) ? blacklist.slice() : [];
      if (enable) {
        list = list.filter((h) => h !== host && !host.endsWith('.' + h));
      } else if (!list.includes(host)) {
        list.push(host);
      }
      await chrome.storage.local.set({ blacklist: list });
    });
  }

  init();
})();
