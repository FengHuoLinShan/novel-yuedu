/**
 * translator.js — 端侧翻译封装（Chrome 内置 Translator API，Chrome 138+）
 *
 * - 翻译在本机模型上完成：无需 API Key、正文不出设备、离线可用
 * - Translator 实例按 源语言>目标语言 键缓存复用；模型未下载时经 monitor 回调报进度
 * - 源语言 "auto"：优先端侧 LanguageDetector，退化 Unicode 区间启发式
 *   （假名→ja / 谚文→ko / 西里尔→ru / 拉丁为主→en / 汉字→按特征字分简繁）
 * - 不支持的环境（Firefox / 旧版 Chrome）：NR.translateSupported() === false，
 *   调用方负责隐藏入口，本模块方法不会被触达
 */
(function () {
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {});

  const CONCURRENCY = 3; // 段落翻译并发上限：端侧推理吃本地算力，串行偏慢、并发过高风扇起飞

  // 目标/源语言选项（值即 BCP-47 码，直接喂给 Translator API）
  NR.LANG_OPTIONS = [
    { value: 'zh-Hans', label: '中文（简体）' },
    { value: 'zh-Hant', label: '中文（繁體）' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'es', label: 'Español' },
    { value: 'ru', label: 'Русский' }
  ];
  NR.SOURCE_OPTIONS = [{ value: 'auto', label: '自动检测' }].concat(NR.LANG_OPTIONS);

  const translators = new Map(); // 'src>tgt' -> Promise<Translator>

  NR.translateSupported = function () {
    return typeof Translator !== 'undefined' && typeof Translator.availability === 'function';
  };

  /** 启发式源语言判断（LanguageDetector 不可用时的兜底） */
  function guessSource(sample) {
    let kana = 0, hangul = 0, cyrillic = 0, latin = 0, cjk = 0, trad = 0, simp = 0;
    for (const ch of sample) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x3040 && cp <= 0x30ff) kana++;
      else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) hangul++;
      else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++;
      else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
      else if (cp >= 0x4e00 && cp <= 0x9fff) {
        cjk++;
        // 高频特征字粗分简繁（仅供翻译选模型，不影响正文；只选简繁写法不同的字）
        if ('体发这说见国关们为没时有学问过'.includes(ch)) simp++;
        else if ('體發這說見國關們為沒時有學問過'.includes(ch)) trad++;
      }
    }
    if (kana > 0) return 'ja'; // 含假名必是日文（中文文本不会混假名）
    if (hangul > 2) return 'ko';
    if (cyrillic > 10) return 'ru';
    if (latin > cjk * 2) return 'en';
    if (cjk > 0) return trad > simp * 2 ? 'zh-Hant' : 'zh-Hans';
    return 'en';
  }

  /** 端侧 LanguageDetector（Chrome 138+ 同源模型族）；不可用或低置信时回退启发式 */
  async function detectSource(texts) {
    const sample = texts.filter(Boolean).join('\n').slice(0, 2000);
    if (typeof LanguageDetector !== 'undefined' && typeof LanguageDetector.availability === 'function') {
      try {
        const avail = await LanguageDetector.availability();
        if (avail !== 'unavailable' && avail !== 'no') {
          const det = await LanguageDetector.create();
          const hits = await det.detect(sample);
          const top = hits && hits[0];
          if (top && top.detectedLanguage && top.confidence > 0.5) {
            const lang = top.detectedLanguage;
            // 检测器可能返回粗粒度 zh：按启发式细分简繁（Translator 要求区分）
            if (lang === 'zh' || lang === 'zh-Hans' || lang === 'zh-Hant') {
              return lang === 'zh' ? guessSource(sample) : lang;
            }
            return lang;
          }
        }
      } catch (e) {
        /* 检测失败走启发式 */
      }
    }
    return guessSource(sample);
  }

  /** 规范化 availability 返回值（新旧版枚举并存：readily/after-download/no 与 available/downloadable/unavailable） */
  function normAvail(a) {
    if (a === 'readily' || a === 'available') return 'available';
    if (a === 'after-download' || a === 'downloadable' || a === 'downloading') return 'downloadable';
    return 'unavailable';
  }

  /** 检查语种对可用性：'available' | 'downloadable' | 'unavailable' */
  NR.checkPair = async function (src, tgt) {
    if (!NR.translateSupported()) return 'unavailable';
    try {
      return normAvail(await Translator.availability({ sourceLanguage: src, targetLanguage: tgt }));
    } catch (e) {
      return 'unavailable'; // 非法语种码等
    }
  };

  function getTranslator(src, tgt, onDownload) {
    const key = src + '>' + tgt;
    if (!translators.has(key)) {
      translators.set(
        key,
        Translator.create({
          sourceLanguage: src,
          targetLanguage: tgt,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              if (onDownload) onDownload(e.loaded, e.total || 1);
            });
          }
        }).catch((err) => {
          translators.delete(key); // 创建失败不留毒缓存，允许重试
          throw err;
        })
      );
    }
    return translators.get(key);
  }

  /** 并发受限的保序 map */
  async function mapPool(items, n, fn, shouldStop) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
          if (shouldStop && shouldStop()) throw new Error('aborted');
          const cur = i++;
          out[cur] = await fn(items[cur], cur);
        }
      })
    );
    return out;
  }

  /**
   * 批量翻译段落数组，返回等长译文数组。
   * @param {string[]} texts 原文段落（应先过简繁转换）
   * @param {string} srcSetting 设置里的源语言（'auto' 时自动检测）
   * @param {string} tgt 目标语言（BCP-47）
   * @param {object} [opts] { onProgress(done,total), onDownload(loaded,total), shouldStop() }
   * @returns {Promise<{texts: string[], src: string}>}
   * @throws {Error} err.code === 'unsupported' 表示语种对不可用
   */
  NR.translateTexts = async function (texts, srcSetting, tgt, opts) {
    opts = opts || {};
    const src = srcSetting && srcSetting !== 'auto' ? srcSetting : await detectSource(texts);
    if (src === tgt) return { texts: texts.slice(), src }; // 同语种无需翻译
    const avail = await NR.checkPair(src, tgt);
    if (avail === 'unavailable') {
      const err = new Error('该语种对暂不支持端侧翻译');
      err.code = 'unsupported';
      throw err;
    }
    const tr = await getTranslator(src, tgt, opts.onDownload);
    const total = texts.length;
    let done = 0;
    const out = await mapPool(
      texts,
      CONCURRENCY,
      async (t) => {
        // 空段/纯符号段不送模型，原样保留（标题分隔符、空白行等）
        const r = !t || !t.trim() ? t : await tr.translate(t);
        done++;
        if (opts.onProgress) opts.onProgress(done, total);
        return r;
      },
      opts.shouldStop
    );
    return { texts: out, src };
  };

  /** 供 UI 展示：'auto' 或非法值时返回 null（先检测再翻译，不预检） */
  NR.langLabel = function (value) {
    const hit = NR.LANG_OPTIONS.find((o) => o.value === value);
    return hit ? hit.label : value;
  };
})();
