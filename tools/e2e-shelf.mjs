#!/usr/bin/env node
/**
 * 书架全页 e2e（chrome-extension://…/src/bookshelf/bookshelf.html）
 *
 * 覆盖点（单 Chrome 会话内按序执行，注意状态衔接：先空态后灌数据）：
 *  一、popup 入口：popup.html 的 #openShelf 点击 → chrome.tabs.create 打开书架全页
 *      （页内打桩记参不真开，断言 url 为 chrome-extension://<id>/src/bookshelf/bookshelf.html）
 *  二、空态：无进度无缓存 → #shelfEmpty 可见、0 张卡片；搜索框/筛选 chips 就位
 *  三、读+缓存一本 → 书架合并展示：阅读自写 p: 键（书键=目录页 catalog.html）与播种
 *      p: 键（书键=目录 /pagesite/）构成书键漂移，必须归并为 1 张 .shelf-card；
 *      书名「镜华录」、readinfo 含「读到」、缓存徽标含「章」
 *  四、续读：点 .shelf-resume → NR.intent.declare 落 po: 键（去 hash 口径）+ tabs.create
 *      指向播种进度章 /pagesite/5.html
 *  五、仅缓存书：swEval 向 IDB 注入「浮灯记」（done=true 全本 + 3 章，max-ts 章 c.html）→
 *      卡片 readinfo 为「已缓存 · 未记录阅读进度」、徽标含「全本」、续读落 max-ts 章
 *  六、移除：镜华录默认勾选删缓存 → 全部 p: 键清空（含播种键与阅读自写键）且 IDB
 *      books/chapters 无 /pagesite/ 残留、列表只剩浮灯记；浮灯记取消勾选 → 只清进度
 *      （本无进度，卡片消失即可），书记录与章节保留在 IDB
 *
 * 运行：python3 tools/gen_fixtures.py（先生成 fixtures）
 *       python3 -m http.server -d test/fixtures 8080（外部起服，本脚本只预检不自起）
 *       node tools/e2e-shelf.mjs "$PWD"
 */
import { rmSync } from 'node:fs';
import { BASE, sleep, check, fail, summary, CDP, launchChrome, evalJs, until, swEval } from './harness.mjs';

const PORT = 9554;
const PROFILE = '/tmp/nr-shelf-profile';
const SHELF_PATH = '/src/bookshelf/bookshelf.html';
const PAGESITE_KEY = BASE + '/pagesite/'; // 与 NR.dirnameOf 推导的 bookKey 一致
const STUB_KEY = BASE + '/shelfstub/';
const LOADING_GONE = "!document.body.textContent.includes('读取中…')";

// ---- 前置检查：fixture 服务器由外部启动（只读共享），无监听时给明确报错 ----
try {
  const probe = await fetch(BASE + '/pagesite/catalog.html');
  if (!probe.ok) throw new Error('HTTP ' + probe.status);
} catch (e) {
  console.error('✗ fixture 服务器不可达（' + BASE + '）：请先执行 python3 -m http.server -d test/fixtures 8080');
  process.exit(2);
}

async function openTab(url) {
  const res = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  cdp.targetId = res.id;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.waitEvent('Page.loadEventFired', 15000).catch(() => {});
  await sleep(1500); // document_idle + boot
  return cdp;
}

async function closeTab(cdp) {
  // /json/close 在当前 Chrome for Testing 已失效（静默不动），页面级会话又无权
  // Target.closeTarget：必须连浏览器级 WS 关 tab，否则阅读页整本缓存链继续存活，
  // 会把书架刚删掉的书记录重新写回
  try {
    const ver = await fetch('http://127.0.0.1:' + PORT + '/json/version').then((r) => r.json());
    const bcdp = await CDP.connect(ver.webSocketDebuggerUrl);
    await bcdp.send('Target.closeTarget', { targetId: cdp.targetId });
    bcdp.ws.close();
  } catch (e) {
    try { await fetch('http://127.0.0.1:' + PORT + '/json/close/' + cdp.targetId, { method: 'PUT' }); } catch (e2) { /* 忽略 */ }
  }
  try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
  await sleep(300); // 等页面卸载与 pagehide 兜底 flush 落地
}

