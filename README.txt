TradingView 多平台交易终端 —— 迁移使用说明
================================

[运行需求]
- Windows 10/11(.NET Framework 系统自带,无需安装)
- 按需使用 NinjaTrader 8 和/或 ATAS X，并配置平台已有行情与交易连接
- ATAS 桥已验证 8.0.14.646 / 8.0.15.643 beta，基于 .NET 10
- 不需要 Node.js / npm / Python
- 复制交易后台服务另需 ASP.NET Core 10 运行时；主机已有 .NET 10 SDK 也可运行

[部署步骤]
1. 解压本包到任意目录(如 D:\NT8Terminal)
2. 使用 NT8 时，把 TvBridgeAddOn.cs 复制到:
     文档\NinjaTrader 8\bin\Custom\AddOns\
   然后打开 NT8 控制中心 -> New -> NinjaScript Editor,
   在编辑器里按 F5 编译，检查 http://127.0.0.1:8090/api/status 的能力版本。
   如仍加载旧 AddOn，在合适时机重启 NT8 后再次核对。
3. 使用 ATAS 时，另行取得 TvAtasBridge.dll（当前 ZIP 不包含此 DLL）。
   在 ATAS 选择 Add custom indicator，加载 DLL，再向一个图表添加
   TradingView Terminal Bridge 指标并保留图表。桥监听 127.0.0.1:8091。
4. 双击 NT8Terminal.exe,自动打开浏览器 http://127.0.0.1:7200/
   同目录的 copy-trading\CopyTrading.exe 会在后台自动启动；首次运行默认没有启用的复制配置。

[关闭]
- 前端:关掉 NT8Terminal.exe 的黑色窗口,或任务管理器结束 NT8Terminal.exe
- NT8 数据桥:随 NinjaTrader 8 关闭而停
- ATAS 数据桥:随 ATAS 关闭或移除最后一个桥接指标而停；已提交工作单不会因此撤销
- 复制交易:关闭浏览器或前端不会停止后台跟单。先在网页停用配置，再按需在任务管理器结束 CopyTrading.exe

[远程浏览器访问]
- 在运行 NT8 / ATAS 的同一台电脑启动前端服务，例如:
    NT8Terminal.exe 7200 --host 192.168.1.20
  把示例 IP 替换为该电脑的局域网 IP，再从其他设备打开 http://192.168.1.20:7200/
- 远程页面自动通过前端服务连接 NT8，无需把数据桥地址设成远程设备的 127.0.0.1，也无需开放 8090。
- 如之前填过其他地址，可在右上角数据桥设置中留空并“保存并重连”。
- 当前前端地址下的 /api/status、/atas/api/status 可分别检查两桥连接。
  /copy/api/status 可检查复制后台。远程入口用于可信内网或受保护的代理。
- 使用 HTTPS 反向代理时，同时转发页面及 /api/*、/atas/api/*、/copy/api/*，并关闭事件流的响应缓冲。
- 反向代理需保留浏览器请求的 Host（含非默认端口），供复制交易入口核对同源请求。

[备注]
- 三个后台端口 8090/8091/8092 都是本机回环；远程模式只需让其他设备能访问前端端口
- 想换前端端口:命令行运行 NT8Terminal.exe 7500
- 浏览器里设置的主题/隐藏账户/面板宽度不随文件迁移,需重设
- 以后前端有更新:只替换 NT8Terminal.exe 旁边的 dist 目录即可
  (NT8 桥有更新:替换 AddOns 里的 .cs 并重新 F5 编译；ATAS 桥按指标方式更新 DLL)
- 从旧版升级远程连接功能时，需要同时替换 NT8Terminal.exe 和 dist，并重启前端服务。
- 复制交易目前只跟随实际成交：未成交挂单及其撤改不复制，成交后目标发市价单。
- 程序包不包含实际成交归档、复制运行状态或浏览器回放；这些数据需单独保留。
- 源码文档从根 README.md、docs/接续工作.md 进入；完整打包当前需要 .NET 10 SDK。
