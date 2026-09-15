#!/usr/bin/env node
/**
 * 真实站点端到端测试：等待 Cloudflare 盾通过 → 悬浮按钮 → 阅读模式 → 提取/翻章预载验证。
 * 运行：node tools/e2e-real.mjs <扩展目录> <页面URL> [--headed]
 */
import { writeFileSync } from 'node:fs';
import { sleep, check, fail, summary, CDP, launchChrome, evalJs } from './harness.mjs';

const URL = process.argv[3];
if (!URL) {
  console.error('用法：node tools/e2e-real.mjs <扩展目录> <章节页URL> [--headed]');
  process.exit(1);
}
const HEADED = process.argv.includes('--headed');
const PORT = 9342;
const PROFILE = '/tmp/nr-real-profile';

const proc = launchChrome({
  port: PORT,
  profile: PROFILE,
  headed: HEADED,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
});
const watchdog = setTimeout(() => { console.error('⏱ 总超时'); try { proc.kill('SIGKILL'); } catch (e) {} process.exit(2); }, 180000);

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(200);
  }
  const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('打开', URL);
  await cdp.send('Page.navigate', { url: URL });

  // 等 Cloudflare 盾通过（标题不再是 Just a moment，且出现正文容器）
  let shields = 0;
  let state = {};
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    state = await evalJs(cdp, `({
      title: document.title,
      ready: !!document.querySelector('.txtnav, #content, #chaptercontent, .noveltext, #txt'),
      btn: !!document.getElementById('novel-reader-float-btn'),
      bodyLen: document.body ? document.body.innerText.length : 0
    })`);
    if (i % 5 === 0) console.log(`  … ${Math.round((i + 1) * 2)}s title=${state.title.slice(0, 30)} ready=${state.ready}`);
    if (state.ready || state.bodyLen > 3000) break;
    if (/just a moment|attention required|cf-/i.test(state.title)) shields++;
  }
  console.log(`盾等待 ${shields * 2}s，title=${state.title}`);

  // ---- 页面结构侦查 ----
  const probe = await evalJs(cdp, `(() => {
    const sels = ['.txtnav','#content','#chaptercontent','.noveltext','#txt','#htmlContent','.content','article'];
    const hit = {};
    for (const s of sels) { const el = document.querySelector(s); if (el) hit[s] = (el.innerText||'').replace(/\\s+/g,'').length; }
    const links = [...document.querySelectorAll('a')].filter(a => /下一[章页]|下章/.test(a.textContent||'')).map(a => ({t:(a.textContent||'').trim().slice(0,12), h:a.getAttribute('href')}));
    return JSON.stringify({title: document.title, hits: hit, nextLinks: links.slice(0,5), cjk: (document.body.innerText.match(/[\\u4e00-\\u9fff]/g)||[]).length, btn: !!document.getElementById('novel-reader-float-btn')});
  })()`);
  console.log('页面侦查:', probe);
  const info = JSON.parse(probe);
  check('Cloudflare 已通过（有正文容器或大量中文）', Object.keys(info.hits).length > 0 || info.cjk > 1500, `cjk=${info.cjk}`);
  check('识别到下一章链接', info.nextLinks.length > 0, info.nextLinks.map((l) => l.t).join(','));
  check('悬浮按钮出现', info.btn);

  // ---- 进入阅读模式 ----
  await evalJs(cdp, `(document.getElementById('novel-reader-float-btn')||{click(){}}).click()`);
  await sleep(2500);
  const opened = await evalJs(cdp, `!!document.getElementById('novel-reader-host')`);
  check('进入阅读模式', opened);
  if (opened) {
    const rstate = await evalJs(cdp, `(() => {
      const sr = document.getElementById('novel-reader-host').shadowRoot;
      const ps = sr.querySelectorAll('.nr-p');
      return JSON.stringify({
        title: sr.querySelector('.nr-ch-title')?.textContent || '',
        pCount: ps.length,
        firstP: ps[0]?.textContent.slice(0, 30) || '',
        lastP: ps[ps.length-1]?.textContent.slice(-30) || '',
        ads: sr.querySelectorAll('.ad,[class*="advert"]').length
      });
    })()`);
    console.log('阅读视图:', rstate);
    const rs = JSON.parse(rstate);
    check('章节标题提取', rs.title.length > 0 && rs.title.length < 30, rs.title);
    check('正文段落数量充足', rs.pCount >= 5, `${rs.pCount} 段`);
    check('首段非广告/导航', !/广告|点击|最快|www\.|Cloudflare/i.test(rs.firstP), rs.firstP.slice(0, 20));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/nr-real-reader.png', Buffer.from(shot.data, 'base64'));
    console.log('  📸 /tmp/nr-real-reader.png');

    // ---- 滚动到底：预加载拼接下一章 ----
    await evalJs(cdp, `(()=>{const sc=document.getElementById('novel-reader-host').shadowRoot.querySelector('.nr-scroll');sc.scrollTop=sc.scrollHeight;})()`);
    await sleep(5000);
    const after = await evalJs(cdp, `(() => {
      const sr = document.getElementById('novel-reader-host').shadowRoot;
      const arts = sr.querySelectorAll('.nr-chapter');
      return JSON.stringify({
        count: arts.length,
        titles: [...sr.querySelectorAll('.nr-ch-title')].map(h => h.textContent.slice(0, 25)),
        lastP: sr.querySelectorAll('.nr-p')[sr.querySelectorAll('.nr-p').length-1]?.textContent.slice(-25) || ''
      });
    })()`);
    console.log('滚动后:', after);
    const as = JSON.parse(after);
    check('预加载并拼接下一章', as.count >= 2, as.titles.join(' | '));
    check('拼接内容非盾页/广告', !/just a moment|cloudflare|验证/i.test(as.lastP), as.lastP);
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/nr-real-2chapters.png', Buffer.from(shot2.data, 'base64'));
    console.log('  📸 /tmp/nr-real-2chapters.png');

    // ---- 翻回 & 退出 ----
    await evalJs(cdp, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    await sleep(600);
    const closed = await evalJs(cdp, `!document.getElementById('novel-reader-host')`);
    check('Esc 退出并还原原页面', closed);
  }
} catch (e) {
  fail();
  console.error('异常：', e.message);
} finally {
  clearTimeout(watchdog);
  try { proc.kill('SIGKILL'); } catch (e) { /* noop */ }
}
process.exit(summary() ? 1 : 0);
