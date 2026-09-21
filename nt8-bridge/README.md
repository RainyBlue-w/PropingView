# NT8 数据与交易桥

本目录的 [TvBridgeAddOn.cs](TvBridgeAddOn.cs) 是单文件 NinjaTrader 8 AddOn，复用 NT8 已有连接，提供行情、账户、交易、桥管理的止盈止损及本机成交归档。随 AddOn 加载启动，在终止时停止，默认仅监听 `127.0.0.1:8090`。

项目全貌见 [项目架构与发布流程](../项目架构与发布流程.md)，构建和回归入口见 [开发与验证](../docs/开发与验证.md)。前端当前使用 Charting Library v32.1.0；前端启动、ATAS 和复制后台不由本文件管理。

## 安装与更新

1. 将 `TvBridgeAddOn.cs` 复制到 NT8 用户目录的 `bin\Custom\AddOns\TvBridgeAddOn.cs`。通常为 `文档\NinjaTrader 8\bin\Custom\AddOns\`，以实际 NT8 用户目录为准。
2. 打开 NT8 控制中心 → **New → NinjaScript Editor**，按 **F5 / Compile** 编译。
3. 通过本机 `http://127.0.0.1:8090/api/status` 核对已加载能力。若仍是旧能力，在合适时机重启 NT8 再检查；仅刷新网页不会更新 AddOn。

当前源码能力标识：

| 字段 | 值 | 说明 |
|---|---|---|
| `historyWindowVersion` | `1` | 历史请求按完整交易日扩窗，再裁回请求范围 |
| `symbolCatalogVersion` | `2` | NT8 平台当前合约搜索 |
| `copySnapshotVersion` | `1` | 复制交易所需严格账户快照 |
| `executionArchiveVersion` | `1` | 独立于平台内存的磁盘成交归档 |

源码存在、编译成功和已加载新版是三件事，以运行桥的能力响应为准。桥使用 TCP 回环监听，无需为桥端口配置 HTTP.sys URL 预留。

远程手机或电脑访问网页服务器，其 `/api/*` 同源代理再连接本机 NT8 桥。不要把远程浏览器的 `127.0.0.1` 当成 NT8 主机，也无需将桥改为对外监听。网页服务器和 NT8 应在同一主机；远程入口配置见开发文档。

## 合约搜索与原生标识

网页搜索使用 `/api/symbols?currentOnly=true` 和 `/api/resolve?symbol=...&currentOnly=true`。每个期货品种只返回 `MasterInstrument.GetNextExpiry(DateTime.Now)` 按 NT8 换月设置选定的当前月份；不另按市场成交量计算主力，不自动猜测缺失月份。非期货保留原目录。

不带 `currentOnly` 的目录枚举 NT8 合约库，不再使用预设 Watchlist；期货仅过滤早于当月的月份，不能用到期月的第一天与当前时间比较而提前剔除当月。普通精确解析、已打开图表、持仓和历史详情不受搜索限制，不自动换月或换仓。

所有行情和交易请求保留桥返回的 NT8 `Instrument.FullName`。检索可以接受月份别名，实际选中与提交仍使用原生完整名称，不能在交易路径强制转换为固定 `MM-YY` 格式。ATAS 合约显示关联由其独立桥负责，不套用到 NT8 交易标识。

## API

桥内所有路径以 `/api` 开头。账户和合约参数使用原始标识并进行 URL 编码；写操作使用 JSON 请求体。

| 端点 | 方法 | 内容 |
|---|---|---|
| `/api/status` | GET | 连接、能力版本及 `archive` 归档状态 |
| `/api/debug` | GET | 各账户连接状态、持仓 / 订单计数及读取异常 |
| `/api/symbols` | GET | 原生合约目录；可加 `currentOnly=true` |
| `/api/resolve?symbol=...` | GET | 精确合约解析、最小跳动、点值；搜索另加 `currentOnly=true` |
| `/api/history?symbol=...&interval=60&from=...&to=...` | GET | OHLCV 历史；周期和 Unix 时间均为秒 |
| `/api/stream?symbol=...&interval=60` | SSE | 实时更新，`data:` 帧及连接保活 |
| `/api/accounts` | GET | 活跃 / 内置账户、连接组及财务数据；账户币种可能为 UsDollar，由前端规范显示为 USD |
| `/api/positions?account=...` | GET | 该账户所有合约的非空仓持仓，含带符号数量和均价；事件缓存兜底 |
| `/api/orders?account=...` | GET | 工作订单及近 6 小时订单，按时间倒序最多 60 条；界面按状态筛选 |
| `/api/brackets?account=...` | GET | 本桥登记的入场与 TP/SL 信息，供未成交保护价预览，及账户 `syncError` |
| `/api/executions` | GET | 本机成交归档；可选 `account/symbol/from/to/offset/limit` |
| `/api/order/place` | POST | 市价、限价、止损、止损限价；可带保护价格或市价单保护金额 |
| `/api/order/cancel` | POST | 按账户及订单 ID 撤单 |
| `/api/order/change` | POST | 按账户及订单 ID 改价 |
| `/api/position/close` | POST | 按账户及完整合约撤工作单并反向市价平仓 |

