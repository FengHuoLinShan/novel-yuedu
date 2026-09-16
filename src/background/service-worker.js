/**
 * service-worker.js — MV3 后台
 * 1. 快捷键 / 工具栏触发阅读模式：优先向活动标签页发消息；接收不到时按需注入内容脚本后重试
 * 2. 会话级 DNR 白名单拦截：阅读模式打开时对当前站点生效——只放行本站域名的请求，
 *    其余（广告/统计脚本、iframe、弹窗、跨站跳转 main_frame）一律拦截；关闭时移除
 *
 * 跨浏览器：Chrome 走 service_worker；Firefox（含 Android）由 tools/package.py
 * 注入 background.scripts 事件页字段加载本文件（无需 importScripts 任何依赖）。
 */

// 兜底注入的脚本清单：以 manifest 为唯一来源（避免手抄副本漂移，见 ADR-0003）。
// 过滤掉主世界脚本（world: 'MAIN' 的 kbd-guard 由 toggleReaderInActiveTab 单独注入）。
const CONTENT_SCRIPT_FILES = (chrome.runtime.getManifest().content_scripts || [])
  .filter((cs) => cs.world !== 'MAIN')
  .flatMap((cs) => cs.js || []);

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
  if (msg && typeof msg.type === 'string' && msg.type.indexOf('NR_CACHE_') === 0) {
    // 整本章节持久缓存（IndexedDB）：统一 Promise 封装的异步 sendResponse，
    // 响应统一为 {ok, data} / {ok:false, error}，调用方见 src/content/chapter-cache.js
    handleCacheMessage(msg)
      .then((data) => {
        try { sendResponse({ ok: true, data }); } catch (e) { /* 响应通道已关闭 */ }
      })
      .catch((e) => {
        try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* 同上 */ }
      });
    return true; // 异步 sendResponse
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
/**
 * 白名单放行域：本站 host + 去 www. 裸域 + （适当时）去首段父域。
 * DNR 域名匹配自带子域向下展开，放行父域即放行全部兄弟子域——m./wap.
 * 前缀站点的 img./static./cdn. 兄弟子域资源极常见，只放行 host 本身会误伤。
 * 安全性不受损：随机子域广告挂在广告联盟自己的域名下，不在本站父域之内。
 *
 * 两种情形不放行父域（无 PSL 的保守启发式）：
 *  - IP 字面量（尾段全数字 = IPv4，含冒号 = IPv6）：按段切分会得出伪域名；
 *  - 父域疑似公共后缀（host 恰好 3 段且末两段均 ≤3 字符，如 abc.com.cn
 *    去掉首段得 com.cn，放行它等于放行整个二级公共后缀，白名单失效）。
 *    ≥4 段时（m.example.com.cn → example.com.cn）父域仍带站点名，放行安全。
 */
function allowDomains(host) {
  const labels = host.split('.');
  const isIp = labels.length > 1 && /^\d+$/.test(labels[labels.length - 1]);
  let parent = null;
  if (!isIp && host.indexOf(':') < 0 && labels.length >= 3) {
    const tail = labels.slice(-2);
    const looksLikePublicSuffix = labels.length === 3 && tail.every((l) => l.length <= 3);
    if (!looksLikePublicSuffix) parent = labels.slice(1).join('.');
  }
  return [...new Set([host, host.replace(/^www\./, ''), parent].filter(Boolean))];
}

