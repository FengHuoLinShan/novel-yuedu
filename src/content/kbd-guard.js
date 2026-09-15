/**
 * kbd-guard.js — 主世界守卫：键盘隔离 + 阅读期间导航/弹窗锁定
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
 * == 导航/弹窗锁定 ==
 * 盗版站的弹窗/跳转广告脚本在页面加载时就已运行驻留（早于阅读模式开启），
 * 网络层拦截（DNR 白名单）救不了内存里的既有代码：这类 SDK 在 window 上挂
 * touch/click 监听，阅读中触屏/点击即 window.open 或 location 跳广告。
 * 必须在主世界把导航本身拦下。阅读模式打开期间（#novel-reader-host 存在）：
 *  - Navigation API navigate 事件（Chrome 102+）：跨源导航一律 preventDefault；
 *    锁定开启（data-nr-nav-lock≠"0"，默认开）时同源的跨文档导航与下载也拦，
 *    只放行同文档导航（hash/history.replaceState——阅读器自身的地址栏跟随依赖它）
 *  - window.open 包装：document_start 先于站点脚本执行，站点拿到的引用即本包装，
 *    阅读期间一律返回 null（弹窗/popunder 广告连窗口都开不出来）
 *  - history.pushState/replaceState 包装：阅读期间站点脚本调用变 no-op
 *    （阅读器在隔离世界持有原始引用，自身的 replaceState 不受影响）
 *  - click/submit 捕获：阅读期间命中 a[href] 的点击与表单提交一律取消
 *    （原页面已 display:none，真实用户点不到原站链接，只拦广告脚本的合成事件）
 *  - 动态注入的 <meta http-equiv=refresh>：阅读期间移除（定时跳转广告几乎
 *    全是运行时注入，首次文档解析自带的拦不住属可接受残留）
 *  - Firefox 无 Navigation API：退化为 beforeunload 原生确认框兜底
 *
 * 阅读器自身的翻章导航（目录跳转/首章返回上一章）通过一次性放行标记
 * data-nr-nav-allow（时间戳，1 秒内一次有效）正常通过。
 *
 * 开关约定（跨世界只通 DOM 属性，无需消息通道）：
 *  - #novel-reader-host 存在与否 = 阅读模式总开关；
 *  - documentElement[data-nr-nav-lock="0"] = 用户关闭了“阅读时锁定页面”，
 *    退回旧行为（仅拦跨源导航与弹窗）。
 *
 * 导航锁、宿主挂回（reader-view 的 hostObserver）与原页隐藏（bodyObserver）共同维护
 * 同一个不变量：阅读器保活不变量（见 CONTEXT.md）。
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

  // ---------------- 导航/弹窗锁定 ----------------
  function reading() {
    return !!document.getElementById('novel-reader-host');
  }
  /** 全量导航锁定是否生效：阅读中且用户未在设置里关闭 */
  function lockOn() {
    return reading() && document.documentElement.getAttribute('data-nr-nav-lock') !== '0';
  }
  /** 消费一次性放行标记（阅读器主动翻章用）：1 秒内有效，用后即焚 */
  function navAllowed() {
    const el = document.documentElement;
    const t = parseInt(el.getAttribute('data-nr-nav-allow') || '', 10);
    if (t && Date.now() - t < 1000) {
      el.removeAttribute('data-nr-nav-allow');
      return true;
    }
    return false;
  }
  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false; // 解析不了的 destination 一律不放行
    }
  }

  // 已知残留：站点可用 iframe.contentWindow.open 拿到未包装的原生 open（新
  // realm），此处不堵（注入 iframe 拦截过于侵入）；DNR 的 popup/main_frame
  // 类型拦截对该路径兜底，广告窗口的请求照样发不出去。
  const origOpen = window.open;
  window.open = function () {
    if (reading()) return null;
    return origOpen.apply(window, arguments);
  };

  if (window.navigation) {
    window.navigation.addEventListener('navigate', (e) => {
      if (!reading()) return;
      // 浏览器侧发起的导航（地址栏输入、书签、chrome.tabs.update 等）也会派发
      // navigate 事件但 cancelable=false，对其 preventDefault 会抛 InvalidStateError；
      // 这类导航是用户的明确意图，放行
      if (!e.cancelable) return;
      const dest = e.destination || {};
      // 跨源导航：无论锁定开关一律拦（旧行为保留：跳外域必为广告）。
      // destination.url 缺失按不可信处理（fail-closed）：部分跨源场景 url 会
      // 被隐私剥离为空串，空串经 new URL('', base) 会误判同源放行
      if (!dest.url || !sameOrigin(dest.url)) {
        e.preventDefault();
        return;
      }
      if (!lockOn()) return;
      if (navAllowed()) return; // 阅读器自身的翻章导航
      // 同文档导航（hash / pushState / replaceState）放行——阅读器翻章后的
      // 地址栏跟随（replaceState）依赖它，且同文档导航不会卸载阅读器。
      // sameDocument 属性缺失的老版本退化为仅拦跨源（上面的分支已拦）。
      if (typeof dest.sameDocument === 'boolean' && !dest.sameDocument) e.preventDefault();
      else if (e.downloadRequest != null) e.preventDefault(); // 强制下载同样拦
    });
  } else {
    // Firefox 等无 Navigation API 的环境：beforeunload 原生确认框兜底。
    // 代价是手动关标签页也会弹一次确认（平台能力所限），站点强跳被拦下。
    window.addEventListener('beforeunload', (e) => {
      if (!lockOn()) return;
      if (navAllowed()) return; // 阅读器主动翻章不弹框
      e.preventDefault();
      e.returnValue = '';
    });
  }

  // history 篡改锁定：广告 SDK 常用 pushState 刷地址栏做跳转伪装/统计
  for (const fn of ['pushState', 'replaceState']) {
    try {
      const orig = history[fn];
      history[fn] = function () {
        if (lockOn()) return undefined;
        return orig.apply(history, arguments);
      };
    } catch (e) {
      /* 个别环境 History 方法不可写：跳过该层防护 */
    }
  }

  // 合成点击/表单提交锁定：原页面阅读中不可见，能触达的只有广告脚本
  document.addEventListener(
    'click',
    (e) => {
      if (!lockOn()) return;
      const t = e.target;
      const a = t && t.closest ? t.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
  document.addEventListener(
    'submit',
    (e) => {
      if (!lockOn()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );

  const metaObserver = new MutationObserver(() => {
    if (!reading()) return;
    for (const m of document.querySelectorAll('meta[http-equiv]')) {
      if (/^refresh$/i.test(m.getAttribute('http-equiv') || '')) m.remove();
    }
  });
  metaObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
