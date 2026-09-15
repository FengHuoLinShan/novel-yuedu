# AMO（addons.mozilla.org）提交材料 — 小说悦读 v0.2.14

Firefox（桌面 / Android）**强制要求扩展经 AMO 签名**，未签名的 `-firefox.zip` 在手机上无法安装。
本文件是提交所需的一切：提交物、上架文案、权限说明、数据声明、提交步骤。

---

## 0. `data_collection_permissions`（已补上）

Mozilla 已把 **`data_collection_permissions` 设为新扩展提交的必填项**（Firefox 140 起推行，此后新提交缺失会被校验器拒绝）。v0.2.13 的 manifest 里没有这个字段，直接提交大概率在第一个校验步骤被打回。

> ⚠️ 该要求我无法在本机核实：当前环境的网页抓取被沙箱阻断（`web_fetch` 全部失败），没能读到 Mozilla 官方文档正文。**请以 AMO 校验器的实际提示为准。**

**v0.2.14 已补上**，manifest 现状：

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

**为什么是 `none`**：本扩展没有自建服务器，**不向开发者或第三方传输任何数据**。阅读进度、排版设置、站点启停只写本机 `chrome.storage.local/sync`；简繁转换是内置字表本地转换；端侧翻译走浏览器本机模型（且 Firefox 上该入口会自动隐藏）。预取下一章请求的是用户正在阅读的那个小说站自身，不属于向开发者收集数据。

> 该字段是**开发者对数据实践的声明**。提交前请再确认一次这一声明与实际行为一致，责任在发布者。

**若校验器仍报错**，两个已知的备选处置：

1. 报「`strict_min_version` 与 `data_collection_permissions` 不匹配」→ 把 `strict_min_version` 从 `128.0` 提到 `140.0`（会放弃 Firefox 128–139 用户，仅在确实被要求时才做）
2. 报字段结构问题 → 尝试补 `"optional": []`

### 版本背景

原先我按「v0.2.13 已发布」为前提准备材料；补字段属于修改 `manifest.json`，会让扩展内容变化，因此**已 bump 到 v0.2.14 并重新打包发布**，保证 AMO 上签名的包与 Release 附件是同一份。v0.2.13 的 Release 保持不变，仍然有效。

---

## 1. 提交物

| 文件 | 说明 |
|---|---|
| `dist/novel-yuedu-v0.2.14.xpi` | AMO 提交用（与 `-firefox.zip` 同内容，规范扩展名） |
| `dist/novel-reader-v0.2.14-firefox.zip` | 同内容，AMO 也接受 zip 上传 |

生成命令：

```bash
python3 tools/package.py
```

XPI 关键字段（已核对）：`manifest_version: 3`、`background.scripts`（Firefox 事件页，**不含** `service_worker`）、`gecko.id = novel-yuedu@tywww.dev`、`strict_min_version: 128.0`、`data_collection_permissions.required = ["none"]`。

`tools/package.py` 现已可复现构建：同一源码连续打包字节完全一致（原先 `manifest.json` 的时间戳取自当前时刻，导致每次打包校验和都变）。

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

- **收集数据类型**：无（建议选 `none`）
- **隐私政策**：因不收集数据，通常无需提供隐私政策 URL；若 AMO 表单强制要求，可填本仓库地址 `https://github.com/FengHuoLinShan/novel-yuedu#隐私`
- **数据去向**：全部仅存本机 `chrome.storage`；唯二的网络请求是用户正在阅读的小说站页面本身，以及（仅 Chrome）用户主动触发的本机翻译模型下载

---

## 5. Android 兼容

1. 提交时在 **Android 兼容性**（"Firefox for Android"）处声明支持——Android 版 Firefox 只显示声明了 Android 兼容的扩展
2. `strict_min_version: 128.0` 已满足当前 Android 版 Firefox 要求
3. 无桌面专属 API 依赖（未使用 `browser.tabs.hide` 等），MV3 事件页写法对 Android 有效

---

## 6. 提交步骤

1. 登录 <https://addons.mozilla.org/developers/> → **Submit a New Add-on**
2. 分发方式选 **On your own（自主分发）** 或 **On this site**：
   - 仅自己/小范围用 → 选 On your own，仍会获得签名，且不公开列表
   - 想让别人也能搜到 → 选 On this site，走完整审核
3. 上传 `dist/novel-yuedu-v0.2.14.xpi`（`data_collection_permissions` 已随 v0.2.14 补上，见第 0 节）
4. 填写第 2、3、4 节的文案与说明，勾选 Android 兼容
5. 提交后等待自动签名（On your own 通常几分钟内完成，不进入人工队列）
6. 签名完成后下载 **签名后的 XPI**，或用 AMO 给出的安装链接

---

## 7. 手机上安装（签名完成后）

**方式 A — 从 AMO 安装（推荐，可自动更新）**

1. Firefox for Android → **⋮ 菜单 → 扩展**
2. 找到「小说悦读」→ **添加**
3. 打开任意小说章节页，右下角出现 📖 悬浮按钮即成功

**方式 B — 直接打开 AMO 安装页**

在 Firefox for Android 地址栏打开该扩展的 AMO 页面，点 **Add to Firefox / 添加到 Firefox**。
（On your own 自主分发的包不在公开列表里，需用 AMO 后台给出的直链。）

**方式 C — 临时载入（仅开发自测，重启失效）**

桌面 Firefox：`about:debugging#/runtime/this-firefox` → **临时载入附加组件** → 选解压目录里的 `manifest.json`。

---

## 8. 附：Firefox 端功能差异（写进描述，避免差评）

- **端侧翻译不可用**：依赖 Chrome 138+ 的 Translator API，Firefox 自动隐藏「译」入口
- **导航锁定变弱**：Firefox 无 Navigation API，退化为 DNR 拦跨站 + `beforeunload` 原生确认框——站点强跳仍被拦下，但阅读中**手动关闭标签页也会弹一次确认**
- 其余功能（简繁转换、目录、进度、无缝连读、白名单拦截）均正常