async function rebuildSessionRules() {
  const dnr = chrome.declarativeNetRequest;
  const existing = await dnr.getSessionRules();
  // 先删后建必须在同一次 updateSessionRules 里完成：分开会有拦截空窗，
  // 且重复 add 已存在的规则 ID 会报 Duplicate rule ID（整批被拒）
  const removeRuleIds = existing.filter((r) => r.id >= SESSION_RULE_BASE_ID).map((r) => r.id);
  const types = blockableTypes();
  if (!types.length) {
    // 极端环境（ResourceType 枚举不可用）：空 resourceTypes 会让规则被拒、
    // 白名单静默失效，比不拦更糟——宁可只清残留规则、整体跳过本层防护
    if (removeRuleIds.length) await dnr.updateSessionRules({ removeRuleIds });
    return;
  }
  const addRules = [...new Set(readingTabs.values())].map((host, hi) => ({
    id: SESSION_RULE_BASE_ID + hi,
    priority: 1,
    action: { type: 'block' },
    condition: {
      // 白名单式：拦"本站发起、目标域名不在放行集"的全部请求。盗版站的弹窗/跳转
      // 广告脚本普遍用随机子域+高位端口动态下发，黑名单永远追不全，白名单一次覆盖。
      // 放行集见 allowDomains；跨父域镜像站的章节链接会被拦，属可接受代价
      // （关闭“阅读时只放行本站请求”设置即可恢复）
      initiatorDomains: [host],
      excludedRequestDomains: allowDomains(host),
      resourceTypes: types
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

// ---------------- 整本章节持久缓存（IndexedDB） ----------------
// 内容脚本不直接持有 IDB 连接：统一经 NR_CACHE_* 消息路由到这里读写，连接随 SW 生命周期惰性管理。
// DB novel-reader（声明 v1；若被外部工具以同版本号抢先建成空库，会自动升一版补建 store）：
//   chapters（keyPath 'url'，索引 'byKey' → bookKey）——章节记录，url 为去 hash 的归一化 URL
//   books（keyPath 'bookKey'）——书记录：count/size 只累计真正新增的章节（按 url 幂等），
//     nextUrl = 已缓存链尾章的下一章 URL（断点续抓起点），done = true 表示全书已到尾（链尾 nextUrl 为空）

const CACHE_DB_NAME = 'novel-reader';
const CACHE_DB_VERSION = 1;
let cacheDbPromise = null;

const CACHE_STORES_OK = (db) => db.objectStoreNames.contains('chapters') && db.objectStoreNames.contains('books');

/**
 * 惰性打开数据库并确保 object store 就绪。
 * 若库曾被外部工具以同版本号抢先创建（没有任何 store），第二次尝试升一个版本号
 * 触发 upgradeneeded 补建——否则 equal-version 的 open 永远不跑升级，缓存层会静默失效。
 */
async function openCacheDbOnce(version) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chapters')) {
        const store = db.createObjectStore('chapters', { keyPath: 'url' });
        store.createIndex('byKey', 'bookKey', { unique: false });
      }
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'bookKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
}

function openCacheDb() {
  if (!cacheDbPromise) {
    cacheDbPromise = (async () => {
      let db = await openCacheDbOnce(CACHE_DB_VERSION);
      if (CACHE_STORES_OK(db)) return db;
      db.close();
      db = await openCacheDbOnce(CACHE_DB_VERSION + 1);
      if (!CACHE_STORES_OK(db)) throw new Error('IndexedDB store 初始化失败');
      return db;
    })();
    cacheDbPromise.catch(() => {
      cacheDbPromise = null; // 失败允许下次重试
    });
  }
  return cacheDbPromise;
}

/** IDBRequest → Promise */
function idbDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
  });
}

/** 事务完成 → Promise */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
}

/** 缓存键归一化：去 hash（origin + pathname + search），与 extractor 的 stripHash 口径一致 */
function normCacheUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search;
  } catch (e) {
    return '';
  }
}

async function handleCacheMessage(msg) {
  switch (msg.type) {
    case 'NR_CACHE_PUT': return cachePut(msg);
    case 'NR_CACHE_GET': return cacheGet(msg);
    case 'NR_CACHE_HAS': return cacheHas(msg);
    case 'NR_CACHE_BOOK': return cacheBook(msg);
    case 'NR_CACHE_LATEST': return cacheLatest(msg);
    case 'NR_CACHE_LIST': return cacheList();
    case 'NR_CACHE_DELETE': return cacheDelete(msg);
    default: throw new Error('未知缓存消息: ' + msg.type);
  }
}

/**
 * 批量落库章节并 upsert 书记录（单事务，原子）。
 * count/size 只累计本批中 DB 里尚不存在的 URL（重复 put 不重复计数）；
 * nextUrl/done 以调用方显式传入的 chainNextUrl/done 为准（链尾章的下一章与到尾标记）。
 */
async function cachePut(msg) {
  const book = msg.book || {};
  const bookKey = book.bookKey || '';
  const chapters = Array.isArray(msg.chapters) ? msg.chapters : [];
  if (!bookKey) throw new Error('NR_CACHE_PUT 缺少 bookKey');
  const db = await openCacheDb();
  const tx = db.transaction(['chapters', 'books'], 'readwrite');
  const chStore = tx.objectStore('chapters');
  const bookStore = tx.objectStore('books');
  let added = 0;
  let addedBytes = 0;
  for (const raw of chapters) {
    if (!raw || !raw.url || !Array.isArray(raw.paragraphs) || !raw.paragraphs.length) continue;
    const rec = {
      url: normCacheUrl(raw.url),
      bookKey,
      title: raw.title || '',
      bookTitle: raw.bookTitle || '',
      paragraphs: raw.paragraphs,
      nextUrl: raw.nextUrl ? normCacheUrl(raw.nextUrl) : null,
      prevUrl: raw.prevUrl ? normCacheUrl(raw.prevUrl) : null,
      indexUrl: raw.indexUrl ? normCacheUrl(raw.indexUrl) : null,
      ts: Date.now()
    };
    if (!rec.url) continue;
    // 事务内只 await IDB 请求的 Promise（微任务续接不会令事务失活），串行 get→put 保证幂等
    const existing = await idbDone(chStore.get(rec.url));
    if (!existing) {
      added++;
      addedBytes += JSON.stringify(rec).length; // 字节估算：序列化长度
    }
    await idbDone(chStore.put(rec));
  }
  const prev = (await idbDone(bookStore.get(bookKey))) || {};
  const next = {
    bookKey,
    title: book.title || prev.title || '',
    count: (prev.count || 0) + added,
    size: (prev.size || 0) + addedBytes,
    nextUrl: msg.chainNextUrl !== undefined ? (msg.chainNextUrl ? normCacheUrl(msg.chainNextUrl) : null) : (prev.nextUrl || null),
    done: msg.done !== undefined ? !!msg.done : !!prev.done,
    ts: Date.now()
  };
  await idbDone(bookStore.put(next));
  await txDone(tx);
  return { count: next.count, added };
}

