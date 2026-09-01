/**
 * kbd-guard.js — 主世界键盘隔离（manifest 里以 world:MAIN + document_start 注入）
 *
 * 小说站普遍把 ←/→ 绑定为整页翻章导航。阅读视图打开期间若放行这些按键，
 * 站点脚本会与阅读器同时触发整页跳转（表现为"按方向键翻章就退出阅读模式"）。
 *
 * 必须在主世界执行：隔离世界的 stopImmediatePropagation 阻断不了页面世界的
 * 监听器（Chrome 按世界先后派发，主世界在前），preventDefault 也拦不住
 * location 跳转。而主世界的 stopImmediatePropagation 会连同隔离世界一起截断，
 * 因此守卫在阻断原始按键后，用 CustomEvent 把按键转发给隔离世界的阅读器
 * （阅读器监听 novelreader:key），自身快捷键不受影响。
 *
 * 以 #novel-reader-host 存在与否为开关：无需与隔离世界通信，阅读器开即拦、
 * 关即放。不调用 preventDefault：目录搜索框打字、光标移动等默认行为照常。
 */
(function () {
  'use strict';
  // 标记守卫已就位（隔离世界可读取 DOM 属性，用于行为分支/调试）
  document.documentElement.setAttribute('data-nr-kbd-guard', '1');
  function guard(e) {
    if (!document.getElementById('novel-reader-host')) return;
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
})();
