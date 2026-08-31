#!/usr/bin/env node
/** 调试：连接启动自带的 about:blank 标签页 → 再导航 → 捕获内容脚本全部事件 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME =
  process.env.NR_TEST_BROWSER ||
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '/tmp/nr-ext-test');
const URL = process.argv[3] || 'http://127.0.0.1:8080/utf8site/1.html';
const PORT = 9339;
const PROFILE = '/tmp/nr-e2e-debug-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: 'ignore' });
setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, 45000).unref();

const fetchJson = async (u, opts) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await (await fetch(u, { ...opts, signal: ctrl.signal })).json();
  } finally {
    clearTimeout(t);
  }
};

const wsUrlOf = async () => {
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('没有可用页面目标: ' + JSON.stringify(targets.map((t) => t.type + t.url)));
  return page.webSocketDebuggerUrl;
};

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch (e) {
      /* retry */
    }
    await sleep(200);
  }
  const ws = new WebSocket(await wsUrlOf());
  await Promise.race([
    new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws error')));
    }),
    sleep(5000).then(() => Promise.reject(new Error('ws connect timeout')))
  ]);

  let id = 0;
  const pending = new Map();
  const logs = [];
  const ctxs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    } else if (m.method === 'Runtime.executionContextCreated') {
      ctxs.push(`id=${m.params.context.id} name=${JSON.stringify(m.params.context.name)} origin=${m.params.context.origin}`);
    }
  });
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((r) => pending.set(i, r));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await sleep(3000);

  console.log('=== execution contexts ===');
  ctxs.forEach((c) => console.log(c));
  console.log('=== console ===');
  logs.forEach((l) => console.log(l));
  const r = await send('Runtime.evaluate', {
    expression: `({btn: !!document.getElementById('novel-reader-float-btn'), content: document.querySelectorAll('#content').length, bodyKids: document.body ? document.body.children.length : -1, title: document.title})`,
    returnByValue: true
  });
  console.log('=== page ===', JSON.stringify(r.result.value));
} catch (e) {
  console.error('调试异常：', e.message);
} finally {
  try { proc.kill('SIGKILL'); } catch (e) { /* noop */ }
}
