#!/usr/bin/env python3
"""生成 src/lib/chinese-convert.js —— 简繁转换字表 + 词组消歧表。

数据源：OpenCC 词典（Apache-2.0，https://github.com/BYVoid/OpenCC）：
  STCharacters.txt / TSCharacters.txt  —— 单字映射（每行多候选取第一个）
  STPhrases.txt / TSPhrases.txt        —— 词组映射

词组表只保留"逐字转换结果 ≠ OpenCC 词组转换结果"的条目（字表能转对的词不冗余存储），
典型如 头发→頭髮（逐字会得 頭發）、后面→後面（逐字会得 后面不变/後取错）。
用法：python3 tools/gen_cc.py [OpenCC data/dictionary 目录]（默认 /tmp/opencc，缺文件时自动下载）
"""
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'lib' / 'chinese-convert.js'
BASE = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/'
FILES = ['STCharacters.txt', 'TSCharacters.txt', 'STPhrases.txt', 'TSPhrases.txt']

MAX_PHRASE_LEN = 8  # 超过 8 字的词组多为书名/专名，消歧收益低，舍去控体积

# OpenCC 部分字/词的首选是异体写法（溼、麪、牀…），大陆读者观感差，
# 转换输出统一替换为通行正体（只作用于输出侧，不影响匹配键）
VARIANT_FIX = {
    '溼': '濕', '麪': '麵', '牀': '床', '羣': '群', '峯': '峰', '鷄': '雞',
}


def fix_variant(s):
    return ''.join(VARIANT_FIX.get(c, c) for c in s)


def load(data_dir: Path):
    data_dir.mkdir(parents=True, exist_ok=True)
    texts = {}
    for f in FILES:
        p = data_dir / f
        if not p.exists():
            print(f'下载 {f} …')
            urllib.request.urlretrieve(BASE + f, p)
        texts[f] = p.read_text(encoding='utf-8')
    return texts


def parse_char_table(text):
    """每行：源字<TAB>候选1 候选2 …；取第一候选做 1:1 映射。"""
    m = {}
    for line in text.splitlines():
        line = line.strip('\n')
        if not line or '\t' not in line:
            continue
        src, dsts = line.split('\t', 1)
        dst = dsts.split(' ')[0]
        if len(src) == 1 and dst and dst[0] != src:
            m[src] = dst[0]
    return m


def parse_phrase_table(text):
    m = {}
    for line in text.splitlines():
        line = line.strip('\n')
        if not line or '\t' not in line:
            continue
        src, dsts = line.split('\t', 1)
        dst = dsts.split(' ')[0]
        if src and dst and src != dst:
            m[src] = dst
    return m


def naive_convert(s, char_map):
    return ''.join(char_map.get(c, c) for c in s)


def diff_phrases(phrases, char_map):
    """只保留逐字转换会转错的词组（这些才需要词组级消歧）。"""
    out = {}
    for src, dst in phrases.items():
        if not (2 <= len(src) <= MAX_PHRASE_LEN):
            continue
        if naive_convert(src, char_map) != dst:
            out[src] = dst
    return out


def pack_chars(m):
    # 交错打包：偶位源字、奇位目标字
    return ''.join(k + v for k, v in sorted(m.items()))


def pack_phrases(m):
    # 每行 key=value；生成端保证 key 不含 '=' / 换行（CJK 词组天然满足）
    return '\n'.join(f'{k}={v}' for k, v in sorted(m.items()))


