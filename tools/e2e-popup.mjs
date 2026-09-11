#!/usr/bin/env node
/**
 * 回归测试：工具栏弹窗（popup）尺寸适配与确定性收起。
 *
 * 背景：手机浏览器（Edge 安卓/Lemur/Kiwi 等）工具栏"插件"图标弹出的是本扩展
 * 的 popup 面板。历史问题：
 *  1. 无 viewport meta + body 写死 300px → 面板视口 ≠ 300px 的浏览器里溢出或缩小到不可读；
 *  2. "进入阅读模式"先 await 内容脚本响应再 window.close() → open() 慢或 reject
 *     时面板永不收起；部分手机浏览器面板本身忽略 window.close() 且无兜底。
 *
 * 覆盖点：
 *  1. viewport meta 存在；加载零未捕获异常；init 完成（pageStatus 离开加载态）。
 *  2. 桌面（1000×900）body 保持 300px 不回归。
 *  3. 最近阅读：storage 播种一条记录后重载渲染出条目；点击续读 → tabs.create
 *     被调用且立即进入收起流程（nr-closing）。
 *  4. 确定性收起（核心回归）：sendMessage 桩永不响应，点击"进入阅读模式"必须在
 *     点击同一 tick 进入收起流程（旧实现 await 响应 → 永不收起，此断言必挂）；
 *     600ms 后目标被 window.close 关闭或按钮变为可见反馈兜底，二者必居其一。
 *  5. 手机面板视口：CDP 设备模拟（本页已声明 viewport meta，可驱动布局）+
 *     触摸模拟翻转 (pointer: coarse)：260px 视口下 body 被压到 260、无横向溢出；
 *     粗指针分支生效——主按钮热区 ≥44px、最近阅读列表 34vh 内部滚动。
 *     注：macOS 上 Chromium 窗口最小宽 ~300px，--window-size 到不了 280，故用模拟。
 *
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-popup.mjs <项目根目录>
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
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
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  → ' + extra));
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
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      // 目标页被 window.close 关掉后 WS 静默死亡，未决消息不得无限挂起
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('CDP 请求超时: ' + method));
        }
      }, 20000).unref();
    });
  }
  exceptions() {
    return this.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
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
    let v = null;
    try { v = await evalJs(cdp, expression, contextId); } catch (e) { /* 导航瞬间上下文销毁，继续等 */ }
    if (v) return true;
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
}, 150000);

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
  return { cdp, targetId: res.id };
}

