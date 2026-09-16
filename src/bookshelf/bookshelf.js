/**
 * bookshelf.js — 独立全页书架
 *
 * 数据：NR.progress.list()（进度记录，ts 倒序）∪ NR.chapterCache.listBooks()（缓存书，ts 倒序）。
 * 两边书键可能漂移（进度侧可能是目录页 indexUrl，缓存侧恒为章目录），
 * 用 NR.dirnameOf 作公共口径归并（见 mergeEntries）。
 *
 * 页面行为：搜索/筛选即时客户端过滤、续读（写 resume 意图后开新标签）、
 * 移除（删全组进度记录 + 可选连删缓存）、主题热切换（storage.onChanged）。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let entries = []; // 合并后的书籍条目：{ recordKeys:[], record|null, cache|null }
  let filter = 'all'; // all | reading | cached
  let query = ''; // 搜索词（书名/章节标题 includes）

  /** 相对时间（与 popup.js 同款） */
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

  /** 缓存体量文案（与 settings-panel.js 的 fmtMB 同款：≥10MB 取整，否则保留一位小数） */
  function fmtMB(bytes) {
    const mb = (bytes || 0) / (1024 * 1024);
    return (mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)) + ' MB';
  }

  /* ---------------- 主题 ---------------- */

  /** 把主题色写到根元素 CSS 变量（CSS 侧默认值即 light，JS 生效前也可读） */
  function applyTheme(themeName) {
    const t = (NR.THEMES || {})[themeName || 'light'] || (NR.THEMES || {}).light;
    if (!t) return;
    const style = document.documentElement.style;
    style.setProperty('--nr-bg', t.bg);
    style.setProperty('--nr-fg', t.fg);
    style.setProperty('--nr-muted', t.muted);
    style.setProperty('--nr-line', t.line);
    style.setProperty('--nr-accent', t.accent);
    style.setProperty('--nr-panel', t.panel);
  }

  /** 设置面板换主题时本页热切换：只读 settings.theme，不走模型订阅 */
  function watchTheme() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes.settings) return;
        applyTheme((changes.settings.newValue || {}).theme || 'light');
      });
    } catch (e) {
      /* storage 不可用时保持默认主题 */
    }
  }

  /* ---------------- 数据加载与合并 ---------------- */

  /**
   * 书键漂移归并：
   *   1. cacheMap 以缓存书键索引；
   *   2. 逐条进度记录求 joinKey——缓存表里有自身 bookKey 就用它；否则尝试
   *      dirnameOf(record.url)（目录口径是两边公共父集）；仍没有则维持原键；
   *   3. 同 joinKey 分组：首条（ts 最新）作展示 record，组内全部 bookKey 存进
   *      recordKeys（移除时删全），命中的缓存记录挂到 entry 并从 cacheMap 消费；
   *   4. 剩余 cacheMap 是「有缓存无进度」的仅缓存 entry；
   *   5. 按 (record.ts || cache.ts) 倒序输出。
   *
   * joinKey 必须先对完整的 cacheMap 一次算完再进分组：若边分组边消费，
   * 同书靠后的漂移记录会因缓存项已被取走而匹配落空，按自身书键另立条目，
   * 一本书拆成两张卡。
   */
  function mergeEntries(records, books) {
    const cacheMap = new Map(books.map((b) => [b.bookKey, b]));
    const joinKeys = records.map((record) => {
      const dirname = NR.dirnameOf(record.url);
      return cacheMap.has(record.bookKey) ? record.bookKey : (cacheMap.has(dirname) ? dirname : record.bookKey);
    });
    const entryMap = new Map();
    records.forEach((record, i) => {
      const joinKey = joinKeys[i];
      let entry = entryMap.get(joinKey);
      if (!entry) {
        entry = { recordKeys: [], record: null, cache: null };
        entryMap.set(joinKey, entry);
      }
      if (!entry.record) entry.record = record; // records 已 ts 倒序，首条即最新
      entry.recordKeys.push(record.bookKey); // 同组全部书键都留存，移除时逐个删
      if (cacheMap.has(joinKey)) {
        entry.cache = cacheMap.get(joinKey);
        cacheMap.delete(joinKey);
      }
    });
    for (const cache of cacheMap.values()) {
      entryMap.set(cache.bookKey, { recordKeys: [], record: null, cache });
    }
    const list = Array.from(entryMap.values());
    list.sort((a, b) => entryTs(b) - entryTs(a));
    return list;
  }

  /** 排序键：进度时间优先，仅缓存书用缓存时间 */
  function entryTs(entry) {
    return (entry.record && entry.record.ts) || entry.cache.ts || 0;
  }

  async function load() {
    const listEl = $('shelfList');
    // 加载中占位
    listEl.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'shelf-loading';
    loading.textContent = '读取中…';
    listEl.appendChild(loading);
    $('shelfError').hidden = true;
    $('shelfEmpty').hidden = true;

    try {
      const settings = await NR.getSettings();
      applyTheme(settings.theme || 'light');
      const [records, books] = await Promise.all([NR.progress.list(), NR.chapterCache.listBooks()]);
      entries = mergeEntries(records || [], books || []);
      render();
    } catch (e) {
      listEl.textContent = ''; // 清掉「读取中…」占位
      $('shelfErrorMsg').textContent = '加载失败：' + ((e && e.message) || '读取数据出错');
      $('shelfError').hidden = false;
    }
  }

  /* ---------------- 过滤与渲染 ---------------- */

  /** 客户端即时过滤：reading = 有进度记录；cached = 已缓存且全本；搜索按书名/章节标题 includes */
  function matchEntry(entry) {
    if (filter === 'reading' && !entry.record) return false;
    if (filter === 'cached' && !(entry.cache && entry.cache.done)) return false;
    if (query) {
      const title = entryTitle(entry);
      const chapter = (entry.record && entry.record.chapterTitle) || '';
      return title.includes(query) || chapter.includes(query);
    }
    return true;
  }

  /** 展示书名：进度侧书名优先，其次缓存标题，兜底「未命名书籍」 */
  function entryTitle(entry) {
    return (entry.record && entry.record.bookTitle) || (entry.cache && entry.cache.title) || '未命名书籍';
  }

  function render() {
    const listEl = $('shelfList');
    listEl.textContent = '';
    const visible = entries.filter(matchEntry);
    // 可见列表为空（真无书，或筛选/搜索无命中）都落到空书架占位
    $('shelfEmpty').hidden = visible.length > 0;
    for (const entry of visible) {
      listEl.appendChild(buildCard(entry));
    }
  }

  function buildCard(entry) {
    const card = document.createElement('div');
    card.className = 'shelf-card';

    const title = document.createElement('div');
    title.className = 'shelf-title';
    title.textContent = entryTitle(entry);
    title.title = entryTitle(entry);

    const readinfo = document.createElement('div');
    readinfo.className = 'shelf-readinfo';
    if (entry.record) {
      const pct = typeof entry.record.chapterRatio === 'number'
        ? ' · ' + Math.round(entry.record.chapterRatio * 100) + '%'
        : '';
      readinfo.textContent = '读到：《' + (entry.record.chapterTitle || entry.record.url || '') + '》' + pct;
    } else {
      readinfo.textContent = '已缓存 · 未记录阅读进度';
    }

    const meta = document.createElement('div');
    meta.className = 'shelf-meta';
    meta.textContent = timeAgo(entryTs(entry));

    card.appendChild(title);
    card.appendChild(readinfo);
    card.appendChild(meta);

    // 缓存徽标：无缓存的书不渲染该节点
    if (entry.cache) {
      const badge = document.createElement('div');
      badge.className = 'shelf-cache';
      badge.textContent = '📥 ' + (entry.cache.count || 0) + ' 章 · 约 ' + fmtMB(entry.cache.size)
        + (entry.cache.done ? ' · 全本' : '');
      card.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'shelf-actions';
    card.appendChild(actions);
    mountDefaultActions(entry, actions);

    return card;
  }

  /** 默认动作区：续读 + 移除（点移除后整块切换为确认区，取消时换回） */
  function mountDefaultActions(entry, actions) {
    actions.textContent = '';
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'shelf-resume';
    resumeBtn.textContent = '续读 ›';
    resumeBtn.addEventListener('click', () => resume(entry));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'shelf-remove';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', () => mountConfirmActions(entry, actions));

    actions.appendChild(resumeBtn);
    actions.appendChild(removeBtn);
  }

  /** 确认区：可选「同时删除已缓存章节」（无缓存的书不渲染勾选项） */
  function mountConfirmActions(entry, actions) {
    actions.textContent = '';
    const confirmEl = document.createElement('div');
    confirmEl.className = 'shelf-confirm';

    let delCacheBox = null;
    if (entry.cache) {
      const label = document.createElement('label');
      label.className = 'shelf-del-label';
      delCacheBox = document.createElement('input');
      delCacheBox.type = 'checkbox';
      delCacheBox.className = 'shelf-del-cache';
      delCacheBox.checked = true; // 默认勾选：连带删缓存
      label.appendChild(delCacheBox);
      label.appendChild(document.createTextNode('同时删除已缓存章节'));
      confirmEl.appendChild(label);
    }

    const okBtn = document.createElement('button');
    okBtn.className = 'shelf-confirm-ok';
    okBtn.textContent = '确认移除';
    okBtn.addEventListener('click', () => {
      removeEntry(entry, delCacheBox ? delCacheBox.checked : false, okBtn);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'shelf-confirm-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => mountDefaultActions(entry, actions));

    confirmEl.appendChild(okBtn);
    confirmEl.appendChild(cancelBtn);
    actions.appendChild(confirmEl);
  }

  /* ---------------- 动作：续读 / 移除 ---------------- */

  let toastTimer = 0;
  /** 列表区顶部短提示，2s 自动消失（不用 alert） */
  function toast(msg) {
    let el = $('shelfToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shelfToast';
      el.className = 'shelf-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  /** 续读：有进度用进度 URL；仅缓存用最新缓存章 URL；写 resume 意图后开新标签 */
  async function resume(entry) {
    let url = null;
    try {
      if (entry.record) {
        url = entry.record.url;
      } else if (entry.cache) {
        const latest = await NR.chapterCache.latest(entry.cache.bookKey);
        url = (latest || {}).url || null;
      }
    } catch (e) {
      url = null;
    }
    if (!url) {
      toast('未找到可续读的位置');
      return;
    }
    try {
      // resume 意图：落地页自动进阅读模式并恢复章内位置
      await NR.intent.declare(url, 'resume');
    } catch (e) {
      /* 标记失败也能打开，只是不自动进阅读模式 */
    }
    chrome.tabs.create({ url });
  }

  /** 移除：删全组进度记录（书键漂移可能一组多键），可选连删缓存，就地剔除重渲染 */
  async function removeEntry(entry, delCache, btn) {
    if (btn) btn.disabled = true;
    try {
      for (const key of entry.recordKeys) {
        await NR.progress.remove(key);
      }
      if (delCache && entry.cache) {
        await NR.chapterCache.deleteBook(entry.cache.bookKey);
      }
    } catch (e) {
      toast('移除失败，请重试');
      if (btn) btn.disabled = false;
      return;
    }
    entries = entries.filter((e) => e !== entry);
    render(); // 其余卡片按当前筛选/搜索状态重绘
  }

  /* ---------------- 初始化 ---------------- */

  function bindChrome() {
    // 搜索即时过滤
    $('shelfSearch').addEventListener('input', (e) => {
      query = e.target.value || '';
      render();
    });
    // 筛选 chips：激活态互斥，切换即重绘
    const chips = document.querySelectorAll('.shelf-chip');
    for (const chip of chips) {
      chip.addEventListener('click', () => {
        filter = chip.dataset.filter || 'all';
        for (const c of chips) c.classList.toggle('active', c === chip);
        render();
      });
    }
    // 加载失败重试：重新走完整加载
    document.querySelector('.shelf-retry').addEventListener('click', () => load());
    watchTheme();
  }

  bindChrome();
  load();
})();
