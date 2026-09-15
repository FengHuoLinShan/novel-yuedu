/**
 * sites.js — 站点启停（深模块）
 *
 *   NR.sites.matchHost(host, list) -> boolean      // host 等同或为其子域
 *   NR.sites.load()                -> Promise<string[]>
 *   NR.sites.isEnabled(host)       -> Promise<boolean>
 *   NR.sites.setEnabled(host, on)  -> Promise<string[]>
 *
 * 停用列表存 chrome.storage.local 'blacklist'（历史键名，冻结；字符串数组，元素为 host）。
 * 测试注入：NR.sites._setStorage(adapter)。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});
  const KEY = 'blacklist';

  const storeHandle = NR.makeStore('local');
  function store() {
    return storeHandle.use();
  }

  /** host 命中等同项或其任一父域（www.example.com 命中 example.com） */
  function matchHost(host, list) {
    return Array.isArray(list) && list.some((h) => host === h || host.endsWith('.' + h));
  }

  NR.sites = {
    _setStorage(adapter) {
      storeHandle.setAdapter(adapter);
    },
    matchHost,

    async load() {
      const s = await store().get(KEY);
      return Array.isArray(s && s[KEY]) ? s[KEY].slice() : [];
    },

    async isEnabled(host) {
      return !matchHost(host, await this.load());
    },

    /** 启用时移除该 host（及覆盖它的父域项），禁用时加入该 host。返回新列表。 */
    async setEnabled(host, enabled) {
      const list = await this.load();
      let next = list;
      if (enabled) next = list.filter((h) => h !== host && !host.endsWith('.' + h));
      else if (!list.includes(host)) next = list.concat(host);
      await store().set({ [KEY]: next });
      return next;
    }
  };
})();
