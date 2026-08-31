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

  /** 最近阅读列表：progress 按时间倒序取前 8 条；点击写 pendingOpen 后开新标签，落地自动进阅读模式 */
  async function loadRecent() {
    const listEl = $('recentList');
    let records = [];
    try {
      const { progress } = await chrome.storage.local.get('progress');
      records = Object.values(progress || {})
        .filter((r) => r && r.url)
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
          // resume 意图：落地后恢复到上次读到的章内位置
          await chrome.storage.local.set({ pendingOpen: { url: r.url, ts: Date.now(), intent: 'resume' } });
        } catch (e) {
          /* 标记失败也能打开，只是不自动进阅读模式 */
        }
        chrome.tabs.create({ url: r.url });
        window.close();
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

  function bindEvents() {
    $('openReader').addEventListener('click', async () => {
      if (!currentTab || currentTab.id == null) return;
      try {
        await chrome.tabs.sendMessage(currentTab.id, { type: 'NR_TOGGLE' });
      } catch (e) {
        // 内容脚本未注入时走后台兜底注入
        await chrome.runtime.sendMessage({ type: 'NR_TOGGLE_ACTIVE_TAB' });
      }
      window.close();
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
