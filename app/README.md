# 交易终端前端

React 19 + TypeScript + Vite + Tailwind，主图使用 Charting Library v32.1.0，交易详情使用 lightweight-charts 5。前端连接 NT8 / ATAS 桥；复制交易由独立后台执行，回放撮合在浏览器内执行。

项目入口见 [根 README](../README.md)。新对话先读 [接续工作](../docs/接续工作.md)，完整边界见 [项目架构与发布流程](../项目架构与发布流程.md)，启动、部署和验证说明见 [开发与验证](../docs/开发与验证.md)。

## 开发与构建

以下在项目根目录的原生 PowerShell 执行：

```powershell
Set-Location app
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 7100
```

`vite.config.ts` 配置的开发默认端口是 **3000**；上面的命令显式使用 **7100**。需要手机访问时，按开发文档选择主机监听地址。开发服务器不会自动启动复制后台。

生产构建在项目根目录执行：

```powershell
.\app\build.cmd
```

构建先做 TypeScript 检查，再生成 `app/dist/`。开发缓存 `node_modules/.vite` 和构建缓存 `.vite-build` 分开；不要删除运行中 Vite 的缓存或全局终止 esbuild，否则交易详情等懒加载页面可能报 504。`app/build.cmd` 保持 ASCII，使用原生 PowerShell / cmd 运行。

运行绘图库位于 `app/public/charting_library/`，升级使用根目录的 `scripts/sync-charting-library.mjs`；不可混用不同版本 bundles。

## 页面与模块

`src/main.tsx` → `src/App.tsx` → `src/sections/ChartTerminal.tsx`。六个页面通过组件状态切换，ChartTerminal 负责连接、账户轮询、行情源、工作区和回放生命周期。

| 页面 | 主要实现 | 职责 |
|---|---|---|
| 交易图表 | `components/ChartWorkspace.tsx`、`TvAdvancedChart.tsx`、`sections/TradingPanel.tsx` | 桌面 1 / 2 / 4 图，左右两个独立侧栏，交易票据与全部合约持仓 / 工作单 |
| 监控面板 | `sections/MonitorPage.tsx`、`components/MonitorAccountCard.tsx`、`MonitorChart.tsx`、`MonitorPageLoader.tsx`、`lib/monitorData.ts` | 有持仓实盘账户各一卡片：余额、实时浮盈、K 线 + 持仓 / TP / SL 线；3 秒轮询 + SSE；只读，含隐藏账户 |
| 账户总览 | `sections/AccountPages.tsx` | 两桥全部账户分组，卡片 / 列表与余额、盈亏 |
| 交易记录 | `components/TradeHistory.tsx`、`PerformanceSummary.tsx`、`TradeDetailsLoader.tsx`、`TradeDetails.tsx` | FIFO 配对、筛选、统计、独立详情图表 |
| 回放模拟 | `sections/ReplayDashboard.tsx`、`ReplayBar.tsx` | 新建、继续、删除 session，回放控制及表现记录 |
| 复制交易 | `sections/CopyTradingPage.tsx`、`lib/copyTrading.ts` | 配置规则、启停与后台状态日志；不在网页执行跟单 |

| 模块 | 关键文件（相对 `src/`） |
|---|---|
| 行情、合约搜索与收藏 | `lib/tvDatafeed.ts`、`nt8Bridge.ts`、`symbolSearch.ts`、`components/SymbolFavorites.tsx` |
| 双桥地址与账户路由 | `lib/config.ts`、`bridgeAccounts.ts`、`nt8Trading.ts`、`tradingRouter.ts` |
| 订单 / 仓位 / 草稿 / 预设保护线 | `hooks/useOrderLines.ts`、`useDraftLines.ts`、`usePendingBracketLines.ts`、`lib/chartInstrument.ts`、`draftCalc.ts` |
| 右键下单与成交箭头 | `lib/tvContextMenu.ts`、`hooks/useExecutionTrades.ts`、`lib/tvExecutionArrow.ts` |
| 原生布局存储与加载事件 | `lib/tvLayoutStore.ts`、`tvLayoutEvents.ts` |
| 成交归档、配对与筛选 | `lib/historyStore.ts`、`tradeAnalytics.ts`、`tradeRecords.ts`、`tradeHistoryFilters.ts` |
| 回放持久化、行情与撮合 | `lib/replayStore.ts`、`replayFeed.ts`、`replaySession.ts`、`simTrading.ts` |
| 手机导航和面板高度 | `components/MobileNavigation.tsx`、`hooks/useMobilePanelHeight.ts`、`useMediaQuery.ts`、`index.css` |

