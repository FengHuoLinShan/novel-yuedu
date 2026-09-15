/**
 * chapter-window.js — 章节窗口（深模块，见 ADR-0004）
 *
 * 阅读模式中当前连续拼接、保留 DOM 的相邻章节集合。本模块独占：
 *  - 记录形态 { meta, data, el, translating }：meta 恒存在；data 仅在持有完整正文时非空
 *  - 滑动窗口裁剪与等高占位柱（.nr-pillow）几何
 *  - 已收起章节的按需回填
 *
 * 调用方注入依赖，模块不直接抓取章节、不直接构建 DOM：
 *   NR.createChapterWindow({
 *     container, maxDom, keepBehind, keepAhead,
 *     loadContent(url) -> Promise<fullChapter>,
 *     buildEl(data) -> Element,
 *     onBuilt(rec), onInsert(), pruneKeep(urls), isAlive()
 *   })
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const META_FIELDS = ['url', 'title', 'bookTitle', 'indexUrl', 'prevUrl', 'nextUrl'];

  function metaOf(data) {
    const m = {};
    for (const f of META_FIELDS) m[f] = data[f];
    return m;
  }

  NR.createChapterWindow = function (opts) {
    const container = opts.container;
    const maxDom = opts.maxDom;
    const keepBehind = opts.keepBehind;
    const keepAhead = opts.keepAhead;
    const loadContent = opts.loadContent;
    const buildEl = opts.buildEl;
    const onBuilt = opts.onBuilt || function () {};
    const onInsert = opts.onInsert || function () {};
    const pruneKeep = opts.pruneKeep || function () {};
    const isAlive = opts.isAlive || function () { return true; };

    const records = [];
    let currentIndex = 0;
    let collapsedCount = 0;
    let pillowEl = null;
    let collapsedNote = null;

    /** 占位柱长高：顶住已收起上方章节的流高度（等高占位，几何与 scrollTop 全程不变） */
    function growPillow(h) {
      if (!pillowEl) {
        const pillow = document.createElement('div');
        pillow.className = 'nr-pillow';
        pillow.style.height = '0px';
        container.insertBefore(pillow, container.firstChild);
        pillowEl = pillow;
      }
      pillowEl.style.height = (parseFloat(pillowEl.style.height) || 0) + h + 'px';
    }

    /** 占位柱缩短：回填章节时按插入实测的流高度收缩（收敛到 0 时移除占位柱） */
    function shrinkPillow(h) {
      if (!pillowEl || !(h > 0)) return;
      const next = Math.max(0, (parseFloat(pillowEl.style.height) || 0) - h);
      pillowEl.style.height = next + 'px';
      if (next === 0) removePillow();
    }

    function removePillow() {
      if (pillowEl) {
        pillowEl.remove();
        pillowEl = null;
      }
    }

    /** 收起提示条：置于占位柱底部（绝对定位脱离文档流，增删不影响几何） */
    function ensureCollapsedNote() {
      if (collapsedCount <= 0) return;
      if (!pillowEl) growPillow(0);
      if (!collapsedNote) {
        const note = document.createElement('div');
        note.className = 'nr-collapsed';
        pillowEl.appendChild(note);
        collapsedNote = note;
      }
      collapsedNote.textContent = '已收起前 ' + collapsedCount + ' 章（按 ← 可翻回）';
    }

    /**
     * 滑动窗口裁剪：移除当前章前后窗口之外的 DOM，并用等高占位柱顶住上方被移除
     * 章节的原流高度，保证视口几何零变化、scrollTop 零写入。
     * 关键顺序：先按「相邻下一存在元素」的 rect 差实测各章流高度并预涨占位柱，
     * 再移除元素——全程内容高度只增不减，杜绝中途布局刷新把越界 scrollTop 钳位。
     */
    function trim() {
      if (records.length <= maxDom) return;
      const minKeep = Math.max(0, currentIndex - keepBehind);
      const maxKeep = Math.min(records.length - 1, currentIndex + keepAhead);
      let flow = 0;
      let hasFlow = false;
      for (let i = 0; i < minKeep && i < records.length; i++) {
        const el = records[i].el;
        if (!el) continue;
        const rectTop = el.getBoundingClientRect().top;
        let next = null;
        for (let j = i + 1; j < records.length; j++) {
          if (records[j].el) { next = records[j].el; break; }
        }
        flow += next ? next.getBoundingClientRect().top - rectTop : el.getBoundingClientRect().height;
        hasFlow = true;
      }
      if (hasFlow) growPillow(flow);
      for (let i = 0; i < minKeep && i < records.length; i++) {
        const c = records[i];
        if (c.el) {
          c.el.remove();
          c.el = null;
          c.data = null;
          collapsedCount++;
        }
      }
      for (let i = records.length - 1; i > maxKeep; i--) {
        const c = records[i];
        if (c.el) {
          c.el.remove();
          c.el = null;
          c.data = null;
        }
      }
      ensureCollapsedNote();
      pruneKeep(records.filter((c) => c.el).map((c) => c.meta.url));
    }

    return {
      records,

      /** 追加一章：构建 DOM、入窗、裁剪，并在 DOM 就绪后回调（翻译等） */
      add(data) {
        const el = buildEl(data);
        container.appendChild(el);
        records.push({ meta: metaOf(data), data: data, el: el, translating: false });
        trim();
        onBuilt(records[records.length - 1]);
        return records.length - 1;
      },

      indexOf(url) {
        return records.findIndex((c) => c.meta.url === url);
      },

      /** DOM 中最后一章（数组末尾可能是已收起的纯元数据记录） */
      lastRendered() {
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i].el) return records[i];
        }
        return null;
      },

      /** 过 40% 视线线的最后一章下标 */
      currentIndexAt(midline) {
        let idx = 0;
        for (let i = 0; i < records.length; i++) {
          const c = records[i];
          if (c.el && c.el.offsetTop <= midline) idx = i;
        }
        return idx;
      },

      /**
       * 回填已收起章节：按需重载 → 原位置插入 → 收缩占位柱 → onBuilt。
       * 返回是否恢复成功；loadContent 失败会抛出，由调用方提示。
       */
      async ensureRendered(url) {
        const idx = records.findIndex((c) => c.meta.url === url && !c.el);
        if (idx < 0) return true; // 已渲染或不存在
        const rec = records[idx];
        // data 仅在持有完整正文时非空（trim 恒置 null、loader 不产出空 paragraphs），
        // 故 !data 等价于旧 reader-view._hasFullData
        if (!rec.data) {
          const chapter = await loadContent(url);
          if (!isAlive()) return false;
          // 原记录里的导航元数据更贴近当次阅读链路，新解析缺失时回填保留
          chapter.indexUrl = chapter.indexUrl || rec.meta.indexUrl;
          chapter.prevUrl = chapter.prevUrl || rec.meta.prevUrl;
          chapter.nextUrl = chapter.nextUrl || rec.meta.nextUrl;
          rec.data = chapter;
          rec.meta = Object.assign({}, rec.meta, metaOf(chapter));
        }
        if (rec.el) return true; // 并发恢复时后完成者复用先完成者插入的 DOM
        const el = buildEl(rec.data);
        let refIdx = idx + 1;
        while (refIdx < records.length && !records[refIdx].el) refIdx++;
        const refNode = refIdx < records.length ? records[refIdx].el : null;
        onInsert();
        const base = refNode ? refNode.getBoundingClientRect().top : container.getBoundingClientRect().height;
        if (refNode) container.insertBefore(el, refNode);
        else container.appendChild(el);
        rec.el = el;
        // onBuilt 不得同步写 DOM：下方 grown 依赖「插入后、回填内容前」的高度测量
        onBuilt(rec);
        const grown = refNode ? refNode.getBoundingClientRect().top - base : container.getBoundingClientRect().height - base;
        if (grown > 0) shrinkPillow(grown);
        trim();
        if (collapsedCount > 0) collapsedCount--;
        if (collapsedCount === 0) {
          if (collapsedNote) {
            collapsedNote.remove();
            collapsedNote = null;
          }
          removePillow();
        } else {
          ensureCollapsedNote();
        }
        return true;
      },

      get currentIndex() { return currentIndex; },
      set currentIndex(v) { currentIndex = v; },
      get collapsedCount() { return collapsedCount; },
      get length() { return records.length; }
    };
  };
})();
