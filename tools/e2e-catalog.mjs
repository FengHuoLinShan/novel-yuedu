#!/usr/bin/env node
/**
 * 回归测试：目录面板定位与移动端翻章按钮。
 *
 * 覆盖点：
 *  1. 打开目录自动定位当前阅读章：真实拉取 longsite 目录页，第 8 章进入阅读后
 *     打开目录，.nr-cur 高亮第 8 章且在列表可见区内。
 *  2. 定位滚动数学：注入 300 章目录、当前章指向第 200 章，断言 scrollTop > 0
 *     且高亮项居中（±60px）。旧实现精确 URL 相等，hash 差异即失配不定位。
 *  3. hash 兜底匹配：当前章 URL 加 #anchor 后仍能高亮定位（_catalogCurIndex 二级匹配）。
 *  4. 搜索唯一命中定位：搜“第123章”渲染全量 300 条 + .nr-hit 居中 + 计数含“已定位”；
 *     多命中“破晓”走过滤（150 条、无 .nr-hit、回到顶部）；无命中显示空态文案。
 *  5. 手机视口（--window-size=390,844 独立实例）：上一章/下一章按钮 ≥ 44×44。
 *     注：CDP setDeviceMetricsOverride 在无 viewport 声明的页面上不改变布局宽度
 *     （media query 不匹配），故手机场景用独立窗口尺寸启动，而非视口模拟。
 *
 * 运行：python3 -m http.server -d test/fixtures 8080 & 然后 node tools/e2e-catalog.mjs <项目根目录>
 */
import { rmSync } from 'node:fs';
import { BASE, sleep, check, fail, summary, CDP, launchChrome, evalJs, until } from './harness.mjs';

const procs = [];
const watchdog = setTimeout(() => {
  console.error('⏱ 超时退出');
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
  process.exit(2);
}, 180000);

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