## 修改时保持的边界

- `nt8Trading` 是沿用名称，现已路由两桥。账户键为 `bridge:<provider>:<编码后的原生名称>`；发送到桥前还原原生名称，不能按显示名合并同名账户。
- 所有持仓 / 工作单指**选中账户的全部合约**。ATAS `chartSymbols` 只用于显示关联，不能剥除完整合约 ID 来下单或推断跨源等价。
- 隐藏账户卡片灰化并保留恢复入口，交易下拉排除；仅用户手动恢复才解除隐藏，轮询缺失和重连不能清洗隐藏名单。账户总览仍显示全部账户。
- 每图独立 widget、订阅和布局；切页面 / 面板保留图表。换账户、合约和行情源必须失效旧响应及旧绘图动作。程序清理图形不能触发撤单。
- 运行态交易图形不写入原生布局；进入回放前保存实盘布局，回放不覆盖它。`tvExecutionArrow.ts` 包含 v32.1 的单实例渲染适配，升级绘图库需回归；`tvExecutionTool.ts` 是未使用的旧实现。
- 手机小于 1024px，单图在上、一个紧凑面板在下；高度可拖动，手机偏好不覆盖桌面的多图及左右双面板偏好。
- 交易详情有局部错误边界。修改懒加载或图表 API 时，失败提示和重试必须保留，避免详情错误导致整个交易页黑屏。

## 浏览器存储

布局、收藏、主题、隐藏账户和回放 session 使用 localStorage；成交查询副本使用 IndexedDB `nt8-terminal-trade-archive`，持续同步两桥磁盘归档。两者均按**设备、浏览器和 origin（协议 / 主机 / 端口）**隔离，不自动跨设备同步。

回放保存的是会话状态，继续时仍需对应行情桥提供历史数据；它不是离线行情包。历史归档启用前已被平台清除的成交不能自动补回。具体 key、桥端数据路径和迁移方式见主架构文档。

## 按任务选择验证

以下脚本均在项目根目录使用 `node scripts/<文件名>` 运行。浏览器测试可能需要已有 `app/dist` 和 Edge，前置条件见 [开发与验证](../docs/开发与验证.md)。测试使用隔离模拟桥，不通过真实账户交易验证界面。

| 修改内容 | 主要脚本 |
|---|---|
| 布局 / 多图 / 行情订阅 | `test-layout-store.mjs`、`test-layout-upgrade.mjs`、`test-chart-isolation.mjs`、`test-multichart-ui.mjs` |
| 双桥账户 / 隐藏 / ATAS 仓位线 | `test-dual-bridge-ui.mjs`、`test-chart-instrument.mjs`、`test-order-line-scope.mjs` |
| 手机面板 | `test-mobile-panels-ui.mjs` |
| 成交配对 / 筛选 / 详情 | `test-trade-analytics.mjs`、`test-trade-records.mjs`、`test-trade-history-filters.mjs`、`test-paired-trades-ui.mjs`、`test-trade-detail-loading-ui.mjs` |
| 回放 | `test-replay.mjs`、`test-replay-persistence.mjs` |
| 复制页面 | `test-copy-trading-ui-state.mjs`、`test-copy-trading-ui.mjs`；后台验证另见复制模块文档 |

按变更运行相关验证和前端构建；不要把历史通过记录当作本轮已执行结果。
