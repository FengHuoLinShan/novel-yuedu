# AMO（addons.mozilla.org）提交材料 — 小说悦读

Firefox（桌面 / Android）**强制要求扩展经 AMO 签名**，未签名的包在手机上装不了。
本文件是提交所需的一切：提交物、上架文案、权限说明、数据声明、第三方库链接、源码包要求、提交与安装步骤。

> **勘误（2026-09 联网核实后修订）**：本文件早前版本称「Firefox 手机上没有『从本地文件安装扩展』的入口」，**该说法是错的**。官方文档明确存在隐藏的 **Install Extension from File** 入口，见第 7 节。另：早前把「把 `strict_min_version` 提到 140」列为备选处置，核实后**并不需要**，见第 0 节。

---

## 0. `data_collection_permissions`（已补，形式经官方文档确认）

依据 Mozilla 官方文档《Firefox built-in consent for data collection and transmission》
（<https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/>，页面标注最后更新 2026-03-12）：

> Firefox supports built-in consent for data collection and transmission in Firefox for desktop **140 and later**, and Firefox for Android **142 and later**.
>
> **From November 3, 2025, all new extensions must adopt** the Firefox built-in data collection consent system. Extensions must state if and what data they collect or transmit.

→ v0.2.13 及更早的 manifest 缺该字段，**新提交会在校验阶段被拒**。v0.2.14 起已补上（当前 v0.2.15）。

**当前 manifest（v0.2.15）**（与官方文档 "No data collection" 示例**逐字一致**，官方示例同样不写 `optional`）：

```json
"browser_specific_settings": {
  "gecko": {
    "id": "novel-yuedu@tywww.dev",
    "strict_min_version": "128.0",
    "data_collection_permissions": {
      "required": ["none"]
    }
  }
}
```

官方 "No data collection" 示例：

```json
"browser_specific_settings": {
  "gecko": {
    "id": "@extension-without-data-collection",
    "data_collection_permissions": {
      "required": ["none"]
    }
  }
}
```

### 为什么 `strict_min_version` 保持 128.0 不用改

内置同意界面只在桌面 140+ / Android 142+ 出现。官方文档对旧版的要求是：

> **If your extension collects data** and a user installs it on Firefox for desktop 139 or earlier, or Firefox for Android 141 or earlier, it must display a custom data collection experience.

该义务**只针对「收集数据」的扩展**。我们声明 `none`（不收集任何数据），因此既不需要自建同意界面，也**不需要**把 `strict_min_version` 提到 140/142 —— 提到 140 只会白白损失 Firefox 128–139 用户。

### 声明依据（已代码级核验，见第 4 节）

本扩展无自建服务器，**不向开发者或第三方传输任何数据**；阅读进度、排版设置、站点启停只写本机 `chrome.storage`。

> 该字段是**开发者对数据实践的声明**。责任在发布者。

---

## 1. 提交物

| 文件 | 说明 |
|---|---|
| `dist/novel-yuedu-v0.2.15.xpi` | AMO 提交用（与 `-firefox.zip` 同内容，规范扩展名） |
| `dist/novel-yuedu-v0.2.15-source.zip` | **源码包（必需）**，与 XPI 一同上传，见第 9 节 |

生成命令：

```bash
python3 tools/package.py
```

XPI 关键字段（已核对）：`manifest_version: 3`、`background.scripts`（Firefox 事件页，**不含** `service_worker`）、`gecko.id = novel-yuedu@tywww.dev`、`strict_min_version: 128.0`、`data_collection_permissions.required = ["none"]`。

`tools/package.py` 为**逐字节可复现构建**：zip 条目时间戳固定，重跑生成器后再打包产物字节仍恒定。

---

## 2. 上架元数据（zh-CN）

**名称**（≤50 字符）

```
小说悦读
```

**摘要 / Summary**（≤250 字符）

```
把任意小说网页重排为干净的沉浸阅读视图：自动排版适应屏幕、字号行距字体主题可调、屏蔽广告与图片、预加载下一章无缝连读、目录快速跳转与阅读进度记录、离线简繁转换；阅读期间锁定站点跳转，不弹出、不跳走。
```

