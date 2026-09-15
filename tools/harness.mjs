#!/usr/bin/env node
/**
 * tools/harness.mjs — 共享 E2E 测试基座
 *
 * 所有 e2e-*.mjs 共用：CDP 客户端、断言计数、浏览器启动、求值/轮询、service worker 求值。
 * 本文件只提供能力，不含任何场景；各 e2e 只保留自己的 PORT / PROFILE / 视口与断言。
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-<name>.mjs <项目根目录>
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME_DEFAULT =
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
export const CHROME = process.env.NR_TEST_BROWSER || CHROME_DEFAULT;
export const EXT = resolve(process.argv[2] || '.');
export const BASE = process.env.NR_TEST_BASE || 'http://127.0.0.1:8080';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
export function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra && !cond ? '  → ' + extra : ''));
  cond ? passed++ : failed++;
}
export function fail() {
  failed++;
}
/** 打印统一结果并返回失败数（调用方据此设置退出码） */
export function summary() {
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  return failed;
}

export class CDP {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    });
  }
  static async connect(url, label) {
    const ws = new WebSocket(url);
    await Promise.race([
      new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', () => rej(new Error('ws error（CDP 连接失败：确认 Chrome 能在当前环境启动；渲染进程崩溃也会报此错）')));
      }),
      sleep(5000).then(() => Promise.reject(new Error('ws connect timeout')))
    ]);
    return new CDP(ws, label);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // 目标页被 window.close 关掉后 WS 静默死亡，未决消息不得无限挂起
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 请求超时: ' + method));
        }
      }, 20000).unref();
    });
  }
  /** 取走一个已到达的事件（用于 Page.loadEventFired / Target.targetCreated 等） */
  async waitEvent(method, timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const idx = this.events.findIndex((e) => e.method === method);
      if (idx >= 0) return this.events.splice(idx, 1)[0];
      if (Date.now() > deadline) throw new Error('timeout waiting ' + method);
      await sleep(100);
    }
  }
  exceptions() {
    return this.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
  }
  /** 最新一个扩展内容脚本隔离世界的 contextId（导航后内容脚本重建，取最新即可） */
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

export async function waitForDevtools(port, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch (e) {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error('browser not ready on port ' + port);
    await sleep(200);
  }
}

/**
 * 启动加载了未打包扩展的 Chrome。默认 headless；headed=true 时显示窗口。
 * windowSize 形如 '1000,900'；userAgent/extraArgs 可选。
 */
export function launchChrome({ port, profile, ext = EXT, headed = false, windowSize, userAgent, extraArgs = [] }) {
  rmSync(profile, { recursive: true, force: true });
  const args = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    `--remote-debugging-port=${port}`
  ];
  if (windowSize) args.push(`--window-size=${windowSize}`);
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  if (!headed) args.unshift('--headless=new');
  args.push(...extraArgs, 'about:blank');
  return spawn(CHROME, args, { stdio: 'ignore' });
}

export async function evalJs(cdp, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId != null) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params);
  if (r.exceptionDetails) {
    throw new Error(expression.slice(0, 80) + ' => ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  }
  return r.result.value;
}

/** 轮询求值直到真值/超时。导航瞬间上下文销毁会被吞掉并继续等（超时信息里带上最后一次错误）。 */
export async function until(cdp, expression, timeout = 10000, interval = 150, contextId) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  for (;;) {
    let v = null;
    try {
      v = await evalJs(cdp, expression, contextId);
    } catch (e) {
      lastErr = e;
    }
    if (v) return true;
    if (Date.now() > deadline) throw new Error('timeout: ' + expression.slice(0, 80) + (lastErr ? ' | ' + lastErr.message : ''));
    await sleep(interval);
  }
}

export async function untilCtx(cdp, ctx, expression, timeout = 10000, interval = 120) {
  return until(cdp, expression, timeout, interval, ctx);
}

export async function screenshot(cdp, path) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('  📸 ' + path);
}

export async function pageTargets(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  return list.filter((t) => t.type === 'page').length;
}

/** 在 service worker 上下文求值（用于检查 DNR 会话规则） */
export async function swEval(port, expression) {
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const bcdp = await CDP.connect(ver.webSocketDebuggerUrl);
  try {
    await bcdp.send('Target.setDiscoverTargets', { discover: true });
    let swTargetId = null;
    for (let i = 0; i < 50 && !swTargetId; i++) {
      const ev = await bcdp.waitEvent('Target.targetCreated', 1000).catch(() => null);
      if (ev && ev.params.targetInfo.type === 'service_worker') swTargetId = ev.params.targetInfo.targetId;
    }
    if (!swTargetId) throw new Error('未找到 service worker 目标');
    const { sessionId } = await bcdp.send('Target.attachToTarget', { targetId: swTargetId, flatten: true });
    const r = await bcdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  } finally {
    try {
      bcdp.ws.close();
    } catch (e) {
      /* 已关闭 */
    }
  }
}
