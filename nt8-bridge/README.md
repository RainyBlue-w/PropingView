# NT8 行情终端 — 本地部署 TradingView + NinjaTrader 8 数据对接

## 主力合约搜索

网页的 NT8 搜索每个期货品种只显示 NT8 换月规则选定的当前月份，使用原生 `MasterInstrument.GetNextExpiry(DateTime.Now)`，不是按成交量另算主力。每次重开搜索更新结果；股票、外汇等非期货维持原列表。

搜索请求使用 `/api/symbols?currentOnly=true` 和 `/api/resolve?symbol=...&currentOnly=true`，非当前期货月份不会作为搜索结果返回。普通合约解析、已打开图表、历史交易详情及持仓仍保留原生月份，不自动换仓。ATAS 搜索不受影响。

复制新版 `TvBridgeAddOn.cs` 后，在 NT8 NinjaScript Editor 按 **F5 编译并重启 NT8**；`/api/status.symbolCatalogVersion` 为 `2` 表示已加载新版。旧桥会在搜索栏提示升级。

## 架构

```
┌──────────────────────────────┐        ┌─────────────────────────────┐
│  浏览器:本地 TradingView 终端  │        │  NinjaTrader 8               │
│  (Charting Library v29.4)    │  HTTP  │  TvBridgeAddOn (本仓库 C#)   │
│  app/  (React + Vite)        │ ─────► │  http://127.0.0.1:8090       │
│                              │ ◄───── │   ├─ /api/status   状态      │
│  历史K线 REST                 │  JSON  │   ├─ /api/symbols  合约表    │
│  实时K线 SSE 推送             │        │   ├─ /api/history  历史K线   │
└──────────────────────────────┘        │   └─ /api/stream   实时推送  │
                                        │      (NT8 当前数据源:Kinetick/  │
                                        │       Continuum/IB/模拟…)     │
                                        └─────────────────────────────┘
```

- 前端用的是 TradingView 官方 **Charting Library v29.4**(你已放入 `charting_library-master`),全功能高级图表:画线、指标、多周期、回放等都在。
- 数据通过自定义 **JS API datafeed** 接入:历史 K 线走 REST,实时 K 线走 SSE(服务器推送事件)。
- NT8 未启动时自动降级为**模拟数据**,界面随时可打开。

## 一、启动前端终端

```bash
cd app
npm install        # 首次
npm run dev        # 开发模式,默认 3000 端口
# 或
npm run build && npm run preview   # 生产模式
```

打开浏览器访问终端页面即可。右上角悬浮面板显示数据源状态:

- 绿色 `NT8 已连接` — 正在使用 NinjaTrader 实时数据
- 黄色 `模拟数据` — 未检测到数据桥,显示内置模拟行情
- 齿轮图标可修改数据桥地址(默认 `http://127.0.0.1:8090`)

## 二、安装 NT8 数据桥 AddOn

1. 把 `nt8-bridge/TvBridgeAddOn.cs` 复制到:
   `文档\NinjaTrader 8\bin\Custom\AddOns\TvBridgeAddOn.cs`
2. 打开 NT8 控制中心 → **New → NinjaScript Editor**,右侧找到 AddOns 下的该文件。
3. 按 **F5**(或点 Compile)编译。如有报错,把错误信息发给我(不同 NT8 小版本 API 略有差异)。
4. **重启 NT8**。AddOn 会自动加载并启动数据桥,输出窗口(Output)会有提示:
   `TvBridgeAddOn: 数据桥已启动 http://127.0.0.1:8090/api/status`
5. 验证:浏览器直接访问 <http://127.0.0.1:8090/api/status>,应返回 JSON。

> 无需管理员权限:数据桥用的是裸 TCP 监听回环地址,不经过 Windows HTTP.sys,也不需要防火墙放行(纯本机回环通信)。

## 三、配置合约(自选股)

编辑 `TvBridgeAddOn.cs` 顶部的 `Watchlist` 数组,改成你 NT8 里有数据的合约名
(与 Market Analyzer / 图表里的名称一致,如 `"ES 09-26"`、`"NQ 09-26"`),
重新编译并重启 NT8。终端左上角的商品搜索框中即可搜到这些合约。

> **换月提醒**:期货合约会到期。图表突然无数据时,先确认 Watchlist 里的
> 合约月份是否还是当前主力(如 ES 从 `09-26` 换到 `12-26`)。
> 在图表搜索框直接输入完整合约名(如 `ES 12-26`)可立即使用,
> 由 `/api/resolve` 动态解析,不用改代码重新编译。

## 四、接口约定(便于二次开发)

| 端点 | 说明 |
|---|---|
| `GET /api/status` | `{ connected, connectionName, time }` |
| `GET /api/symbols` | `{ symbols: [{ symbol, name, tickSize, type }] }`(Watchlist 合约表) |
| `GET /api/resolve?symbol=ES%2009-26` | 按名解析任意 NT8 合约,不存在返回 404 |
| `GET /api/history?symbol=ES%2009-25&interval=60&from=…&to=…` | interval 为秒,from/to 为 Unix 秒,返回 `{ bars: [{ time, open, high, low, close, volume }] }` |
| `GET /api/stream?symbol=…&interval=60` | SSE 流,每条 `data:` 是成型中的当前 K 线 JSON |

支持周期:任意分钟数(1/2/3/5/10/15/30/60/120/240)、日线、周线。

## 五、常见问题

- **时间戳/时区**:K 线时间按本机时区解释(NT8 图表时间即本机时间),前端同样使用浏览器本地时区,两者一致。
- **历史数据为空**:NT8 的历史数据来自其连接的数据源。先在 NT8 图表里能开出该合约 K 线,数据桥才有数据;必要时在 NT8 的 Historical Data Manager 里下载。
- **实时不刷新**:确认 NT8 已连接行情源(Control Center 右下角绿色),且该合约在 Market Analyzer 里有跳动。
- **端口冲突**:8090 被占用时,改 `TvBridgeAddOn.cs` 的 `Port` 常量,并在终端界面齿轮设置里同步修改。
- **换电脑访问**:数据桥只监听 127.0.0.1,如需局域网访问,请自行评估风险后改为 `IPAddress.Any`。