// ---------------- 场景一：桌面 1000×900，目录定位 ----------------
async function runCatalog() {
  console.log('\n[桌面 1000×900] 目录定位与搜索');
  procs.push(launchChrome({ port: 9338, profile: '/tmp/nr-catalog-profile', windowSize: '1000,900' }));
  const cdp = await openTab(9338, `${BASE}/longsite/8.html`);
  const SR = `document.getElementById('novel-reader-host').shadowRoot`;
  const js = (expr) => evalJs(cdp, expr);
  try {
    await js(`document.getElementById('novel-reader-float-btn').click()`);
    await sleep(800);
    check('进入阅读模式', await js(`!!document.getElementById('novel-reader-host')`));

    const ctx = cdp.isolatedContextId();
    check('内容脚本隔离世界可用', ctx != null);

    // 真实目录拉取：打开面板 → 等目录解析完成
    await js(`${SR}.querySelector('[data-act="catalog"]').click()`);
    await until(cdp, `!!NR.reader.state.catalogList`, 10000, 150, ctx);
    await sleep(200);
    check('目录面板打开', await js(`${SR}.querySelector('.nr-root').classList.contains('nr-catalog-open')`));
    check('目录拉取 16 章', (await js(`${SR}.querySelectorAll('.nr-cat-item').length`)) === 16, '实际 ' + (await js(`${SR}.querySelectorAll('.nr-cat-item').length`)));

    const cur1 = await js(`(()=>{
      const list = ${SR}.querySelector('.nr-catalog-list');
      const a = list.querySelector('.nr-cat-item.nr-cur');
      if (!a) return null;
      return { text: a.textContent, top: a.offsetTop, scrollTop: list.scrollTop, view: list.clientHeight };
    })()`);
    check('当前章（第8章）高亮 .nr-cur', !!cur1 && cur1.text.indexOf('第8章') === 0, cur1 ? cur1.text : '无高亮项');
    check('高亮项在可见区内（打开即定位）', !!cur1 && cur1.top >= cur1.scrollTop - 5 && cur1.top <= cur1.scrollTop + cur1.view - 5,
      cur1 ? `top=${cur1.top} scrollTop=${cur1.scrollTop} view=${cur1.view}` : '无高亮项');

    // ---- 注入 300 章目录：定位滚动数学 + hash 兜底 ----
    await evalJs(cdp, `(()=>{
      const st = NR.reader.state;
      st.catalogList = Array.from({ length: 300 }, (_, i) => ({
        title: '第' + (i + 1) + '章 ' + (i % 2 ? '破晓' : '长夜') + '行',
        url: '${BASE}/longsite/cat/' + (i + 1) + '.html'
      }));
      st.chapters[st.currentIndex].meta.url = '${BASE}/longsite/cat/200.html';
      NR.reader._renderCatalogList('');
      return true;
    })()`, ctx);
    const cur2 = await js(`(()=>{
      const list = ${SR}.querySelector('.nr-catalog-list');
      const a = list.querySelector('.nr-cat-item.nr-cur');
      if (!a) return null;
      return { text: a.textContent, top: a.offsetTop, scrollTop: list.scrollTop, view: list.clientHeight };
    })()`);
    check('300 章目录当前章高亮第200章', !!cur2 && cur2.text.indexOf('第200章') === 0, cur2 ? cur2.text : '无高亮项');
    check('列表已滚动（scrollTop > 0）', !!cur2 && cur2.scrollTop > 0, cur2 ? 'scrollTop=' + cur2.scrollTop : '');
    check('当前章居中显示（±60px）', !!cur2 && Math.abs(cur2.top - (cur2.scrollTop + cur2.view / 2)) <= 60,
      cur2 ? `偏差 ${Math.abs(cur2.top - (cur2.scrollTop + cur2.view / 2)).toFixed(1)}px` : '');

    // hash 差异兜底：精确相等失配，应退到去 hash 匹配仍高亮
    await evalJs(cdp, `(()=>{
      const st = NR.reader.state;
      st.chapters[st.currentIndex].meta.url = '${BASE}/longsite/cat/200.html#anchor';
      NR.reader._renderCatalogList('');
      return true;
    })()`, ctx);
    const cur3 = await js(`${SR}.querySelector('.nr-cat-item.nr-cur') ? ${SR}.querySelector('.nr-cat-item.nr-cur').textContent : ''`);
    check('URL 带 #hash 差异仍高亮当前章', cur3.indexOf('第200章') === 0, cur3 || '无高亮项');

    // ---- 搜索唯一命中：全量渲染 + 定位到命中章附近 ----
    await evalJs(cdp, `NR.reader._renderCatalogList('第123章')`, ctx);
    const hit = await js(`(()=>{
      const list = ${SR}.querySelector('.nr-catalog-list');
      const a = list.querySelector('.nr-cat-item.nr-hit');
      if (!a) return null;
      return { text: a.textContent, top: a.offsetTop, scrollTop: list.scrollTop, view: list.clientHeight,
        n: ${SR}.querySelectorAll('.nr-cat-item').length };
    })()`);
    check('唯一命中渲染全量列表（300 条）', !!hit && hit.n === 300, hit ? '实际 ' + hit.n : '无结果');
    check('命中项 .nr-hit 高亮第123章', !!hit && hit.text.indexOf('第123章') === 0, hit ? hit.text : '无 .nr-hit');
    check('命中项居中显示（±60px）', !!hit && Math.abs(hit.top - (hit.scrollTop + hit.view / 2)) <= 60,
      hit ? `偏差 ${Math.abs(hit.top - (hit.scrollTop + hit.view / 2)).toFixed(1)}px` : '');
    check('计数徽标显示已定位', ((await js(`${SR}.querySelector('.nr-cat-count').textContent`))).includes('已定位'));

    // ---- 多命中：过滤模式，停留顶部 ----
    await evalJs(cdp, `NR.reader._renderCatalogList('破晓')`, ctx);
    const multi = await js(`(()=>{
      const list = ${SR}.querySelector('.nr-catalog-list');
      return { n: ${SR}.querySelectorAll('.nr-cat-item').length,
        hit: !!list.querySelector('.nr-cat-item.nr-hit'),
        scrollTop: list.scrollTop, count: ${SR}.querySelector('.nr-cat-count').textContent };
    })()`);
    check('多命中走过滤（150/300 条）', multi.n === 150 && multi.count.includes('150/300'), `实际 ${multi.n} 条，${multi.count}`);
    check('过滤模式无 .nr-hit 且停留顶部', !multi.hit && multi.scrollTop === 0, `scrollTop=${multi.scrollTop}`);

    // ---- 无命中：空态 ----
    await evalJs(cdp, `NR.reader._renderCatalogList('不存在的章节词')`, ctx);
    const empty = await js(`(()=>{
      const e = ${SR}.querySelector('.nr-cat-empty');
      return { text: e ? e.textContent : '', n: ${SR}.querySelectorAll('.nr-cat-item').length };
    })()`);
    check('无命中显示空态文案', empty.n === 0 && empty.text.includes('没有匹配'), empty.text || '无空态节点');
  } finally {
    try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

// ---------------- 场景二：手机视口 390×844，翻章按钮触控区 ----------------
async function runMobileButtons() {
  console.log('\n[手机视口 390×844] 上下章按钮触控区');
  procs.push(launchChrome({ port: 9342, profile: '/tmp/nr-catalog-profile-m', windowSize: '390,844' }));
  const cdp = await openTab(9342, `${BASE}/longsite/1.html`);
  const SR = `document.getElementById('novel-reader-host').shadowRoot`;
  const js = (expr) => evalJs(cdp, expr);
  try {
    await js(`document.getElementById('novel-reader-float-btn').click()`);
    await sleep(800);
    check('进入阅读模式', await js(`!!document.getElementById('novel-reader-host')`));
    const rect = (act) => js(`(()=>{
      const r = ${SR}.querySelector('[data-act="${act}"]').getBoundingClientRect();
      return { w: r.width, h: r.height };
    })()`);
    const prev = await rect('prev');
    const next = await rect('next');
    check('上一章按钮 ≥ 44×44', prev.w >= 44 && prev.h >= 44, `${prev.w.toFixed(0)}×${prev.h.toFixed(0)}`);
    check('下一章按钮 ≥ 44×44', next.w >= 44 && next.h >= 44, `${next.w.toFixed(0)}×${next.h.toFixed(0)}`);
    const others = await js(`(()=>{
      const out = [];
      for (const b of ${SR}.querySelectorAll('.nr-header .nr-act')) {
        if (b.dataset.act === 'prev' || b.dataset.act === 'next') continue;
        const r = b.getBoundingClientRect();
        if (r.height < 44) out.push(b.dataset.act + '=' + r.height.toFixed(0));
      }
      return out;
    })()`);
    check('其余头部按钮高度 ≥ 44', others.length === 0, '不足: ' + others.join(', '));

    // 设置面板控件触控热区（v0.2.11 全热区覆盖）
    await js(`${SR}.querySelector('[data-act="settings"]').click()`);
    await sleep(400);
    const panel = await js(`(()=>{
      const sr = ${SR};
      const h = (sel) => { const el = sr.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : -1; };
      return { open: sr.querySelector('.nr-root').classList.contains('nr-panel-open'),
        select: h('.nr-row > select'), check: h('.nr-check'), reset: h('.nr-reset') };
    })()`);
    check('设置面板已打开', panel.open === true, '');
    check('字体下拉触控热区 ≥44', panel.select >= 44, panel.select);
    check('开关行触控热区 ≥44', panel.check >= 44, panel.check);
    check('恢复默认按钮触控热区 ≥44', panel.reset >= 44, panel.reset);

    // 目录控件触控热区
    await js(`${SR}.querySelector('[data-act="catalog"]').click()`);
    await until(cdp, `${SR}.querySelectorAll('.nr-cat-item').length > 0`, 10000);
    await sleep(200);
    const cat = await js(`(()=>{
      const sr = ${SR};
      const h = (sel) => { const el = sr.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : -1; };
      const w = (sel) => { const el = sr.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : -1; };
      return { close: h('.nr-catalog-close'), closeW: w('.nr-catalog-close'),
        search: h('.nr-catalog-search'), item: h('.nr-cat-item') };
    })()`);
    check('目录关闭钮触控热区 ≥44×44', cat.close >= 44 && cat.closeW >= 44, JSON.stringify(cat));
    check('目录搜索框触控热区 ≥44', cat.search >= 44, cat.search);
    check('目录项触控热区 ≥44', cat.item >= 44, cat.item);

    // UI 框架与阅读行距解耦：行距拉满 2.6，工具栏按钮高度不得跟着膨胀
    const actBefore = await js(`Math.round(${SR}.querySelector('.nr-header .nr-act').getBoundingClientRect().height)`);
    await evalJs(cdp, `NR.saveSettings({ lineHeight: 2.6 })`, cdp.isolatedContextId());
    await sleep(300);
    const actAfter = await js(`Math.round(${SR}.querySelector('.nr-header .nr-act').getBoundingClientRect().height)`);
    check('工具栏高度不随阅读行距缩放（1.9→2.6 不变）', Math.abs(actAfter - actBefore) <= 1, `before=${actBefore} after=${actAfter}`);
    await evalJs(cdp, `NR.saveSettings({ lineHeight: 1.9 })`, cdp.isolatedContextId());
  } finally {
    try { cdp.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

try {
  await runCatalog();
  await runMobileButtons();
} catch (e) {
  fail();
  console.error('  ✗ 测试执行异常：', e.message);
}

clearTimeout(watchdog);
for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
await sleep(500);
let cleanErr = null;
for (const dir of ['/tmp/nr-catalog-profile', '/tmp/nr-catalog-profile-m']) {
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { cleanErr = e; }
}
if (cleanErr) console.log('（临时目录清理失败，可忽略）');
process.exit(summary() ? 1 : 0);
