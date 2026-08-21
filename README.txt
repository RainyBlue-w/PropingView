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

[备注]
- 两个端口都是本机回环,不会触发防火墙
- 想换前端端口:命令行运行 NT8Terminal.exe 7500
- 浏览器里设置的主题/隐藏账户/面板宽度不随文件迁移,需重设
- 以后前端有更新:只替换 NT8Terminal.exe 旁边的 dist 目录即可
  (桥有更新:替换 AddOns 里的 .cs 并重新 F5 编译)
