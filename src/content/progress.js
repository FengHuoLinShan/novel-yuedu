/**
 * progress.js — 书籍阅读进度存储（深模块）
 *
 * 调用方只需知道三件事：
 *   NR.progress.get(bookKey, pageUrl) -> Promise<record|null>
 *   NR.progress.put(bookKey, record)  -> Promise<void>   // 串行化 + 旧格式迁移 + 200 本淘汰
 *   NR.progress.recent(limit)         -> Promise<record[]>
 *   NR.progress.list()                -> Promise<entry[]> // 全量条目（带 bookKey，书架列表用）
 *   NR.progress.remove(bookKey)       -> Promise<void>    // 删除一本书的进度（书架移除用）
 *
 * 键方案（冻结，见 ADR-0001）：每本书独立 key 'p:<书键>'；旧版整包 'progress' 只读兼容，
 * 首次写入时幂等迁移为独立 key 后删除。书键漂移时按章节 URL 目录归并（取 ts 最新）。
 *
 * 测试注入：NR.progress._setStorage(adapter)，adapter = { get(keys), getAll(), set(obj), remove(keys) }。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const PREFIX = 'p:';
  const LEGACY_KEY = 'progress';
  const MAX_BOOKS = 200;
  const EVICT_INTERVAL = 30000;

  const storeHandle = NR.makeStore('local');
  let chain = Promise.resolve();
  let lastEvictAt = 0;

  function store() {
    return storeHandle.use();
  }
  function keyOf(bookKey) {
    return PREFIX + bookKey;
  }

  /** 目录归并匹配（原 detector.findBookRecord 的语义，收进进度模块内部） */
  function findRecord(map, bookKey, pageUrl) {
    if (!map) return null;
    if (bookKey && map[bookKey]) return map[bookKey];
    const dir = NR.dirnameOf(pageUrl);
    if (!dir) return null;
    let best = null;
    for (const k in map) {
      const r = map[k];
      if (r && r.url && NR.dirnameOf(r.url) === dir && (!best || (r.ts || 0) > (best.ts || 0))) best = r;
    }
    return best;
  }

  /** storage 全量 → 「书键 -> 记录」映射（新格式 p: 优先，旧版 progress 兜底） */
  function collect(all) {
    const map = {};
    const legacy = all && all[LEGACY_KEY];
    if (legacy && typeof legacy === 'object') {
      for (const k of Object.keys(legacy)) {
        if (legacy[k] && legacy[k].url) map[k] = legacy[k];
      }
    }
    for (const k of Object.keys(all || {})) {
      if (k.indexOf(PREFIX) === 0 && all[k] && all[k].url) map[k.slice(PREFIX.length)] = all[k];
    }
    return map;
  }

  NR.progress = {
    _setStorage(adapter) {
      storeHandle.setAdapter(adapter);
      chain = Promise.resolve();
      lastEvictAt = 0;
    },

    async get(bookKey, pageUrl) {
      const all = await store().getAll();
      return findRecord(collect(all), bookKey, pageUrl);
    },

    async recent(limit) {
      const all = await store().getAll();
      return Object.values(collect(all))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit || 8);
    },

    /** 全量进度条目（含 legacy 兼容记录），按 ts 倒序；与 recent 同源但保留 bookKey（书架列表用） */
    async list() {
      const all = await store().getAll();
      return Object.entries(collect(all))
        .map(([bookKey, record]) => Object.assign({}, record, { bookKey }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    },

    put(bookKey, record) {
      chain = chain.then(() => this._write(bookKey, record)).catch(() => {});
      return chain;
    },

    /** 删除 'p:<bookKey>'：沿用写串行链避免与 _write 竞态；失败静默（进度丢失可容忍） */
    remove(bookKey) {
      if (!bookKey) return Promise.resolve();
      chain = chain.then(() => store().remove(keyOf(bookKey))).catch(() => {});
      return chain;
    },

    async _write(bookKey, record) {
      const all = await store().getAll();
      const setOps = {};
      const legacy = all && all[LEGACY_KEY];
      if (legacy && typeof legacy === 'object') {
        // 先写全部 p:，成功后再删旧整包：迁移幂等，两标签页并发结果一致
        for (const k of Object.keys(legacy)) {
          if (legacy[k] && legacy[k].url) setOps[PREFIX + k] = legacy[k];
        }
      }
      setOps[keyOf(bookKey)] = record;
      await store().set(setOps);
      if (legacy) await store().remove(LEGACY_KEY);
      await this._evictIfNeeded();
    },

    /** 超过 200 本时淘汰最久未读（节流，避免每次保存全量扫描） */
    async _evictIfNeeded() {
      const now = Date.now();
      if (now - lastEvictAt < EVICT_INTERVAL) return;
      lastEvictAt = now;
      const all = await store().getAll();
      const entries = [];
      for (const k of Object.keys(all || {})) {
        if (k.indexOf(PREFIX) === 0 && all[k] && all[k].url) entries.push([k, all[k]]);
      }
      if (entries.length <= MAX_BOOKS) return;
      entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      await store().remove(entries.slice(0, entries.length - MAX_BOOKS).map((e) => e[0]));
    },

    /** 内部测试缝（不属于接口） */
    _findRecord: findRecord,
    _collect: collect,
    _reset() {
      chain = Promise.resolve();
      lastEvictAt = 0;
    }
  };
})();
