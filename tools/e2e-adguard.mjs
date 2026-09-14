#!/usr/bin/env node
/**
 * 回归测试：阅读期间的广告拦截三层防护（v0.2.12 白名单重构）
 *
 * 威胁模型（盗版站弹窗/跳转广告的通用套路）：广告 SDK 以随机子域+高位端口
 * 动态下发，页面加载时就已运行驻留，在 window 上挂 touch/click 监听，
 * 阅读中触屏即 window.open / location 跳外域，还会继续注入外域 script/iframe
 * 与 meta refresh 定时跳转。黑名单式拦截对随机域名天然失效，且拦不住
 * 已驻留代码发起的跳转，故 v0.2.12 改为三层：
 *  1. 会话级 DNR 白名单：仅放行本站域名，其余请求（含 main_frame 跳转本身）全拦
 *  2. 主世界导航守卫：Navigation API preventDefault 跨源导航（阅读器翻章为同源，不受影响）
 *  3. 主世界 window.open 包装：阅读期间一律返回 null
 *
 * 测试借 localhost 与 127.0.0.1 构造"同服务器、不同域名"的外部目标：
 *  - 阅读中：跨域 fetch / 动态外域 script 必须被 DNR 拦下；本站 fetch 必须放行
 *  - 阅读中：跨源 location.href 赋值 / meta refresh 跳转不发生，阅读器存活
 *  - 阅读中：带用户激活的 window.open 返回 null 且无新标签页
 *  - 退出后：跨域请求恢复（会话规则随阅读器关闭撤销）
 *
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-adguard.mjs <项目根目录>
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME =
  process.env.NR_TEST_BROWSER ||
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '.');
const PORT = 9341;
const PROFILE = '/tmp/nr-adguard-profile';
const BASE = process.env.NR_TEST_BASE || 'http://127.0.0.1:8080';
const OTHER = BASE.replace('127.0.0.1', 'localhost'); // 同一 fixture 服务器、不同域名 → DNR 视为外站

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra && !cond ? '  → ' + extra : ''));
  cond ? passed++ : failed++;
}

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
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
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

async function until(cdp, expression, timeout = 10000, interval = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evalJs(cdp, expression)) return true;
    if (Date.now() > deadline) throw new Error('timeout: ' + expression.slice(0, 80));
    await sleep(interval);
  }
}

async function pageTargets() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  return list.filter((t) => t.type === 'page').length;
}

rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: 'ignore' });
const watchdog = setTimeout(() => { console.error('⏱ 超时退出'); try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, 240000);

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${BASE}/longsite/1.html`)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  cdp.targetId = res.id;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(1800); // document_idle + boot + 悬浮按钮

  const ctx = cdp.isolatedContextId();
  check('内容脚本隔离世界可用', ctx != null);
  check('主世界守卫已注入（data-nr-kbd-guard）', await evalJs(cdp, `document.documentElement.getAttribute('data-nr-kbd-guard') === '1'`));
  check('Navigation API 可用（Chrome 环境前提）', await evalJs(cdp, `!!window.navigation`));

  await evalJs(cdp, `NR.reader.open()`, ctx);
  await until(cdp, `!!document.getElementById('novel-reader-host')`);
  await sleep(900); // 等 DNR 会话规则注册（消息往返 + SW 重建）
  check('进入阅读模式', await evalJs(cdp, `!!document.getElementById('novel-reader-host')`));

  // ---- 1. DNR 白名单：跨域拦、本站放 ----
  const fetchProbe = (url, mode) =>
    `fetch(${JSON.stringify(url)}, {mode: ${JSON.stringify(mode)}}).then(() => 'ok', (e) => 'err:' + (e && e.message))`;
  check('阅读中：跨域 fetch 被 DNR 拦下', (await evalJs(cdp, fetchProbe(`${OTHER}/longsite/2.html`, 'no-cors'))).indexOf('err') === 0,
    await evalJs(cdp, fetchProbe(`${OTHER}/longsite/2.html`, 'no-cors')));
  check('阅读中：本站 fetch 放行（阅读器章节加载不受影响）', (await evalJs(cdp, fetchProbe(`${BASE}/longsite/2.html`, 'cors'))) === 'ok');

  const scriptProbe = (origin) => `new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = ${JSON.stringify(origin + '/adstub.js')} + '?ts=' + Date.now();
    s.onload = () => resolve('loaded');
    s.onerror = () => resolve('blocked');
    document.head.appendChild(s);
  })`;
  check('阅读中：动态注入外域 script 被拦', (await evalJs(cdp, scriptProbe(OTHER))) === 'blocked');

  // ---- 2. 主世界导航守卫 ----
  check('阅读中：跨源 location.href 赋值被阻止', await evalJs(cdp, `(()=>{
    location.href = ${JSON.stringify(OTHER + '/longsite/2.html')};
    return 'assigned';
  })()`) === 'assigned');
  await sleep(800);
  check('阅读中：地址栏未离开本站', await evalJs(cdp, `location.origin`) === BASE);
  check('阅读中：阅读器存活（未被强制跳转）', await evalJs(cdp, `!!document.getElementById('novel-reader-host')`));

  // meta refresh 定时跳转：注入后应被守卫移除且不发生跳转
  await evalJs(cdp, `(()=>{
    const m = document.createElement('meta');
    m.setAttribute('http-equiv', 'refresh');
    m.setAttribute('content', '0; url=' + ${JSON.stringify(OTHER + '/longsite/2.html')});
    document.head.appendChild(m);
    return true;
  })()`);
  await sleep(1600);
  check('阅读中：动态 meta refresh 被移除', await evalJs(cdp, `!document.querySelector('meta[http-equiv]') || !/^refresh$/i.test(document.querySelector('meta[http-equiv]').getAttribute('http-equiv') || '')`));
  check('阅读中：未发生 meta refresh 跳转', await evalJs(cdp, `location.origin`) === BASE);

  // ---- 3. window.open 包装（配真实用户激活，排除弹窗拦截器的假阳性） ----
  const before = await pageTargets();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 450, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 450, button: 'left', clickCount: 1 });
  const opened = await evalJs(cdp, `window.open(${JSON.stringify(OTHER + '/longsite/1.html')}) ? 'opened' : 'null'`);
  await sleep(600);
  check('阅读中：带用户激活的 window.open 返回 null', opened === 'null', opened);
  check('阅读中：无新标签页产生', (await pageTargets()) === before);

  // ---- 4. 退出阅读：规则与守卫同步放行 ----
  await evalJs(cdp, `NR.reader.close()`, ctx);
  await sleep(900); // 会话规则撤销消息往返
  check('退出后：阅读视图已关闭', await evalJs(cdp, `!document.getElementById('novel-reader-host')`));
  check('退出后：跨域 fetch 恢复', (await evalJs(cdp, fetchProbe(`${OTHER}/longsite/2.html`, 'no-cors'))) === 'ok');
  check('退出后：外域 script 可加载（规则已撤）', (await evalJs(cdp, scriptProbe(OTHER))) === 'loaded');

  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${cdp.targetId}`, { method: 'PUT' }); } catch (e) { /* 忽略 */ }
  cdp.ws.close();
} catch (e) {
  console.error('✗ 异常终止：', e.message);
  failed++;
} finally {
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  clearTimeout(watchdog);
  try { proc.kill('SIGKILL'); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
