NT8 行情终端 —— 迁移使用说明
================================

[运行需求]
- Windows 10/11(.NET Framework 系统自带,无需安装)
- NinjaTrader 8(需自行安装并配置好行情数据源)
- 不需要 Node.js / npm / Python

[部署步骤]
1. 解压本包到任意目录(如 D:\NT8Terminal)
2. 把 TvBridgeAddOn.cs 复制到:
     文档\NinjaTrader 8\bin\Custom\AddOns\
   然后打开 NT8 控制中心 -> New -> NinjaScript Editor,
   在编辑器里按 F5 编译,重启 NT8(桥会自动加载,监听 127.0.0.1:8090)
3. 双击 NT8Terminal.exe,自动打开浏览器 http://127.0.0.1:7200/

[关闭]
- 前端:关掉 NT8Terminal.exe 的黑色窗口,或任务管理器结束 NT8Terminal.exe
- 数据桥:随 NinjaTrader 8 关闭而停

[远程浏览器访问]
- 在运行 NT8 的同一台电脑启动前端服务，例如:
    NT8Terminal.exe 7200 --host 192.168.1.20
  把示例 IP 替换为该电脑的局域网 IP，再从其他设备打开 http://192.168.1.20:7200/
- 远程页面自动通过前端服务连接 NT8，无需把数据桥地址设成远程设备的 127.0.0.1，也无需开放 8090。
- 如之前填过其他地址，可在右上角数据桥设置中留空并“保存并重连”。
- 当前前端地址下的 /api/status 可检查连接。远程入口用于可信内网或受保护的代理。
- 使用 HTTPS 反向代理时，同时转发页面及 /api/*，并关闭 /api/stream 的响应缓冲。

[备注]
- 默认两个端口都是本机回环；远程模式只需让其他设备能访问前端端口
- 想换前端端口:命令行运行 NT8Terminal.exe 7500
- 浏览器里设置的主题/隐藏账户/面板宽度不随文件迁移,需重设
- 以后前端有更新:只替换 NT8Terminal.exe 旁边的 dist 目录即可
  (桥有更新:替换 AddOns 里的 .cs 并重新 F5 编译)
- 从旧版升级远程连接功能时，需要同时替换 NT8Terminal.exe 和 dist，并重启前端服务。
