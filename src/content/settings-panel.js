/**
 * settings-panel.js — 排版设置模型与面板 UI
 * 设置存 chrome.storage.sync（跨设备同步），改动即时生效；持久化做尾缘
 * debounce（滑杆拖动的高频 input 只落一次最终值，避开 sync 写限额）。
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
    clickPaging: true,   // 点击屏幕上/下三分之一区域翻页
    floatingButton: true, // 显示悬浮按钮
    blockAdsOnRead: true  // 阅读时启用白名单式拦截：仅放行本站域名的请求（会话级 DNR 规则）
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

  NR.getSettings = async function () {
    try {
      const store = await chrome.storage.sync.get('settings');
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

  let persistTimer = 0;
  let syncFailNotified = false;

  /**
   * 更新设置：页面立即生效，持久化走尾缘 debounce。
   * 滑杆每个 input 事件都会调用本函数（连续拖动高频），直接写 storage.sync 会撞
   * 每分钟 120 次 / 每小时 1800 次的写限额，被拒的值就丢了；收敛为停手后写一次。
   */
  NR.saveSettings = function (patch) {
    Object.assign(NR.settings, patch);
    NR.applySettings();
    NR.persistSettingsSoon();
  };

  NR.persistSettingsSoon = function () {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => NR.persistSettingsNow(), 400);
  };

  NR.persistSettingsNow = function () {
    clearTimeout(persistTimer);
    try {
      if (!NR.extAlive()) return;
      chrome.storage.sync.set({ settings: NR.settings }).catch((e) => {
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
  window.addEventListener('pagehide', () => NR.persistSettingsNow());

  /** 将当前设置应用到打开中的阅读视图（未打开则跳过） */
  NR.applySettings = function () {
    const reader = NR.reader;
    if (!reader || !reader.isOpen || !reader.rootEl) return;
    const s = NR.settings;
    const theme = NR.THEMES[s.theme] || NR.THEMES.light;
    const root = reader.rootEl;
    root.dataset.theme = s.theme;
    root.style.setProperty('--nr-fs', s.fontSize + 'px');
    root.style.setProperty('--nr-lh', String(s.lineHeight));
    root.style.setProperty('--nr-ff', NR.FONT_STACKS[s.fontFamily] || NR.FONT_STACKS.system);
    root.style.setProperty('--nr-width', s.fullWidth ? 'calc(100% - 48px)' : 'min(' + s.widthPercent + '%, calc(100% - 48px))');
    root.style.setProperty('--nr-bg', theme.bg);
    root.style.setProperty('--nr-fg', theme.fg);
    root.style.setProperty('--nr-muted', theme.muted);
    root.style.setProperty('--nr-line', theme.line);
    root.style.setProperty('--nr-accent', theme.accent);
    root.style.setProperty('--nr-panel', theme.panel);
    root.classList.toggle('nr-indent', !!s.indent);
    root.classList.toggle('nr-img-hidden', !!s.noImages);
  };

  /**
   * 构建设置面板（阅读视图 Shadow DOM 内挂载）。
   * @returns {{el: Element, refresh: Function}}
   */
  NR.buildSettingsPanel = function () {
    const ns = 'http://www.w3.org/1999/xhtml';
    const el = document.createElementNS(ns, 'div');
    el.className = 'nr-panel-inner';
    const s = NR.settings;

    const row = function (labelText, control) {
      const rowEl = document.createElementNS(ns, 'div');
      rowEl.className = 'nr-row';
      const lab = document.createElementNS(ns, 'label');
      lab.textContent = labelText;
      const val = document.createElementNS(ns, 'span');
      val.className = 'nr-val';
      rowEl.appendChild(lab);
      rowEl.appendChild(control);
      rowEl.appendChild(val);
      return rowEl;
    };
    const range = function (min, max, step, getVal, onInput) {
      const input = document.createElementNS(ns, 'input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(getVal());
      input.addEventListener('input', () => onInput(parseFloat(input.value)));
      return input;
    };
    const select = function (options, getVal, onChange) {
      const sel = document.createElementNS(ns, 'select');
      for (const opt of options) {
        const o = document.createElementNS(ns, 'option');
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      sel.value = getVal();
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };
    const check = function (labelText, getVal, onChange) {
      const wrap = document.createElementNS(ns, 'label');
      wrap.className = 'nr-check';
      const input = document.createElementNS(ns, 'input');
      input.type = 'checkbox';
      input.checked = !!getVal();
      const span = document.createElementNS(ns, 'span');
      span.textContent = labelText;
      wrap.appendChild(input);
      wrap.appendChild(span);
      input.addEventListener('change', () => onChange(input.checked));
      return wrap;
    };

    const title = document.createElementNS(ns, 'div');
    title.className = 'nr-panel-title';
    title.textContent = '排版设置';

    const frag = document.createDocumentFragment();
    frag.appendChild(title);

    // 字号
    {
      const input = range(14, 28, 1, () => s.fontSize, (v) => setAndSave({ fontSize: v }));
      input.dataset.key = 'fontSize';
      frag.appendChild(row('字号', input));
    }
    // 行距
    {
      const input = range(1.5, 2.6, 0.05, () => s.lineHeight, (v) => setAndSave({ lineHeight: v }));
      input.dataset.key = 'lineHeight';
      frag.appendChild(row('行距', input));
    }
    // 页面宽度（占视口百分比；上限 100% 即当前设备全屏，换设备/横竖屏由 CSS 自动适配）
    {
      const input = range(30, 100, 1, () => s.widthPercent, (v) => setAndSave({ widthPercent: v }));
      input.dataset.key = 'widthPercent';
      frag.appendChild(row('宽度', input));
    }
    // 字体
    frag.appendChild(
      row(
        '字体',
        select(
          [
            { value: 'system', label: '默认' },
            { value: 'song', label: '宋体' },
            { value: 'hei', label: '黑体' },
            { value: 'kai', label: '楷体' }
          ],
          () => s.fontFamily,
          (v) => setAndSave({ fontFamily: v })
        )
      )
    );
    // 主题
    frag.appendChild(
      row(
        '主题',
        select(
          [
            { value: 'light', label: '明亮' },
            { value: 'sepia', label: '羊皮纸' },
            { value: 'dark', label: '暗夜' }
          ],
          () => s.theme,
          (v) => setAndSave({ theme: v })
        )
      )
    );

    const divider = document.createElementNS(ns, 'div');
    divider.className = 'nr-divider';
    frag.appendChild(divider);

    frag.appendChild(check('全屏宽度', () => s.fullWidth, (v) => setAndSave({ fullWidth: v })));
    frag.appendChild(check('首行缩进', () => s.indent, (v) => setAndSave({ indent: v })));
    frag.appendChild(check('屏蔽图片', () => s.noImages, (v) => setAndSave({ noImages: v })));
    frag.appendChild(check('预加载下一章', () => s.preload, (v) => setAndSave({ preload: v })));
    frag.appendChild(check('滚动到底自动拼接', () => s.autoAppend, (v) => setAndSave({ autoAppend: v })));
    frag.appendChild(check('点击上下区域翻页', () => s.clickPaging, (v) => setAndSave({ clickPaging: v })));
    frag.appendChild(check('阅读时只放行本站请求', () => s.blockAdsOnRead, (v) => setAndSave({ blockAdsOnRead: v })));

    const reset = document.createElementNS(ns, 'button');
    reset.className = 'nr-reset';
    reset.textContent = '恢复默认设置';
    reset.addEventListener('click', () => {
      NR.saveSettings(Object.assign({}, NR.DEFAULT_SETTINGS));
      refresh();
      NR.toast('已恢复默认设置');
    });
    frag.appendChild(reset);

    el.appendChild(frag);

    function setAndSave(patch) {
      NR.saveSettings(patch);
      refresh();
      if (NR.reader && NR.reader.onSettingChanged) NR.reader.onSettingChanged(patch);
    }
    function refresh() {
      const cur = NR.settings;
      for (const input of el.querySelectorAll('input[type="range"]')) {
        input.value = String(cur[input.dataset.key]);
      }
      for (const sel of el.querySelectorAll('select')) {
        sel.value = cur[sel.dataset.key || ''];
      }
      const checks = el.querySelectorAll('input[type="checkbox"]');
      // 顺序与构建时一致：fullWidth / indent / noImages / preload / autoAppend / clickPaging / blockAdsOnRead
      const keys = ['fullWidth', 'indent', 'noImages', 'preload', 'autoAppend', 'clickPaging', 'blockAdsOnRead'];
      checks.forEach((c, i) => {
        if (keys[i]) c.checked = !!cur[keys[i]];
      });
      // 全屏宽度开启时，宽度百分比滑杆失效并置灰
      const widthRange = el.querySelector('input[type="range"][data-key="widthPercent"]');
      if (widthRange) widthRange.disabled = !!cur.fullWidth;
      syncVals();
    }
    function syncVals() {
      const cur = NR.settings;
      const map = { fontSize: cur.fontSize + 'px', lineHeight: '×' + cur.lineHeight.toFixed(2), widthPercent: cur.widthPercent + '%' };
      for (const r of el.querySelectorAll('.nr-row')) {
        const input = r.querySelector('input[type="range"]');
        if (input && map[input.dataset.key]) {
          r.querySelector('.nr-val').textContent = map[input.dataset.key];
        } else {
          const v = r.querySelector('.nr-val');
          if (v) v.textContent = '';
        }
      }
    }
    syncVals();

    // select 的 data-key 同步
    el.querySelectorAll('select').forEach((sel, i) => {
      sel.dataset.key = i === 0 ? 'fontFamily' : 'theme';
    });

    return { el, refresh };
  };
})();
