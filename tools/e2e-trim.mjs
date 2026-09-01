#!/usr/bin/env node
/**
 * 回归测试：拼接下一章触发 DOM 章节收起（_trimChapters）时，视口内容必须原地不动。
 *
 * 背景 bug：读到第 13 章起，每次拼接下一章都会把视口上方最旧的章节移出 DOM；
 * 内容变短后浏览器把越界的 scrollTop 钳位到新最大值 → 视口跳到新章末尾，需往回翻页找进度。
 * v0.2.10 起改为等高占位柱（.nr-pillow）：收起章节用等高 div 顶住原流高度，视口几何
 * 零变化、scrollTop 零写入（旧机制按当前章元素位移回写补偿，曾诱发工具栏误弹）；
 * 回填章节时按插入实测的流高度收缩占位柱（场景三/四）。
 *
 * 判定方式：以视口内某段落为锚点，拼接前后 getBoundingClientRect().top 变化必须 ≤ 2px；
 * 收起前后 scrollTop 必须逐位相等（零写入）。
 * 为消除“滚动事件 → 异步拼接”的竞态，构建满 12 章后关闭 autoAppend，
 * 直接在隔离世界调用 NR.reader._appendByUrl(url, false) —— 与自动拼接走同一条代码路径。
 *
 * 视口覆盖：桌面 1000×900 / 手机竖屏 390×844 / 手机横屏 844×390
 * （横屏高度 390px < APPEND_THRESHOLD_PX 600px，压测小屏下的阈值与补偿边界）。
 *
 * 另含两个数值限制回归（桌面档执行一次）：
 *  - 弱网熔断恢复：3 次失败的 URL，用户主动重试（scroll=true）应清零计数重新请求；
 *  - 超长目录：>800 章的书目录应完整渲染（上限与 parseCatalog 的 3000 对齐）。
 *
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-trim.mjs <项目根目录>
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME =
  process.env.NR_TEST_BROWSER ||
  '/Users/tywww/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '.');
const PORT = 9337;
const PROFILE = '/tmp/nr-trim-profile';
const BASE = 'http://127.0.0.1:8080';

const VIEWPORTS = [
  { name: '桌面 1000×900', width: 1000, height: 900, mobile: false, dsf: 1 },
  { name: '手机竖屏 390×844', width: 390, height: 844, mobile: true, dsf: 3 },
  { name: '手机横屏 844×390', width: 844, height: 390, mobile: true, dsf: 2 }
];

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

async function until(cdp, expression, timeout = 10000, interval = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evalJs(cdp, expression)) return true;
    if (Date.now() > deadline) throw new Error('timeout: ' + expression.slice(0, 80));
    await sleep(interval);
  }
}

/** 同 until，但表达式须在内容脚本隔离世界求值（NR.* 不可见于主世界） */
async function untilCtx(cdp, ctx, expression, timeout = 10000, interval = 120) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evalJs(cdp, expression, ctx)) return true;
    if (Date.now() > deadline) throw new Error('timeout: ' + expression.slice(0, 80));
    await sleep(interval);
  }
}

rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: 'ignore' });
const watchdog = setTimeout(() => { console.error('⏱ 超时退出'); try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, 420000);

/**
 * 单视口完整场景：进入阅读模式 → 滚动拼接构建 12 章 → 手动触发两次收起，
 * 断言锚点段落视口位移 ≤ 2px。extras=true 时追加熔断恢复与超长目录检查。
 */
async function runViewport(vp, extras) {
  console.log(`\n[视口] ${vp.name}（mobile=${vp.mobile}）`);
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${BASE}/longsite/1.html`)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await CDP.connect(res.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf, mobile: vp.mobile
    });
    await sleep(1800); // document_idle + boot + 悬浮按钮

    const SR = `document.getElementById('novel-reader-host').shadowRoot`;
    const domCount = () => evalJs(cdp, `${SR}.querySelectorAll('.nr-chapter').length`);
    const anchorTop = () => evalJs(cdp, `${SR}.querySelector('[data-nr-anchor]').getBoundingClientRect().top`);

    await evalJs(cdp, `document.getElementById('novel-reader-float-btn').click()`);
    await sleep(800);
    check('进入阅读模式', await evalJs(cdp, `!!document.getElementById('novel-reader-host')`));

    for (let k = 2; k <= 12; k++) {
      await evalJs(cdp, `(()=>{const sc=${SR}.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
      await until(cdp, `${SR}.querySelectorAll('.nr-chapter').length >= ${k}`);
    }
    check('连续拼接构建 12 章', (await domCount()) === 12, '实际 ' + (await domCount()));

    const ctx = cdp.isolatedContextId();
    check('内容脚本隔离世界可用', ctx != null);
    await evalJs(cdp, `NR.settings.autoAppend = false`, ctx);

    // ---- 场景一：首次收起（一次移除多章），停在读完第 11 章底部 ----
    const nextUrl1 = await evalJs(cdp, `(()=>{
      const st = NR.reader.state;
      const el = st.chapters[st.currentIndex].el;
      const ps = el.querySelectorAll('.nr-p');
      ps[ps.length - 1].setAttribute('data-nr-anchor', '1');
      return st.chapters[st.chapters.length - 1].data.nextUrl;
    })()`, ctx);
    const top0 = await anchorTop();
    const stTop0 = await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`);
    const headerBefore = await evalJs(cdp, `${SR}.querySelector('.nr-chapter-name').textContent`);

    await evalJs(cdp, `NR.reader._appendByUrl(${JSON.stringify(nextUrl1)}, false)`, ctx); // 拼接第 13 章 → 触发收起

    const top1 = await anchorTop();
    const jump1 = Math.abs(top1 - top0);
    check('首次收起（移除多章）视口内容不动', jump1 <= 2, `锚点位移 ${jump1.toFixed(1)}px（${top0.toFixed(1)}→${top1.toFixed(1)}）`);
    check('首次收起 scrollTop 零写入（等高占位）', (await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`)) === stTop0, `${stTop0} → ${await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`)}`);
    check('DOM 章节窗口收缩', (await domCount()) === 8, '实际 ' + (await domCount()));
    check('收起提示条出现', (await evalJs(cdp, `${SR}.querySelector('.nr-collapsed').textContent`)).includes('已收起前 5 章'));
    check('当前章未变（头部章节名）', (await evalJs(cdp, `${SR}.querySelector('.nr-chapter-name').textContent`)) === headerBefore);

    // ---- 场景二：滑窗收起（滚到底读完第 13 章后再拼接，再收起旧章） ----
    await evalJs(cdp, `(()=>{const sc=${SR}.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
    await sleep(400); // 等 _onScroll 判定当前章
    const curTitle = await evalJs(cdp, `(()=>{
      const st = NR.reader.state;
      st.pages.querySelector('[data-nr-anchor]') && st.pages.querySelector('[data-nr-anchor]').removeAttribute('data-nr-anchor');
      const el = st.chapters[st.currentIndex].el;
      el.querySelectorAll('.nr-p')[el.querySelectorAll('.nr-p').length - 1].setAttribute('data-nr-anchor', '1');
      return el.querySelector('.nr-ch-title').textContent;
    })()`, ctx);
    check('滚到底后当前章推进到第 13 章', curTitle.indexOf('第13章') === 0, curTitle);
    const top2 = await anchorTop();
    const stTop2 = await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`);
    const nextUrl2 = await evalJs(cdp, `NR.reader.state.chapters[NR.reader.state.chapters.length - 1].data.nextUrl`, ctx);

    await evalJs(cdp, `NR.reader._appendByUrl(${JSON.stringify(nextUrl2)}, false)`, ctx); // 拼接第 14 章 → 滑窗再收起旧章

    const top3 = await anchorTop();
    const jump2 = Math.abs(top3 - top2);
    check('滑窗收起（再移除旧章）视口内容不动', jump2 <= 2, `锚点位移 ${jump2.toFixed(1)}px（${top2.toFixed(1)}→${top3.toFixed(1)}）`);
    check('滑窗收起 scrollTop 零写入（等高占位）', (await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`)) === stTop2, `${stTop2} → ${await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`)}`);
    const note2 = await evalJs(cdp, `${SR}.querySelector('.nr-collapsed').textContent`);
    check('滑窗后 DOM 章节维持窗口上限', (await domCount()) === 7 && note2.includes('已收起前 7 章'), `DOM=${await domCount()}，${note2}`);

    await evalJs(cdp, `NR.settings.autoAppend = true`, ctx); // 还原

    // ---- 场景三：真实点击下三分之一翻页 → 自动拼接 → 收起（上报 bug 回归） ----
    // 旧机制：收起后回写 scrollTop 补偿（回退近万 px）→ 滚动监听误判用户上滚 → 工具栏弹出。
    // 新机制：等高占位柱顶住流高度，scrollTop 零写入，滚动序列只增不减。
    const pillowH0 = await evalJs(cdp, `parseFloat(${SR}.querySelector('.nr-pillow').style.height)`);
    check('场景三初始：占位柱已就位', pillowH0 > 0, '高度 ' + pillowH0);
    await evalJs(cdp, `(()=>{const sc=${SR}.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight-sc.clientHeight-900;})()`);
    await sleep(450); // 等 _onScroll 判定当前章（余量 900 > 600，不触发拼接）
    await evalJs(cdp, `NR.reader._hideHeader()`, ctx);
    check('场景三初始：工具栏隐藏', await evalJs(cdp, `${SR}.querySelector('.nr-header').classList.contains('nr-hidden')`));
    const len0 = await evalJs(cdp, `NR.reader.state.chapters.length`, ctx);
    await evalJs(cdp, `(()=>{
      const st=NR.reader.state;
      st.__rec=[];
      st.scroller.addEventListener('scroll', ()=>st.__rec.push(st.scroller.scrollTop));
      return true;
    })()`, ctx);
    const pt = await evalJs(cdp, `(()=>{const r=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.bottom-Math.max(48,r.height*0.12))};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await untilCtx(cdp, ctx, `NR.reader.state.appending===false && NR.reader.state.chapters.length>=${len0 + 1}`);
    await sleep(300);
    const rec = await evalJs(cdp, `NR.reader.state.__rec`, ctx);
    const mono = Array.isArray(rec) && rec.length > 0 && rec.every((v, i) => i === 0 || v >= rec[i - 1] - 0.5);
    check('点击翻页+拼接收起：滚动序列只增不减（无补偿回写）', mono, JSON.stringify(rec));
    check('点击翻页+拼接收起：工具栏保持隐藏（上报 bug 回归）', await evalJs(cdp, `${SR}.querySelector('.nr-header').classList.contains('nr-hidden')`));
    const domN = await evalJs(cdp, `${SR}.querySelectorAll('.nr-chapter').length`);
    check('收起后 DOM 章节窗口维持上限', domN <= 12, '实际 ' + domN);
    check('记录无重复', await evalJs(cdp, `NR.reader.state.chapters.length===new Set(NR.reader.state.chapters.map(c=>c.data.url)).size`, ctx));

    if (extras) {
      // ---- 场景四：回填等高 + 程序滚动标记（v0.2.10） ----
      // 把当前章推进到窗口上缘（模拟连续 goPrev 的稳态），其上一章必为已收起记录，
      // _appendByUrl 命中恢复路径：回填 + 上跳。旧机制上跳会被 dy<-6 误判弹工具栏，
      // 新机制 _scrollToChapter 置 progScroll 标记跳过手势判定。
      await evalJs(cdp, `(()=>{const st=NR.reader.state;st.currentIndex=Math.max(0,st.currentIndex-5);return true;})()`, ctx);
      const ci = await evalJs(cdp, `NR.reader.state.currentIndex`, ctx);
      const backIdx = ci - 1;
      check('场景四初始：目标章处于已收起状态', backIdx >= 0 && await evalJs(cdp, `!NR.reader.state.chapters[${backIdx}].el`, ctx));
      const backUrl = await evalJs(cdp, `NR.reader.state.chapters[${backIdx}].data.url`, ctx);
      const pillowH1 = await evalJs(cdp, `parseFloat(${SR}.querySelector('.nr-pillow').style.height)`);
      const cntCollapsed = await evalJs(cdp, `NR.reader.state.collapsedCount`, ctx);
      await evalJs(cdp, `NR.reader._hideHeader()`, ctx);
      const r4 = await evalJs(cdp, `NR.reader._appendByUrl(${JSON.stringify(backUrl)}, true)`, ctx);
      await sleep(600);
      const el4 = await evalJs(cdp, `(()=>{const c=NR.reader.state.chapters[${backIdx}];const el=c&&c.el;return el?{top:el.offsetTop,h:el.offsetHeight,ps:el.querySelectorAll('.nr-p').length}:null;})()`, ctx);
      check('回填成功且带正文', r4 === backIdx && !!el4 && el4.ps > 0, `结果 ${r4}，段落 ${el4 && el4.ps}`);
      const st4 = await evalJs(cdp, `${SR}.querySelector('.nr-scroll').scrollTop`);
      check('回填后视口落在该章', st4 >= el4.top - 30 && st4 <= el4.top + el4.h, `scrollTop ${st4}，章 [${el4.top}, ${el4.top + el4.h}]`);
      check('回填上跳后工具栏保持隐藏（程序滚动标记）', await evalJs(cdp, `${SR}.querySelector('.nr-header').classList.contains('nr-hidden')`));
      check('回填不产生重复记录', await evalJs(cdp, `NR.reader.state.chapters.filter(c=>c.data.url===${JSON.stringify(backUrl)}).length`, ctx) === 1);
      const pillowH2 = await evalJs(cdp, `parseFloat((${SR}.querySelector('.nr-pillow')||{style:{height:'0px'}}).style.height)`);
      check('占位柱按插入实测差值收缩', pillowH2 < pillowH1, `${pillowH1} → ${pillowH2}`);
      check('当前章推进到回填章', await evalJs(cdp, `NR.reader.state.currentIndex`, ctx) === backIdx);
      const note4 = await evalJs(cdp, `(${SR}.querySelector('.nr-collapsed')||{textContent:'(无)'}).textContent`);
      check('收起提示随回填更新', note4.includes(`已收起前 ${cntCollapsed - 1} 章`), note4);

      // ---- 数值限制回归一：弱网熔断（3 次失败计数累积 + 用户主动重试清零） ----
      const badUrl = `${BASE}/longsite/999.html`;
      for (let i = 0; i < 3; i++) {
        await evalJs(cdp, `NR.loader.getChapter(${JSON.stringify(badUrl)}).catch(()=>{})`, ctx);
      }
      const cnt0 = await evalJs(cdp, `NR.loader.cache.get(${JSON.stringify(badUrl)}).count`, ctx);
      const tripped = await evalJs(cdp, `NR.loader.getChapter(${JSON.stringify(badUrl)}).then(()=>'no-throw', (e)=> e.message)`, ctx);
      const retryRes = await evalJs(cdp, `NR.reader._appendByUrl(${JSON.stringify(badUrl)}, true)`, ctx); // 用户主动重试（吞错返回 -1）
      const cnt1 = await evalJs(cdp, `NR.loader.cache.get(${JSON.stringify(badUrl)}).count`, ctx);
      check('失败计数正确累积到 3（旧代码恒为 1，熔断失效）', cnt0 === 3, '实际 ' + cnt0);
      check('熔断后不再发请求（快速失败）', /HTTP 404/.test(String(tripped)), String(tripped));
      check('用户重试清零计数并真实重新请求', retryRes === -1 && cnt1 === 1, `结果 ${retryRes}，count ${cnt0}→${cnt1}`);

      // ---- 数值限制回归二：超长目录完整渲染（旧上限 800 会截断 1200 章的书） ----
      await evalJs(cdp, `(()=>{
        NR.reader.state.catalogList = Array.from({ length: 1200 }, (_, i) => ({ title: '第' + (i + 1) + '章 目录压测', url: '${BASE}/longsite/' + (i % 16 + 1) + '.html' }));
        NR.reader._renderCatalogList('');
        return true;
      })()`, ctx);
      const catN = await evalJs(cdp, `${SR}.querySelectorAll('.nr-cat-item').length`);
      check('超长目录（1200 章）完整渲染', catN === 1200, '实际 ' + catN);
    }
  } finally {
    try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }
  await runViewport(VIEWPORTS[0], true);
  await runViewport(VIEWPORTS[1], false);
  await runViewport(VIEWPORTS[2], false);
} catch (e) {
  failed++;
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
try { proc.kill('SIGKILL'); } catch (e) {}
await sleep(500); // 等 Chrome 进程完全退出再清临时目录
let cleanErr = null;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { cleanErr = e; }
console.log(`\n结果：${passed} 通过，${failed} 失败${cleanErr ? '（临时目录清理失败，可忽略）' : ''}`);
process.exit(failed ? 1 : 0);
