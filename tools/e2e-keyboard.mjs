#!/usr/bin/env node
/**
 * 回归测试：阅读视图打开期间的键盘事件隔离与 Mac 快捷键适配。
 *
 * 覆盖点：
 *  1. 站点键盘脚本隔离：真实小说站普遍在 document 上把 ←/→ 绑定为整页跳章导航。
 *     在主世界安装同款监听器后进入阅读模式，document 派发 ←/→：
 *     阅读器正常翻章（拼接/回滚），站点监听器一次都不能收到（否则整页导航 =
 *     "按方向键翻章退出阅读模式"）。keyup 同样阻断。
 *  2. 自身快捷键不受影响：Space 翻页仍然生效（阻断传播不影响 window 捕获监听器自己）。
 *  3. 目录搜索聚焦时按 → 不翻章、不触发站点导航；Esc 优先关目录而非退出阅读；
 *     再按 Esc 才退出阅读。
 *  4. 悬浮按钮标题显示真实生效的切换快捷键（经后台 chrome.commands 查询，
 *     Mac 新装为 ⌘⇧K，不再是写死的 Alt+R）。
 *  5. 静态断言：manifest 声明 mac suggested_key（Command+Option+R）、版本号。
 *
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-keyboard.mjs <项目根目录>
 */
import { spawn } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME =
  process.env.NR_TEST_BROWSER ||
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '.');
const BASE = process.env.NR_TEST_BASE || 'http://127.0.0.1:8080';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra && !cond ? '  → ' + extra : ''));
  cond ? passed++ : failed++;
}

// ---------------- CDP 客户端（与 e2e-catalog.mjs 同构） ----------------
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
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

async function until(cdp, expression, timeout = 10000, interval = 150, contextId) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evalJs(cdp, expression, contextId)) return true;
    if (Date.now() > deadline) throw new Error('timeout: ' + expression.slice(0, 80));
    await sleep(interval);
  }
}

