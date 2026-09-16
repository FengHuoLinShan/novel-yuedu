# 构建说明（AMO 源码审查用）

本扩展内含**机器生成代码**，按 Mozilla 要求（[Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)）随附本源码包与构建说明，使 reviewer 能在**本地、离线**重建出与提交的 `.xpi` **完全一致**的产物。

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Python | 3.8+ | 全部生成与打包脚本（仅用标准库：`hashlib` / `json` / `struct` / `urllib` / `zipfile` / `pathlib`） |
| `openssl` | 任意近期版本 | **仅** CRX3 签名用；AMO 审查不需要（见下） |

**无 Node.js / npm / 打包器依赖**，扩展本身是原生 JavaScript、零构建。

## 从源码重建（复现提交的 `.xpi`）

以下命令全部在源码包根目录执行，**无需联网**（OpenCC 词典已随源码包分发，见 `tools/data/opencc/`）。

```bash
# 1) 重建离线简繁转换字表 → src/lib/chinese-convert.js
python3 tools/gen_cc.py

# 2) 重建图标 → icons/icon16.png、icon48.png、icon128.png
python3 tools/gen_icons.py

# 3) 打包 → dist/novel-reader-v<版本>.zip、-firefox.zip、novel-yuedu-v<版本>.xpi、-source.zip
#    --no-crx：跳过 CRX3 签名（签名需本项目发布私钥，reviewer 没有；AMO 审查不需要 CRX）
python3 tools/package.py --no-crx
```

**提交给 AMO 的文件是 `dist/novel-yuedu-v<版本>.xpi`**，第 3 步即可产出。

## 零差异核对（重建后应完全一致）

第 1、2 步是**确定性**的：同一份输入必得同一份输出。重建后请核对下列校验值。

`src/lib/chinese-convert.js`（当前版本，223478 字节）

```
sha256 539533a5a1265677c4b6f34b2c1f10f90b8218fd8c656fac90c314f929b61f80
```

`tools/data/opencc/` 下的词典输入（由 `gen_cc.py` 在读取时逐个校验，不符即报错退出）

| 文件 | sha256 |
|---|---|
| `STCharacters.txt` | `a0ca1601c70648cf48b33c3c6210ccbecc5c7eead4b4c3daf76587ba2c03582b` |
| `TSCharacters.txt` | `737c21c66f55a419dd6956cb3089476cdefc5a36877452631617696df1e5d925` |
| `STPhrases.txt` | `f6eab5e5c6dd7640597878d3dfc6599ee1279d2bc91561eadd8e114194e2925a` |
| `TSPhrases.txt` | `35c1eb677b02b0e846b4004199e26c433e969c264e765952c410d1f73b837ef6` |

图标（`gen_icons.py` 生成）

| 文件 | sha256 |
|---|---|
| `icons/icon16.png` | `4f1211ead368d0c68301c86515bc03f8bd0d64bbb85733e67705b72e19bcdbfe` |
| `icons/icon48.png` | `fbd51bd966913e09eb7b0fed877f16ba6e8b41a8ca904bb244890b88341708eb` |
| `icons/icon128.png` | `b96acd6d08bbe0d2d9b1e938b18fedddc802a14ccc8f605861af2b6410660a1c` |

**最终产物 `dist/novel-yuedu-v0.2.16.xpi`（提交给 AMO 的文件）**

```
sha256 9dec114a624f1cd5e07e2b134e6929d042b87b74108741a6e6a545a86e872092
     224383 字节
```

打包本身也是**逐字节可复现**的：zip 条目时间戳被固定为 `1980-01-01`，因此即使重跑生成器改动了源文件 mtime（内容不变），重建产物字节仍完全一致。完整重建（第 1→3 步）重复执行任意次，上述 sha256 恒定不变。Chrome 主包 `novel-reader-v0.2.16.zip` 仅 `manifest.json` 的 `background` 字段不同（`service_worker`），其余 28 个成员与之逐字节相同。

## 本扩展中被生成/改写的文件

| 产物 | 生成者 | 说明 |
|---|---|---|
| `src/lib/chinese-convert.js` | `tools/gen_cc.py` | 单行 17 万字符的紧凑字表。由 OpenCC 词典派生：单字取第一候选；词组仅保留「逐字转换会出错」的消歧条目（如 头发→頭髮） |
| `icons/icon{16,48,128}.png` | `tools/gen_icons.py` | 纯 Python 手写 PNG 编码，无第三方库 |
| 包内 `manifest.json`（Firefox 变体） | `tools/package.py` | 把 `background.service_worker` 改写为 `background.scripts`（Firefox MV3 事件页写法），Chrome 主包保持 `service_worker` |

其余源码均为可直接阅读的未压缩 JavaScript，随附完整 `src/` 目录。

## 第三方库

均为官方发布版原文件、**未做修改**（详见 `THIRD-PARTY-NOTICES`，链接与 sha256 亦见提交时的 "Notes for Reviewers"）：

- **Mozilla Readability 0.6.0** —— `src/lib/Readability.js`、`src/lib/Readability-readerable.js`
- **DOMPurify 3.2.6** —— `src/lib/purify.min.js`（第三方官方压缩发行版，非本项目压缩）
- **OpenCC 词典** —— 只作为 `tools/gen_cc.py` 的**数据输入**，锁定到 commit `c363a7ba51d487950982bd8a589211ffbfd95ba1`（2026-09-09），随本源码包分发于 `tools/data/opencc/`。**不使用 `master`**：master 会漂移，无法保证零差异重建

## 测试（可选，非重建所需）

完整测试套件（单元 + headless Chrome 端到端）需要 Node.js 与 Chrome for Testing，**不影响扩展重建**，故未包含在本源码包内。仓库地址见 AMO 页面。
