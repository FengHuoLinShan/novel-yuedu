/**
 * intent.js — 跳转意图（深模块）
 *
 * 一次跨页面跳转在落地页自动进入阅读模式、并说明是否恢复位置。
 *   NR.intent.declare(url, kind) -> Promise<void>          // kind: 'jump' | 'resume'
 *   NR.intent.consume(hereUrl)   -> Promise<{url,intent}|null>
 *
 * 键方案（冻结，见 ADR-0001）：每个目标 URL 一条独立 key 'po:<url 去 hash>'，
 * 多标签页并发跳转互不覆盖、只删自己命中的条目。兼容旧版单值 'pendingOpen'。
 * 过期 10 分钟；consume 时顺带清理过期与损坏条目。未消费的条目没有定时清理，
 * 最长残留到 TTL 之后的第一次 boot（由 consume 顺带清扫），与旧实现一致。
 *
 * 测试注入：NR.intent._setStorage(adapter)。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const PREFIX = 'po:';
  const LEGACY_KEY = 'pendingOpen';
  const TTL = 10 * 60 * 1000;

  const storeHandle = NR.makeStore('local');
  function store() {
    return storeHandle.use();
  }
  function stripHash(url) {
    return String(url || '').split('#')[0];
  }

  NR.intent = {
    _setStorage(adapter) {
      storeHandle.setAdapter(adapter);
    },

    declare(url, kind) {
      const key = PREFIX + stripHash(url);
      return store().set({ [key]: { url: url, ts: Date.now(), intent: kind } });
    },

    /** 消费落地页命中的意图：删除自己命中的条目与过期/损坏条目，返回 {url,intent} 或 null */
    async consume(hereUrl) {
      const all = await store().getAll();
      const now = Date.now();
      const here = stripHash(hereUrl);
      const doomed = [];
      let mine = null;
      for (const k of Object.keys(all || {})) {
        const entry = all[k];
        if (k === LEGACY_KEY) {
          // 旧版单值标记：按原语义消费/清理
          if (!entry || !entry.url) {
            doomed.push(k);
            continue;
          }
          const samePage = stripHash(entry.url) === here;
          if (samePage || now - (entry.ts || 0) > TTL) doomed.push(k);
          if (samePage && now - (entry.ts || 0) <= TTL) mine = entry;
        } else if (k.indexOf(PREFIX) === 0) {
          if (!entry || !entry.url) {
            doomed.push(k);
            continue;
          }
          if (now - (entry.ts || 0) > TTL) {
            doomed.push(k);
            continue;
          }
          if (stripHash(entry.url) === here) {
            mine = entry;
            doomed.push(k); // 只删自己命中的条目，别的标签页的标记不动
          }
        }
      }
      if (doomed.length) {
        // 清理失败不得影响本次落地打开（对齐旧版 remove().catch(()=>{}) 语义）
        try { await store().remove(doomed); } catch (e) { /* 忽略 */ }
      }
      if (!mine) return null;
      return { url: mine.url, intent: mine.intent === 'resume' ? 'resume' : 'jump' };
    }
  };
})();
