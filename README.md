# 小说悦读 — Chrome 沉浸式小说阅读扩展

一键把杂乱的小说页面重排为干净的全屏阅读视图：自动排版适应屏幕、字号行距可调、屏蔽广告与图片、预加载下一章无缝连读、目录快速跳转与阅读进度记录。

Manifest V3 · 原生 JavaScript · 零构建依赖 · 兼容 Android（Kiwi/Edge Canary/Firefox）

> 版本：0.2.5 · 安装包见 [Releases](../../releases)

---

## 功能

| 能力 | 说明 |
|---|---|
| **自动排版适应屏幕** | 整页替换式阅读视图（Shadow DOM 隔离原站样式），正文宽度 30–100% 视口百分比任意调（100% 即当前设备全屏，横竖屏/换屏自动适配），另设全屏宽度快捷开关；段落两字缩进 |
| **字号/行距/字体/主题** | 字号 14–28px、行距 1.5–2.6、四种字体（默认/宋体/黑体/楷体）、明/暗/羊皮纸三主题，设置跨设备同步 |
| **屏蔽广告与图片** | 重排版天然丢弃原站广告脚本与弹窗；行级清洗水印文案；正文图片默认不加载可开关；阅读时对当前站点自动启用广告域名网络拦截（会话级 DNR，42 个域名），另有全局拦截开关 |
| **预加载下一章** | 进入章节即后台抓取解析下 2 章；滚动距底约一屏无缝拼接；`→` 即时翻章零等待；失败 3 次熔断，目录页链接识别为尾章 |
| **目录快速跳转** | 阅读视图「☰ 目录」拉取目录页生成章节列表，搜索框输入章节号/标题即时过滤，点击直达并自动回到阅读模式 |
| **阅读进度记录** | 按书分卷记录（目录页为书键，识别漂移时按章节 URL 目录自动归并），进度存**章内位置**——与自动拼接的章节数无关，续读恢复永远精确；章节切换即时落库，进度始终跟随屏幕正显示的章节；弹窗「最近阅读」显示每本书读到的章节与百分比，点「续读」回到上次那行；从同书其他章节进入时正文顶部出现「📖 上次读到《…》」提示条，一键跳回 |

正文提取为三层管线：**站点规则选择器**（内置笔趣阁系 30+ 通用选择器与起点/番茄/晋江等站点规则）→ **Mozilla Readability**（DOM 克隆 + DOMPurify 消毒，阈值针对中文短章节调低）→ **中文标点密度启发式** 兜底。当前页与预取页复用同一管线，翻章排版完全一致。GBK/GB2312 老站自动探测编码，`gb18030` 解码不乱码。

## 安装（开发者模式侧载）

> **推荐 Microsoft Edge（桌面稳定版即可）**：Edge 自带「开发人员模式」，无需安装 Dev/Canary 等开发者渠道（只有安卓端侧载才需要 Edge Canary）。Chrome 同样适用，仅入口名称略有差异。

1. 从 [Releases](../../releases) 下载 `novel-reader-v*.zip`（Firefox 用户下载 `-firefox.zip`）并解压
2. 打开扩展管理页：Edge 访问 `edge://extensions`，Chrome 访问 `chrome://extensions`
3. 打开 **开发人员模式**（Edge 在页面左下角，Chrome 在右上角）
4. 点 **加载解压缩的扩展**（Chrome 显示为「加载已解压的扩展程序」），选择解压后的目录（含 `manifest.json`）
5. （可选）在扩展管理页的快捷键设置中确认/修改 `Alt+R`

> 不提供 `.crx` 安装包：Chrome/Edge 的策略禁止直接安装非商店来源的 CRX，下载后双击会报错，请使用上述解压加载方式。

## 使用

- **进入阅读模式**：小说章节页右下角悬浮按钮 📖 / 工具栏图标弹窗按钮 / 快捷键 `Alt+R`
- **快捷键**（阅读视图内）：
  - `PageDown` / `空格` 向下翻一页，`PageUp` / `Shift+空格` 向上翻一页（每次恰好一屏略小，保留 10% 重叠行）
  - 点击屏幕**上/下三分之一区域**同样翻页（可在设置面板关闭）；**中间三分之一**点击唤出/收起顶部工具栏；正在选词或点到按钮时不触发
  - `←` / `→` 上一章 / 下一章（第一章之前会跳转原站上一章并自动回到阅读模式）
  - `+` / `-` 增减字号
  - `Esc` 退出并完整还原原页面
- **目录快速跳转**：顶部栏 `☰ 目录` → 搜索章节号/标题 → 点击直达
- **排版设置**：顶部栏 `Aa` 按钮滑出面板，全部设置即调即存
- **最近阅读**：工具栏图标弹窗顶部列表，点「续读 ›」回到上次读到的位置

## Android 使用

