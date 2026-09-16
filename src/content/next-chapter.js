/**
 * next-chapter.js — 下一章预加载器
 *
 * content script 内同源 fetch（自动带页面 cookie，登录/VIP 态可用）→ arrayBuffer
 * → 探测编码（BOM / Content-Type / meta charset，GBK 站用 gb18030 解码）→ DOMParser
 * → 复用 extractDoc 管线 → 内存缓存。翻章命中缓存即零等待。
 *
 * 两级缓存：内存缓存（本页会话）之外，网络抓取成功的章节还会经 NR.chapterCache
 * （chapter-cache.js → 后台 IndexedDB）持久落库；内存未命中时先查持久缓存，
 * 命中则不走网络、不计熔断。cacheBook 开启时 NR.bookSaver 在预取触发点驱动
 * 「整本链」：从断点沿 nextUrl 一直抓到全书尾（novelreader:cacheprog 事件上报进度）。
 *
 * 防死循环与熔断（My Novel Reader 验证过的策略）：
 *  - URL 校验在 extractor.validChapterUrl 中（同源/非当前/非目录/非静态资源）
 *  - 同一 URL 失败 3 次后熔断，不再重试
 *  - 预取链串行 + 间隔限速，避免给站点压力（持久缓存已有的章节不占限速间隔）
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const FETCH_TIMEOUT = 20000;
  const MAX_FAIL = 3;
  const MAX_CACHE = 80;

  NR.loader = {
    cache: new Map(), // url -> {status:'pending',promise} | {status:'ok',chapter} | {status:'failed',count,error}
    _chainBusy: false,

    /** 抓取并解析一个页面为 Document */
    async fetchDoc(url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      let res;
      try {
        res = await fetch(url, {
          credentials: 'same-origin',
          redirect: 'follow',
          signal: ctrl.signal
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const encoding = this.sniffEncoding(buf, res.headers.get('content-type'));
      const html = new TextDecoder(encoding).decode(buf);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc;
    },

    /**
     * 编码探测：BOM → Content-Type 头 → 头部 2KB 内的 meta charset。
     * gb2312/gbk 统一用 gb18030（超集，兼容无损）。
     */
    sniffEncoding(buf, contentType) {
      const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 2048));
      if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
      let label = null;
      if (contentType) {
        const m = contentType.match(/charset\s*=\s*["']?([\w-]+)/i);
        if (m) label = m[1];
      }
      if (!label) {
        let s = '';
        for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]);
        const m = s.match(/charset\s*=\s*["']?([\w-]+)/i);
        if (m) label = m[1];
      }
      if (!label) return 'utf-8';
      label = label.toLowerCase();
      if (label === 'gb2312' || label === 'gbk' || label === 'gb') label = 'gb18030';
      try {
        new TextDecoder(label, { fatal: true });
        return label;
      } catch (e) {
        return 'utf-8';
      }
    },

    /** 清除某 URL 的失败熔断计数（用户主动翻章/点击重试时允许重新请求，弱网 3 次瞬断不该判死刑） */
    clearFail(url) {
      const entry = this.cache.get(url);
      if (entry && entry.status === 'failed') this.cache.delete(url);
    },

    /**
     * 内存条目命中分类：ok/pending 直接复用；failed 且达熔断线返回待抛错误；
     * 其余（无记录 / 失败未达线可重试）返回 null 走加载。
     */
    _entryHit(url) {
      const entry = this.cache.get(url);
      if (!entry) return null;
      if (entry.status === 'ok') return { value: entry.chapter };
      if (entry.status === 'pending') return { value: entry.promise };
      if (entry.status === 'failed' && entry.count >= MAX_FAIL) {
        return { throws: entry.error || new Error('已熔断') };
      }
      return null;
    },

    /** 取章节（带去重、内存/持久两级缓存与失败熔断） */
    async getChapter(url) {
      let hit = this._entryHit(url);
      if (hit) {
        if (hit.throws) throw hit.throws;
        return hit.value;
      }
      // 持久缓存命中：直接回填内存缓存返回（不走网络、不计熔断、不产生流量）。
      // 查询有 await 窗口，回来后必须复查内存：并发调用可能已建立 pending，
      // 复查（含熔断抛错）必须在 try 之外——catch 只兜持久缓存自身故障，不能吞业务错误
      if (NR.chapterCache) {
        let rec = null;
        try {
          rec = await NR.chapterCache.get(url);
        } catch (e) {
          /* 扩展上下文失效等：持久缓存不可用，静默落到网络路径 */
        }
        hit = this._entryHit(url);
        if (hit) {
          if (hit.throws) throw hit.throws;
          return hit.value;
        }
        if (rec && rec.paragraphs && rec.paragraphs.length) {
          const chapter = {
            ok: true,
            via: 'cache',
            url,
            title: rec.title || '',
            bookTitle: rec.bookTitle || '',
            paragraphs: rec.paragraphs,
            images: [], // 图片不入持久缓存：默认屏蔽图片设置下无感知，需要时在线补载
            prevUrl: rec.prevUrl || null,
            nextUrl: rec.nextUrl || null,
            indexUrl: rec.indexUrl || null
          };
          this.cache.set(url, { status: 'ok', chapter });
          return chapter;
        }
      }
      // 进入本次尝试前先记下历史失败数：下方 pending 条目会覆盖 failed 条目，
      // 失败时若从缓存读会永远拿到 pending，导致计数恒为 1、熔断形同虚设
      const prevFails = (() => {
        const entry = this.cache.get(url);
        return entry && entry.status === 'failed' ? entry.count : 0;
      })();
      const promise = (async () => {
        try {
          const doc = await this.fetchDoc(url);
          // 章节链 URL 已经过 validChapterUrl 校验，允许章末短分页（一两百字）通过：
          // 错误壳/空页只有十几个字，仍会被 120 的门槛拒绝
          const chapter = await NR.extractDoc(doc, url, { minCjk: 120 });
          if (!chapter.ok || !chapter.paragraphs.length) {
            throw new Error('正文提取失败: ' + url);
          }
          chapter.url = url;
          this.cache.set(url, { status: 'ok', chapter });
          // 整本持久缓存：网络抓取成功即异步落库（fire-and-forget，尽力而为，失败不影响阅读）
          if (NR.chapterCache) {
            try {
              NR.chapterCache.put(chapter);
            } catch (e) {
              /* 落库失败静默 */
            }
          }
          this.prune();
          return chapter;
        } catch (err) {
          this.cache.set(url, { status: 'failed', count: prevFails + 1, error: err });
          throw err;
        }
      })();
      this.cache.set(url, { status: 'pending', promise });
      return promise;
    },

    /**
     * 从某章开始沿 nextUrl 链预取 depth 章（串行 + 限速）。
     * 同一时间只允许一条预取链，防止并发轰炸站点（_chainBusy 单链互斥）。
     *
     * 整本模式：cacheBook 开启时 depth 传 Infinity，持久缓存已有的下一章不再限速
     * （本地秒回、不打站点），仅真正需要联网的推进做间隔限速。
     *
     * @param {string} url        链起点
     * @param {number} depth      最多推进的章数（整本模式传 Infinity）
     * @param {Function} [onChapter] 每章确认可读后的回调 (chapter, fresh)：
     *   fresh=true 仅当本章来自本次网络抓取（内存复用/持久命中不回调新增，
     *   供整本状态机计数，避免对已入库章节重复 +1）
     * @returns {Promise<string>} 链终止原因：
     *   'busy' 已有链在跑 | 'depth' 走满 | 'done' 到链尾
     * 连续 MAX_FAIL 次网络失败（或撞上 per-URL 熔断）时抛出最后错误——
     * 整本状态机据此暂停；per-URL 熔断计数由 getChapter 自管，这里不清也不读
     */
    async prefetchFrom(url, depth, onChapter) {
      if (this._chainBusy) return 'busy';
      this._chainBusy = true;
      try {
        let current = url;
        let consecFails = 0;
        for (let i = 0; i < depth; i++) {
          let chapter;
          const entry = this.cache.get(current);
          if (entry && entry.status === 'ok') {
            chapter = entry.chapter;
          } else {
            // 网络抓取：偶发失败原地重试同一 URL，连续 MAX_FAIL 次失败才终止整条链。
            // getChapter 的 per-URL 失败计数照常自增，达线即被其自身熔断（这里不清也不读）；
            // 已熔断的 URL 重试必再抛，直接终止不浪费间隔等待
            for (;;) {
              try {
                chapter = await this.getChapter(current);
                break;
              } catch (e) {
                consecFails++;
                const ent = this.cache.get(current);
                const tripped = !!(ent && ent.status === 'failed' && ent.count >= MAX_FAIL);
                if (consecFails >= MAX_FAIL || tripped) throw e;
                await NR.sleep(900);
              }
            }
            consecFails = 0;
          }
          if (onChapter) {
            const fromMemory = !!(entry && entry.status === 'ok');
            onChapter(chapter, !fromMemory && chapter.via !== 'cache');
          }
          if (!chapter.nextUrl) return 'done';
          const nextEntry = this.cache.get(chapter.nextUrl);
          if (nextEntry && (nextEntry.status === 'ok' || nextEntry.status === 'pending')) {
            current = chapter.nextUrl;
            continue; // 内存已有（已抓/在抓）→ 直接前进
          }
          // 持久缓存已有下一章 → 本地秒回，无需限速；否则温和限速再抓（随机抖动防齐步请求）
          let persisted = false;
          if (NR.chapterCache) {
            try {
              const map = await NR.chapterCache.has([chapter.nextUrl]);
              persisted = !!(map && map[NR.chapterCache.normUrl(chapter.nextUrl)]);
            } catch (e) {
              /* 查询失败按未命中处理 */
            }
          }
          if (!persisted) await NR.sleep(450 + Math.random() * 300);
          current = chapter.nextUrl;
        }
        return 'depth';
      } finally {
        this._chainBusy = false;
      }
    },

    /** 缓存上限：保留正在渲染的章节，淘汰最早的缓存 */
    prune(keepUrls) {
      if (this.cache.size <= MAX_CACHE) return;
      const keep = new Set(keepUrls || []);
      for (const key of this.cache.keys()) {
        if (this.cache.size <= MAX_CACHE) break;
        const entry = this.cache.get(key);
        if (entry.status === 'ok' && !keep.has(key)) this.cache.delete(key);
      }
    }
  };

  /**
   * bookSaver — 整本缓存状态机（NR.settings.cacheBook 开启时接管 reader 的预取触发点）
   *
   *   state: idle 未开始 | running 抓取链进行中 | paused 连续失败暂停 | done 全书到尾
   *   count: 本次会话进度计数（种子取自书记录已缓存章数，仅网络新增章节时递增）
   *
   * 进度经 document 事件 'novelreader:cacheprog' 广播（reader-view 工具栏 chip 消费）：
   *   {count, done:false} 每章新增 | {count, done:true} 到链尾 | {count, paused:true} 连续失败
   * 起点策略：书记录未 done 且带 nextUrl（上次链尾章的下一章）→ 断点续抓；否则从当前章起。
   * 与 loader._chainBusy 单链互斥语义保持：同一页面同时只跑一条链。
   */
  NR.bookSaver = {
    state: 'idle',
    count: 0,

    /** reader 预取触发点入口；cacheBook 关闭时退回原有的 depth 章轻量预取 */
    start(fromUrl, normalDepth) {
      if (!NR.settings || !NR.settings.cacheBook) {
        NR.loader.prefetchFrom(fromUrl, normalDepth || 2).catch(() => {});
        return;
      }
      if (this.state === 'running' || this.state === 'done') return;
      this._run(fromUrl).catch(() => {
        // 防御兜底：prefetchFrom 之外的意外异常同样归为暂停
        this.state = 'paused';
        this._emit({ count: this.count, paused: true });
      });
    },

    async _run(fromUrl) {
      this.state = 'running';
      // 起点：先查书记录，未 done 且有断点 → 从断点续；否则从当前章起
      let startUrl = fromUrl;
      let seed = 0;
      if (NR.chapterCache) {
        try {
          const rec = await NR.chapterCache.book(NR.dirnameOf(location.href));
          if (rec) {
            seed = rec.count || 0;
            if (!rec.done && rec.nextUrl) startUrl = rec.nextUrl;
          }
        } catch (e) {
          /* 查不到记录就从当前章开始 */
        }
      }
      this.count = seed;
      // 连续 3 次网络失败：prefetchFrom 抛出，由 start() 的 catch 归为暂停（不清 per-URL 熔断）
      const reason = await NR.loader.prefetchFrom(startUrl, Infinity, (chapter, fresh) => {
        if (!fresh) return;
        this.count++;
        this._emit({ count: this.count, done: false });
      });
      if (reason === 'done') {
        this.state = 'done';
        this._emit({ count: this.count, done: true });
      } else if (reason === 'busy') {
        // 与普通预取链撞车（防御，正常到不了）：归为暂停，等下次触发点再续
        this.state = 'paused';
      }
      // 'depth' 不会出现（整本模式 depth 为 Infinity）；其余原因维持状态等下次触发点
    },

    _emit(detail) {
      try {
        document.dispatchEvent(new CustomEvent('novelreader:cacheprog', { detail }));
      } catch (e) {
        /* 事件失败不影响状态机 */
      }
    }
  };
})();