**分类**：阅读与书签（Reading & Bookmarks）
**标签建议**：小说、阅读模式、reader、novel、简繁转换、沉浸阅读

**详细描述**（可直接粘贴）

```
把一个杂乱、满是广告的小说页面，重排为一页干净的沉浸阅读视图。

■ 主要能力
• 自动排版：整页替换式阅读视图（Shadow DOM 隔离原站样式），正文宽度 30–100% 自适应，段落两字缩进
• 排版可调：字号 14–28px、行距 1.5–2.6、四种字体、明/暗/羊皮纸三主题，设置跨设备同步
• 离线简繁转换：内置 OpenCC 字表 + 8000 余条词组消歧，正文/标题/目录同步切换原文/简体/繁體，完全离线
• 预加载下一章：进入章节即后台解析后 2 章，滚动到底无缝拼接，→ 即时翻章零等待
• 目录快速跳转：拉取目录页生成章节列表，打开自动定位当前章，搜索章节号/标题即时过滤
• 阅读进度：按书记录章内位置，与自动拼接的章节数无关；续读精确回到上次那行
• 屏蔽广告与图片：重排版天然丢弃广告脚本；阅读期间对本站点启用白名单式网络拦截，非本站请求一律拦截
• 阅读期间导航锁定：站点脚本的整页跳转、window.open 弹窗、history 篡改一律拦截，不会自动退出阅读模式
• 快捷键：Alt+R / Mac ⌘⇧K 进出阅读模式，←/→ 翻章，+/- 调字号，Esc 退出并还原原页面

■ 正文提取
三层管线：站点规则选择器（内置笔趣阁系 30+ 通用选择器与起点/番茄/晋江等站点规则）→ Mozilla Readability → 中文标点密度启发式兜底。GBK/GB2312 老站自动探测编码，不乱码。

■ 隐私
不收集、不上传任何数据。无自建服务器，无统计，无广告。阅读进度与本机设置只存在你自己的浏览器里。

■ 兼容性
桌面 Firefox / Firefox for Android。Android 版 Firefox 无 Navigation API，导航锁定退化为网络层拦截 + 关闭确认框；端侧翻译依赖 Chrome 的 Translator API，在 Firefox 上会自动隐藏该入口，其余功能不受影响。
```

---

## 3. 权限用途说明（审核会要求逐项解释）

| 权限 | 用途 |
|---|---|
| `storage` | 保存阅读进度、排版设置、站点启停开关；`sync` 用于跨设备同步设置 |
| `activeTab` | 用户点击悬浮按钮/快捷键时访问当前标签页 |
| `scripting` | 在用户主动触发时向当前页注入阅读视图 |
| `declarativeNetRequest` | 阅读模式期间启用会话级规则：仅放行当前小说站域名，拦截其余请求（含弹窗跳转）。规则随退出即时撤销 |
| `host_permissions: http://*/*, https://*/*` | 扩展须在**任意**小说站点可用（无法预知用户阅读哪个站）；预取下一章需要在同站后台请求 |

**为什么需要全站 host 权限（审核重点）**：本扩展是通用阅读器，站点不可枚举；权限仅用于用户主动进入阅读模式后的正文提取与同站预取，不做任何数据外传。可在说明中强调：无远程服务器、无遥测。

---

## 4. 数据收集与隐私政策

- **收集数据类型**：无（选 `none`）
- **隐私政策**：因不收集数据，通常无需提供隐私政策 URL；若 AMO 表单强制要求，可填本仓库地址 `https://github.com/FengHuoLinShan/novel-yuedu#隐私`
- **数据去向**：全部仅存本机 `chrome.storage`

### 对 `none` 声明的代码级核验（维护者已确认）

`required: ["none"]` 由维护者确认。为备 AMO 审核追问，以下是可复现的核验证据：

