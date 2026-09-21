# TradingView 多平台交易终端

React / TypeScript 前端，接入 NinjaTrader 8 和 ATAS X 的行情与账户；提供多图表交易、账户总览、成交归档、独立回放会话，以及后台复制交易。

## 文档入口

| 需要做什么 | 阅读入口 |
|---|---|
| 新对话接续、了解当前完成状态和边界 | [接续工作](docs/接续工作.md) |
| 理解整体架构、模块职责、接口和存储 | [项目架构与发布流程](项目架构与发布流程.md) |
| 启动、构建、部署、选择测试、排障 | [开发与验证](docs/开发与验证.md) |
| 安装迁移包 | [README.txt](README.txt) |
| 修改某个组件 | [前端](app/README.md) · [NT8 桥](nt8-bridge/README.md) · [ATAS 桥](atas-bridge/README.md) · [复制交易后台](copy-trading/README.md) |
| 追溯历史缺陷和旧方案 | [历史实现记录](docs/历史实现记录.md)（部分说明已过时） |

当前绘图库为 **Charting Library v32.1.0**。复制交易采用**成交跟随**：主账户实际成交后向跟随账户发送市价单，不预先复制未成交挂单。

开发前端的明确入口（在项目根目录的 PowerShell 执行）：

```powershell
Set-Location app
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 7100
```

NT8、ATAS 和复制后台分别使用本机 8090、8091、8092。远程 / HTTPS 页面默认通过同源代理访问；本机 HTTP 页面默认直连两桥，复制服务始终走同源代理。部署及启动条件见开发文档。
