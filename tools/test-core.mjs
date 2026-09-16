#!/usr/bin/env node
/**
 * 核心模块功能测试（DOM 无关部分）：cleaner / detector 正则 / 编码探测
 * 运行：node tools/test-core.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => new Function(readFileSync(join(ROOT, p), 'utf8'))();

// 模块都以 globalThis.NR 命名空间共享状态，加载顺序与 manifest 一致
load('src/lib/chinese-convert.js');
load('src/content/detector.js');
load('src/content/storage.js');
load('src/content/cleaner.js');
load('src/content/next-chapter.js');
load('src/content/settings.js');
load('src/content/progress.js');
load('src/content/intent.js');
load('src/content/sites.js');

const NR = globalThis.NR;
let failed = 0;
const t = (name, cond) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) failed++;
};

// ---------- cleaner ----------
console.log('cleanLines 水印/广告清洗:');
const lines = [
  '暮色四合，秋雨绵绵，官道尽头的一家客栈亮起了灯笼。',
  '最快更新最新章节！',
  '请记住本书首发站点：booktest.local',
  'www.booktest.local',
  '客栈门口的招幡被雨水打湿,沉甸甸地垂着.',
  '',
  '客栈门口的招幡被雨水打湿,沉甸甸地垂着.', // 连续重复
  '··——……',
  '一秒记住本站地址'
];
const out = NR.cleanLines(lines, '第一章 雨夜客栈');
t('清除水印行', out.length === 2);
t('保留正文', out[0].startsWith('暮色四合'));
t('半角标点转全角', out[1].includes('，') && out[1].includes('。'));

console.log('cleanLines 章节标题去重:');
const t2 = NR.cleanLines(['第一章 雨夜客栈', '正文开始第一章', '正文开始第一章'], '第一章 雨夜客栈');
t('标题行被剔除', t2.length === 1 && t2[0] === '正文开始第一章');

console.log('normalizePunct 边界:');
t('中文间句点', NR.normalizePunct('落雨.天晴') === '落雨。天晴');
t('行尾句点', NR.normalizePunct('天晴了.').endsWith('。'));
t('小数点保留', NR.normalizePunct('身高1.8米') === '身高1.8米');
t('英文引号保留', NR.normalizePunct('hello, world') === 'hello, world');

console.log('cleanTitleText 站点后缀清洗:');
t('去站点名', NR.cleanTitleText('第一章 雨夜客栈_山河剑经_笔趣阁') === '第一章 雨夜客栈');

// ---------- detector 正则 ----------
console.log('导航链接文本识别:');
t('识别“下一章”', NR.NEXT_TEXT_RE.test('下一章'));
t('识别“下一页”', NR.NEXT_TEXT_RE.test('下一页'));
t('识别“继续阅读”', NR.NEXT_TEXT_RE.test('继续阅读'));
t('识别 next', NR.NEXT_TEXT_RE.test('Next Chapter'));
t('不识别“上一章”', !NR.NEXT_TEXT_RE.test('上一章'));
t('识别“上一章”', NR.PREV_TEXT_RE.test('上一章'));
t('识别“返回目录”', NR.INDEX_TEXT_RE.test('返回目录'));
t('识别“章节目录”', NR.INDEX_TEXT_RE.test('章节目录'));

console.log('dirnameOf 章节归并:');
t('dirnameOf 提取章节目录', NR.dirnameOf('http://a.com/txt/57163/37509850.html') === 'http://a.com/txt/57163/');

// ---------- 存储域模块（注入内存适配器，避免依赖 chrome.storage） ----------
function fakeStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    get: async (keys) => {
      if (keys == null) return Object.assign({}, data);
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    getAll: async () => Object.assign({}, data),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
    _dump: () => data
  };
}

console.log('progress 书籍进度:');
{
  const st = fakeStorage({
    progress: { 'http://a.com/book/57163.htm': { url: 'http://a.com/txt/57163/2.html', chapterTitle: '第二章', ts: 200 } }
  });
  NR.progress._setStorage(st);
  const rec = await NR.progress.get('http://a.com/book/57163.htm', 'http://a.com/txt/57163/1.html');
  t('按书键精确命中', !!rec && rec.chapterTitle === '第二章');
  t('书键漂移时按章节目录兜底命中', (await NR.progress.get('drifted-key', 'http://a.com/txt/57163/1.html')).chapterTitle === '第二章');
  t('不同书不误命中', (await NR.progress.get('drifted-key', 'http://a.com/txt/888/1.html')) === null);
  t('空记录安全', (await NR.progress.get(null, 'http://a.com/x/1.html')) === null);
  await NR.progress.put('http://a.com/book/57163.htm', { url: 'http://a.com/txt/57163/3.html', ts: 999 });
  const dump = st._dump();
  t('旧整包迁移为独立 key 并删除', dump['p:http://a.com/book/57163.htm'].ts === 999 && dump.progress === undefined);
  t('recent 按 ts 倒序', (await NR.progress.recent(8))[0].ts === 999);
}

console.log('progress 200 本淘汰:');
{
  const seed = {};
  for (let i = 0; i <= 200; i++) seed['p:book' + i] = { url: 'http://a.com/b' + i + '/1.html', ts: i };
  const st = fakeStorage(seed);
  NR.progress._setStorage(st);
  await NR.progress.put('newbook', { url: 'http://a.com/new/1.html', ts: 9999 });
  const keys = Object.keys(st._dump()).filter((k) => k.indexOf('p:') === 0);
  t('超过 200 本淘汰最旧', keys.length === 200 && !st._dump()['p:book0'] && !!st._dump()['p:book200']);
}

console.log('progress list/remove 书架数据层:');
{
  const st = fakeStorage({
    'p:bookB': { url: 'http://a.com/B/2.html', chapterTitle: 'B 第二章', ts: 100 },
    'p:bookA': { url: 'http://a.com/A/1.html', chapterTitle: 'A 第一章', ts: 300 },
    progress: { bookC: { url: 'http://a.com/C/1.html', chapterTitle: 'C 旧格式', ts: 200 } }
  });
  NR.progress._setStorage(st);
  const list = await NR.progress.list();
  t('list 收录新格式与 legacy 记录', list.length === 3);
  t('list 条目带 bookKey', list.every((e) => typeof e.bookKey === 'string' && !!e.bookKey));
  const legacyEntry = list.find((e) => e.bookKey === 'bookC');
  t('legacy 记录按原键收录', !!legacyEntry && legacyEntry.chapterTitle === 'C 旧格式');
  t('list 按 ts 倒序', list[0].ts === 300 && list[1].ts === 200 && list[2].ts === 100);
  await NR.progress.remove('bookA');
  const after = await NR.progress.list();
  t('remove 后 list 不再含该书', after.length === 2 && !after.some((e) => e.bookKey === 'bookA'));
  t('remove 不影响其他键', st._dump()['p:bookB'].ts === 100 && !!st._dump().progress.bookC);
  t('remove 后 recent 也不含该书', !(await NR.progress.recent(8)).some((e) => e.chapterTitle === 'A 第一章'));
  // put/remove 交替共享同一条写串行链：依次落盘，最终状态以后一次 put 为准
  await NR.progress.put('bookD', { url: 'http://a.com/D/1.html', chapterTitle: 'D 一章', ts: 400 });
  await NR.progress.remove('bookD');
  await NR.progress.put('bookD', { url: 'http://a.com/D/2.html', chapterTitle: 'D 二章', ts: 500 });
  const finalList = await NR.progress.list();
  t('remove/put 交替后状态一致', finalList.some((e) => e.bookKey === 'bookD' && e.url === 'http://a.com/D/2.html'));
  await NR.progress.remove('');
  t('空参 remove 安全', (await NR.progress.list()).length === 3);
}

console.log('intent 跳转意图:');
{
  const st = fakeStorage({});
  NR.intent._setStorage(st);
  await NR.intent.declare('http://a.com/1.html#x', 'resume');
  const hit = await NR.intent.consume('http://a.com/1.html');
  t('declare/consume 命中（去 hash）', !!hit && hit.intent === 'resume' && hit.url.indexOf('1.html') >= 0);
  t('消费后删除，不重复命中', (await NR.intent.consume('http://a.com/1.html')) === null);
  await NR.intent.declare('http://a.com/2.html', 'jump');
  await NR.intent.declare('http://a.com/3.html', 'jump');
  const a = await NR.intent.consume('http://a.com/2.html');
  t('只删自己命中的条目', !!a && !!st._dump()['po:http://a.com/3.html']);
  const st2 = fakeStorage({ pendingOpen: { url: 'http://a.com/old.html', ts: Date.now(), intent: 'resume' } });
  NR.intent._setStorage(st2);
  t('兼容旧版单值 pendingOpen', (await NR.intent.consume('http://a.com/old.html')).intent === 'resume');
  const st3 = fakeStorage({ po: { url: 'http://a.com/x.html', ts: Date.now() } });
  NR.intent._setStorage(st3);
  t('无命中时不误删其他条目', (await NR.intent.consume('http://a.com/y.html')) === null && !!st3._dump()['po']);
  // TTL 边界（10 分钟；判定为 > TTL 才过期，恰好 10 分钟仍有效）
  const now = Date.now();
  const stExp = fakeStorage({ 'po:http://a.com/exp.html': { url: 'http://a.com/exp.html', ts: now - 11 * 60 * 1000, intent: 'jump' } });
  NR.intent._setStorage(stExp);
  t('超过 TTL 的条目不再命中', (await NR.intent.consume('http://a.com/exp.html')) === null);
  t('超过 TTL 的条目被顺带清理', !stExp._dump()['po:http://a.com/exp.html']);
  const stIn = fakeStorage({ 'po:http://a.com/in.html': { url: 'http://a.com/in.html', ts: now - 9 * 60 * 1000, intent: 'resume' } });
  NR.intent._setStorage(stIn);
  t('TTL 内仍然命中', (await NR.intent.consume('http://a.com/in.html')).intent === 'resume');
  const stLegacyExp = fakeStorage({ pendingOpen: { url: 'http://a.com/old2.html', ts: now - 11 * 60 * 1000 } });
  NR.intent._setStorage(stLegacyExp);
  t('旧版 pendingOpen 过期不命中且被清理', (await NR.intent.consume('http://a.com/old2.html')) === null && !stLegacyExp._dump().pendingOpen);
}

console.log('sites 站点启停:');
{
  const st = fakeStorage({});
  NR.sites._setStorage(st);
  t('matchHost 命中自身', NR.sites.matchHost('a.com', ['a.com']));
  t('matchHost 命中子域', NR.sites.matchHost('www.a.com', ['a.com']));
  t('matchHost 不误命中后缀', !NR.sites.matchHost('nota.com', ['a.com']));
  await NR.sites.setEnabled('a.com', false);
  t('禁用后 isEnabled=false', (await NR.sites.isEnabled('www.a.com')) === false);
  await NR.sites.setEnabled('a.com', true);
  t('启用后 isEnabled=true', (await NR.sites.isEnabled('a.com')) === true);
}

console.log('settings 设置模型（注入 sync 适配器）:');
{
  const sync = fakeStorage({ settings: { fontSize: 24, theme: 'dark' } });
  NR.settingsStore._setStorage(sync);
  const s = await NR.getSettings();
  t('存储缺键时回落默认值', s.lineHeight === NR.DEFAULT_SETTINGS.lineHeight && s.indent === true);
  t('存储值覆盖默认值', s.fontSize === 24 && s.theme === 'dark');
  NR.saveSettings({ fontSize: 26 });
  const live = NR.settings.fontSize === 26;
  NR.reloadSettings({ fontSize: 30 });
  t('saveSettings 即时生效 / reloadSettings 整体替换并补默认', live && NR.settings.fontSize === 30 && NR.settings.theme === 'light');
}

// ---------- 编码探测 ----------
console.log('sniffEncoding 编码探测:');
const metaGbk = new Uint8Array([
  ...Buffer.from('<html><head><meta charset="gbk" /></head>', 'latin1'),
  0xd6, 0xd0, 0xce, 0xc4 // “中文” 的 GBK 编码
]);
const enc1 = NR.loader.sniffEncoding(metaGbk.buffer, null);
t('meta charset=gbk → gb18030', enc1 === 'gb18030');
if (enc1 === 'gb18030') {
  t('gb18030 解码正确', new TextDecoder('gb18030').decode(metaGbk).includes('中文'));
}
const withHeader = new Uint8Array(Buffer.from('<html></html>', 'latin1'));
t('Content-Type 头优先', NR.loader.sniffEncoding(withHeader.buffer, 'text/html; charset=gbk') === 'gb18030');
const utf8Bytes = new Uint8Array([...Buffer.from('<html>普通页面</html>', 'utf8')]);
t('无声明默认 utf-8', NR.loader.sniffEncoding(utf8Bytes.buffer, 'text/html') === 'utf-8');
const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('<html/>', 'latin1')]);
t('BOM 识别 utf-8', NR.loader.sniffEncoding(bom.buffer, 'text/html; charset=gbk') === 'utf-8');
t('非法编码回退 utf-8', NR.loader.sniffEncoding(withHeader.buffer, 'text/html; charset=no-such-codec') === 'utf-8');

console.log('cleanLines 元数据行清洗:');
const t3 = NR.cleanLines(['2024-04-14 作者： 差不多了', '作者：差不多了', '正文第一句。'], null);
t('日期/作者行被剔除', t3.length === 1 && t3[0] === '正文第一句。');

// ---------- cjkCount ----------
console.log('cjkCount:');
t('统计中文', NR.cjkCount('abc一二三def四') === 4);
t('空串安全', NR.cjkCount('') === 0 && NR.cjkCount(null) === 0);

// ---------- 简繁转换 ----------
console.log('ccConvert 简繁转换:');
const cc = NR.ccConvert;
t('单字 s2t', cc('体', 's2t') === '體' && cc('楼', 's2t') === '樓' && cc('栈', 's2t') === '棧');
t('单字 t2s', cc('體', 't2s') === '体' && cc('頭', 't2s') === '头' && cc('鬥', 't2s') === '斗');
t('词组消歧 头发/理发', cc('头发和理发', 's2t') === '頭髮和理髮');
t('词组消歧 后面', cc('后面的路', 's2t') === '後面的路');
t('词组消歧 面条', cc('面条', 's2t') === '麵條');
t('词组消歧 干架', cc('干架', 's2t') === '幹架');
t('异体校正 湿→濕', cc('打湿', 's2t') === '打濕');
t('t2s 词组', cc('頭髮和理髮、鬥爭、鐘錶', 't2s') === '头发和理发、斗争、钟表');
t('t2s 幂等', (() => { const a = cc('頭髮幹架覆印雲彩', 't2s'); return cc(a, 't2s') === a; })());
t('none 原样返回', cc('头发', 'none') === '头发' && cc('头发', undefined) === '头发');
t('英文与数字不动', cc('hello 世界 123', 's2t') === 'hello 世界 123');
t('空值安全', cc('', 's2t') === '' && cc(null, 's2t') === null);
t('已是目标字形基本不动', cc('現代繁體文章', 's2t') === '現代繁體文章');

console.log(failed ? `\n${failed} 个断言失败` : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
