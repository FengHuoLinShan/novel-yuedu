/**
 * chapter-cache.js — 整本章节持久缓存（IndexedDB，经 service worker 读写）
 *
 * 内容脚本不直接持有 IndexedDB 连接（连接与存储生命周期统一在后台管理），
 * 本模块只做三件事：
 *   - put(chapter)：网络抓取成功的章节进入微批缓冲（凑 5 条或 2000ms，pagehide 兜底），
 *     刷出时发 NR_CACHE_PUT 交后台落库（chainNextUrl/done 取批内末章的链信息）；
 *   - get/has/book：供 next-chapter 供章与断点续抓起点查询；
 *   - listBooks/deleteBook/clearAll：设置面板「缓存管理」用。
 *
 * 书键与 progress 的目录归并口径一致（NR.dirnameOf），同一本书的章节归并到同一条书记录。
 * 首次 put 前先 NR_CACHE_BOOK 查一次书记录作基线（count/size 已含历史数据；
 * 防重复计数最终由后台按 url 存在性幂等落库保证，基线仅用于会话内标题兜底与调试）。
 *
 * 缓存是尽力而为：扩展上下文失效、存储写满、消息丢失都只损失缓存，绝不影响阅读。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const FLUSH_COUNT = 5; // 缓冲凑满条数即刷
  const FLUSH_DELAY = 2000; // 或 2 秒尾缘兜底刷

  let buffer = []; // 待落库章节缓冲
  let flushTimer = 0;
  let sessionKey = ''; // 本次页面会话的书键（首次 put 时确定，页面内不变）
  let sessionTitle = ''; // 书名（优先取章节对象里的 bookTitle 字段）
  let baselinePromise = null; // 首次 put 的书记录基线查询（幂等）
  const seenUrls = new Set(); // 本会话已入队的 URL：网络重抓不重复入队（后台落库仍按 url 幂等）

  /** 去 hash 的归一化 URL（与后台落库键、extractor stripHash 口径一致） */
  function normUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.search;
    } catch (e) {
      return '';
    }
  }

  /** 书键推导：与 progress 的目录归并一致（origin + 去文件名的路径） */
  function bookKeyOf() {
    return NR.dirnameOf(location.href);
  }

  /** 发消息：extAlive 守卫 + try/catch，任何失败静默降级为空结果（缓存不能影响阅读） */
  function send(msg) {
    if (!NR.extAlive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => {
        console.debug('[novel-reader] 章节缓存消息失败：', (e && e.message) || e);
        return null;
      });
    } catch (e) {
      console.debug('[novel-reader] 章节缓存消息发送异常：', (e && e.message) || e);
      return Promise.resolve(null);
    }
  }

  /** 首次使用时查一次书记录作基线（拿历史 count/size，避免会话侧重复计数观感失真） */
  function ensureBaseline() {
    if (!baselinePromise) {
      baselinePromise = send({ type: 'NR_CACHE_BOOK', bookKey: sessionKey || bookKeyOf() }).then((resp) => {
        return (resp && resp.ok && resp.data) || null;
      });
    }
    return baselinePromise;
  }

  /** 刷出缓冲：整批交后台（chainNextUrl/done 取批内末章的链信息：末章无下一章即全书到尾） */
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!buffer.length) return;
    const chapters = buffer;
    buffer = [];
    const last = chapters[chapters.length - 1];
    const chainNextUrl = last.nextUrl || null;
    const msg = {
      type: 'NR_CACHE_PUT',
      book: { bookKey: sessionKey || bookKeyOf(), title: sessionTitle },
      chapters,
      chainNextUrl,
      done: !chainNextUrl
    };
    ensureBaseline()
      .then(() => send(msg))
      .catch((e) => {
        console.debug('[novel-reader] 章节缓存落库失败：', (e && e.message) || e);
      });
  }

  NR.chapterCache = {
    /** 同 normUrl 暴露给链 prefetch：has() 返回的映射以归一化 URL 为键 */
    normUrl,

    /**
     * 网络抓取成功后的落库入口（fire-and-forget）：入微批缓冲，凑批后交后台写入。
     * @param {object} chapter   extractDoc 产出的章节对象（含 url/title/bookTitle/paragraphs/nextUrl…）
     * @param {object} [bookMeta] 可选 {bookKey,title} 覆盖默认推导
     */
    put(chapter, bookMeta) {
      try {
        if (!chapter || !chapter.url || !chapter.paragraphs || !chapter.paragraphs.length) return;
        if (!NR.extAlive()) return;
        const url = normUrl(chapter.url);
        if (!url || seenUrls.has(url)) return;
        seenUrls.add(url);
        sessionKey = sessionKey || (bookMeta && bookMeta.bookKey) || bookKeyOf();
        const title = (bookMeta && bookMeta.title) || chapter.bookTitle || '';
        if (title && !sessionTitle) sessionTitle = title;
        buffer.push({
          url,
          title: chapter.title || '',
          bookTitle: chapter.bookTitle || '',
          paragraphs: chapter.paragraphs,
          nextUrl: normUrl(chapter.nextUrl) || null,
          prevUrl: normUrl(chapter.prevUrl) || null,
          indexUrl: normUrl(chapter.indexUrl) || null
        });
        ensureBaseline();
        if (buffer.length >= FLUSH_COUNT) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY);
      } catch (e) {
        console.debug('[novel-reader] 章节缓存入队失败：', (e && e.message) || e);
      }
    },

    /** 查单章持久记录：命中返回记录（回填内存缓存由调用方做），未命中返回 null */
    async get(url) {
      const u = normUrl(url);
      if (!u) return null;
      const resp = await send({ type: 'NR_CACHE_GET', url: u });
      return (resp && resp.ok && resp.data) || null;
    },

    /** 批量存在性查询：返回 {归一化url: boolean} */
    async has(urls) {
      const list = (Array.isArray(urls) ? urls : []).map(normUrl).filter(Boolean);
      if (!list.length) return {};
      const resp = await send({ type: 'NR_CACHE_HAS', urls: list });
      return (resp && resp.ok && resp.data) || {};
    },

    /** 查书记录（断点续抓起点 = 记录.nextUrl，done=true 表示全书到尾） */
    async book(bookKey) {
      const resp = await send({ type: 'NR_CACHE_BOOK', bookKey: bookKey || bookKeyOf() });
      return (resp && resp.ok && resp.data) || null;
    },

    /** 全部缓存书列表（ts 倒序），设置面板用 */
    async listBooks() {
      const resp = await send({ type: 'NR_CACHE_LIST' });
      return (resp && resp.ok && resp.data) || [];
    },

    /** 删除一本书的全部章节与书记录 */
    async deleteBook(bookKey) {
      if (!bookKey) return;
      await send({ type: 'NR_CACHE_DELETE', bookKey });
    },

    /** 清空全部缓存（章节 + 书记录），并复位本会话记账 */
    async clearAll() {
      await send({ type: 'NR_CACHE_DELETE', all: true });
      seenUrls.clear();
      baselinePromise = null;
    }
  };

  // 页面卸载兜底：缓冲中的章节立即刷给后台（尽力而为，失败不阻塞卸载）
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      try {
        flush();
      } catch (e) {
        /* 忽略 */
      }
    });
  }
})();