def main():
    data_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/opencc')
    texts = load(data_dir)

    s2t_chars = parse_char_table(texts['STCharacters.txt'])
    t2s_chars = parse_char_table(texts['TSCharacters.txt'])
    s2t_ph = diff_phrases(parse_phrase_table(texts['STPhrases.txt']), s2t_chars)
    t2s_ph = diff_phrases(parse_phrase_table(texts['TSPhrases.txt']), t2s_chars)
    # 异体输出校正（仅简→繁输出侧）
    s2t_chars = {k: fix_variant(v) for k, v in s2t_chars.items()}
    s2t_ph = {k: fix_variant(v) for k, v in s2t_ph.items()}

    print(f'S2T 字 {len(s2t_chars)}，消歧词组 {len(s2t_ph)}')
    print(f'T2S 字 {len(t2s_chars)}，消歧词组 {len(t2s_ph)}')

    js = f'''/**
 * chinese-convert.js —— 离线简繁转换（字表 + 词组消歧）
 *
 * 数据来自 OpenCC 词典（Apache-2.0，https://github.com/BYVoid/OpenCC），
 * 由 tools/gen_cc.py 生成 —— 字表/词组部分请勿手改，改生成脚本后重新生成。
 *
 * 策略：单正则一次扫描，词组最长匹配优先于单字映射，避免二次转换
 * （如"头发"先命中词组得"頭髮"，其中的"髮"不会再被字表触碰）。
 *
 *   NR.ccConvert('汉字', 's2t') → '漢字'
 *   NR.ccConvert('漢字', 't2s') → '汉字'
 *   其余 mode（含 'none'）原样返回。
 */
(function () {{
  'use strict';
  const NR = (globalThis.NR = globalThis.NR || {{}});

  // 交错打包字表：偶位源字 → 奇位目标字
  const S2T_CHARS = {pack_chars(s2t_chars)!r};
  const T2S_CHARS = {pack_chars(t2s_chars)!r};
  // 消歧词组：每行 原词=目标词（仅收录逐字转换会出错的词）
  const S2T_PHRASES = {pack_phrases(s2t_ph)!r};
  const T2S_PHRASES = {pack_phrases(t2s_ph)!r};

  function escRe(s) {{
    return s.replace(/[.*+?^${{}}()|[\\]\\\\-]/g, '\\\\$&');
  }}

  /** 懒构建：首次转换时才编译正则与映射表（不拖慢页面加载） */
  function buildTable(charsPacked, phrasesPacked) {{
    const cMap = new Map();
    // 必须按码点迭代：字表含扩展 B 区汉字（UTF-16 代理对占两码元），
    // 直接索引配对会错位；正则同理必须带 u 标志，否则代理对在字符类里被拆散
    const chars = [...charsPacked];
    for (let i = 0; i + 1 < chars.length; i += 2) {{
      cMap.set(chars[i], chars[i + 1]);
    }}
    const pMap = new Map();
    if (phrasesPacked) {{
      for (const line of phrasesPacked.split('\\n')) {{
        const eq = line.indexOf('=');
        if (eq > 0) pMap.set(line.slice(0, eq), line.slice(eq + 1));
      }}
    }}
    // 长词在前保证最长匹配；字表收成单个字符类放最后兜底
    const parts = [...pMap.keys()].sort((a, b) => b.length - a.length).map(escRe);
    parts.push('[' + escRe([...cMap.keys()].join('')) + ']');
    const re = new RegExp(parts.join('|'), 'gu');
    return {{
      re,
      lookup(m) {{ return pMap.get(m) || cMap.get(m) || m; }}
    }};
  }}

  let s2t = null;
  let t2s = null;

  NR.ccConvert = function (text, mode) {{
    if (!text) return text;
    if (mode === 's2t') {{
      if (!s2t) s2t = buildTable(S2T_CHARS, S2T_PHRASES);
      return text.replace(s2t.re, (m) => s2t.lookup(m));
    }}
    if (mode === 't2s') {{
      if (!t2s) t2s = buildTable(T2S_CHARS, T2S_PHRASES);
      return text.replace(t2s.re, (m) => t2s.lookup(m));
    }}
    return text;
  }};
}})();
'''
    # Python repr 输出单引号字符串，JS 同样合法（表内无单引号/反斜杠）
    OUT.write_text(js, encoding='utf-8')
    print(f'已写出 {OUT}（{OUT.stat().st_size} 字节）')


if __name__ == '__main__':
    main()
