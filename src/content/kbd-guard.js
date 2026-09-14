/**
 * kbd-guard.js — 主世界守卫：键盘隔离 + 阅读期间导航/弹窗隔离
 * （manifest 里以 world:MAIN + document_start 注入）
 *
 * == 键盘隔离 ==
 * 小说站普遍把 ←/→ 绑定为整页翻章导航。阅读视图打开期间若放行这些按键，
 * 站点脚本会与阅读器同时触发整页跳转（表现为“按方向键翻章就退出阅读模式”）。
 *
 * 必须在主世界执行：隔离世界的 stopImmediatePropagation 阻断不了页面世界的
 * 监听器（Chrome 按世界先后派发，主世界在前），preventDefault 也拦不住
 * location 跳转。而主世界的 stopImmediatePropagation 会连同隔离世界一起截断，
 * 因此守卫在阻断原始按键后，用 CustomEvent 把按键转发给隔离世界的阅读器
 * （阅读器监听 novelreader:key），自身快捷键不受影响。
 * 不调用 preventDefault：目录搜索框打字、光标移动等默认行为照常。
 *
 * == 导航/弹窗隔离 ==
 * 盗版站的弹窗/跳转广告脚本在页面加载时就已运行驻留（早于阅读模式开启），
 * 网络层拦截（DNR 白名单）救不了内存里的既有代码：这类 SDK 在 window 上挂
 * touch/click 监听，阅读中触屏/点击即 window.open 或 location 跳外域广告。
 * 必须在主世界把导航本身拦下：
 *  - Navigation API navigate 事件（Chrome 102+）：跨源导航 preventDefault，
 *    阅读器自身的翻章导航均为同源不受影响；Firefox 未实现该 API 时退化为
 *    仅靠 DNR 掐断跳转请求（页面会停在拦截错误页而非广告页）
 *  - window.open 包装：document_start 先于站点脚本执行，站点拿到的引用即本包装，
 *    阅读期间一律返回 null（弹窗/popunder 广告连窗口都开不出来）
 *  - 动态注入的 <meta http-equiv=refresh>：阅读期间移除（定时跳转广告几乎
 *    全是运行时注入，首次文档解析自带的拦不住属可接受残留）
 *
 * 三组防护均以 #novel-reader-host 存在与否为开关：无需与隔离世界通信，
 * 阅读器开即拦、关即放。
 */
(function () {
  'use strict';
  // 标记守卫已就位（隔离世界可读取 DOM 属性，用于行为分支/调试）
  document.documentElement.setAttribute('data-nr-kbd-guard', '1');
  function guard(e) {
    if (!reading()) return;
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    window.dispatchEvent(
      new CustomEvent('novelreader:key', {
        detail: {
          key: e.key,
          code: e.code,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey
        }
      })
    );
  }
  window.addEventListener('keydown', guard, true);
  window.addEventListener('keyup', guard, true);

  // ---------------- 导航/弹窗隔离 ----------------
  function reading() {
    return !!document.getElementById('novel-reader-host');
  }
  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false; // 解析不了的 destination 一律不放行
    }
  }

  const origOpen = window.open;
  window.open = function () {
    if (reading()) return null;
    return origOpen.apply(window, arguments);
  };

  if (window.navigation) {
    window.navigation.addEventListener('navigate', (e) => {
      if (reading() && !sameOrigin(e.destination.url)) e.preventDefault();
    });
  }

  const metaObserver = new MutationObserver(() => {
    if (!reading()) return;
    for (const m of document.querySelectorAll('meta[http-equiv]')) {
      if (/^refresh$/i.test(m.getAttribute('http-equiv') || '')) m.remove();
    }
  });
  metaObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
