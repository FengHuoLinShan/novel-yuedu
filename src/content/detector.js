/**
 * detector.js — 公共工具与小说页检测
 * 最先加载（lib 之后），提供全模块共享的 NR 命名空间、正则常量、文本统计与页面检测。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  // ---------- 导航链接文本正则（用于识别 上一章/下一章/目录 链接） ----------
  NR.NEXT_TEXT_RE = /(下一页|下一章|下一节|下页|下章|下一篇|后一章|后一页|继续阅读|点击阅读|下一卷|后章|next)/i;
  NR.PREV_TEXT_RE = /(上一页|上一章|上一节|上页|上章|上一篇|前一页|前一章|上一卷|前章|prev)/i;
  NR.INDEX_TEXT_RE = /(返回书目|返回目录|回目录|回书目|章节目录|作品目录|目次|全部章节|返回书页|目录)/;

  NR.CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
  NR.CJK_PUNCT_RE = /[，。！？；：…、“”‘’（）—～《》【】]/g;

  // ---------- 基础工具 ----------
  NR.cjkCount = function (text) {
    const m = String(text || '').match(NR.CJK_RE);
    return m ? m.length : 0;
  };

  NR.sleep = function (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  /**
   * 扩展上下文是否存活。扩展被刷新/更新/禁用后，仍留在旧页面的内容脚本会变成孤儿，
   * 此时任何 chrome.* 调用都会同步抛 "Extension context invalidated"。
   */
  NR.extAlive = function () {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  /** URL 的目录部分（origin + 去掉文件名），用于把同一本书的页面归并 */
  NR.dirnameOf = function (url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/[^/]*$/, '');
    } catch (e) {
      return '';
    }
  };

  /**
   * 按书查找进度记录（分书籍兜底匹配）：
   * 1) 精确命中书键（目录页 URL）；
   * 2) 书键不一致时（部分页面识别不到目录链接导致键漂移），退而按章节 URL 的目录归并同一本书，
   *    取时间最新的一条，避免同一本书分裂出多条记录。
   */
  NR.findBookRecord = function (progress, bookKey, pageUrl) {
    if (!progress) return null;
    if (bookKey && progress[bookKey]) return progress[bookKey];
    const dir = NR.dirnameOf(pageUrl);
    if (!dir) return null;
    let best = null;
    for (const k in progress) {
      const r = progress[k];
      if (r && r.url && NR.dirnameOf(r.url) === dir && (!best || (r.ts || 0) > (best.ts || 0))) {
        best = r;
      }
    }
    return best;
  };

  // 压缩所有空白后的小写文本，用于标题/行去重比较
  NR.normText = function (text) {
    return String(text || '').replace(/\s+/g, '').toLowerCase();
  };

  // 轻提示（挂在 documentElement 上，独立 Shadow DOM，不受阅读模式影响）
  NR.toast = function (msg, ms) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:50%;top:26px;transform:translateX(-50%);z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.textContent = msg;
    box.style.cssText =
      'background:rgba(20,20,24,.92);color:#fff;font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
      'padding:8px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    root.appendChild(box);
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), ms || 2400);
  };

  // ---------- 规则未加载时的兜底正文选择器 ----------
  NR.FALLBACK_CONTENT_SELECTORS = [
    '#content', '#contents', '#chaptercontent', '#chapter_content', '#txt',
    '.noveltext', '.read-content', '.readcontent', '.showtxt', 'article'
  ];

  /**
   * 在 doc 中按顺序找第一个“文本量足够且链接密度低”的正文候选元素。
   * @returns {Element|null}
   */
  NR.findContentBySelectors = function (doc, selectors, minCjk) {
    minCjk = minCjk == null ? 300 : minCjk;
    for (const sel of selectors) {
      let el;
      try {
        el = doc.querySelector(sel);
      } catch (e) {
        continue; // 非法选择器
      }
      if (!el) continue;
      const text = el.textContent || '';
      if (NR.cjkCount(text) < minCjk) continue;
      if (text.length > 80000) continue; // 大概率是整个页面壳
      // 链接文本占比过高说明命中了导航/容器，跳过
      let anchorLen = 0;
      for (const a of el.querySelectorAll('a')) anchorLen += (a.textContent || '').length;
      if (anchorLen > text.length * 0.3) continue;
      return el;
    }
    return null;
  };

  /**
   * 判断页面是否疑似小说章节页（决定悬浮按钮是否出现）。
   * 规则表已加载时使用其选择器列表，否则用兜底列表。
   */
  NR.isNovelLike = function (doc) {
    doc = doc || document;
    if (!doc.body) return false;
    let selectors = NR.FALLBACK_CONTENT_SELECTORS;
    if (NR._rules && NR._rules.generic && NR._rules.generic.contentSelector) {
      selectors = NR._rules.generic.contentSelector;
    }
    if (NR.findContentBySelectors(doc, selectors, 400)) return true;
    // 通用长文兜底：整页可见中文文本量充足
    try {
      return NR.cjkCount(doc.body.innerText) > 1500;
    } catch (e) {
      return NR.cjkCount(doc.body.textContent) > 1500;
    }
  };
})();
