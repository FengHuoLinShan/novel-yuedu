#!/usr/bin/env node
/**
 * 整本章节持久缓存 e2e（NR_CACHE_* IndexedDB 缓存层 + NR.bookSaver 断点续抓 + 离线供章）
 *
 * 场景（fixture：pagesite/ 8 章每章 2 分页，共 16 页，尾页无下一页 → 链自然终止）：
 *  - 一、打开 1.html → 阅读器 → 后台整本链跑完：books.done 且 count=16，chapters 16 条无重复
 *  - 二、断点续抓：削减尾部 6 章并伪造 books{count:10, nextUrl:6.html, done:false}，
 *        新页打开 3.html → 链从 books.nextUrl 续跑 → 最终 count=16 无重复
 *  - 三、持久缓存供章：monkeypatch NR.loader.fetchDoc 拒绝（断网），内存缓存已清空的新页面上
 *        getChapter 直读持久缓存成功 + 阅读器翻下一章成功
 *  - 四、清理：NR.chapterCache.clearAll() 后 SW 直读 IDB 断言 chapters/books 均空
 *
 * 运行：node tools/e2e-cache.mjs <项目根目录>
 * 前置：8080 fixture 服务器必须已在外部启动（本脚本不自行起服）：
 *       python3 -m http.server -d test/fixtures 8080
 */
import { rmSync } from 'node:fs';
import { BASE, sleep, check, fail, summary, CDP, launchChrome, evalJs, swEval } from './harness.mjs';

const PORT = 9553;
const PROFILE = '/tmp/nr-cache-profile';
const BOOK_URL = `${BASE}/pagesite/`; // 与 NR.dirnameOf 推导的 bookKey 一致
const TOTAL_PAGES = 16;

// ---- 前置检查：fixture 服务器由外部启动，无监听时全灭，这里给明确报错 ----
try {
  const probe = await fetch(`${BASE}/pagesite/catalog.html`);
  if (!probe.ok) throw new Error('HTTP ' + probe.status);
} catch (e) {
  console.error(`✗ fixture 服务器不可达（${BASE}）：请先执行 python3 -m http.server -d test/fixtures 8080`);
  process.exit(2);
}

async function openPage(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  cdp.targetId = res.id;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.waitEvent('Page.loadEventFired', 15000).catch(() => {});
  await sleep(1500); // document_idle + boot
  return cdp;
}

