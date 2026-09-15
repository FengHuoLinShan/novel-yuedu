#!/usr/bin/env node
/**
 * 报错诊断：加载扩展后收集所有目标的异常与控制台错误。
 * 覆盖：内容脚本（隔离世界）、扩展 service worker、popup 页、chrome://extensions 内部状态。
 * 运行：node tools/e2e-errors.mjs <扩展目录> [真实URL]
 */
import { BASE, sleep, CDP, launchChrome, evalJs } from './harness.mjs';

const REAL_URL = process.argv[3] || '';
const PORT = 9344;
const PROFILE = '/tmp/nr-errors-profile';
const issues = []; // {source, level, text}
const addIssue = (source, level, text) => issues.push({ source, level, text: String(text).slice(0, 400) });

/** 给某个 session 挂错误收集（页面世界 + 隔离世界都会以 executionContext 出现） */
function watchRuntime(cdp, sessionId, label) {
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (sessionId && m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      addIssue(label, 'exception', (d.exception?.description || d.text || 'unknown') + (d.url ? ` @ ${d.url}:${d.lineNumber}` : ''));
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      addIssue(label, m.params.type, text + (m.params.stackTrace?.callFrames?.[0]?.url ? ` @ ${m.params.stackTrace.callFrames[0].url}` : ''));
    }
  });
}

const proc = launchChrome({ port: PORT, profile: PROFILE });
const watchdog = setTimeout(() => { console.error('⏱ 超时退出'); try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, REAL_URL ? 420000 : 120000);

async function openTab(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl, 'tab');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  watchRuntime(cdp, undefined, `页面[${url.slice(0, 40)}]`);
  await sleep(2500);
  return cdp;
}

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }

  // ---------- 浏览器级连接：发现并挂载 service worker ----------
  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  const browserCdp = await CDP.connect(ver.webSocketDebuggerUrl, 'browser');
  let extId = '';
  browserCdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Target.targetCreated') {
      const t = m.params.targetInfo;
      if (t.type === 'service_worker' && t.url.startsWith('chrome-extension://')) {
        extId = t.url.split('/')[2];
        browserCdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
          .then((r) => {
            const sid = r.sessionId;
            browserCdp.send('Runtime.enable', {}, sid);
            browserCdp.send('Log.enable', {}, sid);
            watchRuntime(browserCdp, sid, 'ServiceWorker');
            browserCdp.ws.addEventListener('message', (ev2) => {
              const m2 = JSON.parse(ev2.data);
              if (m2.sessionId !== sid) return;
              if (m2.method === 'Log.entryAdded' && ['error', 'warning'].includes(m2.params.entry.level)) {
                addIssue('ServiceWorker(Log)', m2.params.entry.level, m2.params.entry.text + ' ' + (m2.params.entry.url || ''));
              }
            });
            console.log('已挂载 Service Worker:', t.url.slice(0, 60));
          })
          .catch(() => {});
      }
    }
  });
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });

  // ---------- chrome://extensions 内部状态 ----------
  const cdpInt = await openTab('chrome://extensions-internals');
  const internals = await evalJs(cdpInt, 'document.body.innerText');
  const entries = JSON.parse(internals);
  const ours = entries.filter((e) => e.location === 'COMMAND_LINE' || (e.path || '').indexOf('nr-ext') >= 0 || (e.path || '').indexOf('小说') >= 0);
  for (const e of ours) {
    console.log(`\n扩展「${e.name}」v${e.version} status=${e.registry_status} disable_reasons=${JSON.stringify(e.disable_reasons)}`);
    if (e.disable_reasons && e.disable_reasons.length) addIssue('extensions-internals', 'error', '被禁用: ' + JSON.stringify(e.disable_reasons));
  }
  if (!extId) extId = (ours[0] && ours[0].path ? '' : '') || '';
  await cdpInt.ws.close();

  // ---------- fixture 全流程 ----------
  console.log('\n—— fixture 全流程 ——');
  const cdp = await openTab(`${BASE}/utf8site/1.html`);
  const flow = async (expr) => evalJs(cdp, expr);
  await flow(`(document.getElementById('novel-reader-float-btn')||{click(){}}).click()`);
  await sleep(1000);
  await flow(`(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
  await sleep(2200);
  await flow(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown'}))`);
  await flow(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'+'}))`);
  await flow(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}))`);
  await sleep(1500);
  await flow(`document.getElementById('novel-reader-host').shadowRoot.querySelector('[data-act="catalog"]').click()`);
  await sleep(2000);
  await flow(`document.getElementById('novel-reader-host').shadowRoot.querySelector('[data-act="settings"]').click()`);
  await sleep(500);
  await flow(`(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;const sel=sr.querySelectorAll('select')[0];sel.value='dark';sel.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(400);
  await flow(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await flow(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(600);

  // ---------- popup 页（作为标签页打开，覆盖 popup.js 逻辑） ----------
  console.log('—— popup 页 ——');
  const swTargets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const swUrl = (swTargets.find((t) => t.url.startsWith('chrome-extension://')) || {}).url || '';
  if (!extId && swUrl) extId = swUrl.split('/')[2];
  if (extId) {
    const cdpPopup = await openTab(`chrome-extension://${extId}/popup.html`);
    await sleep(1500);
    await cdpPopup.ws.close();
  } else {
    console.log('（未发现扩展 ID，跳过 popup 检查）');
  }

  // ---------- 真实站点（可选，等待 Cloudflare） ----------
  if (REAL_URL) {
    console.log('\n—— 真实站点 ——', REAL_URL);
    const cdpR = await CDP.connect((await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(REAL_URL)}`, { method: 'PUT' }).then((r) => r.json())).webSocketDebuggerUrl, 'real');
    await cdpR.send('Page.enable');
    await cdpR.send('Runtime.enable');
    watchRuntime(cdpR, undefined, '真实站点');
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      const ok = await evalJs(cdpR, `!!document.querySelector('.txtnav,#content,.noveltext') || (document.body && document.body.innerText.length > 3000)`).catch(() => false);
      if (ok) break;
    }
    await evalJs(cdpR, `(document.getElementById('novel-reader-float-btn')||{click(){}}).click()`).catch(() => {});
    await sleep(2500);
    await evalJs(cdpR, `(()=>{const sc=document.getElementById('novel-reader-host')&&document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');if(sc)sc.scrollTop=sc.scrollHeight;return !!sc;})()`).catch(() => {});
    await sleep(5000);
    await evalJs(cdpR, `(()=>{const h=document.getElementById('novel-reader-host');if(h)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return true;})()`).catch(() => {});
    await sleep(500);
    await cdpR.ws.close();
  }

  await sleep(1500); // 等待末尾异步错误
} catch (e) {
  addIssue('diagnostic', 'error', '诊断脚本异常: ' + e.message);
} finally {
  clearTimeout(watchdog);
  try { proc.kill('SIGKILL'); } catch (e) { /* noop */ }
}

console.log('\n========== 报错汇总 ==========');
if (!issues.length) {
  console.log('未捕获到任何异常 / 错误 / 警告 ✅');
} else {
  let errCount = 0;
  for (const i of issues) {
    const isErr = i.level === 'exception' || i.level === 'error';
    if (isErr) errCount++;
    console.log(`[${i.level}] ${i.source}\n    ${i.text.replace(/\n/g, '\n    ')}`);
  }
  console.log(`\n共 ${issues.length} 条（错误/异常 ${errCount}，警告 ${issues.length - errCount}）`);
  process.exitCode = errCount ? 1 : 0;
}