// ---------------- 场景一：桌面 1000×900，加载/渲染/确定性收起 ----------------
async function runDesktop() {
  console.log('\n[桌面 1000×900] popup 加载、渲染与确定性收起');
  launchChrome(9350, '/tmp/nr-popup-profile', '1000,900');
  // 先开小说页拿扩展 ID（unpacked ID 由扩展绝对路径派生，跨实例稳定）
  const page = await openTab(9350, `${BASE}/longsite/1.html`);
  await sleep(1800); // document_idle 注入内容脚本
  const ctx = page.cdp.isolatedContextId();
  const extId = await evalJs(page.cdp, 'chrome.runtime.id', ctx);
  if (!extId) throw new Error('未取得扩展 ID');
  try { page.cdp.ws.close(); } catch (e) { /* 已关闭 */ }

  const { cdp, targetId } = await openTab(9350, `chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1200); // popup init
  const js = (expr) => evalJs(cdp, expr);
  try {
    check('viewport meta 存在（width=device-width）',
      String(await js(`(document.querySelector('meta[name="viewport"]')||{}).content || ''`)).includes('width=device-width'),
      '缺 meta 或内容不符');

    check('加载零未捕获异常', cdp.exceptions() === 0, cdp.exceptions() + ' 个异常');

    const status = await js(`document.getElementById('pageStatus').textContent`);
    check('init 完成（pageStatus 离开加载态）', status !== '检测当前页面…', status);

    const bodyW = await js(`document.body.getBoundingClientRect().width`);
    check('桌面 body 保持 300px', Math.abs(bodyW - 300) <= 1, '实际 ' + bodyW);

    // 最近阅读：播种 → 重载 → 渲染
    await js(`(async () => {
      await chrome.storage.local.set({ 'p:nr-e2e-popup': {
        url: '${BASE}/longsite/2.html', ts: Date.now() - 60000,
        bookTitle: '_popup回归书', chapterTitle: '第二章', chapterRatio: 0.42 } });
    })(), true`);
    await js(`location.reload(); true`);
    await until(cdp, `document.querySelectorAll('.recent-item').length === 1`, 8000);
    const item = await js(`(()=>{
      const it = document.querySelector('.recent-item');
      return { book: it.querySelector('.r-book').textContent,
        chapter: it.querySelector('.r-chapter').textContent };
    })()`);
    check('播种记录渲染出书名', item.book === '_popup回归书', item.book);
    check('章节行含章名与进度百分比', item.chapter.includes('第二章') && item.chapter.includes('42%'), item.chapter);

    // 续读点击：tabs.create 与 window.close 均打桩（CDP 打开的页面里 window.close
    // 会真的关掉目标页，必须在页内存证），轮询等异步 handler 走完
    await js(`(()=>{
      window.__nrCreates = [];
      window.__nrCloses = 0;
      chrome.tabs.create = (o) => { window.__nrCreates.push(o.url); };
      window.close = () => { window.__nrCloses++; };
      document.querySelector('.recent-item').click();
      return true;
    })()`);
    await until(cdp, `window.__nrCloses >= 1`, 4000);
    const resume = await js(`({ n: window.__nrCreates.length,
      url: window.__nrCreates[0] || '',
      closing: document.body.classList.contains('nr-closing') })`);
    check('续读点击触发 tabs.create 且带目标 URL', resume.n === 1 && resume.url.includes('/longsite/2.html'), JSON.stringify(resume));
    check('续读点击进入收起流程且调用 window.close', resume.closing === true, '无 nr-closing');

    // 核心回归：响应永不回来也必须收起
    await js(`location.reload(); true`);
    // recent-item 由 loadRecent 渲染，必然晚于 bindEvents：此时监听器与 currentTab 均已就绪
    await until(cdp, `document.querySelectorAll('.recent-item').length === 1`, 8000);
    await js(`(()=>{
      window.__nrMsgCalls = 0;
      window.__nrCloses = 0;
      chrome.tabs.sendMessage = (id, msg, cb) => { window.__nrMsgCalls++; }; // 桩：永不响应
      window.close = () => { window.__nrCloses++; }; // 桩：不真关页，验证兜底反馈路径
      const btn = document.getElementById('openReader');
      btn.disabled = false;
      btn.click();
      return true;
    })()`);
    const click = await js(`({ calls: window.__nrMsgCalls,
      closing: document.body.classList.contains('nr-closing') })`);
    check('NR_TOGGLE 已发出（1 次）', click.calls === 1, '实际 ' + click.calls);
    check('点击同一 tick 即进入收起流程（不 await 响应）', click.closing === true, '旧实现会挂在响应等待上');
    await until(cdp, `window.__nrCloses >= 1`, 4000);
    check('window.close 已被调用', true, '');
    await sleep(500);
    const fb = await js(`({ text: document.getElementById('openReader').textContent,
      disabled: document.getElementById('openReader').disabled,
      connected: !!document.body.isConnected })`);
    check('浏览器拒不收起时展示可见反馈兜底', fb.connected && fb.disabled && fb.text.indexOf('已进入阅读模式') === 0,
      JSON.stringify(fb));
  } finally {
    try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
    void targetId;
  }
}

// ---------------- 场景二：手机面板视口 260×700，尺寸自适应 + 粗指针分支 ----------------
async function runMobilePanel() {
  console.log('\n[手机面板视口 260×700] 尺寸自适应与触控热区');
  launchChrome(9351, '/tmp/nr-popup-narrow', '800,600');
  const page = await openTab(9351, `${BASE}/longsite/1.html`);
  await sleep(1800);
  const ctx = page.cdp.isolatedContextId();
  const extId = await evalJs(page.cdp, 'chrome.runtime.id', ctx);
  try { page.cdp.ws.close(); } catch (e) { /* 已关闭 */ }

  const { cdp } = await openTab(9351, `chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1200);
  // 页面已声明 viewport meta，设备模拟可驱动布局宽度；触摸模拟翻转 pointer:coarse
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 260, height: 700, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const js = (expr) => evalJs(cdp, expr);
  try {
    check('视口已模拟为 260px 且 pointer:coarse 生效',
      (await js(`window.innerWidth === 260 && matchMedia('(pointer: coarse)').matches`)) === true,
      '模拟未生效');
    const m = await js(`(()=>{
      const de = document.documentElement;
      const body = document.body.getBoundingClientRect();
      const btn = document.getElementById('openReader').getBoundingClientRect();
      const head = document.querySelector('.head');
      const sub = document.querySelector('.sub');
      const cs = getComputedStyle(sub);
      const recent = getComputedStyle(document.querySelector('.recent'));
      const rows = Array.from(document.querySelectorAll('.row')).map((r) => r.getBoundingClientRect().height);
      return { scrollW: de.scrollWidth,
        bodyW: Math.round(body.width), btnW: Math.round(btn.width), btnH: Math.round(btn.height),
        headOverflow: head.scrollWidth - head.clientWidth,
        ellipsis: cs.textOverflow === 'ellipsis' && cs.overflowX === 'hidden',
        recentOverflowY: recent.overflowY, recentMaxPx: parseFloat(recent.maxHeight) || 0,
        minRowH: Math.round(Math.min.apply(null, rows)) };
    })()`);
    check('无横向溢出（scrollWidth ≤ 视口 260）', m.scrollW <= 260, 'scrollWidth=' + m.scrollW);
    check('body 被 max-width:100vw 压到 260px', m.bodyW === 260, '实际 ' + m.bodyW);
    check('主按钮随面板全宽（260 − wrap 左右 padding 28）', m.btnW === m.bodyW - 28, '实际 ' + m.btnW);
    check('主按钮触控热区 ≥44px', m.btnH >= 44, '高度 ' + m.btnH);
    check('设置行触控热区 ≥44px', m.minRowH >= 44, '最小高度 ' + m.minRowH);
    check('最近阅读列表内部滚动（34vh 封顶）', m.recentOverflowY === 'auto' && m.recentMaxPx > 100 && m.recentMaxPx < 300,
      `overflowY=${m.recentOverflowY} maxHeight=${m.recentMaxPx}px`);
    check('头部无溢出（域名省略号生效，不撑破布局）', m.headOverflow <= 0, '溢出 ' + m.headOverflow + 'px');
    check('.sub 具备省略号样式', m.ellipsis === true, 'text-overflow/overflow-x 不符');
  } finally {
    try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

try {
  await runDesktop();
  await runMobilePanel();
} catch (e) {
  failed++;
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
await sleep(500);
for (const dir of ['/tmp/nr-popup-profile', '/tmp/nr-popup-narrow']) {
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 可忽略 */ }
}
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