async function closeTab(cdp) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${cdp.targetId}`, { method: 'PUT' });
  } catch (e) {
    try { await cdp.send('Target.closeTarget', { targetId: cdp.targetId }); } catch (e2) { /* 忽略 */ }
  }
  try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
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

async function readBooks() {
  for (let i = 0; i < 10; i++) {
    const v = await swEval(PORT, idbAllExpr('books')).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return [];
}

async function readChapters() {
  for (let i = 0; i < 10; i++) {
    const v = await swEval(PORT, idbAllExpr('chapters')).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return [];
}

function bookOf(books) {
  return (books || []).find((b) => b.bookKey === BOOK_URL) || null;
}

/** 轮询直到书记录 done 且 count 达标，返回该记录 */
async function untilBookDone(timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = bookOf(await readBooks());
    if (last && last.done && last.count >= TOTAL_PAGES) return last;
    if (Date.now() > deadline) throw new Error('等待整本缓存完成超时：' + JSON.stringify(last));
    await sleep(700);
  }
}

// ---------------- 启动浏览器 ----------------
const proc = launchChrome({ port: PORT, profile: PROFILE });
const watchdog = setTimeout(() => { console.error('⏱ 超时退出'); try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, 300000);

const SR = `document.getElementById('novel-reader-host').shadowRoot`;

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }

  // ============ 一、整本后台缓存 ============
  console.log('\n[一] 打开 1.html → 阅读器 → 后台整本链抓完 16 页');
  const cdp1 = await openPage(`${BASE}/pagesite/1.html`);
  const ctx1 = cdp1.isolatedContextId();
  check('内容脚本隔离世界可用', ctx1 != null);
  await evalJs(cdp1, `window.__prog=[];document.addEventListener('novelreader:cacheprog',e=>window.__prog.push(Object.assign({},e.detail)))`, ctx1);
  await evalJs(cdp1, `NR.reader.open()`, ctx1);
  const book1 = await untilBookDone(150000);
  check('书记录 done 且 count=16', !!book1 && book1.done === true && book1.count === TOTAL_PAGES, JSON.stringify(book1));
  check('书记录 nextUrl 为空（链尾即全书尾）', !!book1 && !book1.nextUrl, JSON.stringify(book1));
  check('书记录标题取自章节 bookTitle', !!book1 && book1.title === '镜华录', JSON.stringify(book1 && book1.title));
  const evts1 = await evalJs(cdp1, `({n:window.__prog.length,last:window.__prog[window.__prog.length-1]||null})`, ctx1);
  check('cacheprog 以 {count:16, done:true} 收尾', evts1.last && evts1.last.done === true && evts1.last.count === TOTAL_PAGES, JSON.stringify(evts1));
  const chapters1 = await readChapters();
  const uniq1 = new Set((chapters1 || []).map((c) => c.url)).size;
  check('chapters 落库 16 条且 url 无重复', chapters1.length === TOTAL_PAGES && uniq1 === TOTAL_PAGES, `rows=${chapters1.length} uniq=${uniq1}`);
  const chip1 = await evalJs(cdp1, `${SR}.querySelector('.nr-cache-chip').textContent`, ctx1);
  check('工具栏缓存 chip 显示「已缓存全书」', chip1 === '已缓存全书', chip1);
  await closeTab(cdp1);

  // ============ 二、断点续抓 ============
  console.log('\n[二] 削减尾部 6 章并伪造断点 → 新页 3.html 从 books.nextUrl 续跑');
  // 先开新标签页（页面加载会唤醒 MV3 SW，swEval 才有目标可连），再做库手术
  const cdp2 = await openPage(`${BASE}/pagesite/3.html`);
  const ctx2 = cdp2.isolatedContextId();
  // 删除 6.html..8_2.html 六条章节记录，把书记录改成 {count:10, nextUrl:6.html, done:false}
  // （模拟上次链在此中断），验证 bookSaver 从记录 nextUrl 续抓而不是从当前章重复起步
  const surgery =
    '(async () => {' +
    'const db = await new Promise((res, rej) => { const r = indexedDB.open("novel-reader"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });' +
    'const gone = ["6.html","6_2.html","7.html","7_2.html","8.html","8_2.html"].map((u) => "' + BOOK_URL + '" + u);' +
    'await new Promise((res, rej) => {' +
    "  const tx = db.transaction(['chapters','books'], 'readwrite');" +
    '  const ch = tx.objectStore("chapters");' +
    '  for (const u of gone) ch.delete(u);' +
    "  const bq = tx.objectStore('books').get('" + BOOK_URL + "');" +
    '  bq.onsuccess = () => {' +
    '    const rec = bq.result || { bookKey: "' + BOOK_URL + '", title: "", size: 0 };' +
    '    rec.count = 10; rec.nextUrl = "' + BOOK_URL + '6.html"; rec.done = false; rec.ts = Date.now();' +
    "    tx.objectStore('books').put(rec);" +
    '  };' +
    '  tx.oncomplete = () => res(true);' +
    '  tx.onerror = () => rej(tx.error);' +
    '});' +
    'return true;' +
    '})()';
  let surgOk = false;
  for (let i = 0; i < 8 && !surgOk; i++) {
    surgOk = (await swEval(PORT, surgery).catch(() => false)) === true;
    if (!surgOk) await sleep(500);
  }
  check('断点库手术完成（count=10 / nextUrl=6.html / done=false）', surgOk);
  await evalJs(cdp2, `window.__prog=[];document.addEventListener('novelreader:cacheprog',e=>window.__prog.push(Object.assign({},e.detail)))`, ctx2);
  await evalJs(cdp2, `NR.reader.open()`, ctx2);
  const book2 = await untilBookDone(60000);
  const chapters2 = await readChapters();
  const uniq2 = new Set((chapters2 || []).map((c) => c.url)).size;
  check('断点续抓后 count=16（10+6，无重复入库）', book2.count === TOTAL_PAGES && chapters2.length === TOTAL_PAGES && uniq2 === TOTAL_PAGES, `count=${book2.count} rows=${chapters2.length} uniq=${uniq2}`);
  check('续抓到尾后 done 且 nextUrl 为空', book2.done === true && !book2.nextUrl, JSON.stringify(book2));
  const evts2 = await evalJs(cdp2, `window.__prog[window.__prog.length-1]||null`, ctx2);
  check('续抓 cacheprog 以 {count:16, done:true} 收尾', evts2 && evts2.done === true && evts2.count === TOTAL_PAGES, JSON.stringify(evts2));
  await closeTab(cdp2);

  // ============ 三、持久缓存供章（断网） ============
  console.log('\n[三] fetchDoc 拒绝（断网）：getChapter 直读持久缓存 + 阅读器翻下一章成功');
  const cdp3 = await openPage(`${BASE}/pagesite/3.html`);
  const ctx3 = cdp3.isolatedContextId();
  const r3 = await evalJs(
    cdp3,
    '(async () => {' +
    'const realFetchDoc = NR.loader.fetchDoc;' +
    "NR.loader.fetchDoc = () => Promise.reject(new Error('offline'));" +
    'try {' +
    // 内存缓存此时为空：直接命中持久缓存（任何网络尝试都会被上面的 patch 拒绝）
    "  const direct = await NR.loader.getChapter('" + BASE + "/pagesite/7_2.html');" +
    '  await NR.reader.open();' +
    '  const st = NR.reader.state;' +
    '  const before = st.chapters.length;' +
    '  await NR.reader.goNext();' +
    '  await NR.sleep(400);' +
    '  return {' +
    '    directOk: !!(direct && direct.paragraphs && direct.paragraphs.length > 0),' +
    '    directVia: direct && direct.via,' +
    '    before,' +
    '    after: st.chapters.length,' +
    // autoAppend 可能连拼多章，取第一个新拼接章（before 下标）验证直接下一页
    '    firstAppended: st.chapters[before].meta.title,' +
    '    domChapters: ' + SR + ".querySelectorAll('.nr-chapter').length" +
    '  };' +
    '} finally {' +
    '  NR.loader.fetchDoc = realFetchDoc;' +
    '}' +
    '})()',
    ctx3
  );
  check('断网下 getChapter 由持久缓存供章', r3.directOk && r3.directVia === 'cache', JSON.stringify(r3));
  check('断网下阅读器翻下一章成功（DOM 出现第 2 章）', r3.after >= r3.before + 1 && r3.domChapters >= 2, JSON.stringify(r3));
  check('翻到的章是 3.html 的下一页（标题含 (2/2)）', String(r3.firstAppended).indexOf('(2/2)') > 0, String(r3.firstAppended));

  // ============ 四、清理 ============
  console.log('\n[四] clearAll 后 IDB chapters/books 均空');
  await evalJs(cdp3, `NR.chapterCache.clearAll()`, ctx3);
  await sleep(500); // 等后台删除事务彻底收尾
  const chapters4 = await readChapters();
  const books4 = await readBooks();
  check('chapters 已清空', Array.isArray(chapters4) && chapters4.length === 0, String(chapters4 && chapters4.length));
  check('books 已清空', Array.isArray(books4) && books4.length === 0, String(books4 && books4.length));
  await closeTab(cdp3);
} catch (e) {
  fail();
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
try { proc.kill('SIGKILL'); } catch (e) {}
await sleep(500);
let cleanErr = null;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { cleanErr = e; }
if (cleanErr) console.log('（临时目录清理失败，可忽略）');
process.exit(summary() ? 1 : 0);
