#!/usr/bin/env node
/**
 * 端到端测试：用 headless Chrome 加载未打包扩展，对本地 fixture 站点做全流程验证。
 * 零依赖（Node 22+ 全局 WebSocket + fetch + CDP）。
 * 运行：node tools/e2e-test.mjs <项目根目录> [--headed]
 * 前置：python3 -m http.server -d test/fixtures 8080 已启动
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Chrome for Testing（Playwright 缓存）支持 --load-extension；正式版 Chrome 137+ 已移除该开关
const CHROME =
  process.env.NR_TEST_BROWSER ||
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '.');
const HEADED = process.argv.includes('--headed');
const PORT = 9333;
const PROFILE = '/tmp/nr-e2e-profile';
const BASE = 'http://127.0.0.1:8080';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra && !cond ? '  → ' + extra : ''));
  cond ? passed++ : failed++;
}

// ---------------- CDP 客户端 ----------------
class CDP {
  constructor(ws) {
    this.ws = ws;
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
  async waitEvent(method, timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const idx = this.events.findIndex((e) => e.method === method);
      if (idx >= 0) return this.events.splice(idx, 1)[0];
      if (Date.now() > deadline) throw new Error('timeout waiting ' + method);
      await sleep(100);
    }
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

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch (e) {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('devtools 未启动');
}

async function openPage(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.waitEvent('Page.loadEventFired').catch(() => {});
  await sleep(1500); // document_idle + boot + 悬浮按钮检测
  return cdp;
}

async function evalJs(cdp, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId != null) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params);
  if (r.exceptionDetails) throw new Error(expression.slice(0, 80) + ' => ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
}

async function screenshot(cdp, path) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('  📸 ' + path);
}

// ---------------- 主流程 ----------------
rmSync(PROFILE, { recursive: true, force: true });
const args = [
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank'
];
if (!HEADED) args.unshift('--headless=new');
const proc = spawn(CHROME, args, { stdio: 'ignore' });

try {
  await waitForDevtools();
  const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
  console.log('扩展加载：', targets.some((t) => t.type === 'service_worker' || t.url.startsWith('chrome-extension')) ? '✓ service worker 已注册' : '（无 service worker 目标，仅检查内容脚本）');

  // ============ 测试一：UTF-8 站点完整流程 ============
  console.log('\n[测试一] UTF-8 站点 http://127.0.0.1:8080/utf8site/1.html');
  const cdp1 = await openPage(`${BASE}/utf8site/1.html`);

  const hasBtn = await evalJs(cdp1, `!!document.getElementById('novel-reader-float-btn')`);
  check('悬浮按钮出现在小说页', hasBtn);

  await evalJs(cdp1, `document.getElementById('novel-reader-float-btn').click()`);
  await sleep(800);
  const opened = await evalJs(cdp1, `!!document.getElementById('novel-reader-host')`);
  check('点击后进入阅读模式', opened);
  if (opened) {
    await screenshot(cdp1, '/tmp/nr-e2e-reader-open.png');

    const bodyHidden = await evalJs(cdp1, `getComputedStyle(document.body).display === 'none'`);
    check('原页面已隐藏', bodyHidden);

    const defaultWidth = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-root').style.getPropertyValue('--nr-width')`);
    check('宽度默认值为 75% 视口', defaultWidth === 'min(75%, calc(100% - 48px))', defaultWidth);

    const title = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-ch-title').textContent`);
    check('章节标题提取正确', title === '第一章 雨夜客栈', JSON.stringify(title));

    const pCount = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelectorAll('.nr-p').length`);
    check('段落数正确（30 段，水印已清）', pCount === 30, '实际 ' + pCount);

    const firstP = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-p').textContent`);
    check('首段内容正确', firstP.startsWith('暮色四合，秋雨绵绵'), firstP.slice(0, 20));

    const allText = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-pages').textContent`);
    check('水印文案已清除', !allText.includes('最快更新') && !allText.includes('一秒记住') && !allText.includes('booktest.local'));

    // 滚动到底 → 自动预加载并拼接第二章
    await evalJs(cdp1, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;return sc.scrollHeight;})()`);
    await sleep(2000);
    let arts = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelectorAll('.nr-chapter').length`);
    check('滚动触发预加载并拼接第二章', arts === 2, '实际章节数 ' + arts);

    let t2 = await evalJs(cdp1, `[...document.getElementById('novel-reader-host').shadowRoot.querySelectorAll('.nr-ch-title')].map(h=>h.textContent).join('|')`);
    check('第二章标题正确', t2.includes('第二章 青衫书生'), t2);

    // 再滚 → 第三章
    await evalJs(cdp1, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
    await sleep(2000);
    arts = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelectorAll('.nr-chapter').length`);
    check('拼接第三章', arts === 3, '实际 ' + arts);
    await screenshot(cdp1, '/tmp/nr-e2e-reader-3chapters.png');

    // 第三章的下一章指向目录 → 应识别为最后一章
    await evalJs(cdp1, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
    await sleep(1200);
    arts = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelectorAll('.nr-chapter').length`);
    const tail = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-tail').textContent`);
    check('尾章正确停止（不抓目录页）', arts === 3 && tail.includes('最后一章'), `章节数 ${arts}，尾部：${tail.trim().slice(0, 20)}`);

    // 设置面板
    await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('[data-act="settings"]').click()`);
    await sleep(300);
    const panelOpen = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-root').classList.contains('nr-panel-open')`);
    check('排版设置面板可打开', panelOpen);
    const boxCount = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelectorAll('.nr-panel input[type="checkbox"]').length`);
    check('设置面板含 7 个开关（含点击翻页）', boxCount === 7, String(boxCount));

    // 宽度滑杆拖到 90%（百分比显示与实时生效）
    await evalJs(cdp1, `(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;const r=sr.querySelector('input[type="range"][data-key="widthPercent"]');r.value='90';r.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(400);
    const w90 = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-root').style.getPropertyValue('--nr-width')`);
    check('宽度滑杆 90% 实时生效', w90 === 'min(90%, calc(100% - 48px))', w90);

    // 全屏宽度开关（面板中第一个 checkbox）
    await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-panel input[type="checkbox"]').click()`);
    await sleep(400);
    const fullW = await evalJs(cdp1, `(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;const root=sr.querySelector('.nr-root');return JSON.stringify({w:root.style.getPropertyValue('--nr-width'), disabled:sr.querySelector('input[type="range"][data-key="widthPercent"]').disabled});})()`);
    const fw = JSON.parse(fullW);
    check('全屏宽度生效且滑杆置灰', fw.w === 'calc(100% - 48px)' && fw.disabled === true, JSON.stringify(fw));
    await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-panel input[type="checkbox"]').click()`);
    await sleep(300);
    await screenshot(cdp1, '/tmp/nr-e2e-reader-panel.png');
    await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scrim').click()`);
    await sleep(300);

    // 悬浮栏不遮挡章节标题（回到顶部，测量几何位置）
    await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll').scrollTop = 0`);
    await sleep(500);
    const ov = JSON.parse(await evalJs(cdp1, `(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;const h=sr.querySelector('.nr-header').getBoundingClientRect();const t=sr.querySelector('.nr-ch-title').getBoundingClientRect();return JSON.stringify({headerBottom:Math.round(h.bottom), titleTop:Math.round(t.top)});})()`));
    check('悬浮栏不遮挡章节标题', ov.titleTop >= ov.headerBottom - 1, JSON.stringify(ov));

    // 键盘翻页：一次恰好一屏略小（90% 视口高，保留 10% 重叠）
    const scrollTop = () => evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll').scrollTop`);
    const chH = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll').clientHeight`);
    const st0 = await scrollTop();
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown'}))`);
    await sleep(200);
    const st1 = await scrollTop();
    check('PageDown 精确翻 90% 屏', Math.abs(st1 - st0 - Math.round(chH * 0.9)) <= 4, `Δ=${st1 - st0} 期望≈${Math.round(chH * 0.9)}`);
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space'}))`);
    await sleep(200);
    const st2 = await scrollTop();
    check('空格向下翻页', st2 > st1, `${st1}→${st2}`);
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',shiftKey:true}))`);
    await sleep(200);
    const st3 = await scrollTop();
    check('Shift+空格向上翻页', st3 < st2, `${st2}→${st3}`);
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp'}))`);
    await sleep(200);
    const st4 = await scrollTop();
    check('PageUp 向上翻页', st4 < st3, `${st3}→${st4}`);

    // 点击上/下三分之一区域翻页（真实鼠标事件）
    const zone = JSON.parse(await evalJs(cdp1, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');const r=sc.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2), yBottom:Math.round(r.top+r.height*0.85), yTop:Math.round(r.top+r.height*0.15)});})()`));
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zone.x, y: zone.yBottom, button: 'left', clickCount: 1 });
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zone.x, y: zone.yBottom, button: 'left', clickCount: 1 });
    await sleep(250);
    const st5 = await scrollTop();
    check('点击下三分之一向下翻页', st5 > st4, `${st4}→${st5}`);
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zone.x, y: zone.yTop, button: 'left', clickCount: 1 });
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zone.x, y: zone.yTop, button: 'left', clickCount: 1 });
    await sleep(250);
    const st6 = await scrollTop();
    check('点击上三分之一向上翻页', st6 < st5, `${st5}→${st6}`);

    // 点击中间三分之一：唤出 / 收起工具栏（toggle）
    const ctx1 = cdp1.isolatedContextId();
    await evalJs(cdp1, `NR.reader._hideHeader()`, ctx1);
    const mid = JSON.parse(await evalJs(cdp1, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');const r=sc.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});})()`));
    const hdrHidden = () => evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-header').classList.contains('nr-hidden')`);
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
    await sleep(250);
    check('点击中间区域唤出工具栏', !(await hdrHidden()));
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
    await sleep(250);
    check('再次点击中间区域收起工具栏', await hdrHidden());

    // 字号调整（快捷键 +）
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'+'}))`);
    await sleep(300);
    const fs = await evalJs(cdp1, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-root').style.getPropertyValue('--nr-fs')`);
    check('快捷键调整字号生效', fs === '20px', fs);

    // Esc 退出 → 原页面还原
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    await sleep(500);
    const closed = await evalJs(cdp1, `!document.getElementById('novel-reader-host')`);
    const bodyBack = await evalJs(cdp1, `getComputedStyle(document.body).display !== 'none'`);
    check('Esc 退出阅读模式', closed);
    check('原页面完整还原', bodyBack);

    // 重新进入 → 进度恢复（同一 URL）
    await evalJs(cdp1, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})) /* noop */`);
    const reopened = await evalJs(cdp1, `globalThis.NR ? globalThis.NR.reader.open() : false`).catch(() => false);
    // NR 在隔离世界，页面主世界拿不到——改用悬浮按钮重进
    const reopenedViaBtn = reopened || (await evalJs(cdp1, `document.getElementById('novel-reader-float-btn') ? (document.getElementById('novel-reader-float-btn').click(), true) : false`).catch(() => false));
    await sleep(800);
    const reOpenedOk = await evalJs(cdp1, `!!document.getElementById('novel-reader-host')`);
    check('可再次进入阅读模式', reOpenedOk);
    await evalJs(cdp1, `(()=>{const h=document.getElementById('novel-reader-host');if(h){const w=new KeyboardEvent('keydown',{key:'Escape'});window.dispatchEvent(w);}})()`);
  }
  await cdp1.ws.close();

  // ============ 测试二：GBK 站点 ============
  console.log('\n[测试二] GBK 站点 http://127.0.0.1:8080/gbksite/1.html');
  const cdp2 = await openPage(`${BASE}/gbksite/1.html`);
  await evalJs(cdp2, `(document.getElementById('novel-reader-float-btn')||{click(){}}).click()`);
  await sleep(800);
  const gbkOk = await evalJs(cdp2, `(()=>{const h=document.getElementById('novel-reader-host');if(!h)return '未打开';const p=h.shadowRoot.querySelector('.nr-p');return p?p.textContent.slice(0,12):'无段落';})()`);
  check('GBK 站正文无乱码', gbkOk === '暮色四合，秋雨绵绵，官道', JSON.stringify(gbkOk));
  await evalJs(cdp2, `(()=>{const h=document.getElementById('novel-reader-host');if(h)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));})()`);
  await cdp2.ws.close();

  // ============ 测试三：非小说页零打扰 ============
  console.log('\n[测试三] 普通页面（目录页无正文）不出现悬浮按钮');
  const cdp3 = await openPage(`${BASE}/utf8site/index.html`);
  const noBtn = await evalJs(cdp3, `!document.getElementById('novel-reader-float-btn')`);
  check('目录页不出现悬浮按钮（正文不足）', noBtn);
  await cdp3.ws.close();

  // ============ 测试四：进度记录与快速跳转 ============
  console.log('\n[测试四] 进度记录、pendingOpen 自动打开、目录快速跳转');
  const cdp4 = await openPage(`${BASE}/utf8site/1.html`);
  const ctx = cdp4.isolatedContextId();
  check('内容脚本隔离世界可用', ctx != null);

  // 1) 打开阅读模式、滚动 → progress 记录落库
  await evalJs(cdp4, `globalThis.NR.reader.open()`, ctx);
  await sleep(600);
  await evalJs(cdp4, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=400;})()`);
  await sleep(2200); // 进度保存节流 1.5s
  const progressRaw = await evalJs(
    cdp4,
    `new Promise(res=>chrome.storage.local.get(null,s=>{const m={};for(const k of Object.keys(s))if(k.indexOf('p:')===0)m[k.slice(2)]=s[k];res(JSON.stringify(m))}))`,
    ctx
  );
  const progressMap = JSON.parse(progressRaw);
  const rec = Object.values(progressMap).find((r) => r && r.url && r.url.indexOf('/utf8site/1.html') >= 0);
  check('阅读进度已记录（章节+标题+章内位置，按书独立 key）', !!rec && rec.chapterTitle === '第一章 雨夜客栈' && rec.chapterRatio > 0, progressRaw.slice(0, 160));

  // 2) pendingOpen → 跳转第三章后自动进入阅读模式
  await evalJs(
    cdp4,
    `new Promise(res=>chrome.storage.local.set({pendingOpen:{url:'${BASE}/utf8site/3.html',ts:Date.now()}},res))`,
    ctx
  );
  await evalJs(cdp4, `location.assign('${BASE}/utf8site/3.html')`);
  await cdp4.waitEvent('Page.loadEventFired', 20000).catch(() => {});
  await sleep(3500);
  const autoOpened = await evalJs(cdp4, `(()=>{const h=document.getElementById('novel-reader-host');if(!h)return 'no';return h.shadowRoot.querySelector('.nr-ch-title').textContent;})()`);
  check('pendingOpen 落地自动进入阅读模式', autoOpened === '第三章 剑出如虹', String(autoOpened));

  // 3) 目录面板：列表、当前章高亮、搜索唯一命中定位、点击跳转
  await evalJs(cdp4, `document.getElementById('novel-reader-host').shadowRoot.querySelector('[data-act="catalog"]').click()`);
  await sleep(2000); // 目录页 fetch + 解析
  const catOpen = await evalJs(cdp4, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-root').classList.contains('nr-catalog-open')`);
  check('目录面板打开', catOpen);
  const catState = JSON.parse(await evalJs(cdp4, `(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;return JSON.stringify({count:sr.querySelectorAll('.nr-cat-item').length, cur:sr.querySelector('.nr-cat-item.nr-cur')?sr.querySelector('.nr-cat-item.nr-cur').textContent:'', counter:sr.querySelector('.nr-cat-count').textContent});})()`));
  check('目录列出全部 3 章且当前章高亮', catState.count === 3 && catState.cur.indexOf('第三章') === 0, JSON.stringify(catState));

  await evalJs(cdp4, `(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;const s=sr.querySelector('.nr-catalog-search');s.value='二';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(300);
  const filtered = JSON.parse(await evalJs(cdp4, `(()=>{const sr=document.getElementById('novel-reader-host').shadowRoot;const items=[...sr.querySelectorAll('.nr-cat-item')];const hit=sr.querySelector('.nr-cat-item.nr-hit');return JSON.stringify({count:items.length, hit:hit?hit.textContent:'', counter:sr.querySelector('.nr-cat-count').textContent});})()`));
  check('搜索“二”唯一命中：保留全量列表并标记定位', filtered.count === 3 && (filtered.hit || '').indexOf('第二章') === 0 && filtered.counter.indexOf('已定位') >= 0, JSON.stringify(filtered));

  await evalJs(cdp4, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-cat-item.nr-hit').click()`);
  await cdp4.waitEvent('Page.loadEventFired', 20000).catch(() => {});
  await sleep(3500);
  const jumped = await evalJs(cdp4, `(()=>{const h=document.getElementById('novel-reader-host');if(!h)return 'no:'+location.pathname;return h.shadowRoot.querySelector('.nr-ch-title').textContent;})()`);
  check('点击目录跳转第二章并自动进入阅读模式', jumped === '第二章 青衫书生', String(jumped));

  // 4) 拼接进入第三章后，进度动态同步到屏幕上的章节（预加载不同步回归）
  const ctx2 = cdp4.isolatedContextId();
  await evalJs(cdp4, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
  await sleep(2200); // 触发拼接第三章
  await evalJs(cdp4, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight-sc.clientHeight-20;})()`);
  await sleep(2300); // 章节切换即时落库
  const progAfter = JSON.parse(await evalJs(cdp4, `new Promise(res=>chrome.storage.local.get(null,s=>{const m={};for(const k of Object.keys(s))if(k.indexOf('p:')===0)m[k.slice(2)]=s[k];res(JSON.stringify(Object.values(m)))}))`, ctx2));
  const rec3 = progAfter.find((r) => r && (r.url || '').endsWith('/utf8site/3.html'));
  check('拼接滚动后进度同步到当前屏章节', !!rec3 && rec3.chapterRatio > 0, JSON.stringify(rec3 || {}).slice(0, 140));

  // 5) 续读落地：pendingOpen(resume) 重开第三章，恢复到章内位置
  await evalJs(cdp4, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(600);
  await evalJs(cdp4, `new Promise(res=>chrome.storage.local.set({pendingOpen:{url:'${BASE}/utf8site/3.html',ts:Date.now(),intent:'resume'}},res))`, ctx2);
  await evalJs(cdp4, `location.assign('${BASE}/utf8site/3.html')`);
  await cdp4.waitEvent('Page.loadEventFired', 20000).catch(() => {});
  await sleep(3500);
  const restored = JSON.parse(await evalJs(cdp4, `(()=>{const h=document.getElementById('novel-reader-host');if(!h)return JSON.stringify({title:'no'});const sc=h.shadowRoot.querySelector('.nr-scroll');const ch=h.shadowRoot.querySelector('.nr-chapter');return JSON.stringify({title:h.shadowRoot.querySelector('.nr-ch-title').textContent, top:Math.round(sc.scrollTop), chTop:ch.offsetTop});})()`));
  check('续读精确恢复章内位置', restored.title === '第三章 剑出如虹' && restored.top >= restored.chTop, JSON.stringify(restored));

  // 6) 从第一章自然进入 → 显示继续阅读提示条 → 点击跳回第三章
  await evalJs(cdp4, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(500);
  await evalJs(cdp4, `location.assign('${BASE}/utf8site/1.html')`);
  await cdp4.waitEvent('Page.loadEventFired', 20000).catch(() => {});
  await sleep(2000);
  await evalJs(cdp4, `(document.getElementById('novel-reader-float-btn')||{click(){}}).click()`);
  await sleep(1200);
  const chip = await evalJs(cdp4, `(()=>{const h=document.getElementById('novel-reader-host');if(!h)return 'no-reader';const c=h.shadowRoot.querySelector('.nr-resume');return c?c.textContent:'no-chip';})()`);
  check('自然进入显示继续阅读提示条', String(chip).indexOf('第三章') >= 0, String(chip));
  await screenshot(cdp4, '/tmp/nr-e2e-resume-chip.png');
  await evalJs(cdp4, `document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-resume-go').click()`);
  await cdp4.waitEvent('Page.loadEventFired', 20000).catch(() => {});
  await sleep(3500);
  const chipJump = await evalJs(cdp4, `(()=>{const h=document.getElementById('novel-reader-host');if(!h)return 'no';return h.shadowRoot.querySelector('.nr-ch-title').textContent;})()`);
  check('提示条点击跳回上次章节', chipJump === '第三章 剑出如虹', String(chipJump));
  await evalJs(cdp4, `(()=>{const h=document.getElementById('novel-reader-host');if(h)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));})()`);
  await cdp4.ws.close();

  // ============ 测试五：扩展重载后孤儿内容脚本不抛 "Extension context invalidated" ============
  console.log('\n[测试五] 扩展重载（孤儿内容脚本）后再次进入阅读模式');
  const cdp5 = await openPage(`${BASE}/utf8site/1.html`);
  const ctx5 = cdp5.isolatedContextId();
  check('内容脚本隔离世界可用（五）', ctx5 != null);
  // 在隔离世界记录未处理的 Promise 拒绝（复现用户控制台的 Uncaught 报错）
  await evalJs(cdp5, `window.__nrRejects=[];window.addEventListener('unhandledrejection',e=>{window.__nrRejects.push(String((e.reason&&e.reason.message)||e.reason))})`, ctx5);
  // 主世界记录 opened 事件（open() 完整走完才会派发）
  await evalJs(cdp5, `window.__nrOpened5=false;document.addEventListener('novelreader:opened',()=>{window.__nrOpened5=true})`);

  // 通过 service worker 执行 chrome.runtime.reload()，真实复现“扩展更新/重载后旧页面内容脚本失效”
  let orphaned = false;
  try {
    const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
    const browserCdp = await CDP.connect(ver.webSocketDebuggerUrl);
    await browserCdp.send('Target.setDiscoverTargets', { discover: true });
    let swTargetId = null;
    for (let i = 0; i < 50 && !swTargetId; i++) {
      const ev = await browserCdp.waitEvent('Target.targetCreated', 1000).catch(() => null);
      if (ev && ev.params.targetInfo.type === 'service_worker') swTargetId = ev.params.targetInfo.targetId;
    }
    if (swTargetId) {
      const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: swTargetId, flatten: true });
      await Promise.race([
        browserCdp.send('Runtime.evaluate', { expression: 'chrome.runtime.reload(); "reloading"' }, sessionId).catch(() => {}),
        sleep(4000)
      ]);
    }
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if (!(await evalJs(cdp5, `NR.extAlive()`, ctx5).catch(() => true))) { orphaned = true; break; }
    }
  } catch (e) { /* 重载失败时跳过本组断言 */ }
  check('扩展重载后旧页面内容脚本成为孤儿（chrome 上下文失效）', orphaned);

  // 孤儿页面点击悬浮按钮 → 阅读模式应照常打开且流程完整，不再产生未处理拒绝
  await evalJs(cdp5, `(document.getElementById('novel-reader-float-btn')||{click(){}}).click()`);
  await sleep(1200);
  const reopened5 = await evalJs(cdp5, `!!document.getElementById('novel-reader-host')`);
  check('孤儿页面仍可进入阅读模式', reopened5);
  check('进入流程完整（opened 事件已派发）', await evalJs(cdp5, `window.__nrOpened5`));
  const rejects5 = await evalJs(cdp5, `window.__nrRejects.slice()`, ctx5);
  check('无 "Extension context invalidated" 未处理拒绝', !rejects5 || !rejects5.some((t) => /invalidated/i.test(t)), JSON.stringify(rejects5));
  await evalJs(cdp5, `(()=>{const h=document.getElementById('novel-reader-host');if(h)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));})()`);
  await sleep(500);
  await cdp5.ws.close();
} catch (e) {
  failed++;
  console.error('异常：', e.message);
} finally {
  proc.kill('SIGKILL');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