Android/iOS 版 Chrome 本身不支持安装扩展（平台限制）。本扩展 v0.2.0 起做了移动端适配（触控热区、惯性滚动、双击缩放消除、面板窄屏布局），可通过以下支持扩展的 Android 浏览器使用同一安装包：

- **Kiwi Browser / Edge Canary (Android)**：Chromium 内核，可直接侧载 `dist/novel-reader-v*.zip`（或在 Kiwi 的扩展页开启开发者模式后加载）
- **Firefox for Android**：manifest 已含 gecko 兼容字段（事件页 background + 扩展 ID）；正式安装需经 addons.mozilla.org 签名，开发者可用 `about:debugging` 临时加载
- 触屏下：悬浮按钮点击进入，双击暂停，`Aa` 面板与目录面板均为全高侧滑设计

## 打包

```bash
python3 tools/package.py   # 产出 dist/novel-reader-v<版本>.zip（仅运行时文件）
```

产物可直接用于 Chrome Web Store 上传或 Android 侧载。`dist/` 不纳入版本库，zip 作为 GitHub Release 附件分发。

## 本地测试

```bash
# 1. 生成测试站点（UTF-8 + GBK 各 3 章，含广告/水印/尾章导航）
python3 tools/gen_fixtures.py

# 2. 启动本地站点
python3 -m http.server -d test/fixtures 8080

# 3. 单元测试（清洗器/导航识别/编码探测，21 项断言）
node tools/test-core.mjs

# 4. 端到端测试（headless Chrome for Testing 实际加载扩展，18 项断言）
#    需 Playwright 缓存的 Chrome for Testing（正式版 Chrome 137+ 已移除 --load-extension）
node tools/e2e-test.mjs "$PWD"
```

手动验证：浏览器访问 `http://127.0.0.1:8080/utf8site/1.html`（UTF-8）与 `http://127.0.0.1:8080/gbksite/1.html`（GBK 编码），然后走一遍悬浮按钮 → 滚动拼接 → 翻章 → 设置 → Esc 流程。

真实站点回归测试：`node tools/e2e-real.mjs <扩展目录> <章节页URL>` 可对任意公开小说站跑同一套断言（悬浮按钮 → 正文提取 → 下一章预取 → 翻章），用于验证通用规则对线上站点的命中情况。

## 目录结构

```
manifest.json               MV3 配置（内容脚本按序加载，无打包）
rules/sites.json            站点规则表（generic 通用选择器 + 具名站点覆盖）
rules/dnr-blocklist.json    广告域名静态 DNR 规则（默认关闭，popup 可开）
src/lib/                    vendored：Readability / Readability-readerable / DOMPurify
src/content/
  detector.js               公共工具、导航链接正则、小说页检测
  cleaner.js                行级文本清洗（水印/网址行/重复行/半角标点）
  extractor.js              三层正文提取管线 + 上一章/下一章/目录识别
  next-chapter.js           预加载器：fetch + 编码探测 + 解析缓存 + 熔断限速
  reader-view.js            阅读视图：Shadow DOM、滚动拼接、快捷键、进度记忆
  settings-panel.js         排版设置模型与面板 UI
  main.js                   入口：悬浮按钮、消息、黑名单、设置热更新
src/background/             service worker：命令分发、按需注入、会话级 DNR
src/popup/                  工具栏弹窗
tools/                      图标/fixture/DNR 生成器 + 单元/e2e 测试
test/fixtures/              本地小说站（UTF-8 与 GBK）
```

## 已知限制（v1）

- 正文由站点前端 JS 动态注入（无服务端 HTML）的页面，fetch 预取拿不到正文；当前页仍可正常阅读（v2 预留降级通道：background 抓取 / iframe + DNR 去 X-Frame-Options）
- 进度记忆只恢复"同一章节 URL"；跨章节续读需 v2（沿预取链回放）
- 预取受同源限制：下一章链接指向其他域名时视为尾章
- SPA 站点（客户端路由切章）支持有限，悬浮按钮每 10 秒重判一次

## v2 路线（未实现）

目录侧栏、书架管理、TXT 批量导出、TTS 朗读、自定义站点规则编辑器、规则云端订阅、iframe 降级抓取通道。

## 声明

- 本扩展是**纯本地工具**：只在用户浏览器内对当前页面做重排版，不存储、不上传、不分发任何小说内容；排版设置与阅读进度仅保存在本地浏览器 `storage`，**不收集任何数据、无任何网络上报**。
- 广告域名拦截**默认关闭**，需用户在弹窗中显式开启，且仅在阅读视图打开期间对当前站点会话级生效。
- 站点规则只是识别正文节点的通用 CSS 选择器，不绕过任何付费或访问限制；付费内容请通过正版渠道阅读，支持原作者。
- 内置第三方库：[Mozilla Readability](https://github.com/mozilla/readability)（Apache-2.0）、[DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 / MPL-2.0），详见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)。
- 本项目按 [MIT License](LICENSE) 开源，仅供学习与个人使用；如有侵权请联系移除相关内容。
