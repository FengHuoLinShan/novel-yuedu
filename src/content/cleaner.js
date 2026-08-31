/**
 * cleaner.js — 行级文本清洗
 * 输入正文按行拆分后的原始行数组，输出去除水印/广告/噪声后的段落文本数组。
 * 参考了笔趣阁系站点的常见噪声形态（My Novel Reader 与各优化脚本的通用做法）。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  // 命中即整行删除的水印/广告文案（对单行做整行匹配，短句误伤概率低）
  const WATERMARK_RE = new RegExp(
    [
      '最快更新', '最快最全', '最新章节', '首发站', '首发网站', '本书首发', '请记住本书', '请牢记本书',
      '记住本书', '新章节更新', '无弹窗', '无广告', '纯文字', '精华书阁', '笔趣阁', '小说下载',
      '手机阅读', '手机版', '移动端阅读', '章节目录', '点击下一页', '点击下一章', '继续阅读',
      '求收藏', '求推荐票', '求月票', '求鲜花', '求评价票', '章节错误', '点此举报', '联系站长',
      '加入书签', '百度搜索', '谷歌搜索', '阅读更精彩', '天才一秒记住', '一秒记住', '未完待续',
      '本章完', '本章尚未完', '点击查看', '温馨提示', '亲爱的读者', '感谢书友', '新书推荐',
      '本章结束后', '防盗版', '防采集', '请刷新页面', '加载中', '请稍候'
    ].join('|')
  );

  // 含网址的行直接删除（正文里几乎不会出现）
  const URL_LINE_RE = /https?:\/\/|www\.|[a-z0-9.-]+\.(com|net|cn|org|cc|top|xyz|vip)\b/i;

  // 日期/作者元数据行（如 "2024-04-14 作者： xxx"，部分站点正文首行常见）
  const META_LINE_RE = /^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}/;

  // 存在中文或字母数字（剔除纯符号行）
  const HAS_CONTENT_RE = /[\u3400-\u4dbf\u4e00-\u9fff a-zA-Z0-9]/;

  const CJK_CHAR = '\u4e00-\u9fff';

  /** 半角标点在中文语境下转全角 */
  NR.normalizePunct = function (line) {
    let s = line;
    s = s.replace(new RegExp('([' + CJK_CHAR + '])\\,', 'g'), '$1，');
    s = s.replace(new RegExp('\\,([' + CJK_CHAR + '])', 'g'), '，$1');
    s = s.replace(new RegExp('([' + CJK_CHAR + '])[;:!?~]', 'g'), function (m, c) {
      return c + { ';': '；', ':': '：', '!': '！', '?': '？', '~': '～' }[m.slice(1)];
    });
    // 句点只处理夹在两个中文之间、或中文后行尾的情况，避免误伤小数与英文缩写
    s = s.replace(new RegExp('([' + CJK_CHAR + '])\\.([' + CJK_CHAR + '])', 'g'), '$1。$2');
    s = s.replace(new RegExp('([' + CJK_CHAR + '])\\.$', 'g'), '$1。');
    return s;
  };

  /**
   * 清洗正文行。
   * @param {string[]} lines 原始行
   * @param {string} [chapterTitle] 章节标题（用于剔除正文首的重复标题行）
   * @returns {string[]}
   */
  NR.cleanLines = function (lines, chapterTitle) {
    const out = [];
    const titleNorm = chapterTitle ? NR.normText(chapterTitle) : '';
    for (const raw of lines) {
      let line = String(raw == null ? '' : raw).replace(/[\s\u3000]+/g, ' ').trim();
      if (!line) continue;
      if (URL_LINE_RE.test(line)) continue;
      if (META_LINE_RE.test(line)) continue;
      if (/^作者[:：]/.test(line)) continue;
      if (WATERMARK_RE.test(line)) continue;
      if (!HAS_CONTENT_RE.test(line)) continue;
      // 超长且无任何标点的行，多为反爬填充文本
      if (line.length > 300 && !/[，。！？；：…、]/.test(line)) continue;
      line = NR.normalizePunct(line);
      if (titleNorm && NR.normText(line) === titleNorm) continue;
      if (out.length && out[out.length - 1] === line) continue; // 连续重复行
      out.push(line);
    }
    return out;
  };

  /** 清洗页面标题：去站点后缀与常见噪声 */
  NR.cleanTitleText = function (text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    // 站点后缀分隔：下划线/竖线直接切；破折号等要求前后有空白，避免误切标题内文
    t = t.split(/\s+[-–—|»·]+\s*|[_｜]+/)[0].trim();
    t = t.replace(/[(（][^()（）]*笔趣阁[^()（）]*[)）]/g, '');
    t = t.replace(/(最新章节|章节目录|正文卷?|笔趣阁|小说网|文学网|阅读网|书阁|\.com|\.net)$/i, '');
    return t.trim();
  };
})();