```bash
# 全仓出站网络调用：只有 2 处
# （用 \bfetch\( 加词边界，避免命中 _startPrefetch( 这类含 "fetch(" 的同名字符串）
grep -rnE "\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource" src/
#   src/content/extractor.js:26     fetch(chrome.runtime.getURL(...))      → 扩展内部资源，非网络
#   src/content/next-chapter.js:31  fetch(url, {...})                      → 用户正在阅读的小说站自身

# 无身份/外部通信/上传类 API
grep -rnE "chrome\.identity|externally_connectable|chrome\.webRequest|chrome\.cookies" src/ manifest.json   # 无匹配
grep -c externally_connectable manifest.json                                                                # 0

# 无硬编码外部端点：本项目自有代码零匹配
# 三处需要正确理解的非端点字面量：
#   1. src/lib/ 是 vendored 第三方库（Mozilla Readability、DOMPurify 等），其中 URL 全是
#      注释/文档链接与许可证头（wikipedia、schema.org 的 JSON-LD 类型正则、slate.com 注释等）
#   2. settings-panel.js 的 http://www.w3.org/1999/xhtml 是 createElementNS 的 XHTML 命名空间
#      标识符（XML 命名空间是不参与解析的不透明字符串，不会发起请求）
#   3. 全仓真实 fetch( 只有上面列出的 2 处
grep -rnoE "https?://[^\"' ]+" src/ --exclude-dir=lib | grep -v "w3\.org/1999/xhtml" \
  && echo "!! 有匹配" || echo "零匹配 ✅"
```

结论：**扩展自身不向开发者或第三方发送任何数据。**

- **预取下一章**（`next-chapter.js`）用 `credentials: 'same-origin'`、`redirect: 'follow'` 请求**当前小说站的下一页**——即用户自己正在浏览的那个站，携带的是用户与该站之间本就存在的会话 cookie。这属于用户自身的浏览行为，不是向开发者收集数据。跨域名链接按「尾章」处理，不跨站预取。
- **端侧翻译**（`translator.js`）只调用浏览器内置 `Translator.availability` / `Translator.create`，用本机模型在本机完成翻译，该文件内**没有任何网络调用**。模型的下载由浏览器自身管理（且 Firefox 上该入口自动隐藏），与扩展无关。
- 简繁转换是内置字表（`src/lib/chinese-convert.js`）的纯本地字符串变换。

---

## 5. 第三方库链接（填入 "Notes for Reviewers"）

官方要求（<https://extensionworkshop.com/documentation/publish/third-party-library-usage/>）：必须提供**原始文件**链接与**可读源码**链接；用**发布 tag**，不能用 `master`、不能用 CDN；**reviewer 用 checksum 核对**，文件必须与官方发行版完全一致；写进 AMO 的 "Notes for Reviewers"。

**已逐一校验：本扩展内置的第三方库均为官方发布版原文件、未做修改。**

### Mozilla Readability 0.6.0

```
https://github.com/mozilla/readability/blob/0.6.0/Readability.js
https://github.com/mozilla/readability/blob/0.6.0/Readability-readerable.js
```

| 文件 | sha256（与 0.6.0 官方文件逐字节一致） |
|---|---|
| `src/lib/Readability.js` | `34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174` |
| `src/lib/Readability-readerable.js` | `a98d28805804c1986ceed470678a3f409f150ee7f1d227f8c8239c005d21de65` |

> 版本是靠 checksum 逐 tag 比对确定的（0.6.0 命中，0.5.0/0.4.4/0.4.3/0.4.2/0.4.1/0.4.0/0.3.0 均不匹配）——源文件头部没有版本号，此结论已实测。

### DOMPurify 3.2.6

```
https://github.com/cure53/DOMPurify/blob/3.2.6/dist/purify.min.js
```

| 文件 | sha256（与官方 `dist/purify.min.js` 逐字节一致） |
|---|---|
| `src/lib/purify.min.js` | `89e1fa7647cb495370d3a997ace4387f5d15d9f4c5af12352c53daa400956287` |

压缩版属第三方库的官方发行文件，按第三方库链接规则处理即可（checksum 一致），不因此额外要求我们提交 DOMPurify 的源码构建。

### OpenCC 词典数据（只作生成器输入，已锁定并随源码包分发）

```
https://github.com/BYVoid/OpenCC   （词典位于 data/dictionary/）
锁定 commit：c363a7ba51d487950982bd8a589211ffbfd95ba1
```

