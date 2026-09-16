/**
 * settings.js — 排版 / 文本偏好设置模型（深模块）
 *
 *   NR.DEFAULT_SETTINGS / NR.FONT_STACKS / NR.THEMES
 *   NR.settings              当前生效值（读取）
 *   NR.getSettings()         从 storage.sync 载入（含旧版 widthEm 迁移）
 *   NR.saveSettings(patch)   赋值 + 尾缘 debounce 持久化 + 通知订阅者
 *   NR.persistSettingsNow()  立即落盘（pagehide / 测试）
 *   NR.reloadSettings(value) 外部（storage.onChanged）变更：赋值 + 通知
 *   NR.subscribeSettings(fn) 订阅变更，返回退订函数
 *   NR.settingsStore._setStorage(adapter)  注入 sync 域适配器（test-core 用）
 *
 * 本模块不触碰阅读视图：阅读器订阅后自行把设置应用到自己的 DOM（见评审报告）。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  NR.DEFAULT_SETTINGS = {
    fontSize: 19,        // px
    lineHeight: 1.9,     // 倍
    fontFamily: 'system',
    theme: 'light',      // light | dark | sepia
    widthPercent: 75,      // 正文宽度占视口百分比；100% 即当前设备全屏，横竖屏切换由 CSS 自动适配
    fullWidth: false,      // 全屏宽度快捷开关：正文铺满屏幕，仅保留少量边距
    indent: true,        // 首行缩进两字
    noImages: true,      // 屏蔽正文图片
    preload: true,       // 预加载下一章
    autoAppend: true,    // 滚动到底自动拼接下一章
    cacheBook: true,     // 阅读时后台缓存整本书（依次抓取后续章节落 IndexedDB，消耗流量）
    clickPaging: true,   // 点击屏幕上/下三分之一区域翻页
    floatingButton: true, // 显示悬浮按钮
    blockAdsOnRead: true,  // 阅读时启用白名单式拦截：仅放行本站域名的请求（会话级 DNR 规则）
    navLock: true,         // 阅读时锁定页面：禁止站点脚本跳转/弹窗/篡改地址栏/强制退出阅读器
    textConvert: 'none',   // 简繁转换：none 原文 | s2t 转繁体 | t2s 转简体（离线字表，渲染时应用）
    translateMode: 'off',  // 端侧翻译：off 关闭 | replace 替换原文 | bilingual 双语对照
    translateSource: 'auto', // 源语言：auto 自动检测，或 BCP-47 码
    translateTarget: 'en'    // 目标语言（BCP-47，见 NR.LANG_OPTIONS）
  };

  NR.FONT_STACKS = {
    system: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif',
    song: 'Georgia, "Songti SC", SimSun, "NSimSun", "Songti", serif',
    hei: '"PingFang SC", "Heiti SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif',
    kai: '"Kaiti SC", KaiTi, STKaiti, "STSong", "WenQuanYi Micro Hei Light", serif'
  };

  NR.THEMES = {
    light: { bg: '#f7f7f4', fg: '#2c2c2c', muted: '#8a8a85', line: '#e4e4de', accent: '#4f46e5', panel: '#ffffff' },
    dark: { bg: '#16161a', fg: '#c9c9cf', muted: '#7c7c85', line: '#2c2a32', accent: '#8b87f7', panel: '#1e1e24' },
    sepia: { bg: '#f5ecd9', fg: '#584634', muted: '#a08c72', line: '#e6d9bf', accent: '#8a6d3b', panel: '#faf3e3' }
  };

  NR.settings = Object.assign({}, NR.DEFAULT_SETTINGS);

  const syncHandle = NR.makeStore('sync');
  function syncStore() {
    return syncHandle.use();
  }

  /**
   * 测试注入（sync 域）。不挂在 NR.settings 上：那是会被 getSettings/reloadSettings
   * 整体替换的值对象，挂上去第一次载入后就没了。
   */
  NR.settingsStore = {
    _setStorage(adapter) {
      syncHandle.setAdapter(adapter);
    }
  };

  const listeners = new Set();
  let persistTimer = 0;
  let syncFailNotified = false;

  function notify() {
    for (const fn of Array.from(listeners)) {
      try {
        fn(NR.settings);
      } catch (e) {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  /** 订阅设置变更，返回退订函数 */
  NR.subscribeSettings = function (fn) {
    listeners.add(fn);
    return function unsubscribe() {
      listeners.delete(fn);
    };
  };

  NR.getSettings = async function () {
    try {
      const store = await syncStore().get('settings');
      const stored = store.settings || {};
      NR.settings = Object.assign({}, NR.DEFAULT_SETTINGS, stored);
      // 旧版 em 宽度迁移为百分比：按当前设备视口换算，保证观感不变
      if (stored.widthPercent == null && stored.widthEm != null && typeof window !== 'undefined') {
        const px = stored.widthEm * (stored.fontSize || NR.DEFAULT_SETTINGS.fontSize);
        NR.settings.widthPercent = Math.min(100, Math.max(30, Math.round((px / Math.max(320, window.innerWidth)) * 100)));
      }
    } catch (e) {
      NR.settings = Object.assign({}, NR.DEFAULT_SETTINGS);
    }
    return NR.settings;
  };

  /**
   * 更新设置：页面立即生效，持久化走尾缘 debounce。
   * 滑杆每个 input 事件都会调用本函数（连续拖动高频），直接写 storage.sync 会撞
   * 每分钟 120 次 / 每小时 1800 次的写限额，被拒的值就丢了；收敛为停手后写一次。
   */
  NR.saveSettings = function (patch) {
    Object.assign(NR.settings, patch);
    notify();
    NR.persistSettingsSoon();
  };

  /** 外部（storage.onChanged）变更：整体替换当前值并通知订阅者 */
  NR.reloadSettings = function (value) {
    NR.settings = Object.assign({}, NR.DEFAULT_SETTINGS, value || {});
    notify();
  };

  NR.persistSettingsSoon = function () {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => NR.persistSettingsNow(), 400);
  };

  NR.persistSettingsNow = function () {
    clearTimeout(persistTimer);
    try {
      if (!NR.extAlive()) return;
      syncStore().set({ settings: NR.settings }).catch((e) => {
        // 持久化失败不能无声丢失（超限时本次修改不会跨设备保留）
        console.warn('[novel-reader] 设置同步失败：', e && e.message);
        if (!syncFailNotified) {
          syncFailNotified = true;
          NR.toast('设置同步失败，本次修改不会跨设备保留', 2600);
        }
      });
    } catch (e) {
      /* 扩展上下文失效时设置仍在本页生效，只是不再持久化 */
    }
  };

  // 页面卸载前把 debounce 中的最后一次修改落盘，避免关页丢改动
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => NR.persistSettingsNow());
  }
})();
