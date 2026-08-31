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

// 三个模块都以 globalThis.NR 命名空间共享状态，加载顺序与 manifest 一致
load('src/content/detector.js');
load('src/content/cleaner.js');
load('src/content/next-chapter.js');

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

console.log('findBookRecord / dirnameOf 分书籍匹配:');
t('dirnameOf 提取章节目录', NR.dirnameOf('http://a.com/txt/57163/37509850.html') === 'http://a.com/txt/57163/');
const prog = {
  'http://a.com/book/57163.htm': { url: 'http://a.com/txt/57163/2.html', chapterTitle: '第二章', ts: 200 },
  other: { url: 'http://a.com/txt/999/1.html', chapterTitle: '别的书', ts: 300 }
};
t('按书键精确命中', NR.findBookRecord(prog, 'http://a.com/book/57163.htm', 'http://a.com/txt/57163/1.html') === prog['http://a.com/book/57163.htm']);
t('书键漂移时按章节目录兜底命中', NR.findBookRecord(prog, 'drifted-key', 'http://a.com/txt/57163/1.html') === prog['http://a.com/book/57163.htm']);
t('不同书不误命中', NR.findBookRecord(prog, 'drifted-key', 'http://a.com/txt/888/1.html') === null);
t('空记录安全', NR.findBookRecord(null, 'k', 'http://a.com/x/1.html') === null);

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

console.log(failed ? `\n${failed} 个断言失败` : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
