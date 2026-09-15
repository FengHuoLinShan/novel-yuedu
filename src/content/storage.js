/**
 * storage.js — chrome.storage 适配器与可注入测试缝
 *
 *   const handle = NR.makeStore('local' | 'sync')
 *   handle.use()          -> { get(keys), getAll(), set(obj), remove(keys) }
 *   handle.setAdapter(a)  -> 注入内存适配器（test-core 用）
 *
 * 惰性解析：模块加载期不触碰 chrome（test-core 以 new Function 加载本文件）。
 * getAll() 只有 local 域需要（整包兼容读取）。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  function defaultAdapter(area) {
    const store = typeof chrome !== 'undefined' && chrome.storage && chrome.storage[area];
    if (!store) throw new Error('chrome.storage.' + area + ' 不可用');
    const adapter = {
      get: (keys) => store.get(keys),
      set: (obj) => store.set(obj),
      remove: (keys) => store.remove(keys)
    };
    if (area === 'local') adapter.getAll = () => store.get(null);
    return adapter;
  }

  NR.makeStore = function (area) {
    let injected = null;
    return {
      setAdapter(adapter) {
        injected = adapter;
      },
      use() {
        if (!injected) injected = defaultAdapter(area);
        return injected;
      }
    };
  };
})();
