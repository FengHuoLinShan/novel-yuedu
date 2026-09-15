# 章节记录统一为 meta / data / el

章节记录原先把导航元数据直接放在 `data` 上，收起后又用元数据覆盖 `data`，导致「data 是完整正文还是导航元数据」需要靠函数反复判断。统一为 `meta`（恒存在的导航信息）、`data`（仅在持有完整正文时非空）、`el`（DOM 引用）、`translating`。这是章节窗口模块的接口基础。

`translating` 为端侧翻译功能批次预留（当前恒 `false`，随翻译队列置位）；章节窗口不解释它的语义，只负责在记录里保留该位，避免翻译状态散落到调用方。

已登记的债务：`state.chapters` 别名与 `state.currentIndex` / `state.collapsedCount` accessor 让旧的 records 泄漏接口继续存活，部分 e2e 仍直接写记录数组（`e2e-catalog.mjs`、`e2e-lifecycle.mjs`），测试尚未打到 `add` / `ensureRendered` / `currentIndexAt` 上。