/** 在 SW 上下文直读 IndexedDB（与 service-worker.js 同库；不带版本号打开，绝不抢先建空库） */
function idbAllExpr(store) {
  return (
    '(async () => {' +
    'let names = null;' +
    "try { names = (await indexedDB.databases()).map((d) => d.name); } catch (e) { /* 老内核无 databases()：退回直接打开 */ }" +
    "if (names && names.indexOf('novel-reader') < 0) return null;" + // 库未创建（SW 尚未首写）：返回 null，不抢先建空库
    'const db = await new Promise((res, rej) => { const r = indexedDB.open("novel-reader"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });' +
    "if (!db.objectStoreNames.contains('" + store + "')) return null;" +
    'return await new Promise((res, rej) => {' +
    "  const tx = db.transaction(['" + store + "'], 'readonly');" +
    "  const rq = tx.objectStore('" + store + "').getAll();" +
    '  rq.onsuccess = () => res(rq.result);' +
    '  rq.onerror = () => rej(rq.error);' +
    '});' +
    '})()'
  );
}

async function readStore(store) {
  for (let i = 0; i < 10; i++) {
    const v = await swEval(PORT, idbAllExpr(store)).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return [];
}

// ---------------- 页内求值片段（书架卡 / 确认框 / storage） ----------------
/** 读一张卡的信息：title 传 null 取第一张。返回 {title, readinfo, cache, hasResume, hasRemove} 或 null */
function cardInfoExpr(title) {
  const cond = title == null
    ? 'true'
    : `String((c.querySelector('.shelf-title')||{}).textContent||'').trim() === ${JSON.stringify(title)}`;
  return `(() => {
    const card = Array.from(document.querySelectorAll('.shelf-card')).find((c) => ${cond});
    if (!card) return null;
    const q = (s) => card.querySelector(s);
    const cache = q('.shelf-cache');
    return { title: String((q('.shelf-title')||{}).textContent||'').trim(),
      readinfo: String((q('.shelf-readinfo')||{}).textContent||''),
      cache: cache ? String(cache.textContent) : null,
      hasResume: !!q('button.shelf-resume'), hasRemove: !!q('button.shelf-remove') };
  })()`;
}

/** 点击指定书名卡上的按钮（tabs.create 桩由调用方先注入，记参不真开） */
function cardClickExpr(title, sel) {
  return `(() => {
    const card = Array.from(document.querySelectorAll('.shelf-card')).find((c) => String((c.querySelector('.shelf-title')||{}).textContent||'').trim() === ${JSON.stringify(title)});
    if (!card) return false;
    const btn = card.querySelector(${JSON.stringify(sel)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`;
}

/** chrome.tabs.create 桩：保存原调用不真开；window.close 一并桩掉（CDP 打开的页会被真关） */
const STUB_TABS = `(() => {
  window.__nrCreates = [];
  chrome.tabs.create = (o) => { window.__nrCreates.push(o && o.url); };
  window.close = () => {};
  return true;
})()`;

/** 可见的移除确认框（实现可能是单例浮层或卡内嵌，按可见优先取） */
function visibleConfirmExpr(inner) {
  return `(() => {
    const list = Array.from(document.querySelectorAll('.shelf-confirm'));
    const box = list.find((n) => n.getClientRects().length > 0) || null;
    ${inner}
  })()`;
}
const CONFIRM_VISIBLE = `(() => {
  const list = Array.from(document.querySelectorAll('.shelf-confirm'));
  return list.some((n) => n.getClientRects().length > 0);
})()`;
const CONFIRM_INFO = visibleConfirmExpr(
  `if (!box) return null;
    const cb = box.querySelector('input.shelf-del-cache');
    return { checkbox: !!cb, checked: cb ? !!cb.checked : null, ok: !!box.querySelector('.shelf-confirm-ok'), cancel: !!box.querySelector('.shelf-confirm-cancel') };`
);
const CONFIRM_UNCHECK = visibleConfirmExpr(
  `if (!box) return false;
    const cb = box.querySelector('input.shelf-del-cache');
    if (!cb || !cb.checked) return false;
    cb.click(); // 切换为不勾选：只清进度、保留整本缓存
    return !cb.checked;`
);
const CONFIRM_OK = visibleConfirmExpr(
  `if (!box) return false;
    const ok = box.querySelector('.shelf-confirm-ok');
    if (!ok) return false;
    ok.click();
    return true;`
);

/** storage.local 里指定前缀的键列表 */
const storageKeysExpr = (prefix) => `(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.indexOf(${JSON.stringify(prefix)}) === 0);
})()`;

/** reload 书架页并等「读取中…」消失（列表容器就绪），之后才能断言 */
async function reloadShelf(cdp) {
  await evalJs(cdp, 'location.reload(); true');
  await sleep(400); // 等导航提交，避免 until 命中旧文档
  await until(cdp, `!!document.getElementById('shelfList')`, 10000);
  await until(cdp, LOADING_GONE, 10000);
}

// ---------------- 启动浏览器（独立实例 + 全新 profile） ----------------
const proc = launchChrome({ port: PORT, profile: PROFILE, windowSize: '1000,900' });
const watchdog = setTimeout(() => { console.error('⏱ 超时退出'); try { proc.kill('SIGKILL'); } catch (e) { /* 已退出 */ } process.exit(2); }, 300000);

let extId = null;

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }

  // ============ 一、popup 入口 ============
  console.log('\n[一] popup 书架入口 → tabs.create 打开书架全页');
  const page1 = await openTab(`${BASE}/longsite/1.html`);
  let ctx1 = page1.isolatedContextId();
  for (let i = 0; i < 10 && ctx1 == null; i++) { await sleep(500); ctx1 = page1.isolatedContextId(); }
  check('内容脚本隔离世界可用', ctx1 != null);
  extId = await evalJs(page1, 'chrome.runtime.id', ctx1); // unpacked ID 由绝对路径派生，跨实例稳定
  check('取得扩展 ID', !!extId, String(extId));
  await closeTab(page1);

  const popup = await openTab(`chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1200); // popup init
  const jsP = (e) => evalJs(popup, e);
  check('popup #openShelf 入口按钮存在', await jsP(`!!document.getElementById('openShelf')`));
  await jsP(STUB_TABS);
  await jsP(`document.getElementById('openShelf').click(); true`);
  await until(popup, `window.__nrCreates.length >= 1`, 4000);
  const openedUrl = await jsP(`String(window.__nrCreates[0] || '')`);
  check('点击书架入口 → tabs.create 打开 bookshelf.html', openedUrl === `chrome-extension://${extId}${SHELF_PATH}`, openedUrl);
  await closeTab(popup);

  // ============ 二、空态（此刻 profile 尚无任何进度/缓存写入） ============
  console.log('\n[二] 空态：#shelfEmpty 可见、0 张卡片');
  const shelf = await openTab(`chrome-extension://${extId}${SHELF_PATH}`);
  const js = (e) => evalJs(shelf, e);
  await until(shelf, `!!document.getElementById('shelfList')`, 10000);
  await until(shelf, LOADING_GONE, 10000);
  check('#shelfEmpty 空态可见',
    await js(`(() => { const el = document.getElementById('shelfEmpty'); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; })()`));
  check('空态 0 张 .shelf-card', (await js(`document.querySelectorAll('.shelf-card').length`)) === 0);
  check('搜索框与 全部/在读/已缓存 筛选 chips 就位',
    await js(`!!document.getElementById('shelfSearch') && ['all','reading','cached'].every((f) => !!document.querySelector('.shelf-chip[data-filter="' + f + '"]'))`));

  // ============ 三、读+缓存一本 → 书键漂移归并展示 ============
  console.log('\n[三] 读+缓存 pagesite → 播种更新进度 → 归并为 1 张卡');
  const ps = await openTab(`${BASE}/pagesite/1.html`);
  let ctxPs = ps.isolatedContextId();
  for (let i = 0; i < 10 && ctxPs == null; i++) { await sleep(500); ctxPs = ps.isolatedContextId(); }
  check('pagesite 隔离世界可用', ctxPs != null);
  await evalJs(ps, `NR.reader.open()`, ctxPs);
  await evalJs(ps, `NR.reader._saveProgressNow(), true`, ctxPs); // 立即落一条阅读自写进度（不等滚动节流）

  let bookRec = null;
  const dlCache = Date.now() + 60000;
  for (;;) {
    const books = await readStore('books');
    bookRec = (books || []).find((b) => String(b.bookKey || '').endsWith('/pagesite/')) || null;
    if (bookRec && bookRec.count >= 2) break;
    if (Date.now() > dlCache) throw new Error('等待后台整本缓存起步超时：' + JSON.stringify(bookRec));
    await sleep(700);
  }
  check('后台整本缓存起步（books 出现 /pagesite/ 且 count≥2）', !!bookRec && bookRec.count >= 2, JSON.stringify(bookRec));

  let ownWritten = false;
  const dlOwn = Date.now() + 8000;
  for (;;) {
    const recs = await js(`(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.keys(all).filter((k) => k.indexOf('p:') === 0 && all[k] && String(all[k].url || '').indexOf('/pagesite/1.html') >= 0);
    })()`);
    if (recs && recs.length) { ownWritten = true; break; }
    if (Date.now() > dlOwn) break;
    await sleep(400);
  }
  check('阅读自写进度键已落库（p: 前缀）', ownWritten);
  await closeTab(ps);

  // 播种一条更新的进度。播种书键 = /pagesite/（与缓存一致），阅读自写书键 = /pagesite/catalog.html
  // （章节页识别出的目录链接）：两把键的 record.url 同目录 → 书架必须归并成一张卡
  await js(`(async () => {
    await chrome.storage.local.set({ 'p:${PAGESITE_KEY}': {
      url: '${BASE}/pagesite/5.html', chapterRatio: 0.4,
      chapterTitle: '第5章 双镜奇缘', bookTitle: '镜华录', ts: Date.now() } });
    return true;
  })()`);
  const pKeys = await js(storageKeysExpr('p:'));
  check('书键漂移前提：两把 p: 键并存', Array.isArray(pKeys) && pKeys.length === 2, JSON.stringify(pKeys));

  await reloadShelf(shelf);
  await until(shelf, `document.querySelectorAll('.shelf-card').length === 1`, 10000);
  check('归并后恰好 1 张 .shelf-card（阅读键+播种键合并）', (await js(`document.querySelectorAll('.shelf-card').length`)) === 1);
  const card = await js(cardInfoExpr(null));
  check('.shelf-title 为「镜华录」', !!card && card.title === '镜华录', card && card.title);
  check('.shelf-readinfo 含「读到」', !!card && card.readinfo.indexOf('读到') >= 0, card && card.readinfo);
  check('.shelf-cache 徽标存在且含「章」', !!card && !!card.cache && card.cache.indexOf('章') >= 0, card && card.cache);

  // ============ 四、续读 ============
  console.log('\n[四] 续读：po: 意图键 + tabs.create 指向播种进度章');
  await js(STUB_TABS);
  await js(`document.querySelector('.shelf-card button.shelf-resume').click(); true`);
  await until(shelf, `window.__nrCreates.length >= 1`, 4000);
  const resumeUrl = await js(`String(window.__nrCreates[0] || '')`);
  check('续读 tabs.create 指向播种进度章 5.html', resumeUrl === `${BASE}/pagesite/5.html`, resumeUrl);
  const poUrls = await js(`(async () => {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const k of Object.keys(all)) {
      if (k.indexOf('po:') === 0 && all[k] && all[k].url) out.push(String(all[k].url).split('#')[0]);
    }
    return out;
  })()`);
  check('storage 出现 po: 意图键且 url 一致（去 hash）', Array.isArray(poUrls) && poUrls.some((u) => u === resumeUrl), JSON.stringify(poUrls));

  // ============ 五、仅缓存书 ============
  console.log('\n[五] 仅缓存书「浮灯记」：已缓存卡 + 续读落 max-ts 章');
  // books: {bookKey,title,count,size,nextUrl,done,ts}；chapters 三条不同 ts，max-ts 章 = c.html
  const injectExpr =
    '(async () => {' +
    'const db = await new Promise((res, rej) => { const r = indexedDB.open("novel-reader"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });' +
    'const now = Date.now();' +
    'await new Promise((res, rej) => {' +
    "  const tx = db.transaction(['chapters','books'], 'readwrite');" +
    "  tx.objectStore('books').put({ bookKey: '" + STUB_KEY + "', title: '浮灯记', count: 3, size: 90000, nextUrl: null, done: true, ts: now - 5000 });" +
    "  const ch = tx.objectStore('chapters');" +
    "  ch.put({ url: '" + STUB_KEY + "a.html', bookKey: '" + STUB_KEY + "', title: '第1章', bookTitle: '浮灯记', paragraphs: ['x'], ts: now - 3000 });" +
    "  ch.put({ url: '" + STUB_KEY + "b.html', bookKey: '" + STUB_KEY + "', title: '第2章', bookTitle: '浮灯记', paragraphs: ['x'], ts: now - 1000 });" +
    "  ch.put({ url: '" + STUB_KEY + "c.html', bookKey: '" + STUB_KEY + "', title: '第3章', bookTitle: '浮灯记', paragraphs: ['x'], ts: now });" +
    '  tx.oncomplete = () => res(true);' +
    '  tx.onerror = () => rej(tx.error);' +
    '});' +
    'return true;' +
    '})()';
  let injectOk = false;
  for (let i = 0; i < 8 && !injectOk; i++) {
    injectOk = (await swEval(PORT, injectExpr).catch(() => false)) === true;
    if (!injectOk) await sleep(500);
  }
  check('浮灯记书记录与 3 章注入完成', injectOk);
  await reloadShelf(shelf);
  await until(shelf, `document.querySelectorAll('.shelf-card').length === 2`, 10000);
  const fd = await js(cardInfoExpr('浮灯记'));
  check('浮灯记卡片出现（共 2 张）', !!fd && (await js(`document.querySelectorAll('.shelf-card').length`)) === 2, JSON.stringify(fd));
  check('仅缓存书 readinfo 为「已缓存 · 未记录阅读进度」',
    !!fd && fd.readinfo.replace(/\s+/g, ' ').trim() === '已缓存 · 未记录阅读进度', fd && fd.readinfo);
  check('整本缓存徽标含「全本」', !!fd && !!fd.cache && fd.cache.indexOf('全本') >= 0, fd && fd.cache);

  await js(STUB_TABS); // reload 后桩已失效，重新打桩
  await js(cardClickExpr('浮灯记', 'button.shelf-resume'));
  await until(shelf, `window.__nrCreates.length >= 1`, 4000);
  const fdUrl = await js(`String(window.__nrCreates[0] || '')`);
  check('仅缓存书续读指向 max-ts 章 c.html', fdUrl === `${STUB_KEY}c.html`, fdUrl);

  // ============ 六、移除（含删缓存与多进度键清理） ============
  console.log('\n[六] 移除：镜华录全清 → 浮灯记取消勾选只清进度');
  await js(cardClickExpr('镜华录', 'button.shelf-remove'));
  await until(shelf, CONFIRM_VISIBLE, 4000);
  const cf1 = await js(CONFIRM_INFO);
  check('确认框出现且 checkbox 默认勾选', !!cf1 && cf1.checkbox && cf1.checked === true, JSON.stringify(cf1));
  check('确认框 OK/Cancel 按钮就位', !!cf1 && cf1.ok && cf1.cancel, JSON.stringify(cf1));
  await js(CONFIRM_OK);
  // 移除是异步链（storage 多键清理 + SW 删 IDB），轮询到 p: 键清空为止
  await until(shelf, `(async () => { const all = await chrome.storage.local.get(null); return Object.keys(all).filter((k) => k.indexOf('p:') === 0).length === 0; })()`, 10000);
  const pLeft = await js(storageKeysExpr('p:'));
  check('p: 前缀进度键全部消失（含播种键与阅读自写键）', Array.isArray(pLeft) && pLeft.length === 0, JSON.stringify(pLeft));

  let booksLeft = [];
  const dlBooks = Date.now() + 10000;
  for (;;) {
    booksLeft = await readStore('books');
    if (!(booksLeft || []).some((b) => String(b.bookKey || '').endsWith('/pagesite/'))) break;
    if (Date.now() > dlBooks) break;
    await sleep(500);
  }
  check('books 无 /pagesite/ 书记录', !(booksLeft || []).some((b) => String(b.bookKey || '').endsWith('/pagesite/')), JSON.stringify(booksLeft));
  let chLeft = [];
  const dlCh = Date.now() + 10000;
  for (;;) {
    chLeft = await readStore('chapters');
    if (!(chLeft || []).some((c) => String(c.bookKey || '').endsWith('/pagesite/'))) break;
    if (Date.now() > dlCh) break;
    await sleep(500);
  }
  check('chapters 无该书残留', !(chLeft || []).some((c) => String(c.bookKey || '').endsWith('/pagesite/')), '残留 ' + (chLeft || []).length + ' 条');

  await until(shelf, `document.querySelectorAll('.shelf-card').length === 1`, 6000);
  const onlyTitle = await js(`String((document.querySelector('.shelf-card .shelf-title')||{}).textContent||'').trim()`);
  check('列表只剩「浮灯记」', onlyTitle === '浮灯记', onlyTitle);

  // 浮灯记：有缓存 → 勾选项渲染；取消勾选 → 只清进度（本无进度），缓存保留
  await js(cardClickExpr('浮灯记', 'button.shelf-remove'));
  await until(shelf, CONFIRM_VISIBLE, 4000);
  const cf2 = await js(CONFIRM_INFO);
  check('浮灯记确认框含缓存勾选项且默认勾选', !!cf2 && cf2.checkbox && cf2.checked === true, JSON.stringify(cf2));
  check('取消勾选成功', (await js(CONFIRM_UNCHECK)) === true);
  await js(CONFIRM_OK);
  await until(shelf, `document.querySelectorAll('.shelf-card').length === 0`, 6000);
  check('浮灯记卡片消失', (await js(`document.querySelectorAll('.shelf-card').length`)) === 0);
  const stubBook = ((await readStore('books')) || []).find((b) => b.bookKey === STUB_KEY) || null;
  check('取消勾选时书记录仍在 IDB（只清进度）', !!stubBook && stubBook.title === '浮灯记', JSON.stringify(stubBook));
  const stubChs = ((await readStore('chapters')) || []).filter((c) => c.bookKey === STUB_KEY);
  check('浮灯记 3 条章节仍在 IDB', stubChs.length === 3, '实际 ' + stubChs.length);
} catch (e) {
  fail();
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
try { proc.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
await sleep(500);
let cleanErr = null;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { cleanErr = e; }
if (cleanErr) console.log('（临时目录清理失败，可忽略）');
process.exit(summary() ? 1 : 0);