const procs = [];
function launchChrome(port, profile, windowSize) {
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--window-size=${windowSize}`,
    `--remote-debugging-port=${port}`, 'about:blank'
  ], { stdio: 'ignore' });
  procs.push(proc);
  return proc;
}
const watchdog = setTimeout(() => {
  console.error('⏱ 超时退出');
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
  process.exit(2);
}, 120000);

async function openTab(port, url) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    if (i === 49) throw new Error('browser not ready on port ' + port);
    await sleep(200);
  }
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(1800); // document_idle + boot + 悬浮按钮
  return cdp;
}

// ---------------- 静态断言：manifest mac 快捷键与版本 ----------------
function staticChecks() {
  console.log('\n[静态] manifest 快捷键声明');
  const mf = JSON.parse(readFileSync(resolve(EXT, 'manifest.json'), 'utf8'));
  const cmd = mf.commands && mf.commands['toggle-reader'];
  check('manifest 声明 mac suggested_key', !!(cmd && cmd.suggested_key && cmd.suggested_key.mac === 'Command+Shift+K'),
    cmd && cmd.suggested_key ? JSON.stringify(cmd.suggested_key) : '无 toggle-reader command');
  // 版本只验合法性，不钉死具体号：功能回归不应随每次发版改测试
  check('manifest 版本为合法 semver', /^\d+\.\d+\.\d+$/.test(mf.version), '实际 ' + mf.version);
}

// ---------------- 场景：站点键盘脚本隔离 + 自身快捷键 ----------------
async function runKeyboard() {
  console.log('\n[桌面 1000×900] 键盘事件隔离（站点 ←/→ 翻章脚本）');
  launchChrome(9344, '/tmp/nr-kbd-profile', '1000,900');
  const cdp = await openTab(9344, `${BASE}/longsite/8.html`);
  const SR = `document.getElementById('novel-reader-host').shadowRoot`;
  const js = (expr) => evalJs(cdp, expr);
  const press = (key, type = 'keydown') =>
    js(`document.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, {key: ${JSON.stringify(key)}, bubbles: true, cancelable: true}))`);
  try {
    // 主世界安装"典型小说站"键盘脚本：←/→ 整页跳章（keydown + keyup 两种绑定都装）
    await js(`(() => {
      window.__siteKeys = [];
      const nav = (k) => {
        if (k === 'ArrowRight') location.href = '9.html';
        else if (k === 'ArrowLeft') location.href = '7.html';
      };
      document.addEventListener('keydown', (e) => { window.__siteKeys.push('down:' + e.key); nav(e.key); });
      document.addEventListener('keyup', (e) => { window.__siteKeys.push('up:' + e.key); nav(e.key); });
      return true;
    })()`);

    // 悬浮按钮标题显示真实生效快捷键（后台代查，非写死 Alt+R）
    const title = await until(cdp, `(()=>{ const b = document.getElementById('novel-reader-float-btn'); return b && /^进入小说阅读模式（.+）$/.test(b.title) ? b.title : false; })()`, 8000).catch(() => null);
    check('悬浮按钮标题含真实快捷键', !!title, title === null ? '未读取到标题' : title);

    // 进入阅读模式
    await js(`document.getElementById('novel-reader-float-btn').click()`);
    await sleep(800);
    check('进入阅读模式', await js(`!!document.getElementById('novel-reader-host')`));

    const ctx = cdp.isolatedContextId();
    check('内容脚本隔离世界可用', ctx != null);
    const st = (expr) => evalJs(cdp, expr, ctx);

    // → 翻章：阅读器内部拼接第 9 章，站点脚本不得收到（否则整页导航退出阅读）
    await press('ArrowRight');
    // 主世界哨兵：站点脚本一旦触发整页跳转，window.__siteKeys 随文档销毁变为 undefined
    if (!(await js('Array.isArray(window.__siteKeys)'))) {
      check('→ 翻章未触发站点整页导航（阅读模式被退出的根因）', false, '站点 ←/→ 脚本劫持按键并跳转，页面已销毁');
      return;
    }
    try {
      await until(cdp, `NR.reader.state && NR.reader.state.chapters.length === 2`, 10000, 150, ctx);
    } catch (e) {
      check('→ 翻到第 9 章（拼接）', false, '章节未拼接或隔离上下文已失效：' + e.message);
      return;
    }
    await sleep(500); // _scrollToChapter 的 rAF 推进 currentIndex
    const siteKeys1 = await js('window.__siteKeys.join(",")'); // 主世界读取：站点脚本真正看到的按键
    const afterNext = await st(`({ idx: NR.reader.state.currentIndex,
      url: (NR.reader.state.chapters[NR.reader.state.currentIndex].data.url || ''),
      host: !!document.getElementById('novel-reader-host') })`);
    check('→ 翻到第 9 章（拼接）', afterNext.idx === 1 && /9\.html$/.test(afterNext.url), JSON.stringify(afterNext));
    check('→ 后阅读视图仍在（未退出）', afterNext.host);
    check('→ 站点 keydown 脚本未收到按键', siteKeys1 === '', '站点收到：' + siteKeys1);

    // ← 回翻：滚回第 8 章，同样不触发站点导航
    await press('ArrowLeft');
    await sleep(500);
    const afterPrev = await st(`({ idx: NR.reader.state.currentIndex,
      host: !!document.getElementById('novel-reader-host') })`);
    check('← 回翻到第 8 章', afterPrev.idx === 0, '实际 idx=' + afterPrev.idx);
    check('← 后阅读视图仍在（未退出）', afterPrev.host);
    check('← 站点脚本未收到按键', (await js('window.__siteKeys.join(",")')) === '', '站点收到：' + (await js('window.__siteKeys.join(",")')));

    // keyup 绑定的站点翻章同样被阻断
    await press('ArrowRight', 'keyup');
    await sleep(400);
    check('keyup 翻章绑定被阻断（未导航）', (await js('window.__siteKeys.join(",")')) === '', '站点收到：' + (await js('window.__siteKeys.join(",")')));

    // 自身快捷键不受阻断影响：Space 向下翻一页
    await press(' ');
    await sleep(300);
    const scrolled = await st(`NR.reader.state.scroller.scrollTop`);
    check('Space 翻页仍生效', scrolled > 0, 'scrollTop=' + scrolled);

    // 目录搜索聚焦：→ 不翻章、不触发站点导航；Esc 优先关目录而非退出阅读
    await js(`${SR}.querySelector('[data-act="catalog"]').click()`);
    await sleep(300);
    check('目录面板打开', await js(`${SR}.querySelector('.nr-root').classList.contains('nr-catalog-open')`));
    await js(`${SR}.querySelector('.nr-catalog-search').focus()`);
    await sleep(200);
    await press('ArrowRight');
    await sleep(400);
    const whileTyping = await st(`({ idx: NR.reader.state.currentIndex,
      open: ${SR}.querySelector('.nr-root').classList.contains('nr-catalog-open') })`);
    check('搜索框聚焦时 → 不翻章', whileTyping.idx === 0, '实际 idx=' + whileTyping.idx);
    check('搜索框聚焦时站点脚本未收到按键', (await js('window.__siteKeys.join(",")')) === '', '站点收到：' + (await js('window.__siteKeys.join(",")')));
    await press('Escape');
    await sleep(300);
    const afterEsc1 = await js(`({ open: ${SR}.querySelector('.nr-root').classList.contains('nr-catalog-open'),
      host: !!document.getElementById('novel-reader-host') })`);
    check('Esc（焦点在搜索框）只关目录', !afterEsc1.open && afterEsc1.host, JSON.stringify(afterEsc1));
    await press('Escape');
    await sleep(400);
    check('再次 Esc 退出阅读模式', !(await js(`!!document.getElementById('novel-reader-host')`)));
    check('全程站点脚本未收到任何键盘事件', (await js(`window.__siteKeys.join(',')`)) === '');
  } finally {
    try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

staticChecks();
try {
  await runKeyboard();
} catch (e) {
  failed++;
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
await sleep(500);
try { rmSync('/tmp/nr-kbd-profile', { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
