#!/usr/bin/env node
/**
 * 生命周期 / 长时使用稳定性回归（对应《长期使用稳定性问题交接》STAB-001~010）。
 *
 * 覆盖交接文档第 6 节回归矩阵：
 *  - 并发 open() ×10             → 只构建一套阅读器（STAB-003）
 *  - 慢网连点下一章 ×10          → 只拼接一章（STAB-002）
 *  - 第 14 章逐步回到第 1 章     → 无重复 URL、不卡章、往返 50 次（STAB-001/005）
 *  - 章节/目录加载中退出再重开   → 无未处理异常、旧会话不污染新会话（STAB-004）
 *  - 跨章边界往返 50 次          → history.length 不增长，URL 与内容一致（STAB-006）
 *  - 连续阅读 300 章（合成）     → DOM / 完整正文 / loader 缓存均有上限（STAB-005）
 *  - 两标签页各保存 100 次       → 两本书最新进度都存在 + 旧版整包迁移（STAB-007）
 *  - 两标签页同时跳转            → 各自自动打开目标章 + 过期标记清理（STAB-008）
 *  - 两 host 同时阅读            → 关闭一页不清另一页 DNR；关闭设置不产生规则（STAB-009）
 *  - 滑杆连续拖动                → UI 实时、storage 写入收敛、终值持久化（STAB-010）
 *
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-lifecycle.mjs <项目根目录>
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME =
  process.env.NR_TEST_BROWSER ||
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '.');
const PORT = 9341;
const PROFILE = '/tmp/nr-lifecycle-profile';
const BASE = process.env.NR_TEST_BASE || 'http://127.0.0.1:8080';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra && !cond ? '  → ' + extra : ''));
  cond ? passed++ : failed++;
}

// ---------------- CDP 客户端（与 e2e-test.mjs 同构） ----------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else {
        this.events.push(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  isolatedContextId() {
    let found = null;
    for (const e of this.events) {
      if (e.method === 'Runtime.executionContextCreated') {
        const c = e.params.context;
        if (c.name && c.name.indexOf('小说悦读') >= 0) found = c.id;
      }
    }
    return found;
  }
}

async function evalJs(cdp, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId != null) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params);
  if (r.exceptionDetails) throw new Error(expression.slice(0, 80) + ' => ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
}

async function openPage(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  cdp.targetId = res.id;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.waitEventCompat('Page.loadEventFired', 15000).catch(() => {});
  await sleep(1500); // document_idle + boot
  return cdp;
}
// 轻量事件等待（避免整份基类复制）
CDP.prototype.waitEventCompat = async function (method, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const idx = this.events.findIndex((e) => e.method === method);
    if (idx >= 0) return this.events.splice(idx, 1)[0];
    if (Date.now() > deadline) throw new Error('timeout waiting ' + method);
    await sleep(100);
  }
};

/** 在 service worker 上下文求值（用于检查 DNR 会话规则） */
async function swEval(expression) {
  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  const bcdp = await CDP.connect(ver.webSocketDebuggerUrl);
  try {
    await bcdp.send('Target.setDiscoverTargets', { discover: true });
    let swTargetId = null;
    for (let i = 0; i < 50 && !swTargetId; i++) {
      const ev = await bcdp.waitEventCompat('Target.targetCreated', 1000).catch(() => null);
      if (ev && ev.params.targetInfo.type === 'service_worker') swTargetId = ev.params.targetInfo.targetId;
    }
    if (!swTargetId) throw new Error('未找到 service worker 目标');
    const { sessionId } = await bcdp.send('Target.attachToTarget', { targetId: swTargetId, flatten: true });
    const r = await bcdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  } finally {
    try { bcdp.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

/** 轮询会话规则的 (host 集合, 条数)，直到匹配或超时 */
async function untilRules(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = '';
  for (;;) {
    const raw = await swEval(`chrome.declarativeNetRequest.getSessionRules().then(rs => JSON.stringify({hosts:[...new Set(rs.map(r=>r.condition.initiatorDomains[0]))].sort(), n:rs.length, adn:self.AD_DOMAINS.length}))`).catch((e) => null);
    if (raw) {
      last = raw;
      const info = JSON.parse(raw);
      if (predicate(info)) return info;
    }
    if (Date.now() > deadline) throw new Error('等待 DNR 规则超时：' + last);
    await sleep(300);
  }
}

async function closeTab(cdp) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${cdp.targetId}`, { method: 'PUT' });
  } catch (e) {
    try { await cdp.send('Target.closeTarget', { targetId: cdp.targetId }); } catch (e2) { /* 忽略 */ }
  }
  try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
}

// ---------------- 启动浏览器 ----------------
rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: 'ignore' });
const watchdog = setTimeout(() => { console.error('⏱ 超时退出'); try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, 420000);

const SR = `document.getElementById('novel-reader-host').shadowRoot`;

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }

  // ============ 一、并发 open() ×10 → 只构建一套阅读器（STAB-003） ============
  console.log('\n[一] 并发 open() ×10（正文提取延迟 700ms）');
  const cdp1 = await openPage(`${BASE}/longsite/1.html`);
  const ctx1 = cdp1.isolatedContextId();
  check('内容脚本隔离世界可用', ctx1 != null);
  await evalJs(cdp1, `window.__nrRejects=[];window.addEventListener('unhandledrejection',e=>{window.__nrRejects.push(String((e.reason&&e.reason.message)||e.reason))})`, ctx1);
  const r1 = await evalJs(cdp1, `(async () => {
    const orig = NR.extractDoc;
    NR.extractDoc = async function (...a) { await NR.sleep(700); return orig.apply(this, a); };
    const ps = [];
    for (let i = 0; i < 10; i++) ps.push(NR.reader.open());
    const rs = await Promise.all(ps);
    NR.extractDoc = orig;
    return {
      hosts: document.querySelectorAll('#novel-reader-host').length,
      opened: rs.filter(Boolean).length,
      chapters: NR.reader.state.chapters.length,
      openPromiseCleared: NR.reader._openPromise === null
    };
  })()`, ctx1);
  check('10 次并发 open() 全部成功且只有一个 host', r1.hosts === 1 && r1.opened === 10, JSON.stringify(r1));
  check('只有一套 state（单章）', r1.chapters === 1, JSON.stringify(r1));
  check('完成后 _openPromise 已清理', r1.openPromiseCleared);

  // ============ 二、慢网连点下一章 ×10 → 只拼接一章（STAB-002） ============
  console.log('\n[二] 慢网（fetch 延迟 1.2s）连点下一章 ×10');
  const r2 = await evalJs(cdp1, `(async () => {
    const orig = NR.loader.fetchDoc;
    NR.loader.fetchDoc = function (url) { return NR.sleep(1200).then(() => orig.call(this, url)); };
    const ps = [];
    for (let i = 0; i < 10; i++) ps.push(NR.reader.goNext());
    await Promise.all(ps);
    await NR.sleep(200);
    NR.loader.fetchDoc = orig;
    const st = NR.reader.state;
    const urls = st.chapters.map(c => c.data.url);
    return {
      dom: ${SR}.querySelectorAll('.nr-chapter').length,
      len: st.chapters.length,
      uniq: new Set(urls).size === urls.length,
      tail: ${SR}.querySelector('.nr-tail').textContent.trim().slice(0, 12)
    };
  })()`, ctx1);
  check('连点 10 次只拼接一章（DOM=2 且 URL 唯一）', r2.dom === 2 && r2.len === 2 && r2.uniq, JSON.stringify(r2));

  // ============ 三、构建 14 章 → 逐章回第 1 章 → 往返 50 次（STAB-001/005） ============
  console.log('\n[三] 14 章逐步回到第 1 章（无重复记录、不卡章）+ 前后往返 50 次');
  const r3 = await evalJs(cdp1, `(async () => {
    const st = NR.reader.state;
    // 构建 14 章（直接走与自动拼接相同的 _appendByUrl 路径，读位推进到末章）
    while (st.chapters.length < 14) {
      st.currentIndex = st.chapters.length - 1;
      const u = st.chapters[st.chapters.length - 1].data.nextUrl;
      if (!u) break;
      await NR.reader._appendByUrl(u, false);
    }
    const built = st.chapters.length;
    // 逐步回翻到第 1 章
    let stuck = 0, dups = 0, lenChanges = 0;
    const uniq = () => { const us = st.chapters.map(c => c.data.url); return new Set(us).size === us.length; };
    for (let step = 0; step < 30 && st.currentIndex > 0; step++) {
      const before = st.currentIndex;
      const lenBefore = st.chapters.length;
      NR.reader.goPrev();
      await NR.sleep(380);
      if (!uniq()) dups++;
      if (st.chapters.length !== lenBefore) lenChanges++;
      if (st.currentIndex >= before) stuck++;
    }
    const domAtCh1 = ${SR}.querySelectorAll('.nr-chapter').length;
    const headerAtCh1 = ${SR}.querySelector('.nr-chapter-name').textContent;
    return { built, atFirst: st.currentIndex === 0, stuck, dups, lenChanges, domAtCh1, headerAtCh1, total: st.chapters.length };
  })()`, ctx1);
  check('成功构建 14 章', r3.built === 14, JSON.stringify(r3));
  check('逐章回到第 1 章不卡章（无 stuck）', r3.atFirst && r3.stuck === 0, JSON.stringify(r3));
  check('回翻全程无重复 URL 且记录数不变', r3.dups === 0 && r3.lenChanges === 0, JSON.stringify(r3));
  check('回翻后仍能看到第 1 章标题', r3.headerAtCh1.indexOf('第1章') === 0, r3.headerAtCh1);
  check('回翻后 DOM 章节数有界（≤12）', r3.domAtCh1 <= 12, String(r3.domAtCh1));

  // 前后往返 50 次：窗口滑动 + 收起章节按需恢复，仍无重复、不卡章
  const r3b = await evalJs(cdp1, `(async () => {
    const st = NR.reader.state;
    let dups = 0;
    const uniq = () => { const us = st.chapters.map(c => c.data.url); return new Set(us).size === us.length; };
    for (let i = 0; i < 50; i++) {
      if (i % 2) NR.reader.goNext(); else NR.reader.goPrev();
      await NR.sleep(170);
      if (!uniq()) dups++;
    }
    // 往返后再回到第 1 章验证可达
    let ok = false;
    for (let step = 0; step < 30 && st.currentIndex > 0; step++) { NR.reader.goPrev(); await NR.sleep(200); }
    ok = st.currentIndex === 0 && ${SR}.querySelector('.nr-chapter-name').textContent.indexOf('第1章') === 0;
    return { dups, backOk: ok, len: st.chapters.length };
  })()`, ctx1);
  check('往返 50 次无重复 URL', r3b.dups === 0, JSON.stringify(r3b));
  check('往返后仍可逐章到达第 1 章', r3b.backOk, JSON.stringify(r3b));

  // 从第 1 章连续前进：被收起的后方章节逐一恢复，不跳章（_lastRendered 锚点回归）
  const r3c = await evalJs(cdp1, `(async () => {
    const st = NR.reader.state;
    let stuck = 0;
    for (let step = 0; step < 20 && st.currentIndex < 7; step++) {
      const before = st.currentIndex;
      NR.reader.goNext();
      await NR.sleep(300);
      if (st.currentIndex <= before) stuck++;
    }
    return { at8: st.currentIndex === 7, stuck, header: ${SR}.querySelector('.nr-chapter-name').textContent };
  })()`, ctx1);
  check('回翻后连续前进逐章恢复到第 8 章（不跳章）', r3c.at8 && r3c.stuck === 0 && r3c.header.indexOf('第8章') === 0, JSON.stringify(r3c));

  // ============ 四、加载中退出再重开：旧会话不污染新会话（STAB-004） ============
  console.log('\n[四] 章节/目录加载中退出，旧 Promise 回来后不回写');
  const r4 = await evalJs(cdp1, `(async () => {
    const orig = NR.loader.fetchDoc;
    NR.loader.fetchDoc = function (url) { return NR.sleep(1500).then(() => orig.call(this, url)); };
    let done = false, err = null;
    NR.reader._appendByUrl('${BASE}/longsite/15.html', true).then(() => { done = true; }, (e) => { err = String((e && e.message) || e); });
    NR.reader._ensureCatalog().catch(() => {});
    await NR.sleep(200);
    NR.reader.close();
    await NR.sleep(2300); // 等两个旧 Promise 完成
    NR.loader.fetchDoc = orig;
    const closedOk = !document.getElementById('novel-reader-host');
    const reopened = await NR.reader.open();
    await NR.sleep(400);
    const st2 = NR.reader.state;
    return {
      done, err, closedOk, reopened,
      rejects: window.__nrRejects.slice(),
      newLen: st2.chapters.length,
      has15: st2.chapters.some(c => c.data.url.indexOf('/15.html') >= 0),
      catalogCarried: st2.catalogList == null
    };
  })()`, ctx1);
  check('旧拼接 Promise 正常收尾（无异常）', r4.done && !r4.err, JSON.stringify(r4));
  check('退出后 host 移除、无未处理拒绝', r4.closedOk && r4.rejects.length === 0, JSON.stringify(r4.rejects));
  check('重开后新会话只有本章（旧结果未回写）', r4.reopened && r4.newLen === 1 && !r4.has15 && r4.catalogCarried, JSON.stringify(r4));
  await evalJs(cdp1, `NR.reader.close()`, ctx1).catch(() => {});

  // ============ 五、跨章边界往返 50 次：history 不增长（STAB-006） ============
  console.log('\n[五] 跨章边界往返 50 次，浏览器历史长度不增长');
  const r5 = await evalJs(cdp1, `(async () => {
    await NR.reader.open();
    await NR.sleep(300);
    const st = NR.reader.state;
    for (const u of ['${BASE}/longsite/2.html', '${BASE}/longsite/3.html']) {
      st.currentIndex = st.chapters.length - 1;
      await NR.reader._appendByUrl(u, false);
    }
    const h0 = history.length;
    const sc = st.scroller;
    for (let i = 0; i < 50; i++) {
      const t = st.chapters[i % 2 ? 2 : 1].el.offsetTop;
      sc.scrollTop = t + 10;
      await NR.sleep(70);
    }
    await NR.sleep(400); // 等最后一次 replaceState 与滚动判定
    const h1 = history.length;
    const idx = st.currentIndex;
    const urlOk = location.pathname === '/longsite/' + (idx + 1) + '.html';
    NR.reader.close();
    await NR.sleep(300);
    return { h0, h1, urlOk, idx, exitUrl: location.pathname, hAfter: history.length };
  })()`, ctx1);
  check('跨章往返 50 次历史长度不变（pushState 会 +50）', r5.h1 === r5.h0, `history ${r5.h0}→${r5.h1}`);
  check('阅读中 URL 与可见章节一致', r5.urlOk && r5.idx === 2, JSON.stringify(r5));
  check('退出后 URL 恢复原始页且历史长度不变', r5.exitUrl === '/longsite/1.html' && r5.hAfter === r5.h0, JSON.stringify(r5));
  await cdp1.ws.close();

  // ============ 六、连续阅读 300 章（合成）：DOM/完整正文/loader 缓存均有上限（STAB-005） ============
  console.log('\n[六] 合成 300 章单向阅读，内存驻留有界');
  const cdp6 = await openPage(`${BASE}/longsite/1.html`);
  const ctx6 = cdp6.isolatedContextId();
  await evalJs(cdp6, `NR.reader.open()`, ctx6);
  await sleep(500);
  const r6 = await evalJs(cdp6, `(async () => {
    const st = NR.reader.state;
    const mk = (i) => ({
      url: '${BASE}/synth/' + i + '.html',
      title: '第' + i + '章 合成压测',
      bookTitle: '合成压测书',
      indexUrl: '${BASE}/synth/index.html',
      prevUrl: i > 1 ? '${BASE}/synth/' + (i - 1) + '.html' : null,
      nextUrl: i < 300 ? '${BASE}/synth/' + (i + 1) + '.html' : null,
      paragraphs: Array.from({ length: 40 }, (_, j) => '第' + i + '章第' + j + '段。' + '长文内容测试。'.repeat(12)),
      images: []
    });
    for (let i = 2; i <= 300; i++) {
      st.currentIndex = st.chapters.length - 1; // 模拟读到末章
      NR.reader._appendChapter(mk(i));
    }
    const withEl = st.chapters.filter(c => c.el).length;
    const full = st.chapters.filter(c => c.data.paragraphs && c.data.paragraphs.length).length;
    // loader 缓存上限：注入 300 条成功缓存后按当前窗口 prune
    for (let i = 0; i < 300; i++) NR.loader.cache.set('${BASE}/cache/' + i + '.html', { status: 'ok', chapter: { url: '${BASE}/cache/' + i + '.html' } });
    NR.loader.prune(st.chapters.filter(c => c.el).map(c => c.data.url));
    return {
      total: st.chapters.length,
      withEl, full,
      cacheSize: NR.loader.cache.size,
      evicted: !NR.loader.cache.has('${BASE}/cache/0.html'),
      metaOnlyOk: !st.chapters[0].data.paragraphs
    };
  })()`, ctx6);
  check('300 章记录保留（可回翻导航）', r6.total === 300, JSON.stringify(r6));
  check('DOM 章节数有界（≤12）', r6.withEl <= 12, String(r6.withEl));
  check('完整正文对象数有界（≤12）', r6.full <= 12, String(r6.full));
  check('最早章节已裁剪为纯元数据', r6.metaOnlyOk);
  check('loader 成功缓存淘汰到上限（≤80）且最旧可淘汰', r6.cacheSize <= 80 && r6.evicted, `size=${r6.cacheSize} evicted=${r6.evicted}`);

  // 回翻被淘汰章节：按需重载且不复制记录
  const r6b = await evalJs(cdp6, `(async () => {
    const st = NR.reader.state;
    const mk = (i) => ({
      url: i, title: '重载' + i, bookTitle: '合成压测书', indexUrl: '${BASE}/synth/index.html',
      prevUrl: null, nextUrl: null,
      paragraphs: Array.from({ length: 40 }, (_, j) => '重载段' + j), images: []
    });
    NR.loader.getChapter = async function (url) { return mk(url); }; // 模拟重载（缓存已被裁剪/淘汰）
    const lenBefore = st.chapters.length;
    NR.reader.goPrev();
    await NR.sleep(400);
    const urls = st.chapters.map(c => c.data.url);
    return {
      back: st.currentIndex,
      len: st.chapters.length,
      lenSame: st.chapters.length === lenBefore,
      uniq: new Set(urls).size === urls.length,
      rendered: st.chapters[st.currentIndex].el ? st.chapters[st.currentIndex].el.querySelectorAll('.nr-p').length : 0
    };
  })()`, ctx6);
  check('回翻被淘汰章节可重载且记录不复制', r6b.back < 299 && r6b.lenSame && r6b.uniq && r6b.rendered === 40, JSON.stringify(r6b));
  await closeTab(cdp6);

  // ============ 七、两标签页各保存不同书 100 次（STAB-007） ============
  console.log('\n[七] 两标签页并发保存进度 + 旧版整包迁移');
  const cdpA = await openPage(`${BASE}/utf8site/1.html`);
  const cdpB = await openPage(`${BASE}/longsite/1.html`);
  const ctxA = cdpA.isolatedContextId();
  const ctxB = cdpB.isolatedContextId();
  // 预置旧版整包 progress（验证迁移不丢历史书）
  await evalJs(cdpA, `new Promise(res=>chrome.storage.local.set({progress:{'legacy-book':{'url':'${BASE}/utf8site/2.html','ts':Date.now()-1000,'chapterTitle':'旧版记录','chapterRatio':0.2,'bookTitle':'旧版书'}}},res))`, ctxA);
  await evalJs(cdpA, `NR.reader.open()`, ctxA);
  await evalJs(cdpB, `NR.reader.open()`, ctxB);
  await sleep(300);
  const keyA = await evalJs(cdpA, `NR.reader._bookKey()`, ctxA);
  const keyB = await evalJs(cdpB, `NR.reader._bookKey()`, ctxB);
  check('两本书的书键不同', keyA !== keyB, keyA + ' vs ' + keyB);
  const t0 = Date.now();
  await Promise.all([
    evalJs(cdpA, `(()=>{for(let i=0;i<100;i++)NR.reader._saveProgressNow();return NR.reader._progressChain})()`, ctxA),
    evalJs(cdpB, `(()=>{for(let i=0;i<100;i++)NR.reader._saveProgressNow();return NR.reader._progressChain})()`, ctxB)
  ]);
  await sleep(600);
  const r7 = await evalJs(cdpA, `new Promise(res=>chrome.storage.local.get(null,s=>res({
    a:!!s['p:'+${JSON.stringify(keyA)}], b:!!s['p:'+${JSON.stringify(keyB)}],
    aTs:(s['p:'+${JSON.stringify(keyA)}]||{}).ts||0, bTs:(s['p:'+${JSON.stringify(keyB)}]||{}).ts||0,
    aBook:(s['p:'+${JSON.stringify(keyA)}]||{}).bookTitle, bBook:(s['p:'+${JSON.stringify(keyB)}]||{}).bookTitle,
    legacyGone:s.progress===undefined, legacyMigrated:!!s['p:legacy-book']
  })))`, ctxA);
  // ts 用 >=：保存与 t0 同毫秒完成时严格大于会误报（机器越快越容易触发）
  check('两本书的进度都存在且均为本次会话新记录', r7.a && r7.b && r7.aTs >= t0 && r7.bTs >= t0, JSON.stringify(r7));
  check('两本书标题各自正确', r7.aBook && r7.bBook && r7.aBook !== r7.bBook, JSON.stringify(r7));
  check('旧版整包 progress 已迁移且旧记录保留', r7.legacyGone && r7.legacyMigrated, JSON.stringify(r7));

  // ============ 八、两标签页同时跳转（STAB-008） ============
  console.log('\n[八] 两标签页并发写跳转标记，各自自动打开目标章');
  await evalJs(cdpA, `NR.reader.close()`, ctxA).catch(() => {});
  await evalJs(cdpB, `NR.reader.close()`, ctxB).catch(() => {});
  const urlA2 = `${BASE}/utf8site/3.html`;
  const urlB2 = `${BASE}/longsite/5.html`;
  const expiredUrl = `${BASE}/utf8site/expired.html`;
  await evalJs(cdpA, `new Promise(res=>chrome.storage.local.set({
    ['po:'+${JSON.stringify(urlA2)}]:{url:${JSON.stringify(urlA2)},ts:Date.now(),intent:'jump'},
    ['po:'+${JSON.stringify(urlB2)}]:{url:${JSON.stringify(urlB2)},ts:Date.now(),intent:'jump'},
    ['po:'+${JSON.stringify(expiredUrl)}]:{url:${JSON.stringify(expiredUrl)},ts:Date.now()-11*60*1000,intent:'jump'}
  },res))`, ctxA);
  await Promise.all([
    evalJs(cdpA, `location.assign(${JSON.stringify(urlA2)})`).catch(() => {}),
    evalJs(cdpB, `location.assign(${JSON.stringify(urlB2)})`).catch(() => {})
  ]);
  await cdpA.waitEventCompat('Page.loadEventFired', 20000).catch(() => {});
  await cdpB.waitEventCompat('Page.loadEventFired', 20000).catch(() => {});
  await sleep(3500);
  const landedA = await evalJs(cdpA, `(()=>{const h=document.getElementById('novel-reader-host');return h?h.shadowRoot.querySelector('.nr-ch-title').textContent:'no-reader'})()`);
  const landedB = await evalJs(cdpB, `(()=>{const h=document.getElementById('novel-reader-host');return h?h.shadowRoot.querySelector('.nr-ch-title').textContent:'no-reader'})()`);
  check('标签页 A 自动打开第三章（未被 B 覆盖）', landedA === '第三章 剑出如虹', String(landedA));
  check('标签页 B 自动打开第 5 章（未被 A 覆盖）', String(landedB).indexOf('第5章') === 0, String(landedB));
  const expiredGone = await evalJs(cdpA, `new Promise(res=>chrome.storage.local.get(null,s=>res(!s['po:'+${JSON.stringify(expiredUrl)}])))`, cdpA.isolatedContextId());
  check('过期跳转标记被清理', expiredGone);

  // ============ 九、两 host 同时阅读的 DNR 会话规则（STAB-009） ============
  console.log('\n[九] 按标签页跟踪 DNR：互不覆盖、关闭一页不影响另一页');
  await evalJs(cdpA, `NR.reader.close()`, cdpA.isolatedContextId()).catch(() => {});
  const cdpL = await openPage(`${BASE.replace('127.0.0.1', 'localhost')}/utf8site/1.html`); // 第二个 host：localhost（同 fixture 服务器换域名，勿硬编码端口）
  const ctxL = cdpL.isolatedContextId();
  // B 页重开阅读器（127.0.0.1 host）
  await evalJs(cdpB, `NR.reader.open()`, cdpB.isolatedContextId());
  await sleep(300);
  await evalJs(cdpL, `NR.reader.open()`, ctxL);
  await sleep(800);
  const ad = await swEval('self.AD_DOMAINS ? self.AD_DOMAINS.length : 0');
  let rules = await untilRules((i) => i.n === i.adn * 2);
  check('两个 host 同时阅读各有一组会话规则', rules.hosts.join(',') === '127.0.0.1,localhost' && rules.n === ad * 2, JSON.stringify(rules));

  await evalJs(cdpL, `NR.reader.close()`, ctxL).catch(() => {}); // 关闭 localhost 页阅读器
  rules = await untilRules((i) => i.n === i.adn);
  check('关闭一页只移除该 host 的规则，另一页不受影响', rules.hosts.join(',') === '127.0.0.1', JSON.stringify(rules));

  // 关闭设置后重开：走真实链路（saveSettings 持久化后 open 才能从 storage 读到 false）
  await evalJs(cdpB, `NR.saveSettings({blockAdsOnRead:false}); NR.persistSettingsNow()`, cdpB.isolatedContextId());
  await sleep(600); // 落盘 + onChanged 同步 + debounce
  await evalJs(cdpB, `NR.reader.close()`, cdpB.isolatedContextId()).catch(() => {});
  await evalJs(cdpB, `NR.reader.open()`, cdpB.isolatedContextId());
  await sleep(800);
  rules = await untilRules((i) => i.n === 0);
  check('关闭“阅读时屏蔽本站广告”后重开不产生会话规则', rules.n === 0, JSON.stringify(rules));

  await closeTab(cdpB); // 整标签页关闭（onRemoved 清理）
  rules = await untilRules((i) => i.n === 0);
  check('关闭标签页后无残留规则', rules.n === 0, JSON.stringify(rules));
  await closeTab(cdpL);
  await closeTab(cdpA);

  // ============ 十、滑杆连续拖动：UI 实时、写入收敛（STAB-010） ============
  console.log('\n[十] 设置滑杆连续拖动 6 秒（60 个 input 事件）');
  const cdp10 = await openPage(`${BASE}/longsite/2.html`);
  const ctx10 = cdp10.isolatedContextId();
  await evalJs(cdp10, `NR.reader.open()`, ctx10);
  await sleep(500);
  const r10 = await evalJs(cdp10, `(async () => {
    const sr = document.getElementById('novel-reader-host').shadowRoot;
    const r = sr.querySelector('input[type="range"][data-key="fontSize"]');
    window.__syncWrites = 0;
    const listener = (ch, area) => { if (area === 'sync' && ch.settings) window.__syncWrites++; };
    chrome.storage.onChanged.addListener(listener);
    let liveOk = false;
    for (let v = 0; v < 60; v++) {
      r.value = String(14 + (v % 15));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      if (v === 5) liveOk = sr.querySelector('.nr-root').style.getPropertyValue('--nr-fs') === r.value + 'px';
      await NR.sleep(100);
    }
    await NR.sleep(1000); // 尾缘 debounce 落盘
    const stored = await new Promise(res => chrome.storage.sync.get('settings', s => res(s.settings ? s.settings.fontSize : null)));
    chrome.storage.onChanged.removeListener(listener);
    return { writes: window.__syncWrites, liveOk, lastVal: Number(r.value), stored };
  })()`, ctx10);
  check('拖动全程 UI 实时生效', r10.liveOk);
  check('storage 写入收敛（60 事件 ≤3 次写入）', r10.writes >= 1 && r10.writes <= 3, String(r10.writes));
  check('最终值已持久化', r10.stored === r10.lastVal, JSON.stringify(r10));
  await closeTab(cdp10);
} catch (e) {
  failed++;
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
try { proc.kill('SIGKILL'); } catch (e) {}
await sleep(500);
let cleanErr = null;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { cleanErr = e; }
console.log(`\n结果：${passed} 通过，${failed} 失败${cleanErr ? '（临时目录清理失败，可忽略）' : ''}`);
process.exit(failed ? 1 : 0);
