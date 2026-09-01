/**
 * reader-view.js — 全屏阅读视图（Shadow DOM 隔离）
 *
 * - 开放 Shadow DOM + 内部容器 all:initial，彻底隔离原站 CSS
 * - 原 body 隐藏但保留 DOM，退出后完整还原原页面
 * - 章节滚动拼接（瀑布流）+ 快捷键翻章 + 按书记忆阅读进度
 * - 地址栏通过 replaceState 跟随当前章节（不污染浏览器历史），刷新后配合进度记忆可回到原位
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const APPEND_THRESHOLD_PX = 600; // 距底多少像素触发自动拼接
  const PREFETCH_DEPTH = 2;
  const MAX_DOM_CHAPTERS = 12; // DOM 中最多保留的章节数（防内存膨胀）
  const KEEP_BEHIND = 5; // 当前章之后回收，当前章之前保留几章
  const KEEP_AHEAD = MAX_DOM_CHAPTERS - KEEP_BEHIND - 1; // 回翻时当前章之后保留几章（窗口对称滑动）
  const PROGRESS_THROTTLE = 1500;
  const CATALOG_RENDER_CAP = 3000; // 目录渲染条数上限，与 parseCatalog 的 3000 解析上限对齐（超长完本书也能翻到尾章）

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .nr-root {
      all: initial;
      display: flex; flex-direction: column;
      position: fixed; inset: 0; z-index: 2147483647;
      font-family: var(--nr-ff); color: var(--nr-fg); background: var(--nr-bg);
      font-size: var(--nr-fs); line-height: var(--nr-lh);
      -webkit-font-smoothing: antialiased;
    }
    .nr-progress {
      position: absolute; top: 0; left: 0; height: 3px; width: 0;
      background: var(--nr-accent); z-index: 30; transition: width .15s linear;
    }
    .nr-header {
      position: absolute; top: 0; left: 0; right: 0; z-index: 20;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 16px;
      background: color-mix(in srgb, var(--nr-bg) 88%, transparent);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--nr-line);
      transition: transform .25s ease;
    }
    .nr-header.nr-hidden { transform: translateY(-105%); }
    .nr-titles { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .nr-book { font-size: 12px; color: var(--nr-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nr-chapter-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nr-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .nr-act {
      all: unset; cursor: pointer; font: inherit;
      font-size: 13px; color: var(--nr-fg);
      padding: 6px 10px; border-radius: 8px; white-space: nowrap;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .nr-act:hover { background: color-mix(in srgb, var(--nr-fg) 10%, transparent); }
    .nr-act.nr-accent { color: var(--nr-accent); font-weight: 600; }
    .nr-scroll {
      flex: 1; overflow-y: auto; position: relative; overscroll-behavior: contain;
      padding: 84px 18px 96px; /* 顶部留足悬浮工具栏高度（书名+章节名两行约 60px），避免遮挡章节标题 */
      -webkit-overflow-scrolling: touch;
      /* 收起上方章节时的位置补偿由 _trimChapters 手工执行，禁用原生滚动锚定防止双重偏移 */
      overflow-anchor: none;
      scrollbar-width: thin; scrollbar-color: var(--nr-line) transparent;
    }
    .nr-scroll::-webkit-scrollbar { width: 8px; }
    .nr-scroll::-webkit-scrollbar-thumb { background: var(--nr-line); border-radius: 4px; }
    .nr-pages { max-width: var(--nr-width); margin: 0 auto; }
    .nr-chapter { margin: 0 0 70px; }
    .nr-chapter:last-child { margin-bottom: 0; }
    .nr-ch-title {
      font-size: 1.35em; font-weight: 700; text-align: center;
      margin: 0 0 1.5em; line-height: 1.5;
    }
    .nr-p { margin: 0 0 0.95em; text-align: justify; }
    .nr-indent .nr-p { text-indent: 2em; }
    .nr-chapter img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
    .nr-img-hidden .nr-chapter img { display: none !important; }
    .nr-chapter-sep {
      text-align: center; color: var(--nr-muted); font-size: .85em;
      margin: 2.5em 0; letter-spacing: .5em;
    }
    .nr-collapsed {
      text-align: center; color: var(--nr-muted); font-size: .8em;
      border: 1px dashed var(--nr-line); border-radius: 8px; padding: 8px; margin-bottom: 24px;
    }
    .nr-resume {
      display: flex; align-items: center; gap: 10px;
      border: 1px solid var(--nr-line); background: var(--nr-panel);
      border-radius: 10px; padding: 10px 14px; margin: 0 0 26px;
      font-size: .85em; color: var(--nr-muted);
    }
    .nr-resume > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nr-resume-go {
      all: unset; cursor: pointer; color: var(--nr-accent); font-weight: 600;
      padding: 5px 10px; border-radius: 6px; flex-shrink: 0; touch-action: manipulation;
    }
    .nr-resume-go:hover { background: color-mix(in srgb, var(--nr-accent) 10%, transparent); }
    .nr-resume-x { all: unset; cursor: pointer; color: var(--nr-muted); padding: 5px 8px; flex-shrink: 0; }
    .nr-tail { text-align: center; color: var(--nr-muted); font-size: .9em; padding: 26px 0 8px; }
    .nr-tail .nr-btn {
      all: unset; cursor: pointer; font: inherit;
      border: 1px solid var(--nr-line); border-radius: 999px;
      padding: 8px 26px; color: var(--nr-fg); background: var(--nr-panel);
    }
    .nr-tail .nr-btn:hover { border-color: var(--nr-accent); color: var(--nr-accent); }
    .nr-spin {
      display: inline-block; width: 14px; height: 14px; vertical-align: -2px;
      border: 2px solid var(--nr-line); border-top-color: var(--nr-accent);
      border-radius: 50%; animation: nr-rot .8s linear infinite; margin-right: 8px;
    }
    @keyframes nr-rot { to { transform: rotate(360deg); } }
    .nr-scrim { position: absolute; inset: 0; z-index: 38; background: rgba(0,0,0,.25); display: none; }
    .nr-panel-open .nr-scrim, .nr-catalog-open .nr-scrim { display: block; }
    .nr-act, .nr-btn, .nr-cat-item, .nr-reset, .nr-catalog-close { touch-action: manipulation; }
    .nr-panel {
      position: absolute; top: 0; right: 0; bottom: 0; z-index: 40;
      width: min(320px, 88vw); background: var(--nr-panel);
      border-left: 1px solid var(--nr-line);
      transform: translateX(105%); transition: transform .25s ease;
      overflow-y: auto; padding: 18px 18px 30px;
      font-size: 13px; color: var(--nr-fg);
    }
    .nr-panel-open .nr-panel { transform: translateX(0); }
    .nr-panel-inner .nr-panel-title { font-size: 15px; font-weight: 700; margin-bottom: 14px; }
    .nr-row { display: flex; align-items: center; gap: 10px; margin: 12px 0; }
    .nr-row > label { flex-shrink: 0; width: 3.5em; color: var(--nr-muted); }
    .nr-row > input[type="range"] { flex: 1; accent-color: var(--nr-accent); }
    .nr-row > input[type="range"]:disabled { opacity: .3; }
    .nr-row > select {
      flex: 1; font: inherit; color: var(--nr-fg); background: var(--nr-bg);
      border: 1px solid var(--nr-line); border-radius: 6px; padding: 5px 6px;
    }
    .nr-val { width: 3.4em; text-align: right; color: var(--nr-muted); font-size: 12px; }
    .nr-divider { border-top: 1px solid var(--nr-line); margin: 16px 0 8px; }
    .nr-check { display: flex; align-items: center; gap: 8px; padding: 7px 0; cursor: pointer; }
    .nr-check input { accent-color: var(--nr-accent); }
    .nr-reset {
      all: unset; cursor: pointer; font: inherit; box-sizing: border-box;
      display: block; text-align: center; width: 100%; margin-top: 16px;
      border: 1px solid var(--nr-line); border-radius: 8px; padding: 8px; color: var(--nr-muted);
    }
    .nr-reset:hover { color: var(--nr-accent); border-color: var(--nr-accent); }
    .nr-kbd { color: var(--nr-muted); font-size: 11px; text-align: center; margin-top: 18px; line-height: 1.8; }
    .nr-catalog {
      position: absolute; top: 0; left: 0; bottom: 0; z-index: 40;
      width: min(360px, 85vw); background: var(--nr-panel);
      border-right: 1px solid var(--nr-line);
      transform: translateX(-105%); transition: transform .25s ease;
      display: flex; flex-direction: column;
      font-size: 13px; color: var(--nr-fg);
    }
    .nr-catalog-open .nr-catalog { transform: translateX(0); }
    .nr-catalog-head { padding: 14px 14px 12px; border-bottom: 1px solid var(--nr-line); }
    .nr-catalog-title { font-size: 14px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
    .nr-catalog-title .nr-cat-count { font-size: 11px; font-weight: 400; color: var(--nr-muted); }
    .nr-catalog-close { all: unset; cursor: pointer; color: var(--nr-muted); font-size: 15px; padding: 2px 8px; border-radius: 6px; }
    .nr-catalog-close:hover { background: color-mix(in srgb, var(--nr-fg) 10%, transparent); }
    .nr-catalog-search {
      width: 100%; box-sizing: border-box; font: inherit; color: var(--nr-fg);
      padding: 8px 10px; border: 1px solid var(--nr-line); border-radius: 8px;
      background: var(--nr-bg); outline: none;
    }
    .nr-catalog-search:focus { border-color: var(--nr-accent); }
    .nr-catalog-list { flex: 1; overflow-y: auto; position: relative; padding: 8px 6px; -webkit-overflow-scrolling: touch; }
    .nr-cat-item {
      display: block; padding: 8px 10px; border-radius: 8px; cursor: pointer;
      color: var(--nr-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .nr-cat-item:hover { background: color-mix(in srgb, var(--nr-fg) 8%, transparent); }
    .nr-cat-item.nr-cur { color: var(--nr-accent); font-weight: 600; background: color-mix(in srgb, var(--nr-accent) 8%, transparent); }
    .nr-cat-item.nr-hit { color: var(--nr-accent); font-weight: 600; outline: 1px dashed var(--nr-accent); outline-offset: -1px; }
    .nr-cat-empty { padding: 24px 14px; text-align: center; color: var(--nr-muted); line-height: 2; }
    .nr-cat-empty .nr-btn { all: unset; cursor: pointer; font: inherit; border: 1px solid var(--nr-line); border-radius: 999px; padding: 6px 20px; color: var(--nr-fg); }
    /* 手机适配：窄窗口或触屏设备（老站常无 viewport 声明，手机上布局宽度仍是 980px，
       仅凭 max-width 会漏掉这类站点，需叠加 pointer: coarse） */
    @media (max-width: 640px), (pointer: coarse) {
      .nr-scroll { padding: 72px 12px 70px; }
      .nr-act { padding: 10px 8px; min-height: 44px; }
      .nr-act[data-act="prev"], .nr-act[data-act="next"] {
        font-size: 20px; line-height: 1;
        min-width: 44px; justify-content: center; padding: 0 12px;
      }
      .nr-act .nr-act-text { display: none; }
      .nr-cat-item { padding: 11px 10px; }
    }
  `;

  function px(el) {
    return el && el.offsetParent ? el.offsetTop : 0;
  }

  NR.reader = {
    isOpen: false,
    state: null,
    rootEl: null,
    _openPromise: null,

    // ---------------- 生命周期 ----------------

    /**
     * 打开阅读视图。getSettings/extractDoc 期间可能被悬浮按钮、快捷键、消息并发重入，
     * 共享同一个打开 Promise：并发调用只构建一套 UI / state / 监听器。
     */
    open() {
      if (this.isOpen) return Promise.resolve(true);
      if (this._openPromise) return this._openPromise;
      this._openPromise = this._doOpen().finally(() => {
        this._openPromise = null;
      });
      return this._openPromise;
    },

    async _doOpen() {
      if (!/^https?:$/.test(location.protocol)) {
        NR.toast('此页面不支持阅读模式');
        return false;
      }
      await NR.getSettings();
      const chapter = await NR.extractDoc(document, location.href);
      if (!chapter.ok || !chapter.paragraphs.length) {
        NR.toast('未能识别本页正文，无法进入阅读模式');
        return false;
      }

      const state = (this.state = {
        originalUrl: location.href,
        originalTitle: document.title,
        chapters: [], // [{data, el}]
        currentIndex: 0,
        appending: false,
        appendingUrl: null, // 正在拼接的 URL（同 URL 并发去重）
        appendingPromise: null,
        tailError: false,
        inputFocus: false,
        lastScrollTop: 0,
        lastPrefetchAt: 0,
        headerHideTimer: 0,
        progressTimer: 0,
        collapsedCount: 0,
        restoredRatio: null,
        catalogList: null,
        catalogLoading: false,
        landingIntent: NR._autoOpenIntent || null // 落地方式：resume=续读（恢复位置）/ jump=主动跳转（不提示不恢复）
      });
      NR._autoOpenIntent = null;
      this.isOpen = true;

      this._buildUI(chapter);
      this._hideOriginal();
      this._appendChapter(chapter);
      this._renderTail();
      this._startPrefetch();
      this._syncDnr(!!NR.settings.blockAdsOnRead); // 是否注册会话级拦截跟随设置，而非无条件开启
      this._restoreProgress();

      document.dispatchEvent(new CustomEvent('novelreader:opened'));
      return true;
    },

    close() {
      if (!this.isOpen) return;
      const state = this.state;
      this._saveProgressNow();
      this._syncDnr(false);
      try {
        window.removeEventListener('keydown', state.keyHandler, true);
        window.removeEventListener('keyup', state.keyUpHandler, true);
        window.removeEventListener('novelreader:key', state.guardKeyHandler);
        state.scroller.removeEventListener('scroll', state.scrollHandler);
        window.removeEventListener('pagehide', state.pageHideHandler);
        document.removeEventListener('visibilitychange', state.pageHideHandler);
        if (state.bodyObserver) state.bodyObserver.disconnect();
      } catch (e) {
        /* 忽略 */
      }
      this._restoreOriginal();
      if (state.host && state.host.isConnected) state.host.remove();
      if (location.href !== state.originalUrl) {
        try {
          // 替换而非新增历史条目：退出不应在浏览器历史里留下章节地址
          history.replaceState(null, '', state.originalUrl);
        } catch (e) {
          /* 跨域异常忽略 */
        }
      }
      this.isOpen = false;
      this.state = null;
      this.rootEl = null;
      document.dispatchEvent(new CustomEvent('novelreader:closed'));
    },

    /**
     * 异步边界存活检查：reader 仍打开且 state 仍是当前会话的那份。
     * 章节/目录/进度等 await 之后必须先过此检查再继续，防止旧会话的
     * 异步任务回写已关闭或已重开的新会话（"reader state is gone" 类错误的根源）。
     */
    _alive(state) {
      return !!(state && this.isOpen && this.state === state);
    },

    // ---------------- UI 构建 ----------------

    _buildUI(firstChapter) {
      const state = this.state;
      const host = document.createElement('div');
      host.id = 'novel-reader-host';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'open' });

      const styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      shadow.appendChild(styleEl);

      const root = document.createElement('div');
      root.className = 'nr-root';
      root.innerHTML =
        '<div class="nr-progress"></div>' +
        '<header class="nr-header nr-hidden">' +
        '  <div class="nr-titles"><div class="nr-book"></div><div class="nr-chapter-name"></div></div>' +
        '  <div class="nr-actions">' +
        '    <button class="nr-act" data-act="catalog" title="目录与快速跳转">☰ <span class="nr-act-text">目录</span></button>' +
        '    <button class="nr-act nr-accent" data-act="settings" title="排版设置">Aa</button>' +
        '    <button class="nr-act" data-act="prev" title="上一章（←）">‹ <span class="nr-act-text">上一章</span></button>' +
        '    <button class="nr-act" data-act="next" title="下一章（→）"><span class="nr-act-text">下一章</span> ›</button>' +
        '    <button class="nr-act" data-act="exit" title="退出（Esc）">✕</button>' +
        '  </div>' +
        '</header>' +
        '<main class="nr-scroll"><div class="nr-pages"></div><div class="nr-tail"></div></main>' +
        '<div class="nr-scrim"></div>' +
        '<aside class="nr-panel"></aside>' +
        '<aside class="nr-catalog">' +
        '  <div class="nr-catalog-head">' +
        '    <div class="nr-catalog-title"><span>目录<span class="nr-cat-count"></span></span><button class="nr-catalog-close" title="关闭">✕</button></div>' +
        '    <input class="nr-catalog-search" type="search" placeholder="搜索章节号 / 标题…" />' +
        '  </div>' +
        '  <div class="nr-catalog-list"></div>' +
        '</aside>';
      shadow.appendChild(root);

      state.host = host;
      state.shadow = shadow;
      state.root = root;
      state.scroller = root.querySelector('.nr-scroll');
      state.pages = root.querySelector('.nr-pages');
      state.tail = root.querySelector('.nr-tail');
      state.header = root.querySelector('.nr-header');
      state.headerBook = root.querySelector('.nr-book');
      state.headerChapter = root.querySelector('.nr-chapter-name');
      state.progressBar = root.querySelector('.nr-progress');
      this.rootEl = root;

      // 设置面板
      const panelBox = root.querySelector('.nr-panel');
      const panel = NR.buildSettingsPanel();
      state.panelApi = panel;
      panelBox.appendChild(panel.el);
      const kbd = document.createElement('div');
      kbd.className = 'nr-kbd';
      kbd.textContent = '← → 翻章 · + - 字号 · Esc 退出';
      panelBox.appendChild(kbd);
      for (const input of panelBox.querySelectorAll('input,select,button')) {
        input.addEventListener('focus', () => (state.inputFocus = true));
        input.addEventListener('blur', () => (state.inputFocus = false));
      }

      // 头部按钮
      root.querySelector('.nr-actions').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'settings') this._togglePanel();
        else if (act === 'catalog') this._toggleCatalog();
        else if (act === 'prev') this.goPrev();
        else if (act === 'next') this.goNext();
        else if (act === 'exit') this.close();
      });
      root.querySelector('.nr-scrim').addEventListener('click', () => {
        if (root.classList.contains('nr-catalog-open')) this._toggleCatalog(false);
        else this._togglePanel(false);
      });
      root.querySelector('.nr-catalog-close').addEventListener('click', () => this._toggleCatalog(false));
      const catalogSearch = root.querySelector('.nr-catalog-search');
      catalogSearch.addEventListener('input', () => this._renderCatalogList(catalogSearch.value));
      catalogSearch.addEventListener('focus', () => (state.inputFocus = true));
      catalogSearch.addEventListener('blur', () => (state.inputFocus = false));
      root.querySelector('.nr-catalog-list').addEventListener('click', (e) => {
        const item = e.target.closest('.nr-cat-item');
        if (item) this._jumpTo(item.dataset.url);
      });

      state.headerBook.textContent = firstChapter.bookTitle || '';
      state.headerChapter.textContent = firstChapter.title || '';

      // 未识别到目录页时隐藏目录按钮
      if (!firstChapter.indexUrl) {
        const catalogBtn = root.querySelector('[data-act="catalog"]');
        if (catalogBtn) catalogBtn.style.display = 'none';
      }

      // 滚动
      state.scrollHandler = () => this._onScroll();
      state.scroller.addEventListener('scroll', state.scrollHandler, { passive: true });

      // 快捷键：阅读视图打开期间，站点脚本不应再看到任何键盘事件——
      // 大量小说站把 ←/→ 绑定为上一章/下一章的整页跳转，放行会与阅读器
      // 同时触发导航（表现为"按方向键翻章就退出阅读模式"）。
      // 按键管线（Chrome 下主世界先派发、且主世界的 stopImmediatePropagation
      // 会连隔离世界一起截断）：
      //  - 主世界守卫 kbd-guard.js 拦截原始 keydown/keyup，经 CustomEvent
      //    （novelreader:key）转发到本世界，由 handleKey 统一处理；
      //  - 无守卫的环境（world:MAIN 不可用等）退回直接监听原始事件。
      // 只阻断传播、不改默认行为：目录搜索、设置面板打字和移动光标不受影响。
      const blockPageKeys = (e) => e.stopImmediatePropagation();
      state.handleKey = (k) => {
        if (k.key === 'Escape') {
          // Esc 优先关浮层（即使焦点在浮层的搜索框里），无浮层且焦点不在输入框时才退出阅读
          if (root.classList.contains('nr-catalog-open')) this._toggleCatalog(false);
          else if (root.classList.contains('nr-panel-open')) this._togglePanel(false);
          else if (!state.inputFocus) this.close();
          k.preventDefault();
          return;
        }
        if (k.altKey || k.ctrlKey || k.metaKey || state.inputFocus) return;
        const isSpace = k.key === ' ' || k.code === 'Space';
        if (k.key === 'PageDown' || (isSpace && !k.shiftKey)) {
          this._pageScroll(1);
          k.preventDefault();
        } else if (k.key === 'PageUp' || (isSpace && k.shiftKey)) {
          this._pageScroll(-1);
          k.preventDefault();
        } else if (k.key === 'ArrowRight') {
          this.goNext();
          k.preventDefault();
        } else if (k.key === 'ArrowLeft') {
          this.goPrev();
          k.preventDefault();
        } else if (k.key === '+' || k.key === '=') {
          this._adjustFont(1);
          k.preventDefault();
        } else if (k.key === '-' || k.key === '_') {
          this._adjustFont(-1);
          k.preventDefault();
        }
      };
      state.keyHandler = (e) => {
        blockPageKeys(e);
        state.handleKey(e);
      };
      state.guardKeyHandler = (e) => {
        const d = e.detail || {};
        state.handleKey({
          key: d.key,
          code: d.code,
          shiftKey: !!d.shiftKey,
          altKey: !!d.altKey,
          ctrlKey: !!d.ctrlKey,
          metaKey: !!d.metaKey,
          preventDefault() {}
        });
      };
      window.addEventListener('keydown', state.keyHandler, true);
      // keyup 同理阻断：少数站点把翻章导航绑在 keyup 上
      state.keyUpHandler = blockPageKeys;
      window.addEventListener('keyup', state.keyUpHandler, true);
      window.addEventListener('novelreader:key', state.guardKeyHandler);

      // 点击分区：上/下三分之一翻页（避开按钮链接与选词），中间三分之一唤出/收起工具栏
      state.scroller.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select, textarea, label, .nr-btn, .nr-resume, .nr-cat-item, .nr-collapsed')) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return; // 正在选中文字，不动作
        const rect = state.scroller.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const third = rect.height / 3;
        if (y < third) {
          if (NR.settings.clickPaging) this._pageScroll(-1);
        } else if (y > rect.height - third) {
          if (NR.settings.clickPaging) this._pageScroll(1);
        } else if (state.header.classList.contains('nr-hidden')) {
          this._showHeader();
        } else {
          this._hideHeader();
        }
      });

      state.pageHideHandler = () => this._saveProgressNow();
      window.addEventListener('pagehide', state.pageHideHandler);
      document.addEventListener('visibilitychange', state.pageHideHandler);

      document.documentElement.appendChild(host);
      NR.applySettings();
      this._showHeader();
    },

    _togglePanel(force) {
      const root = this.state.root;
      const open = force == null ? !root.classList.contains('nr-panel-open') : force;
      if (open) root.classList.remove('nr-catalog-open'); // 两个侧板互斥
      root.classList.toggle('nr-panel-open', open);
      if (open) this.state.panelApi.refresh();
      else this._blurPanelFocus(); // 焦点残留会让 inputFocus 恒真，Esc 退出等按键被误吞
    },

    // ---------------- 目录面板与快速跳转 ----------------

    _toggleCatalog(force) {
      const state = this.state;
      const root = state.root;
      const open = force == null ? !root.classList.contains('nr-catalog-open') : force;
      if (open) {
        root.classList.remove('nr-panel-open');
        root.classList.add('nr-catalog-open');
        this._ensureCatalog();
        const search = root.querySelector('.nr-catalog-search');
        search.value = '';
        this._renderCatalogList('');
      } else {
        root.classList.remove('nr-catalog-open');
        this._blurPanelFocus(); // 同 _togglePanel：移出搜索框焦点，避免 inputFocus 残留
      }
    },

    /** 关闭侧板后把焦点移回正文滚动区（inputFocus 复位，快捷键恢复全量可用） */
    _blurPanelFocus() {
      const state = this.state;
      const el = state.shadow && state.shadow.activeElement;
      if (el && typeof el.blur === 'function') el.blur();
    },

    /** 拉取目录页并解析章节列表（复用 loader 的 fetch + 编码探测管线） */
    async _ensureCatalog() {
      const state = this.state;
      if (state.catalogList || state.catalogLoading) return;
      const indexUrl = state.chapters[0] && state.chapters[0].data.indexUrl;
      if (!indexUrl) {
        this._renderCatalogError('未识别到本书目录页');
        return;
      }
      state.catalogLoading = true;
      this._renderCatalogLoading();
      try {
        const doc = await NR.loader.fetchDoc(indexUrl);
        if (!this._alive(state)) return; // 加载期间已退出/重开：丢弃结果，不回写
        state.catalogList = NR.parseCatalog(doc, indexUrl, state.originalUrl);
        this._renderCatalogList('');
      } catch (e) {
        if (this._alive(state)) this._renderCatalogError('目录加载失败');
      } finally {
        state.catalogLoading = false;
      }
    },

    _renderCatalogLoading() {
      const listEl = this.state.root.querySelector('.nr-catalog-list');
      listEl.textContent = '';
      const box = document.createElement('div');
      box.className = 'nr-cat-empty';
      const spin = document.createElement('span');
      spin.className = 'nr-spin';
      box.appendChild(spin);
      box.appendChild(document.createTextNode(' 目录加载中…'));
      listEl.appendChild(box);
      this.state.root.querySelector('.nr-cat-count').textContent = '';
    },

    _renderCatalogError(msg) {
      const self = this;
      const state = this.state;
      const listEl = state.root.querySelector('.nr-catalog-list');
      listEl.textContent = '';
      const box = document.createElement('div');
      box.className = 'nr-cat-empty';
      box.appendChild(document.createTextNode(msg + '\n'));
      const btn = document.createElement('button');
      btn.className = 'nr-btn';
      btn.textContent = '重试';
      btn.addEventListener('click', () => {
        state.catalogList = null;
        state.catalogLoading = false;
        self._ensureCatalog();
      });
      box.appendChild(btn);
      listEl.appendChild(box);
    },

    /**
     * 当前章在目录中的索引：先精确 href 匹配，失配后退到去 hash 匹配
     * （目录页链接与实际阅读地址常有 #锚点 差异，精确相等会静默失配导致打开目录不定位）。
     * 不做仅 pathname 兜底：read.html?id=N 类站点全章共享 pathname，会错配到第一章。
     */
    _catalogCurIndex(list) {
      const cur = this.state.chapters[this.state.currentIndex];
      const curUrl = cur && cur.data.url;
      if (!curUrl) return -1;
      for (let i = 0; i < list.length; i++) {
        if (list[i].url === curUrl) return i;
      }
      let curKey;
      try {
        const u = new URL(curUrl);
        curKey = u.origin + u.pathname + u.search;
      } catch (e) {
        return -1;
      }
      for (let i = 0; i < list.length; i++) {
        try {
          const u = new URL(list[i].url);
          if (u.origin + u.pathname + u.search === curKey) return i;
        } catch (e) {
          /* 非法 URL 跳过 */
        }
      }
      return -1;
    },

    /**
     * 渲染章节列表：无搜索词时定位当前章；搜索精确到唯一章节时不裁剪列表、
     * 滚动定位到命中章附近（可看到前后章节）；多命中走过滤。
     */
    _renderCatalogList(filterText) {
      const state = this.state;
      const listEl = state.root.querySelector('.nr-catalog-list');
      const list = state.catalogList;
      if (!list) return;
      const q = String(filterText || '').trim().toLowerCase();
      let hitIdx = -1;
      if (q) {
        let hits = 0;
        for (let i = 0; i < list.length && hits <= 1; i++) {
          if (list[i].title.toLowerCase().indexOf(q) >= 0) {
            hits++;
            hitIdx = i;
          }
        }
        if (hits !== 1) hitIdx = -1;
      }
      const curIdx = this._catalogCurIndex(list);
      listEl.textContent = '';
      const frag = document.createDocumentFragment();
      let shown = 0;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (q && hitIdx < 0 && item.title.toLowerCase().indexOf(q) < 0) continue;
        if (shown >= CATALOG_RENDER_CAP) break; // 超长书目保护（与解析上限一致）
        const d = document.createElement('div');
        d.className = 'nr-cat-item' + (i === curIdx ? ' nr-cur' : '') + (i === hitIdx ? ' nr-hit' : '');
        d.textContent = item.title;
        d.dataset.url = item.url;
        frag.appendChild(d);
        shown++;
      }
      if (!shown) {
        const empty = document.createElement('div');
        empty.className = 'nr-cat-empty';
        empty.textContent = q ? '没有匹配“' + filterText.trim() + '”的章节' : '目录为空';
        listEl.appendChild(empty);
      } else {
        listEl.appendChild(frag);
      }
      const countEl = state.root.querySelector('.nr-cat-count');
      countEl.textContent = hitIdx >= 0 ? `（1/${list.length}·已定位）` : q ? `（${shown}/${list.length}）` : `（共 ${list.length} 章）`;
      // 居中滚动到锚点：无搜索词→当前章；唯一命中→命中章；多命中过滤回到顶部（内容整体更换，旧偏移无意义）
      if (hitIdx >= 0) {
        const hit = listEl.querySelector('.nr-hit');
        if (hit) listEl.scrollTop = Math.max(0, hit.offsetTop - listEl.clientHeight / 2);
      } else if (!q) {
        const cur = listEl.querySelector('.nr-cur');
        if (cur) listEl.scrollTop = Math.max(0, cur.offsetTop - listEl.clientHeight / 2);
      } else {
        listEl.scrollTop = 0;
      }
    },

    /**
     * 写跳转标记：每个目标 URL 一条独立 storage key（po:<url>），
     * 两个标签页同时跳不同章节互不覆盖，落地页只消费自己命中的条目。
     */
    _setPendingOpen(url, intent) {
      const key = 'po:' + String(url).split('#')[0];
      return chrome.storage.local.set({ [key]: { url: url, ts: Date.now(), intent: intent } });
    },

    /** 跳转到指定章节：写跳转标记后导航，新页面自动进入阅读模式（jump 意图：不恢复旧位置） */
    _jumpTo(url) {
      if (!url || !this.isOpen) return;
      this._saveProgressNow();
      this._toggleCatalog(false);
      if (!NR.extAlive()) {
        // 扩展上下文失效：无法携带自动打开标记，直接普通导航
        NR.toast('正在跳转…（扩展已更新，跳转后请手动进入阅读模式）', 2600);
        setTimeout(() => location.assign(url), 300);
        return;
      }
      NR.toast('正在跳转…', 900);
      const go = () => setTimeout(() => location.assign(url), 150);
      try {
        this._setPendingOpen(url, 'jump').then(go, go);
      } catch (e) {
        go();
      }
    },

    // ---------------- 原页面隐藏与还原 ----------------

    _hideOriginal() {
      const state = this.state;
      const body = document.body;
      const html = document.documentElement;
      state.prevBodyStyle = body.getAttribute('style');
      state.prevHtmlOverflow = html.style.overflow;
      body.style.setProperty('display', 'none', 'important');
      html.style.overflow = 'hidden';
      // 某些站点脚本会重写 body 内联样式，盯住并保持隐藏
      state.bodyObserver = new MutationObserver(() => {
        if (this.isOpen && getComputedStyle(body).display !== 'none') {
          body.style.setProperty('display', 'none', 'important');
        }
      });
      state.bodyObserver.observe(body, { attributes: true, attributeFilter: ['style'] });
    },

    _restoreOriginal() {
      const state = this.state;
      const body = document.body;
      const html = document.documentElement;
      if (state.prevBodyStyle == null) body.removeAttribute('style');
      else body.setAttribute('style', state.prevBodyStyle);
      html.style.overflow = state.prevHtmlOverflow || '';
    },

    // ---------------- 章节渲染 ----------------

    _buildChapterEl(chapter) {
      const art = document.createElement('article');
      art.className = 'nr-chapter';
      art.dataset.url = chapter.url;
      const h2 = document.createElement('h2');
      h2.className = 'nr-ch-title';
      h2.textContent = chapter.title || '';
      art.appendChild(h2);
      const frag = document.createDocumentFragment();
      for (const p of chapter.paragraphs) {
        const el = document.createElement('p');
        el.className = 'nr-p';
        el.textContent = p;
        frag.appendChild(el);
      }
      art.appendChild(frag);
      // 插图：默认由 .nr-img-hidden 隐藏，用户关闭“屏蔽图片”后可见；懒加载避免流量浪费
      if (chapter.images && chapter.images.length) {
        for (const src of chapter.images.slice(0, 20)) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = src;
          art.appendChild(img);
        }
      }
      return art;
    },

    _appendChapter(chapter) {
      const state = this.state;
      const el = this._buildChapterEl(chapter);
      state.pages.appendChild(el);
      state.chapters.push({ data: chapter, el });
      this._trimChapters();
      return state.chapters.length - 1;
    },

    /** 该章节记录是否还持有完整正文（收起时会被裁剪成纯导航元数据） */
    _hasFullData(c) {
      return !!(c && c.data && c.data.paragraphs && c.data.paragraphs.length);
    },

    /**
     * DOM 中最后一章（数组末尾可能是被收起的纯元数据记录）。
     * 前进拼接、尾部提示、预取都必须以它为锚，否则回翻后继续前读会跳过中间章节。
     */
    _lastRendered() {
      const chapters = this.state.chapters;
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (chapters[i].el) return chapters[i];
      }
      return null;
    },

    /** 裁剪为可回翻的最小元数据：正文段落/图片不随历史章数驻留内存 */
    _chapterMeta(data) {
      return {
        url: data.url,
        title: data.title,
        bookTitle: data.bookTitle,
        indexUrl: data.indexUrl,
        prevUrl: data.prevUrl,
        nextUrl: data.nextUrl
      };
    },

    _trimChapters() {
      const state = this.state;
      if (state.chapters.length <= MAX_DOM_CHAPTERS) return;
      const minKeep = Math.max(0, state.currentIndex - KEEP_BEHIND);
      const maxKeep = Math.min(state.chapters.length - 1, state.currentIndex + KEEP_AHEAD);
      // 被收起的上方章节：移除后内容变短，浏览器会把越界的 scrollTop 钳位到
      // 新的最大值（阅读中拼接下一章时必然越界）→ 视口跳到新章末尾，需往回翻页找进度。
      // 因此必须在移除前记下滚动位置，移除后按当前章元素的实际位移回退，让视口内容原地不动。
      // （原生滚动锚定已用 overflow-anchor 关闭，此补偿是唯一位移来源；
      //   下方章节的移除不影响 offsetTop，无需补偿）
      const scroller = state.scroller;
      const stBefore = scroller.scrollTop;
      const heightBefore = scroller.scrollHeight;
      const cur = state.chapters[state.currentIndex];
      const refEl = cur && cur.el ? cur.el : null;
      const refTopBefore = refEl ? refEl.offsetTop : 0;
      let removedAny = false;
      for (let i = 0; i < minKeep && i < state.chapters.length; i++) {
        const c = state.chapters[i];
        if (c.el) {
          c.el.remove();
          c.el = null;
          c.data = this._chapterMeta(c.data);
          state.collapsedCount++;
          removedAny = true;
        }
      }
      // 回翻场景：窗口后方（远于 KEEP_AHEAD）的章节同样收起，DOM 不随回翻章数增长
      for (let i = state.chapters.length - 1; i > maxKeep; i--) {
        const c = state.chapters[i];
        if (c.el) {
          c.el.remove();
          c.el = null;
          c.data = this._chapterMeta(c.data);
        }
      }
      if (state.collapsedCount > 0 && !state.collapsedNote) {
        const note = document.createElement('div');
        note.className = 'nr-collapsed';
        state.collapsedNote = note;
        state.pages.insertBefore(note, state.pages.firstChild);
      }
      if (state.collapsedNote) {
        state.collapsedNote.textContent = '已收起前 ' + state.collapsedCount + ' 章（按 ← 可翻回）';
      }
      // 只锁定窗口内仍持正文的章节：被裁剪的历史章节允许从 loader 缓存淘汰，
      // 否则成功缓存会随阅读章数线性增长
      NR.loader.prune(state.chapters.filter((c) => c.el).map((c) => c.data.url));
      if (removedAny) {
        // 用当前章元素的实际位移回滚：比 scrollHeight 差值更准，不受下方 :last-child
        // 外距、尾部提示等与阅读位置无关的高度变化影响
        const shift = refEl ? refTopBefore - refEl.offsetTop : heightBefore - scroller.scrollHeight;
        if (shift > 0) scroller.scrollTop = Math.max(0, stBefore - shift);
      }
    },

    _renderTail() {
      const state = this.state;
      const tail = state.tail;
      if (state.appending) {
        // 切 spinner 前锁定尾部高度：贴底阅读时尾部变矮会触发浏览器钳位 scrollTop，
        // 造成正文轻微上跳（拼接下一章时尤其明显）
        tail.style.minHeight = tail.offsetHeight + 'px';
      } else {
        tail.style.minHeight = '';
      }
      const last = this._lastRendered();
      tail.textContent = '';
      if (state.appending) {
        const spin = document.createElement('span');
        spin.className = 'nr-spin';
        tail.appendChild(spin);
        tail.appendChild(document.createTextNode('正在加载下一章…'));
        return;
      }
      if (!last) return;
      if (!last.data.nextUrl) {
        tail.textContent = '· 已经读到最后一章啦 ·';
        return;
      }
      if (state.tailError) {
        tail.textContent = '下一章加载失败，';
        const btn = document.createElement('button');
        btn.className = 'nr-btn';
        btn.textContent = '重试';
        btn.addEventListener('click', () => {
          state.tailError = false;
          this._appendByUrl(last.data.nextUrl, true);
        });
        tail.appendChild(btn);
        return;
      }
      if (NR.settings.autoAppend) {
        const sep = document.createElement('div');
        sep.className = 'nr-chapter-sep';
        sep.textContent = '上滑继续阅读';
        tail.appendChild(sep);
        const hint = document.createElement('div');
        hint.textContent = '（已预加载下一章：' + (last.data.title || '') + '）';
        tail.appendChild(hint);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'nr-btn';
      btn.textContent = '加载下一章 ↓';
      btn.addEventListener('click', () => this._appendByUrl(last.data.nextUrl, true));
      tail.appendChild(btn);
    },

    // ---------------- 翻章与拼接 ----------------

    /**
     * 返回目标章节下标；失败返回 -1。
     * 同一 URL 的并发调用（慢网连点下一章、按钮/键盘/自动拼接同时到达）共享同一次
     * 拼接 Promise，只渲染一章；用户主动重试已失败章节的语义不变（失败后标记即清除）。
     */
    async _appendByUrl(url, scroll) {
      const state = this.state;
      if (!url) return -1;
      const exist = state.chapters.find((c) => c.data.url === url);
      if (exist) {
        if (!exist.el) await this._rerenderCollapsed(url);
        if (scroll) this._scrollToChapter(url);
        return state.chapters.indexOf(exist);
      }
      if (state.appendingUrl === url && state.appendingPromise) return state.appendingPromise;
      state.appending = true;
      state.appendingUrl = url;
      this._renderTail();
      // scroll=true 即用户主动操作（翻章/点重试）：清除失败熔断再请求，弱网下瞬断可恢复
      if (scroll) NR.loader.clearFail(url);
      const promise = (async () => {
        try {
          const chapter = await NR.loader.getChapter(url);
          if (!this._alive(state)) return -1; // 等待期间已退出/重开：丢弃，不回写新会话
          const idx = this._appendChapter(chapter);
          state.tailError = false;
          this._startPrefetch();
          if (scroll) this._scrollToChapter(url);
          return idx;
        } catch (e) {
          if (this._alive(state)) state.tailError = true;
          return -1;
        } finally {
          state.appending = false;
          state.appendingUrl = null;
          state.appendingPromise = null;
          if (this._alive(state)) this._renderTail();
        }
      })();
      state.appendingPromise = promise;
      return promise;
    },

    /**
     * 恢复已收起的章节：只重建 DOM 并回填原记录的 el，不向 state.chapters 插入新记录
     * （否则同 URL 记录被复制，回翻会反复命中空记录卡在同一章）。
     * 正文已被裁剪成元数据时先按需重载。返回是否恢复成功。
     */
    async _rerenderCollapsed(url) {
      const state = this.state;
      const idx = state.chapters.findIndex((c) => c.data.url === url && !c.el);
      if (idx < 0) return true; // 已恢复或不存在
      if (!this._hasFullData(state.chapters[idx])) {
        try {
          const chapter = await NR.loader.getChapter(url);
          if (!this._alive(state)) return false;
          // 原记录里的导航元数据更贴近当次阅读链路，新解析缺失时回填保留
          chapter.indexUrl = chapter.indexUrl || state.chapters[idx].data.indexUrl;
          chapter.prevUrl = chapter.prevUrl || state.chapters[idx].data.prevUrl;
          chapter.nextUrl = chapter.nextUrl || state.chapters[idx].data.nextUrl;
          state.chapters[idx].data = chapter;
        } catch (e) {
          if (this._alive(state)) NR.toast('章节加载失败，请重试', 1600);
          return false;
        }
      }
      const rec = state.chapters[idx];
      if (rec.el) return true; // 并发恢复时后完成者直接复用先完成者插入的 DOM
      const el = this._buildChapterEl(rec.data);
      let refIdx = idx + 1;
      while (refIdx < state.chapters.length && !state.chapters[refIdx].el) refIdx++;
      if (refIdx < state.chapters.length) state.pages.insertBefore(el, state.chapters[refIdx].el);
      else state.pages.appendChild(el);
      rec.el = el;
      this._trimChapters();
      if (state.collapsedCount > 0) state.collapsedCount--;
      if (state.collapsedCount === 0 && state.collapsedNote) {
        state.collapsedNote.remove();
        state.collapsedNote = null;
      }
      return true;
    },

    _scrollToChapter(url) {
      const state = this.state;
      const idx = state.chapters.findIndex((c) => c.data.url === url && c.el);
      if (idx < 0) return;
      const el = state.chapters[idx].el;
      requestAnimationFrame(() => {
        if (!this._alive(state)) return;
        state.scroller.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: 'auto' });
        // 回翻恢复的章节插回后，目标滚动位置可能与当前 scrollTop 完全重合，
        // 浏览器对"滚到原位"不派发 scroll 事件 → 显式导航必须自行推进当前章判定
        if (state.currentIndex !== idx) {
          state.currentIndex = idx;
          this._onCurrentChanged();
        }
      });
    },

    async goNext() {
      const state = this.state;
      const cur = state.chapters[state.currentIndex];
      if (!cur) return;
      const next = state.chapters[state.currentIndex + 1];
      if (next && next.el) {
        this._scrollToChapter(next.data.url);
        return;
      }
      if (!cur.data.nextUrl) {
        NR.toast('已经是最后一章了', 1400);
        return;
      }
      await this._appendByUrl(cur.data.nextUrl, true);
    },

    goPrev() {
      const state = this.state;
      const curIdx = state.currentIndex;
      if (curIdx > 0) {
        const prev = state.chapters[curIdx - 1];
        if (!prev.el) {
          // 章节可能已被裁剪正文，需要按需重载（异步）；失败提示后停留原章
          this._rerenderCollapsed(prev.data.url)
            .then((ok) => {
              if (ok && this._alive(state)) this._scrollToChapter(prev.data.url);
            })
            .catch(() => {});
          return;
        }
        this._scrollToChapter(prev.data.url);
        return;
      }
      const prevUrl = state.chapters[0] && state.chapters[0].data.prevUrl;
      if (prevUrl) {
        this._saveProgressNow();
        NR.toast('正在返回上一章…', 1000);
        const go = () => setTimeout(() => location.assign(prevUrl), 200);
        try {
          this._setPendingOpen(prevUrl, 'jump').then(go, go);
        } catch (e) {
          go();
        }
      } else {
        NR.toast('没有更早的章节了', 1400);
      }
    },

    // ---------------- 滚动处理 ----------------

    _onScroll() {
      const state = this.state;
      if (!state) return;
      const scroller = state.scroller;
      const st = scroller.scrollTop;

      // 进度条
      const total = scroller.scrollHeight - scroller.clientHeight;
      state.progressBar.style.width = (total > 0 ? Math.min(100, (st / total) * 100) : 0) + '%';

      // 当前章节判定：过 40% 视线线的最后一章
      const midline = st + scroller.clientHeight * 0.4;
      let idx = 0;
      for (let i = 0; i < state.chapters.length; i++) {
        const c = state.chapters[i];
        if (c.el && c.el.offsetTop <= midline) idx = i;
      }
      if (idx !== state.currentIndex) {
        state.currentIndex = idx;
        this._onCurrentChanged();
      }

      // 头部显示/隐藏
      const dy = st - state.lastScrollTop;
      state.lastScrollTop = st;
      if (dy < -6 || st < 100) this._showHeader();
      else if (dy > 10 && st > 200) this._hideHeader();

      // 距底阈值：自动拼接 / 预取
      const remaining = scroller.scrollHeight - st - scroller.clientHeight;
      if (remaining < APPEND_THRESHOLD_PX) {
        const last = this._lastRendered();
        if (last && last.data.nextUrl && NR.settings.autoAppend && !state.appending && !state.tailError) {
          this._appendByUrl(last.data.nextUrl, false);
        }
      }
      const now = Date.now();
      if (remaining < scroller.clientHeight * 2 && now - state.lastPrefetchAt > 3000) {
        state.lastPrefetchAt = now;
        this._startPrefetch();
      }

      this._saveProgressThrottled();
    },

    _onCurrentChanged() {
      const state = this.state;
      const cur = state.chapters[state.currentIndex];
      if (!cur) return;
      state.headerChapter.textContent = cur.data.title || '';
      if (cur.data.bookTitle) state.headerBook.textContent = cur.data.bookTitle;
      if (cur.data.url && cur.data.url !== location.href) {
        try {
          // 地址栏只做展示跟随：替换当前条目而非压栈，跨章往返不污染浏览器历史
          history.replaceState(null, '', cur.data.url);
        } catch (e) {
          /* 忽略 */
        }
      }
      // 章节切换即时落库：自动拼接/翻章后进度立即跟随屏幕上的章节，不受滚动节流影响
      this._saveProgressNow();
    },

    /** 翻页：一次恰好一个屏幕略小（90%，保留 10% 重叠行便于衔接） */
    _pageScroll(dir) {
      const state = this.state;
      if (!state) return;
      const scroller = state.scroller;
      scroller.scrollTop += dir * Math.round(scroller.clientHeight * 0.9);
    },

    _showHeader() {
      const state = this.state;
      state.header.classList.remove('nr-hidden');
      clearTimeout(state.headerHideTimer);
      state.headerHideTimer = setTimeout(() => {
        if (state.scroller.scrollTop > 200) state.header.classList.add('nr-hidden');
      }, 2200);
    },

    _hideHeader() {
      const state = this.state;
      clearTimeout(state.headerHideTimer);
      state.header.classList.add('nr-hidden');
    },

    _adjustFont(delta) {
      const size = Math.min(28, Math.max(14, NR.settings.fontSize + delta));
      if (size === NR.settings.fontSize) return;
      NR.saveSettings({ fontSize: size });
      if (this.state.panelApi) this.state.panelApi.refresh();
      NR.toast('字号 ' + size + 'px', 900);
    },

    _startPrefetch() {
      if (!NR.settings.preload) return;
      const state = this.state;
      const last = this._lastRendered();
      if (last) NR.loader.prefetchFrom(last.data.url, PREFETCH_DEPTH).catch(() => {});
    },

    onSettingChanged(patch) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'blockAdsOnRead')) {
        this._syncDnr(!!patch.blockAdsOnRead);
      }
    },

    // ---------------- 广告拦截（会话级 DNR，仅本站生效） ----------------

    _syncDnr(enable) {
      if (!NR.extAlive()) return;
      try {
        chrome.runtime
          .sendMessage({ type: 'NR_DNR_SESSION', enable: !!enable, host: location.hostname })
          .catch(() => {});
      } catch (e) {
        /* 扩展上下文失效时忽略 */
      }
    },

    // ---------------- 阅读进度 ----------------

    _bookKey() {
      const state = this.state;
      const first = state.chapters[0] && state.chapters[0].data;
      if (first && first.indexUrl) return first.indexUrl;
      try {
        const u = new URL(state.originalUrl);
        u.hash = '';
        u.search = '';
        u.pathname = u.pathname.replace(/[^/]*$/, '');
        return u.origin + u.pathname;
      } catch (e) {
        return state.originalUrl;
      }
    },

    _saveProgressThrottled() {
      const state = this.state;
      clearTimeout(state.progressTimer);
      state.progressTimer = setTimeout(() => this._saveProgressNow(), PROGRESS_THROTTLE);
    },

    _saveProgressNow() {
      const state = this.state;
      if (!state || !this.isOpen || !state.chapters.length) return;
      const scroller = state.scroller;
      const cur = state.chapters[state.currentIndex];
      if (!cur) return;
      // 扩展上下文已失效（扩展被刷新/更新）：阅读视图本身可继续用，仅暂停进度保存
      if (state.extDead || !NR.extAlive()) {
        this._notifyExtDead();
        return;
      }
      // 章内进度：相对当前章节自身的阅读位置，与已拼接的章节数量无关，
      // 保证自动拼接下一章后比例不失真、在单章页面上恢复依然精确
      let chapterRatio = 0;
      if (cur.el) {
        const top = cur.el.offsetTop;
        const span = Math.max(1, cur.el.offsetHeight - scroller.clientHeight);
        chapterRatio = Math.max(0, Math.min(1, (scroller.scrollTop - top) / span));
      }
      const record = {
        url: cur.data.url || state.originalUrl,
        chapterRatio,
        chapterTitle: cur.data.title || '',
        bookTitle: (cur.data.bookTitle || '').trim(),
        ts: Date.now()
      };
      const key = this._bookKey();
      // 同一内容脚本内的写入串行化：保证本页 ts 单调、get→set 不自交错
      this._progressChain = (this._progressChain || Promise.resolve())
        .then(() => this._writeProgressRecord(key, record))
        .catch(() => {});
    },

    /**
     * 每本书独立 storage key（p:<书键>）。旧版整包 progress 是"读全量—改一条—写全量"，
     * 两个标签页同时保存会互相覆盖对方的新记录；拆 key 后各写各的书，天然无冲突。
     * 首次写入时把旧版整包数据迁移为独立 key（幂等，多标签页并发迁移结果一致）。
     */
    async _writeProgressRecord(bookKey, record) {
      const store = await chrome.storage.local.get(['progress', 'p:' + bookKey]);
      const legacy = store.progress;
      const setOps = {};
      if (legacy && typeof legacy === 'object') {
        for (const k of Object.keys(legacy)) {
          const v = legacy[k];
          if (v && v.url) setOps['p:' + k] = v;
        }
      }
      setOps['p:' + bookKey] = record;
      await chrome.storage.local.set(setOps);
      if (legacy) await chrome.storage.local.remove('progress');
      this._evictProgressBooks();
    },

    /** 超过 200 本时淘汰最久未读（节流执行，避免每次保存全量扫描） */
    async _evictProgressBooks() {
      const now = Date.now();
      if (this._lastEvictAt && now - this._lastEvictAt < 30000) return;
      this._lastEvictAt = now;
      const all = await chrome.storage.local.get(null);
      const entries = [];
      for (const k of Object.keys(all)) {
        if (k.indexOf('p:') === 0 && all[k] && all[k].url) entries.push([k, all[k]]);
      }
      if (entries.length <= 200) return;
      entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      await chrome.storage.local.remove(entries.slice(0, entries.length - 200).map((e) => e[0]));
    },

    /** 扩展上下文失效提示（每次阅读会话只提示一次） */
    _notifyExtDead() {
      const state = this.state;
      if (!state || state.extDead) return;
      state.extDead = true;
      NR.toast('扩展已重新加载，进度保存已暂停；刷新本页后恢复', 3600);
    },

    _restoreProgress() {
      const state = this.state;
      const key = this._bookKey();
      // 扩展上下文已失效（扩展被刷新/更新）：storage 调用会同步抛
      // "Extension context invalidated"（末尾 .catch 拦不住同步 throw），
      // 跳过进度恢复即可，阅读模式照常进入
      if (!NR.extAlive()) return;
      try {
        chrome.storage.local
          .get(['p:' + key, 'progress'])
          .then(async (store) => {
            if (!this._alive(state)) return;
            // 分书籍：先精确命中书键（新格式独立 key / 旧版整包），未命中按章节 URL
            // 目录归并（防目录识别漂移导致同书分裂）
            let record = store['p:' + key];
            if (!record && store.progress) record = NR.findBookRecord(store.progress, key, state.originalUrl);
            if (!record) {
              // 新格式精确未命中：扫描全部 p:*（书键漂移时按章节 URL 归并）
              const all = await chrome.storage.local.get(null).catch(() => null);
              if (!this._alive(state)) return;
              if (all) {
                const map = {};
                for (const k of Object.keys(all)) {
                  if (k.indexOf('p:') === 0 && all[k] && all[k].url) map[k.slice(2)] = all[k];
                }
                record = NR.findBookRecord(map, key, state.originalUrl);
              }
            }
            if (!record) return;
            if (record.url === state.originalUrl) {
              // 打开的就是上次读到的章节：续读落地时按章内比例精确恢复；主动跳转则从头开始
              if (state.landingIntent === 'jump') return;
              const ratio = typeof record.chapterRatio === 'number' ? record.chapterRatio : null;
              if (ratio == null) return;
              state.restoredRatio = ratio;
              requestAnimationFrame(() => {
                if (!this._alive(state)) return;
                const cur = state.chapters[state.currentIndex];
                const scroller = state.scroller;
                if (cur && cur.el) {
                  const span = Math.max(1, cur.el.offsetHeight - scroller.clientHeight);
                  scroller.scrollTop = cur.el.offsetTop + ratio * span;
                }
              });
            } else if (record.url && !state.landingIntent) {
              // 从同书其他章节自然进入（悬浮按钮/快捷键）才提示续读；主动跳转不提示
              this._showResumeChip(record);
            }
          })
          .catch(() => {});
      } catch (e) {
        /* extAlive 检查与实际调用之间上下文失效的竞态：同样跳过恢复 */
      }
    },

    /** 跨章节续读提示条：正文顶部显示上次读到的章节，点击跳回 */
    _showResumeChip(record) {
      const state = this.state;
      if (!record || !record.url || record.url === state.originalUrl) return;
      if (state.pages.querySelector('.nr-resume')) return;
      const chip = document.createElement('div');
      chip.className = 'nr-resume';
      const text = document.createElement('span');
      text.textContent = '📖 上次读到《' + (record.chapterTitle || '更早的章节') + '》';
      const go = document.createElement('button');
      go.className = 'nr-resume-go';
      go.textContent = '继续阅读 ›';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'nr-resume-x';
      closeBtn.title = '关闭提示';
      closeBtn.textContent = '✕';
      go.addEventListener('click', () => this._jumpTo(record.url));
      closeBtn.addEventListener('click', () => chip.remove());
      chip.appendChild(text);
      chip.appendChild(go);
      chip.appendChild(closeBtn);
      state.pages.insertBefore(chip, state.pages.firstChild);
    },
  };
})();