/** 查单章记录：命中返回记录，未命中返回 null */
async function cacheGet(msg) {
  const url = normCacheUrl(msg.url);
  if (!url) return null;
  const db = await openCacheDb();
  const tx = db.transaction(['chapters'], 'readonly');
  const rec = await idbDone(tx.objectStore('chapters').get(url));
  return rec || null;
}

/** 批量存在性查询：{url: boolean}（键与入参一致，均为归一化 URL） */
async function cacheHas(msg) {
  const urls = (Array.isArray(msg.urls) ? msg.urls : []).map(normCacheUrl).filter(Boolean);
  const out = {};
  if (!urls.length) return out;
  const db = await openCacheDb();
  const tx = db.transaction(['chapters'], 'readonly');
  const store = tx.objectStore('chapters');
  // 同步发出全部 get 再统一 await：避免逐条 await 的事务活性顾虑
  const pending = urls.map((u) => ({ u, req: idbDone(store.get(u)) }));
  for (const { u, req } of pending) {
    const rec = await req;
    out[u] = !!rec;
  }
  return out;
}

/** 查书记录：命中返回记录，未命中返回 null */
async function cacheBook(msg) {
  if (!msg.bookKey) return null;
  const db = await openCacheDb();
  const tx = db.transaction(['books'], 'readonly');
  const rec = await idbDone(tx.objectStore('books').get(msg.bookKey));
  return rec || null;
}

/**
 * 查某本书缓存章节中 ts 最新的一条（书架续读落点：有缓存但进度记录缺失的书，
 * 以末次落章的归一化 URL 作为续读入口）；无缓存返回 null。
 */
async function cacheLatest(msg) {
  if (!msg.bookKey) throw new Error('NR_CACHE_LATEST 缺少 bookKey');
  const db = await openCacheDb();
  const tx = db.transaction(['chapters'], 'readonly');
  const all = (await idbDone(tx.objectStore('chapters').index('byKey').getAll(msg.bookKey))) || [];
  let best = null;
  for (const rec of all) {
    if (rec && (!best || (rec.ts || 0) > (best.ts || 0))) best = rec;
  }
  return best ? { url: best.url, title: best.title } : null;
}

/** 全部书记录，按 ts 倒序（最近缓存的在前） */
async function cacheList() {
  const db = await openCacheDb();
  const tx = db.transaction(['books'], 'readonly');
  const all = (await idbDone(tx.objectStore('books').getAll())) || [];
  return all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/** 删除整本书或全部缓存：章节用 byKey 索引游标逐条删，再删书记录 */
async function cacheDelete(msg) {
  const db = await openCacheDb();
  const tx = db.transaction(['chapters', 'books'], 'readwrite');
  const chStore = tx.objectStore('chapters');
  const bookStore = tx.objectStore('books');
  if (msg.all) {
    await idbDone(chStore.clear());
    await idbDone(bookStore.clear());
  } else if (msg.bookKey) {
    const idx = chStore.index('byKey');
    // continue() 不返回请求对象（推进结果在 openCursor 原请求上以 success 事件
    // 送达），不能拿 idbDone 包它——否则对 undefined 挂 onsuccess 抛 TypeError，
    // 实测只删掉第一条章节就中止，书记录也删不到。持有原请求逐次改写回调推进；
    // 每条 delete 等成功后再 continue，事务活性才不断。
    const req = idx.openCursor(IDBKeyRange.only(msg.bookKey));
    let cursor = await idbDone(req);
    while (cursor) {
      await idbDone(cursor.delete());
      cursor = await new Promise((resolve, reject) => {
        req.onsuccess = (e) => resolve(e.target.result || null);
        req.onerror = () => reject(req.error || new Error('游标推进失败'));
        cursor.continue();
      });
    }
    await idbDone(bookStore.delete(msg.bookKey));
  } else {
    throw new Error('NR_CACHE_DELETE 需要 bookKey 或 all:true');
  }
  await txDone(tx);
  return { ok: true };
}