桥管理的保护单在入场实际成交后生成，随同账户同合约持仓数量同步；不接管任意外部手工或 ATM 保护单。下单、撤改、平仓接口会操作真实账户，不属于只读健康检查。

## 复制交易严格快照

复制引擎使用以下查询，不把普通界面的有限订单列表当成完整账户状态：

```text
GET /api/positions?account=...&copyStrict=true
GET /api/orders?account=...&copyStrict=true
```

响应带 `copyStrict:true`。严格订单返回全部非终态订单，不截断 60 条；严格持仓仍保留 NT8 懒加载所需的事件缓存兜底，但集合读取失败、原生数量与缓存冲突时返回 503，不伪装空仓。未支持该能力的旧桥不能启用复制交易。

复制实际执行在 [copy-trading](../copy-trading/README.md) 独立后台。它跟随新成交并发送目标市价单，不提前复制未成交挂单。

## 成交持久化

归档路径：

```text
NinjaTrader.Core.Globals.UserDataDir/TvBridge/executions-v1.log
```

以 `/api/status` 或 `/api/executions` 中 `archive.path` 为准。日志独立于浏览器和 NT8 当前内存成交集合；桥启动 / 扫描补入仍可取得的成交，并持续记录账户成交事件。账户与 ExecutionId 去重，迟到资料或手续费更新追加新版本；保留毫秒时间、文本编码和行校验，写入后落盘。

分页返回 `executions/total/nextOffset/archive`，最多每页 500 条；不分页时兼容最近 200 条升序图表标记查询，不限制磁盘归档总量。`timeMs` 是精确成交毫秒，`time` 为秒。浏览器 IndexedDB 是查询缓存，不能替代此文件备份。

归档只能保存启用后取得的成交；NT8 已丢失且此前未归档的历史不能自动恢复。读取、校验、待写入异常应查看 `archive`，不能把缓存可见等同于磁盘已保存。

## 排障与代码入口

| 症状 | 核对入口 |
|---|---|
| 网页显示 NT8 未连接 | 主机 `/api/status`，远程网页同源 `/api/status`；确认平台 / AddOn、端口和代理 |
| 外部账户持仓为空 | `/api/debug` 的连接状态、读取错误、持仓计数；账户订阅与事件缓存不可移除 |
| 当前月份搜索不到 / 出现过多月份 | `symbolCatalogVersion=2`、`currentOnly` 响应与 NT8 换月规则；不能改回 Watchlist |
| 复制规则提示更新桥或快照异常 | `copySnapshotVersion=1` 和严格接口；不要用普通快照绕过检查 |
| 历史有断续或时间错位 | `historyWindowVersion=1`、原平台历史范围、交易时段；检查扩窗、bar 起始时间和 SSE 桶对齐 |
| 交易记录缺失 | `archive` 状态 / 文件；区分未归档旧记录、磁盘失败和浏览器查询缓存 |

单文件内按方法检索：`OnStateChange/StartServer`（生命周期）、`HandleStatus`（能力）、`GetCurrentContractCatalog/HandleResolve`（搜索）、`HandleHistory/BarStartUnix`（历史）、`HandlePositions/HandleOrders`（快照）、`ExecutionJournal`（归档）、`RegisterBracketOnFill`（保护）。

离线回归入口包括 `scripts/test-symbol-catalog.ps1 -CompileNative`、`scripts/test-copy-snapshots.ps1` 及成交归档脚本；环境要求与完整命令见 [开发与验证](../docs/开发与验证.md)。文档列出入口不表示本次已执行测试或部署。
