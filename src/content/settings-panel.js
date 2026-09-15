/**
 * settings-panel.js — 排版设置面板 UI
 * 设置模型与持久化在 settings.js（NR.settings / NR.saveSettings / NR.subscribeSettings）；
 * 本模块只负责构建面板控件并把改动交给模型，不触碰阅读视图。
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

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
    const select = function (key, options, getVal, onChange) {
      const sel = document.createElementNS(ns, 'select');
      sel.dataset.key = key;
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
    const check = function (key, labelText, getVal, onChange) {
      const wrap = document.createElementNS(ns, 'label');
      wrap.className = 'nr-check';
      const input = document.createElementNS(ns, 'input');
      input.type = 'checkbox';
      input.dataset.key = key;
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
          'fontFamily',
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
          'theme',
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
    // 简繁转换（离线字表，切换即时生效）
    frag.appendChild(
      row(
        '简繁',
        select(
          'textConvert',
          [
            { value: 'none', label: '原文' },
            { value: 't2s', label: '转为简体' },
            { value: 's2t', label: '转为繁體' }
          ],
          () => s.textConvert,
          (v) => setAndSave({ textConvert: v })
        )
      )
    );

    // 端侧翻译（仅 Chrome 138+ 等支持 Translator API 的环境显示，其余浏览器隐藏）
    if (NR.translateSupported && NR.translateSupported()) {
      frag.appendChild(
        row(
          '翻译',
          select(
            'translateMode',
            [
              { value: 'off', label: '关闭' },
              { value: 'replace', label: '替换原文' },
              { value: 'bilingual', label: '双语对照' }
            ],
            () => s.translateMode,
            (v) => setAndSave({ translateMode: v })
          )
        )
      );
      frag.appendChild(
        row('源语言', select('translateSource', NR.SOURCE_OPTIONS, () => s.translateSource, (v) => setAndSave({ translateSource: v })))
      );
      frag.appendChild(
        row('目标语言', select('translateTarget', NR.LANG_OPTIONS, () => s.translateTarget, (v) => setAndSave({ translateTarget: v })))
      );
    }

    const divider = document.createElementNS(ns, 'div');
    divider.className = 'nr-divider';
    frag.appendChild(divider);

    frag.appendChild(check('fullWidth', '全屏宽度', () => s.fullWidth, (v) => setAndSave({ fullWidth: v })));
    frag.appendChild(check('indent', '首行缩进', () => s.indent, (v) => setAndSave({ indent: v })));
    frag.appendChild(check('noImages', '屏蔽图片', () => s.noImages, (v) => setAndSave({ noImages: v })));
    frag.appendChild(check('preload', '预加载下一章', () => s.preload, (v) => setAndSave({ preload: v })));
    frag.appendChild(check('autoAppend', '滚动到底自动拼接', () => s.autoAppend, (v) => setAndSave({ autoAppend: v })));
    frag.appendChild(check('clickPaging', '点击上下区域翻页', () => s.clickPaging, (v) => setAndSave({ clickPaging: v })));
    frag.appendChild(check('blockAdsOnRead', '阅读时只放行本站请求', () => s.blockAdsOnRead, (v) => setAndSave({ blockAdsOnRead: v })));
    frag.appendChild(check('navLock', '阅读时锁定页面（禁止跳转/弹窗）', () => s.navLock, (v) => setAndSave({ navLock: v })));

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
      for (const c of el.querySelectorAll('input[type="checkbox"]')) {
        // 按构建时写入的 data-key 同步（新增开关不必维护顺序表）
        if (c.dataset.key) c.checked = !!cur[c.dataset.key];
      }
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
    // select 的 data-key 均在构建时写入，refresh 直接按 key 同步；
    // 设置也可能被其他上下文改变（storage.sync 热更新、快捷键改字号）→ 订阅刷新
    const unsubscribe = NR.subscribeSettings(refresh);

    return { el, refresh, dispose: unsubscribe };
  };
})();