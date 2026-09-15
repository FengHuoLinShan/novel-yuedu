# 内容脚本清单以 manifest 为唯一来源

兜底注入所需的脚本清单原先在 `manifest.json` 与 service worker 各存一份，新增模块时容易漂移。改为运行时由 `chrome.runtime.getManifest().content_scripts` 派生，并过滤掉主世界脚本（主世界脚本仍按文件名单独注入）。

这是可逆的普通重构，记 ADR 的价值在于固定约束：脚本清单只能有一个来源，新增模块只改 manifest。
