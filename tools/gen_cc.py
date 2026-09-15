#!/usr/bin/env python3
"""生成 src/lib/chinese-convert.js —— 简繁转换字表 + 词组消歧表。

数据源：OpenCC 词典（Apache-2.0，https://github.com/BYVoid/OpenCC）：
  STCharacters.txt / TSCharacters.txt  —— 单字映射（每行多候选取第一个）
  STPhrases.txt / TSPhrases.txt        —— 词组映射

词典**锁定到 OpenCC 的固定 commit**，不用 master：
  - master 会漂移，同一份源码不同时间重建会得到不同字表；
  - AMO 明确不接受第三方库的非发布版本（"non-release versions are not accepted"），
    且要求 reviewer 能在本地离线零差异重建。
锁定 commit c363a7ba51d487950982bd8a589211ffbfd95ba1（2026-09-09）。

词典随仓库分发在 tools/data/opencc/（约 1.1 MB），构建时**离线读取**；仅在缺失时才按
上述 commit 下载，并对每个文件校验 SHA256 —— 校验不过即报错退出，绝不静默产出别的字表。

词组表只保留"逐字转换结果 ≠ OpenCC 词组转换结果"的条目（字表能转对的词不冗余存储），
典型如 头发→頭髮（逐字会得 頭發）、后面→後面（逐字会得 后面不变/後取错）。

用法：python3 tools/gen_cc.py [词典目录]（默认 tools/data/opencc）
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'lib' / 'chinese-convert.js'
DEFAULT_DATA_DIR = ROOT / 'tools' / 'data' / 'opencc'

# 锁定的 OpenCC commit 与其词典文件校验值（换 commit 必须同步更新）
OPENCC_COMMIT = 'c363a7ba51d487950982bd8a589211ffbfd95ba1'
BASE = f'https://raw.githubusercontent.com/BYVoid/OpenCC/{OPENCC_COMMIT}/data/dictionary/'
FILES = ['STCharacters.txt', 'TSCharacters.txt', 'STPhrases.txt', 'TSPhrases.txt']
EXPECTED_SHA256 = {
    'STCharacters.txt': 'a0ca1601c70648cf48b33c3c6210ccbecc5c7eead4b4c3daf76587ba2c03582b',
    'TSCharacters.txt': '737c21c66f55a419dd6956cb3089476cdefc5a36877452631617696df1e5d925',
    'STPhrases.txt': 'f6eab5e5c6dd7640597878d3dfc6599ee1279d2bc91561eadd8e114194e2925a',
    'TSPhrases.txt': '35c1eb677b02b0e846b4004199e26c433e969c264e765952c410d1f73b837ef6',
}

MAX_PHRASE_LEN = 8  # 超过 8 字的词组多为书名/专名，消歧收益低，舍去控体积

# OpenCC 部分字/词的首选是异体写法（溼、麪、牀…），大陆读者观感差，
# 转换输出统一替换为通行正体（只作用于输出侧，不影响匹配键）
VARIANT_FIX = {
    '溼': '濕', '麪': '麵', '牀': '床', '羣': '群', '峯': '峰', '鷄': '雞',
}


def fix_variant(s):
    return ''.join(VARIANT_FIX.get(c, c) for c in s)


def load(data_dir: Path):
    """读取锁定版本的四份 OpenCC 词典；缺失则按锁定 commit 下载，然后逐个校验 SHA256。"""
    data_dir.mkdir(parents=True, exist_ok=True)
    texts = {}
    for f in FILES:
        p = data_dir / f
        if not p.exists():
            print(f'词典缺失，按锁定 commit {OPENCC_COMMIT[:10]} 下载 {f} …')
            urllib.request.urlretrieve(BASE + f, p)
        raw = p.read_bytes()
        got = hashlib.sha256(raw).hexdigest()
        want = EXPECTED_SHA256[f]
        if got != want:
            raise SystemExit(
                f'错误：{p} 校验不符，拒绝生成。\n'
                f'  期望 sha256 {want}\n  实际 sha256 {got}\n'
                f'  该文件应取自 OpenCC commit {OPENCC_COMMIT}；'
                f'内容不符会导致字表与已发布版本不一致。'
            )
        texts[f] = raw.decode('utf-8')
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
    data_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DATA_DIR
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