`src/lib/chinese-convert.js` 由 `tools/gen_cc.py` 从 OpenCC 词典**离线**生成。词典不属"库代码"而是**生成器输入**，已随源码包分发于 `tools/data/opencc/`，并锁定到上述不可变 commit（不用 `master`：master 会漂移，无法保证零差异重建）。`gen_cc.py` 读取时会逐个校验 SHA256。详见第 9 节。

---

## 6. Android 兼容

1. 提交时在 **平台兼容性** 处勾选 **Firefox for Android**（AMO 提交流程有 "Select the add-on's compatible platform(s)" 一步）
2. `strict_min_version: 128.0` 满足当前 Android 版 Firefox 要求；因声明不收集数据，无需为同意界面把版本抬到 142（见第 0 节）
3. 无桌面专属 API 依赖，MV3 事件页写法对 Android 有效
4. **建议（可选）**：官方建议在 `browser_specific_settings` 里加 `gecko_android.strict_min_version` 来独立声明 Android 兼容区间，`web-ext lint` 的 Android 兼容检查依赖它。目前 manifest 只写了 `gecko`。

---

## 7. 手机上安装（签名完成后）

**方式 A — 从文件安装（自主分发/未上架时用这个）**

官方步骤（<https://extensionworkshop.com/documentation/publish/install-self-distributed/>，"Install add-on from file on Android"）：

1. 把**已签名的**扩展文件（`.xpi`）传/下载到手机
2. Firefox → **设置 → 关于 Firefox**
3. **连续快速点击 Firefox 标志 5 次**，解锁隐藏菜单项
4. 回到 **设置 → Install Extension from File**
5. 浏览并选中刚保存的扩展文件
6. 提示时点 **Add**
7. 扩展出现在「扩展」列表里即可使用；打开小说章节页，右下角出现 📖 悬浮按钮

**方式 B — 从 AMO 安装（已上架时，可自动更新）**

1. Firefox for Android → **⋮ 菜单 → 扩展** → 找到「小说悦读」→ **添加**
2. 或在 Firefox for Android 里直接打开该扩展的 AMO 页面，点 **Add to Firefox / 添加到 Firefox**

**方式 C — 临时载入（仅开发自测，重启失效）**

桌面 Firefox：`about:debugging#/runtime/this-firefox` → **临时载入附加组件** → 选解压目录里的 `manifest.json`。

---

## 8. 附：Firefox 端功能差异（写进描述，避免差评）

- **端侧翻译不可用**：依赖 Chrome 138+ 的 Translator API，Firefox 自动隐藏「译」入口
- **导航锁定变弱**：Firefox 无 Navigation API，退化为 DNR 拦跨站 + `beforeunload` 原生确认框——站点强跳仍被拦下，但阅读中**手动关闭标签页也会弹一次确认**
- 其余功能（简繁转换、目录、进度、无缝连读、白名单拦截）均正常

---

## 9. 源码包（**必需**）—— 已按方案 B 完成

### 为什么必须提交源码

官方要求（<https://extensionworkshop.com/documentation/publish/source-code-submission/>）：只要代码是用下列方式产生的，就**必须上传源码并附构建说明**：

> code minifiers… tools that generate a single file from other files… template engines… **any other custom tool that takes files, applies pre-processing, and generates file(s) to include in the extension**.

> If you do not provide source code with clear instructions and the reviewer cannot evaluate your extension, **it may be rejected**.

本扩展命中：

| 文件 | 生成方式 | 归属 |
|---|---|---|
| `src/lib/chinese-convert.js` | `tools/gen_cc.py`（单行 17 万字符，223 KB） | 自有代码 |
| `src/lib/purify.min.js` | 第三方 DOMPurify 压缩发行版 | 第三方（走第 5 节链接） |
| `icons/icon{16,48,128}.png` | `tools/gen_icons.py` | 自有代码 |
| 包内 `manifest.json`（Firefox 变体） | `tools/package.py` 改写 `background` 字段 | 自有代码 |

官方对构建说明的要求：**reviewer 会照说明重建，然后 diff，必须零差异**；所用工具必须开源、**不能是在线的（web-based）**，须在本地可跑。

### 提交物

| 文件 | 内容 |
|---|---|
| `dist/novel-yuedu-v0.2.15-source.zip` | 37 个文件，676 KB —— 直接上传这一份即可 |
| `BUILD.md` | 构建说明（已含在源码包内，仓库根目录也有一份） |

