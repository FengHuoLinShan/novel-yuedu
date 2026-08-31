/**
 * next-chapter.js — 下一章预加载器
 *
 * content script 内同源 fetch（自动带页面 cookie，登录/VIP 态可用）→ arrayBuffer
 * → 探测编码（BOM / Content-Type / meta charset，GBK 站用 gb18030 解码）→ DOMParser
 * → 复用 extractDoc 管线 → 内存缓存。翻章命中缓存即零等待。
 *
 * 防死循环与熔断（My Novel Reader 验证过的策略）：
 *  - URL 校验在 extractor.validChapterUrl 中（同源/非当前/非目录/非静态资源）
 *  - 同一 URL 失败 3 次后熔断，不再重试
 *  - 预取链串行 + 间隔限速，避免给站点压力
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

    /** 取章节（带去重、缓存与失败熔断） */
    async getChapter(url) {
      const entry = this.cache.get(url);
      if (entry) {
        if (entry.status === 'ok') return entry.chapter;
        if (entry.status === 'pending') return entry.promise;
        if (entry.status === 'failed' && entry.count >= MAX_FAIL) {
          throw entry.error || new Error('已熔断');
        }
      }
      const promise = (async () => {
        try {
          const doc = await this.fetchDoc(url);
          const chapter = await NR.extractDoc(doc, url);
          if (!chapter.ok || !chapter.paragraphs.length) {
            throw new Error('正文提取失败: ' + url);
          }
          chapter.url = url;
          this.cache.set(url, { status: 'ok', chapter });
          this.prune();
          return chapter;
        } catch (err) {
          const prev = this.cache.get(url);
          const count = prev && prev.status === 'failed' ? prev.count + 1 : 1;
          this.cache.set(url, { status: 'failed', count, error: err });
          throw err;
        }
      })();
      this.cache.set(url, { status: 'pending', promise });
      return promise;
    },

    /**
     * 从某章开始沿 nextUrl 链预取 depth 章（串行 + 限速）。
     * 同一时间只允许一条预取链，防止并发轰炸站点。
     */
    async prefetchFrom(url, depth) {
      if (this._chainBusy) return;
      this._chainBusy = true;
      try {
        let current = url;
        for (let i = 0; i < depth; i++) {
          let chapter;
          const entry = this.cache.get(current);
          if (entry && entry.status === 'ok') {
            chapter = entry.chapter;
          } else {
            try {
              chapter = await this.getChapter(current);
            } catch (e) {
              break; // 预取失败静默终止，用户翻章时再报错重试
            }
          }
          if (!chapter.nextUrl) break;
          const nextEntry = this.cache.get(chapter.nextUrl);
          if (nextEntry && (nextEntry.status === 'ok' || nextEntry.status === 'pending')) continue;
          await NR.sleep(350); // 温和限速
          current = chapter.nextUrl;
        }
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
})();
