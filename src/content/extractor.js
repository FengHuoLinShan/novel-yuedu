/**
 * extractor.js — 三层正文提取管线
 *
 * 层级：站点规则选择器 → Mozilla Readability（DOM 克隆 + DOMPurify 消毒）→ 中文标点密度启发式。
 * 当前页与预取页复用同一个 extractDoc()，保证翻章后的排版与当前章完全一致。
 * 所有破坏性操作（删广告节点等）都作用于克隆节点，绝不修改原始文档。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  // 块级标签集合：文本行切分时补换行
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'BR', 'LI', 'TD', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'PRE', 'HR',
    'FIGURE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'DL', 'DD', 'DT'
  ]);

  const NON_HTML_EXT_RE = /\.(js|css|jpe?g|png|gif|webp|svg|ico|bmp|zip|rar|7z|mp3|mp4|avi|mkv|txt|xml|pdf)($|\?)/i;

  // ---------------- 规则加载与匹配 ----------------

  NR.loadSiteRules = function () {
    if (!NR._rulesPromise) {
      try {
        NR._rulesPromise = fetch(chrome.runtime.getURL('rules/sites.json'))
          .then((r) => r.json())
          .then((rules) => {
            NR._rules = rules;
            return rules;
          })
          .catch((e) => {
            NR._rulesPromise = null; // 允许下次重试
            throw e;
          });
      } catch (e) {
        // 扩展上下文失效时 getURL 同步抛错：转为拒绝承诺，由调用方 .catch 兜底
        NR._rulesPromise = Promise.reject(e);
      }
    }
    return NR._rulesPromise;
  };

  /** 取某 URL 的合并规则（generic + 命中的站点覆盖字段） */
  NR.getRulesFor = function (url) {
    const generic = (NR._rules && NR._rules.generic) || {};
    const sites = (NR._rules && NR._rules.sites) || [];
    const merged = Object.assign({}, generic);
    for (const site of sites) {
      if (!site.match) continue;
      let re;
      try {
        re = new RegExp(site.match, 'i');
      } catch (e) {
        continue;
      }
      if (re.test(url)) {
        for (const key of ['contentSelector', 'titleSelector', 'contentRemove', 'nextSelector', 'prevSelector', 'indexSelector']) {
          if (site[key]) merged[key] = site[key];
        }
        merged.siteName = site.name;
        break;
      }
    }
    return merged;
  };

  // ---------------- 文本行切分 ----------------

  /** 深度遍历，按 <br> 与块级边界把内容元素拆成文本行 */
  function collectLines(node, out) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(child.data);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') {
          out.push('\n');
        } else {
          const block = BLOCK_TAGS.has(child.tagName);
          if (block) out.push('\n');
          collectLines(child, out);
          if (block) out.push('\n');
        }
      }
    }
  }

  function contentToLines(el) {
    const parts = [];
    collectLines(el, parts);
    return parts.join('').split('\n');
  }

  // ---------------- 链接规范化与导航识别 ----------------

  function absHref(a, baseUrl) {
    const raw = a.getAttribute('href');
    if (!raw) return null;
    try {
      const u = new URL(raw, baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (e) {
      return null;
    }
  }

  function stripHash(u) {
    return u.origin + u.pathname + u.search;
  }

  /**
   * 校验章节 URL 合法性（防死循环的关键）：
   * 同源、非当前页、非目录页、非静态资源。
   */
  function validChapterUrl(u, baseUrl, indexHref) {
    if (!u) return null;
    let base;
    try {
      base = new URL(baseUrl);
    } catch (e) {
      return null;
    }
    if (u.origin !== base.origin) return null;
    if (stripHash(u) === stripHash(base)) return null;
    if (indexHref && stripHash(u) === stripHash(new URL(indexHref, base))) return null;
    const last = (u.pathname.split('/').pop() || '').toLowerCase();
    if (/^index\d*\.s?html?$/.test(last)) return null;
    if (NON_HTML_EXT_RE.test(u.pathname)) return null;
    return u.href;
  }

  /** 在文档中识别 上一章/下一章/目录 链接 */
  function findNavLinks(doc, rules, baseUrl) {
    let prevUrl = null;
    let nextUrl = null;
    let indexUrl = null;

    const pickBySelector = function (selectors, validate) {
      for (const sel of selectors || []) {
        let a;
        try {
          a = doc.querySelector(sel);
        } catch (e) {
          continue;
        }
        if (!a) continue;
        const u = absHref(a, baseUrl);
        const href = u && validate(u);
        if (href) return href;
      }
      return null;
    };

    // 第一步：遍历全部 <a>，按文本分类收集候选（取文档顺序最后一个，通常是底部导航条）
    let textNext = null;
    let textPrev = null;
    let textIndex = null;
    for (const a of doc.querySelectorAll('a')) {
      const text = NR.normText(a.textContent).slice(0, 30);
      if (!text || text.length > 20) continue;
      const u = absHref(a, baseUrl);
      if (!u) continue;
      if (NR.INDEX_TEXT_RE.test(text) && !textIndex) textIndex = u.href;
      // "下一章" 与 "目录" 的文本可能同时命中（如"返回目录"含"目录"不含"下一"），先判 next/prev
      if (NR.NEXT_TEXT_RE.test(text)) textNext = u.href;
      else if (NR.PREV_TEXT_RE.test(text)) textPrev = u.href;
    }

    const indexHref = (rules.indexSelector && pickBySelector(rules.indexSelector, (u) => u.href)) || textIndex;

    const validateNext = (u) => validChapterUrl(u, baseUrl, indexHref);
    const validatePrev = (u) => validChapterUrl(u, baseUrl, null);

    // 第二步：规则选择器优先，其次文本识别结果，最后 rel/class 属性
    nextUrl =
      (rules.nextSelector && pickBySelector(rules.nextSelector, validateNext)) ||
      (textNext && validateNext(new URL(textNext, baseUrl))) ||
      attrFallback(doc, 'next', baseUrl, validateNext);

    prevUrl =
      (rules.prevSelector && pickBySelector(rules.prevSelector, validatePrev)) ||
      (textPrev && validatePrev(new URL(textPrev, baseUrl))) ||
      attrFallback(doc, 'prev', baseUrl, validatePrev);

    indexUrl = indexHref;
    return { prevUrl, nextUrl, indexUrl };
  }

  function attrFallback(doc, kind, baseUrl, validate) {
    // a[rel=next] / class 含 next 的短文本链接
    for (const a of doc.querySelectorAll('a')) {
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const cls = (a.className && String(a.className).toLowerCase()) || '';
      const hit =
        (kind === 'next' && (rel === 'next' || cls.includes('next'))) ||
        (kind === 'prev' && (rel === 'prev' || cls.includes('prev')));
      if (!hit) continue;
      if ((a.textContent || '').trim().length > 20) continue; // 避免误抓长链接
      const u = absHref(a, baseUrl);
      const href = u && validate(u);
      if (href) return href;
    }
    return null;
  }

  // ---------------- 启发式兜底（中文标点密度） ----------------

  function scoreBlock(el) {
    const text = el.textContent || '';
    if (text.length > 80000) return 0;
    const cjk = NR.cjkCount(text);
    if (cjk < 500) return 0;
    const punct = (text.match(NR.CJK_PUNCT_RE) || []).length;
    let anchorLen = 0;
    for (const a of el.querySelectorAll('a')) anchorLen += (a.textContent || '').length;
    if (anchorLen > text.length * 0.25) return 0;
    return cjk + punct * 2;
  }

  function heuristicFindContent(doc) {
    const blocks = doc.querySelectorAll('div,td,article,section');
    let best = null;
    let bestScore = 0;
    const limit = Math.min(blocks.length, 4000);
    for (let i = 0; i < limit; i++) {
      const s = scoreBlock(blocks[i]);
      if (s > bestScore) {
        bestScore = s;
        best = blocks[i];
      }
    }
    if (!best) return null;
    // 向下收敛：如果某个后代节点几乎包含同等评分，取更精确的深层节点
    let node = best;
    for (;;) {
      let deeper = null;
      for (const child of node.children) {
        const s = scoreBlock(child);
        if (s >= bestScore * 0.9) {
          deeper = child;
          bestScore = s;
        }
      }
      if (!deeper) break;
      node = deeper;
    }
    return node;
  }

  /**
   * 解析目录页：返回按目录顺序排列的章节列表 [{title, url}]。
   * 过滤规则：同源、与样章 URL 同书路径前缀（如 /txt/57163/）、文本长度合理、
   * 排除导航类链接；重复 URL 保留后出现的位置（完整目录通常排在"最新章节"块之后）。
   */
  NR.parseCatalog = function (doc, indexUrl, sampleChapterUrl) {
    let base;
    try {
      base = new URL(indexUrl);
    } catch (e) {
      return [];
    }
    // 书路径前缀：优先取样章 URL 的目录部分
    let prefix = '';
    try {
      const cu = new URL(sampleChapterUrl, indexUrl);
      prefix = cu.origin + cu.pathname.replace(/[^/]*$/, '');
    } catch (e) {
      prefix = base.origin + (base.pathname.replace(/[^/]*$/, '') || '/');
    }
    const map = new Map(); // url -> {title, url, order}
    let order = 0;
    for (const a of doc.querySelectorAll('a')) {
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('#') || /^(javascript|mailto):/i.test(raw)) continue;
      let u;
      try {
        u = new URL(raw, indexUrl);
      } catch (e) {
        continue;
      }
      if (u.origin !== base.origin) continue;
      if (prefix && (u.origin + u.pathname).indexOf(prefix) !== 0) continue;
      if (NON_HTML_EXT_RE.test(u.pathname)) continue;
      if (u.href === base.href) continue;
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (title.length < 2 || title.length > 60) continue;
      if (NR.INDEX_TEXT_RE.test(title) || NR.NEXT_TEXT_RE.test(title) || NR.PREV_TEXT_RE.test(title)) continue;
      if (!/[\u4e00-\u9fff0-9]/.test(title)) continue;
      if (map.has(u.href)) map.delete(u.href); // 后出现的位置优先
      map.set(u.href, { title: title, url: u.href, order: order++ });
      if (map.size >= 3000) break;
    }
    return Array.from(map.values()).sort((x, y) => x.order - y.order);
  };

  // ---------------- 书名识别 ----------------

  function findBookTitle(doc, rules, indexUrl) {
    // 目录链接的锚文本常是书名（如「书名_目录」）
    if (indexUrl) {
      for (const a of doc.querySelectorAll('a')) {
        const u = absHref(a, doc.baseURI || location.href);
        if (u && u.href === indexUrl) {
          let t = (a.textContent || '').replace(/\s+/g, '');
          t = t.replace(/(目录|书页|章节目录|返回书目|全文阅读|最新章节)($|_)/g, '');
          t = t.replace(/^[《》]|[《》]$/g, '');
          if (t.length >= 2 && t.length <= 20 && !NR.INDEX_TEXT_RE.test(t)) return t;
        }
      }
    }
    // 标题里「第一章」之前的部分
    const title = NR.cleanTitleText(doc.title);
    const m = title.split(/第\s*[一二三四五六七八九十百千0-9０-９]+\s*[章卷节回]/)[0];
    if (m && m.trim().length >= 2) return m.trim();
    return '';
  }

  // ---------------- 主入口 ----------------

  /**
   * 从文档中提取章节。
   * @param {Document} doc    live document 或 DOMParser 解析出的文档
   * @param {string}   url    该文档对应的页面 URL（相对链接解析基准）
   * @returns {Promise<{
   *   ok: boolean, via: string, title: string, bookTitle: string,
   *   paragraphs: string[], images: string[],
   *   prevUrl: ?string, nextUrl: ?string, indexUrl: ?string, url: string
   * }>}
   */
  NR.extractDoc = async function (doc, url) {
    try {
      await NR.loadSiteRules().catch(() => {});
      const rules = NR.getRulesFor(url);
      let via = 'rule';
      let readabilityTitle = '';

      // ---- 第一层：站点规则选择器 ----
      let contentEl =
        (rules.contentSelector && NR.findContentBySelectors(doc, rules.contentSelector, 300)) || null;

      // ---- 第二层：Readability（克隆文档，避免破坏原页面） ----
      if (!contentEl && typeof Readability === 'function') {
        try {
          const clone = doc.cloneNode(true);
          const article = new Readability(clone, {
            charThreshold: 100, // 中文短章节调低阈值
            nbTopCandidates: 3
          }).parse();
          if (article && article.content) {
            const div = doc.createElement('div');
            div.innerHTML = DOMPurify.sanitize(article.content);
            if (NR.cjkCount(div.textContent) > 200) {
              contentEl = div;
              via = 'readability';
              readabilityTitle = article.title || '';
            }
          }
        } catch (e) {
          /* 落到第三层 */
        }
      }

      // ---- 第三层：中文标点密度启发式 ----
      if (!contentEl) {
        contentEl = heuristicFindContent(doc);
        via = 'heuristic';
      }

      if (!contentEl) {
        return { ok: false, via: 'none', title: '', bookTitle: '', paragraphs: [], images: [], prevUrl: null, nextUrl: null, indexUrl: null, url };
      }

      // ---- 标题 ----
      let title = '';
      if (rules.titleSelector) {
        for (const sel of rules.titleSelector) {
          let el;
          try {
            el = doc.querySelector(sel);
          } catch (e) {
            continue;
          }
          if (el) {
            const t = NR.cleanTitleText(el.textContent);
            if (t) {
              title = t;
              break;
            }
          }
        }
      }
      if (!title && readabilityTitle) title = NR.cleanTitleText(readabilityTitle);
      if (!title) title = NR.cleanTitleText(doc.title);

      // ---- 内容处理（全部在克隆上做，不动原文档） ----
      const working = contentEl.cloneNode(true);
      const images = [];
      for (const img of working.querySelectorAll('img')) {
        const src = img.getAttribute('src') || img.getAttribute('data-src');
        if (src) {
          try {
            images.push(new URL(src, doc.baseURI || url).href);
          } catch (e) {
            /* 忽略非法 src */
          }
        }
      }
      for (const rm of working.querySelectorAll('script,style,iframe,ins,noscript,form,button,svg')) {
        rm.remove();
      }
      if (rules.contentRemove) {
        for (const sel of rules.contentRemove) {
          try {
            for (const el of working.querySelectorAll(sel)) el.remove();
          } catch (e) {
            /* 非法选择器跳过 */
          }
        }
      }

      const rawLines = contentToLines(working);
      const paragraphs = NR.cleanLines(rawLines, title);

      // ---- 导航链接 ----
      const nav = findNavLinks(doc, rules, url);
      const bookTitle = findBookTitle(doc, rules, nav.indexUrl);

      if (!paragraphs.length) {
        return { ok: false, via, title, bookTitle, paragraphs: [], images: [], prevUrl: nav.prevUrl, nextUrl: nav.nextUrl, indexUrl: nav.indexUrl, url };
      }
      return {
        ok: true,
        via,
        title,
        bookTitle,
        paragraphs,
        images,
        prevUrl: nav.prevUrl,
        nextUrl: nav.nextUrl,
        indexUrl: nav.indexUrl,
        url
      };
    } catch (e) {
      return { ok: false, via: 'error', error: e, title: '', bookTitle: '', paragraphs: [], images: [], prevUrl: null, nextUrl: null, indexUrl: null, url };
    }
  };
})();