源码包内含：完整 `src/`、`rules/`、`icons/`、`manifest.json`、构建器 `tools/{gen_cc,gen_icons,package}.py`、**锁定的 OpenCC 词典** `tools/data/opencc/*.txt`、`BUILD.md`、`THIRD-PARTY-NOTICES`。

### 采用的修法：方案 B（锁定 commit + 词典随包分发，行为不变）

原先的问题：`gen_cc.py` 从 `raw.githubusercontent.com/BYVoid/OpenCC/**master**/` 下载词典，仓库内不存这些输入。实测（`chinese-convert.js` sha256 `539533a5…`）：

- 用 OpenCC `master` 词典重跑 → **完全一致**（master 当时 HEAD = `c363a7ba51`, 2026-09-09）
- 用发布 tag **ver.1.4.2 / 1.4.1 / 1.4.0 / 1.3.2 / 1.3.1 / 1.3.0** 重跑 → **全部不一致**

即：线上字表来自 **`master` 快照**，而 master 会漂移、且不符合 AMO「第三方须用发布版本」的要求，reviewer 无法保证零差异重建。

**已实施的修复**：

- `tools/gen_cc.py` 数据源固定为不可变 commit **`c363a7ba51d487950982bd8a589211ffbfd95ba1`**（2026-09-09），不再用 `master`
- 四份词典（约 1.1 MB，Apache-2.0）随仓库分发于 `tools/data/opencc/`，构建时**离线读取**
- `gen_cc.py` 读取时**逐个校验 SHA256**，不符即报错退出（实测篡改词典会以退出码 1 终止），杜绝静默产出不同字表
- 因此 `chinese-convert.js` 与改动前**逐字节相同**（sha256 仍为 `539533a5a1265677c4b6f34b2c1f10f90b8218fd8c656fac90c314f929b61f80`），**功能零变化**，无需重测转换断言

> 该词典数据属"作为生成器输入分发的第三方数据"，来源为固定 commit（不可变），并随源码包一并提交，因此 reviewer 无需联网即可复现。已在 "Notes for Reviewers" 中说明（见第 5 节末尾）。

### 已验证的复现情况

| 产物 | 结论 |
|---|---|
| `chinese-convert.js` | ✅ 用随包词典**离线重建，逐字节一致** |
| `icons/*.png` | ✅ `gen_icons.py` 纯本地无网络，逐字节一致 |
| `Readability*.js`、`purify.min.js` | ✅ 官方发布版原文件，checksum 一致 |
| **`dist/novel-yuedu-v0.2.15.xpi`** | ✅ **完整重建后逐字节一致**（sha256 `abb5ab205615cb331893140ee80f42dc9c777af31d9db505a5665f9e7b60dfd8`） |

打包脚本原本会因 zip 记录文件 mtime 而"改变容器字节"（同内容不同校验和），现已把 zip 条目时间戳固定为 `1980-01-01`，**重跑生成器后再打包，产物字节仍恒定**。另提供 `--no-crx` 开关：reviewer 没有本项目发布私钥，AMO 审查只需 zip/xpi，无需 CRX 签名。

`tools/gen_fixtures.py` 生成的是**测试用**站点，不进扩展包，故未放入源码包。

---

## 10. 提交步骤

1. 登录 <https://addons.mozilla.org/developers/> → **Submit a New Add-on**
2. 分发方式选 **On your own（自主分发）** 或 **On this site**：
   - 仅自己/小范围用 → 选 On your own，仍会获得签名、不公开列表，用第 7 节方式 A 安装
   - 想让别人也能搜到 → 选 On this site，走完整审核
3. 上传 `dist/novel-yuedu-v<版本>.xpi`
4. **选择兼容平台**，勾选 Firefox for Android
5. 按第 9 节判断是否需要提供**源码包**（本扩展需要），需要时上传并附 `BUILD.md`
6. 填写第 2、3、4 节文案与说明；在 **Notes for Reviewers** 里填入第 5 节的第三方库链接
7. 提交后等待校验/签名；On your own 通常几分钟完成，不进入人工队列
8. 完成后下载签名后的 XPI，按第 7 节装到手机
