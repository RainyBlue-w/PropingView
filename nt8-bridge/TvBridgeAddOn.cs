#region 说明
//
// TvBridgeAddOn — NinjaTrader 8 本地数据桥
//
// 作用:在 NT8 内部启动一个仅监听 127.0.0.1 的极简 HTTP 服务,把 NT8 的行情
// 数据(历史 K 线 + 实时逐笔聚合)暴露给本地浏览器端 TradingView 图表终端。
//
// 接口约定(与前端 src/lib/nt8Bridge.ts 对应):
//   GET /api/status                          -> { connected, connectionName, time }
//   GET /api/symbols                         -> { symbols: [{ symbol, name, tickSize, type }] }
//   GET /api/history?symbol=&interval=&from=&to=
//       interval 单位秒(60=1分钟 … 86400=日线 604800=周线),from/to 为 Unix 秒
//       -> { bars: [{ time, open, high, low, close, volume }] }  time 为 Unix 秒
//   GET /api/stream?symbol=&interval=        -> SSE 推送,每条 data: 为成型中的当前 Bar JSON
//
// 安装:把本文件复制到 文档\NinjaTrader 8\bin\Custom\AddOns\ ,
//       在 NT8 控制中心 New -> NinjaScript Editor 中编译(F5),重启 NT8 即自动加载。
//
// 注意:使用 TcpListener 而非 HttpListener,只为避免 HTTP.sys 的 URL ACL
//       限制(否则需要管理员运行或 netsh 授权)。仅监听回环地址,不对外开放。
//
#endregion

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.Data;

namespace NinjaTrader.NinjaScript.AddOns
{
    public class TvBridgeAddOn : AddOnBase
    {
        // ===== 可按需修改的配置 =====
        private const int Port = 8090;
        // ============================

        private TcpListener listener;
        private Thread acceptThread;
        private volatile bool running;
        private readonly object streamLock = new object();
        private readonly List<StreamSession> streamSessions = new List<StreamSession>();

        // 待触发括号单注册表:entryOrderId -> 预设的止盈/止损价(入场单成交后才真正挂出)
        private class PendingBracket
        {
            public Account Acc;
            public string Instrument;
            public double Tp;
            public double Sl;
            public double TpAmount;
            public double SlAmount;
            public Order Entry;
            public bool Activated;
            public bool PositionObserved;
        }
        private readonly object bracketLock = new object();
        private readonly Dictionary<Order, PendingBracket> pendingBrackets =
            new Dictionary<Order, PendingBracket>();
        private readonly HashSet<Account> protectionWorkers = new HashSet<Account>();
        private readonly Dictionary<Account, long> protectionRevisions = new Dictionary<Account, long>();
        private readonly ConcurrentDictionary<string, string> protectionErrors = new ConcurrentDictionary<string, string>();

        // 每个 合约|周期 /api/history 已返回的最新 bar 时间(unix 秒):
        // 实时流不得发出比这更早的帧(库会报 "time order violation" 并丢弃)。
        // 注意只登记历史值、实时帧绝不回写:外推失误产生的幻影桶若写回,
        // 会永久抬高地平线,之后所有新会话都被钳到幻影桶上
        private static readonly ConcurrentDictionary<string, long> historyFloor =
            new ConcurrentDictionary<string, long>();

        // NT8 内置仿真账户:没有独立连接(或连接状态不反映"在线"),始终保留在账户列表里
        private static readonly HashSet<string> BuiltinAccounts =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Sim101", "Backtest", "Playback101" };

        // ===== 账户数据订阅(实盘/PROP 账户持仓为空问题的修复) =====
        // NT8 对外部连接账户是懒加载的:没有代码订阅其数据流时,acc.Positions/acc.Orders
        // 一直返回空集合;Sim101 等内置账户由核心常驻跟踪,所以看起来"只有仿真账户正常"。
        // 为每个账户挂四个更新事件的常驻 handler 即迫使 NT8 开始跟踪该账户;
        // 同时用 PositionUpdate 事件维护持仓缓存,作为 Positions 集合仍为空时的兜底。
        private readonly object subscribeLock = new object();
        private readonly HashSet<Account> subscribedAccounts = new HashSet<Account>();

        private class CachedPosition
        {
            public int Quantity;        // 带符号:多正空负
            public double AveragePrice;
            public string MarketPosition;
        }
        // key = accountName|instrumentFullName
        private readonly Dictionary<string, CachedPosition> positionCache =
            new Dictionary<string, CachedPosition>();

        private void EnsureSubscribed(Account acc)
        {
            if (acc == null) return;
            lock (subscribeLock)
            {
                if (subscribedAccounts.Contains(acc)) return;
                try
                {
                    acc.PositionUpdate += OnAccountPositionUpdate;
                    acc.OrderUpdate += OnAccountOrderNoop;
                    acc.ExecutionUpdate += OnAccountExecutionNoop;
                    acc.AccountItemUpdate += OnAccountItemNoop;
                    subscribedAccounts.Add(acc);
                    NinjaTrader.Code.Output.Process("TvBridgeAddOn 已订阅账户数据: " + acc.Name, PrintTo.OutputTab1);
                }
                catch (Exception ex)
                {
                    acc.PositionUpdate -= OnAccountPositionUpdate;
                    acc.OrderUpdate -= OnAccountOrderNoop;
                    acc.ExecutionUpdate -= OnAccountExecutionNoop;
                    acc.AccountItemUpdate -= OnAccountItemNoop;
                    throw new InvalidOperationException("订阅账户失败(" + acc.Name + "): " + ex.Message, ex);
                }
            }
        }

        private void OnAccountPositionUpdate(object sender, PositionEventArgs e)
        {
            try
            {
                var acc = sender as Account;
                if (acc == null || e.Position == null || e.Position.Instrument == null) return;
                string key = acc.Name + "|" + e.Position.Instrument.FullName;
                lock (positionCache)
                {
                    if (e.MarketPosition == MarketPosition.Flat)
                        positionCache.Remove(key);
                    else
                        positionCache[key] = new CachedPosition
                        {
                            Quantity = e.MarketPosition == MarketPosition.Long ? e.Quantity : -e.Quantity,
                            AveragePrice = e.AveragePrice,
                            MarketPosition = e.MarketPosition.ToString(),
                        };
                }
                lock (bracketLock)
                    foreach (var p in pendingBrackets.Values)
                        if (p.Acc == acc && p.Instrument == e.Position.Instrument.FullName && p.Entry.Filled > 0)
                            p.PositionObserved = true;
                QueueProtectionSync(acc);
            }
            catch { }
        }

        // 这三个事件只用于"激活"NT8 对该账户的跟踪,不需要处理内容
        private void OnAccountOrderNoop(object sender, OrderEventArgs e)
        {
            var acc = sender as Account;
            if (acc == null || e.Order == null) return;
            if (IsManagedProtection(e.Order) || e.Order.Name == "TV Entry")
            {
                if (IsManagedProtection(e.Order) && e.Order.OrderState == OrderState.Rejected)
                    protectionErrors[acc.Name] = "止盈止损订单被拒绝: " + e.Order.OrderId + "。请在 NT8 检查订单。";
                QueueProtectionSync(acc);
            }
        }
        private void OnAccountExecutionNoop(object sender, ExecutionEventArgs e)
        {
            var acc = sender as Account;
            // Take an immutable snapshot immediately; disk work never runs in NT8's execution handler.
            CaptureExecution(acc, e == null ? null : e.Execution);
            if (acc != null) QueueProtectionSync(acc);
        }
        private void OnAccountItemNoop(object sender, AccountItemEventArgs e) { }

        private static long HistoryFloor(string instrFullName, int intervalSec)
        {
            return historyFloor.TryGetValue(instrFullName + "|" + intervalSec, out var mb) ? mb : 0;
        }

        // NT8 BarsRequest 的分钟级系列是"右端点键控":bar.Time 是槽的结束时间,
        // 末根未收盘 bar 的键因此落在未来(实测 1m 未来 1 分钟、4h 未来半个多小时);
        // 日/周级则是左端点键控。这里统一换算成左端点(交易时段开始时间):
        // 槽是相邻的,bar[i] 的真实开始 = bar[i-1] 的键——对跨休市的 3h 短槽也精确。
        // 历史与实时流必须使用同一套键控,否则末根 bar 永远对不齐
        private static long BarStartUnix(Bars bars, int i, int intervalSec)
        {
            if (intervalSec >= 86400) return ToUnix(bars.GetTime(i));
            if (i > 0) return ToUnix(bars.GetTime(i - 1));
            return ToUnix(bars.GetTime(0)) - intervalSec;
        }

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "TvBridgeAddOn";
                Description = "本地 TradingView 终端数据桥(HTTP/SSE, 端口 " + Port + ")";
            }
            else if (State == State.Active)
            {
                StartExecutionArchive();
                StartServer();
            }
            else if (State == State.Terminated)
            {
                StopServer();
                StopExecutionArchive();
                // 退订账户数据流,避免 NT8 侧挂着悬空调用
                Account[] all;
                lock (subscribeLock) all = subscribedAccounts.ToArray();
                foreach (var acc in all)
                {
                    try
                    {
                        acc.PositionUpdate -= OnAccountPositionUpdate;
                        acc.OrderUpdate -= OnAccountOrderNoop;
                        acc.ExecutionUpdate -= OnAccountExecutionNoop;
                        acc.AccountItemUpdate -= OnAccountItemNoop;
                    }
                    catch { }
                }
                lock (subscribeLock) subscribedAccounts.Clear();
            }
        }

        // ---------------- 服务生命周期 ----------------

        private void StartServer()
        {
            if (running) return;
            running = true;
            listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Start();
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "TvBridgeAccept" };
            acceptThread.Start();
            NinjaTrader.Code.Output.Process(
                string.Format("TvBridgeAddOn: 数据桥已启动 http://127.0.0.1:{0}/api/status", Port),
                PrintTo.OutputTab1);
        }

        private void StopServer()
        {
            running = false;
            try { if (listener != null) listener.Stop(); } catch { }
            lock (streamLock)
            {
                foreach (var s in streamSessions.ToArray()) s.Dispose();
                streamSessions.Clear();
            }
        }

        private void AcceptLoop()
        {
            while (running)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch { break; }
                Task.Run(() => HandleClient(client));
            }
        }

        // ---------------- 极简 HTTP 处理 ----------------

        private void HandleClient(TcpClient client)
        {
            using (client)
            {
                client.ReceiveTimeout = 15000;
                client.SendTimeout = 15000;
                NetworkStream ns = client.GetStream();

                string headerText, body;
                try { headerText = ReadRequest(ns, out body); }
                catch { return; }
                if (string.IsNullOrEmpty(headerText)) return;

                string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries);
                if (lines.Length == 0) return;

                string[] parts = lines[0].Split(' ');
                if (parts.Length < 2) return;
                string method = parts[0].ToUpperInvariant();

                string path, query;
                SplitPath(parts[1], out path, out query);
                var q = ParseQuery(query);

                if (method == "OPTIONS")
                {
                    WriteRaw(ns, "HTTP/1.1 204 No Content\r\n" + CorsHeaders() +
                                 "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                                 "Access-Control-Allow-Headers: Content-Type\r\n" +
                                 "Content-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }

                if (method != "GET" && method != "POST") { WriteJson(ns, 405, "{\"error\":\"method not allowed\"}"); return; }

                try
                {
                    switch (path)
                    {
                        case "/api/status":  HandleStatus(ns);   break;
                        case "/api/symbols": HandleSymbols(ns, q);  break;
                        case "/api/resolve": HandleResolve(ns, q); break;
                        case "/api/history": HandleHistory(ns, q); break;
                        // ---- 交易接口 ----
                        case "/api/accounts":  HandleAccounts(ns);   break;
                        case "/api/debug":     HandleDebug(ns);     break;
                        case "/api/positions": HandlePositions(ns, q); break;
                        case "/api/orders":    HandleOrders(ns, q);  break;
                        case "/api/brackets":  HandleBrackets(ns, q); break;
                        case "/api/executions": HandleExecutions(ns, q); break;
                        case "/api/order/place":  HandlePlaceOrder(ns, body);  break;
                        case "/api/order/cancel": HandleCancelOrder(ns, body); break;
                        case "/api/order/change": HandleChangeOrder(ns, body); break;
                        case "/api/position/close": HandleClosePosition(ns, body); break;
                        case "/api/stream":
                            // SSE 长连接:HandleStream 自己管理连接生命周期,这里保持 using 不提前关闭
                            HandleStream(client, ns, q);
                            break;
                        default: WriteJson(ns, 404, "{\"error\":\"not found\"}"); break;
                    }
                }
                catch (Exception ex)
                {
                    try { WriteJson(ns, 500, "{\"error\":" + JsonQuote(ex.Message) + "}"); } catch { }
                }
            }
        }

        // 读取完整请求(头部 + 可选 body),返回 header 文本(不含 \r\n\r\n)
        private static string ReadRequest(NetworkStream ns, out string body)
        {
            body = string.Empty;
            var ms = new MemoryStream();
            var buffer = new byte[8192];
            string headerText = null;
            int headerEnd = -1;
            int contentLength = 0;

            while (ms.Length < 1048576)
            {
                int n = ns.Read(buffer, 0, buffer.Length);
                if (n <= 0) break;
                ms.Write(buffer, 0, n);

                if (headerText == null)
                {
                    string s = Encoding.ASCII.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                    headerEnd = s.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                    if (headerEnd >= 0)
                    {
                        headerText = s.Substring(0, headerEnd);
                        foreach (string line in headerText.Split(new[] { "\r\n" }, StringSplitOptions.None))
                        {
                            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                                int.TryParse(line.Substring(15).Trim(), out contentLength);
                        }
                    }
                }

                if (headerText != null)
                {
                    int total = headerEnd + 4 + contentLength;   // 头部为 ASCII,字符索引即字节偏移
                    if (ms.Length >= total)
                    {
                        if (contentLength > 0)
                            body = Encoding.UTF8.GetString(ms.GetBuffer(), headerEnd + 4, contentLength);
                        return headerText;
                    }
                }
            }
            return headerText ?? Encoding.ASCII.GetString(ms.GetBuffer(), 0, (int)ms.Length);
        }

        private static void SplitPath(string raw, out string path, out string query)
        {
            int i = raw.IndexOf('?');
            if (i >= 0) { path = raw.Substring(0, i); query = raw.Substring(i + 1); }
            else { path = raw; query = string.Empty; }
        }

        private static Dictionary<string, string> ParseQuery(string query)
        {
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string pair in query.Split('&'))
            {
                if (string.IsNullOrEmpty(pair)) continue;
                int i = pair.IndexOf('=');
                // 注意:query string 里 '+' 代表空格(前端 URLSearchParams 的编码方式),
                // 必须先替换成空格再做百分号解码,否则 "ES 09-26" 会变成 "ES+09-26" 解析失败
                string k = i >= 0 ? pair.Substring(0, i) : pair;
                string v = i >= 0 ? pair.Substring(i + 1) : string.Empty;
                dict[Uri.UnescapeDataString(k.Replace('+', ' '))] = Uri.UnescapeDataString(v.Replace('+', ' '));
            }
            return dict;
        }

        // ---------------- 各端点 ----------------

        private void HandleStatus(NetworkStream ns)
        {
            string connName = string.Empty;
            bool connected = false;
            try
            {
                var conn = Connection.Connections != null
                    ? Connection.Connections.FirstOrDefault(c => c.Status == ConnectionStatus.Connected)
                    : null;
                if (conn != null)
                {
                    connected = true;
                    connName = conn.Options != null ? conn.Options.Name : string.Empty;
                }
            }
            catch { }

            string json = "{"
                + "\"connected\":" + (connected ? "true" : "false") + ","
                + "\"connectionName\":" + JsonQuote(connName) + ","
                + "\"historyWindowVersion\":1,"
                + "\"symbolCatalogVersion\":2,"
                + "\"executionArchiveVersion\":1,\"archive\":" + ExecutionArchiveStatusJson() + ","
                + "\"time\":" + ToUnix(DateTime.Now).ToString(CultureInfo.InvariantCulture)
                + "}";
            WriteJson(ns, 200, json);
        }

        // 候选合约列表:直接读 NT8 合约库(Instrument.All),不用预设字符串。
        // 跳过历史月份期货,按全名排序;前端图表/订单/持仓统一以 NT8 FullName 为准
        private void HandleSymbols(NetworkStream ns, Dictionary<string, string> q = null)
        {
            bool currentOnly = IsCurrentContractSearch(q);
            Instrument[] all;
            if (currentOnly) all = GetCurrentContractCatalog(DateTime.Now);
            else { lock (Instrument.All) all = Instrument.All.ToArray(); }
            var names = new List<string>();
            foreach (var instr in all)
            {
                if (instr == null || instr.MasterInstrument == null) continue;
                try
                {
                    if (!currentOnly && IsPastFuturesContractMonth(instr, DateTime.Now)) continue;
                }
                catch { }
                names.Add(instr.FullName);
            }
            names.Sort(StringComparer.OrdinalIgnoreCase);

            var sb = new StringBuilder("{\"symbols\":[");
            bool first = true;
            foreach (string name in names)
            {
                Instrument instr = null;
                try { instr = Instrument.GetInstrument(name); } catch { }
                string entry = BuildSymbolJson(instr);
                if (entry == null) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append(entry);
            }
            sb.Append(currentOnly ? "],\"currentOnly\":true,\"symbolCatalogVersion\":2}" : "]}");
            WriteJson(ns, 200, sb.ToString());
        }

        private static bool IsCurrentContractSearch(Dictionary<string, string> q)
        {
            string value;
            return q != null && q.TryGetValue("currentOnly", out value)
                && (value == "1" || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase));
        }

        private static Instrument[] GetCurrentContractCatalog(DateTime now)
        {
            var result = new Dictionary<string, Instrument>(StringComparer.OrdinalIgnoreCase);
            Instrument[] instruments;
            lock (Instrument.All) instruments = Instrument.All.ToArray();
            foreach (var instr in instruments)
                if (instr != null && instr.MasterInstrument != null
                    && instr.MasterInstrument.InstrumentType != InstrumentType.Future)
                    result[instr.FullName] = instr;

            MasterInstrument[] masters;
            lock (MasterInstrument.All) masters = MasterInstrument.All.ToArray();
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var master in masters)
            {
                if (master == null || string.IsNullOrWhiteSpace(master.Name)
                    || master.InstrumentType != InstrumentType.Future || !visited.Add(master.Name)) continue;
                var current = GetCurrentContract(master, now);
                if (current != null) result[current.FullName] = current;
            }
            return result.Values.OrderBy(i => i.FullName, StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static Instrument GetCurrentContract(MasterInstrument master, DateTime now)
        {
            try
            {
                if (master == null || master.InstrumentType != InstrumentType.Future) return null;
                DateTime month;
                lock (master.RolloverCollection) month = master.GetNextExpiry(now);
                if (month <= Core.Globals.MinDate || month >= Core.Globals.MaxDate) return null;
                // Follow NT8's configured rollover schedule. Do not infer the lead month
                // from calendar proximity or select a different expiry by its name.
                var current = Instrument.GetInstrument(master.Name + " " + month.ToString("MM-yy", CultureInfo.InvariantCulture));
                if (current == null || current.MasterInstrument == null
                    || !string.Equals(current.MasterInstrument.Name, master.Name, StringComparison.OrdinalIgnoreCase)
                    || current.MasterInstrument.InstrumentType != InstrumentType.Future
                    || current.Expiry.Year != month.Year || current.Expiry.Month != month.Month) return null;
                return current;
            }
            catch { return null; }
        }

        private static bool IsPastFuturesContractMonth(Instrument instr, DateTime now)
        {
            // NT8 Expiry 表示期货合约月份,不是最后交易日;如 09-26 的值可为 9 月 1 日。
            // 保留整个当月,避免月初就把仍可查看/交易的当月合约从候选列表删除。
            if (instr.MasterInstrument.InstrumentType != InstrumentType.Future) return false;
            DateTime expiry = instr.Expiry;
            return expiry > Core.Globals.MinDate && expiry < new DateTime(now.Year, now.Month, 1);
        }

        // 按名称解析任意 NT8 合约,供前端搜索框直接输入的合约使用
        // 返回的 symbol 一律是 NT8 FullName(如 "NQ SEP26"),前端直接采用,不做名称转换
        private void HandleResolve(NetworkStream ns, Dictionary<string, string> q)
        {
            string symbol;
            if (!q.TryGetValue("symbol", out symbol) || string.IsNullOrWhiteSpace(symbol))
            { WriteJson(ns, 400, "{\"error\":\"missing symbol\"}"); return; }

            Instrument instr = null;
            try { instr = Instrument.GetInstrument(symbol); } catch { }
            bool currentOnly = IsCurrentContractSearch(q);
            if (currentOnly && instr != null && instr.MasterInstrument != null
                && instr.MasterInstrument.InstrumentType == InstrumentType.Future)
            {
                var current = GetCurrentContract(instr.MasterInstrument, DateTime.Now);
                bool rootOnly = string.Equals(symbol.Trim(), instr.MasterInstrument.Name, StringComparison.OrdinalIgnoreCase);
                if (current == null || (!rootOnly && !string.Equals(instr.FullName, current.FullName, StringComparison.OrdinalIgnoreCase)))
                { WriteJson(ns, 404, "{\"error\":\"not the current NT8 contract\"}"); return; }
                instr = current;
            }
            string entry = BuildSymbolJson(instr, currentOnly);
            if (entry == null) { WriteJson(ns, 404, "{\"error\":\"unknown symbol\"}"); return; }
            WriteJson(ns, 200, entry);
        }

        private static string BuildSymbolJson(Instrument instr, bool currentOnly = false)
        {
            if (instr == null) return null;

            double tick = 0.01;
            double pointValue = 1;
            string desc = instr.FullName;
            string type = "futures";
            try
            {
                tick = instr.MasterInstrument.TickSize;
                pointValue = instr.MasterInstrument.PointValue;
                if (!string.IsNullOrEmpty(instr.MasterInstrument.Description))
                    desc = instr.MasterInstrument.Description;
                type = instr.MasterInstrument.InstrumentType == InstrumentType.Forex ? "forex" : "futures";
            }
            catch { }

            return "{\"symbol\":" + JsonQuote(instr.FullName)
                 + ",\"name\":" + JsonQuote(desc)
                 + ",\"tickSize\":" + tick.ToString("R", CultureInfo.InvariantCulture)
                 + ",\"pointValue\":" + pointValue.ToString("R", CultureInfo.InvariantCulture)
                 + ",\"type\":" + JsonQuote(type)
                 + (currentOnly ? ",\"currentOnly\":true" : string.Empty)
                 + "}";
        }

        private void HandleHistory(NetworkStream ns, Dictionary<string, string> q)
        {
            string symbol;
            if (!q.TryGetValue("symbol", out symbol) || string.IsNullOrWhiteSpace(symbol))
            { WriteJson(ns, 400, "{\"error\":\"missing symbol\"}"); return; }

            int intervalSec = q.ContainsKey("interval") ? ParseInt(q["interval"], 60) : 60;
            long fromUnix = q.ContainsKey("from") ? ParseLong(q["from"], 0) : 0;
            long toUnix = q.ContainsKey("to") ? ParseLong(q["to"], 0) : 0;

            Instrument instr = Instrument.GetInstrument(symbol);
            if (instr == null) { WriteJson(ns, 404, "{\"error\":\"unknown symbol\"}"); return; }

            DateTime from = FromUnix(fromUnix);
            DateTime to = toUnix > 0 ? FromUnix(Math.Min(toUnix, ToUnix(DateTime.Now))) : DateTime.Now;
            if (intervalSec <= 0 || fromUnix < 0 || (toUnix > 0 && fromUnix > toUnix))
            { WriteJson(ns, 400, "{\"error\":\"invalid history range or interval\"}"); return; }
            if (from > to) { WriteJson(ns, 200, "{\"bars\":[]}"); return; }

            BarsPeriod bp = BuildBarsPeriod(intervalSec);
            var tcs = new TaskCompletionSource<Bars>(TaskCreationOptions.RunContinuationsAsynchronously);

            // BarsRequest 按本地交易日截到午夜。覆盖两端会话后再按原窗口过滤,
            // 否则同一自然日的 8h 请求可能返回 0 根,而宽窗能取到完整 481 根。
            using (var request = new BarsRequest(instr, from.Date.AddDays(-1), to.Date.AddDays(1)) { BarsPeriod = bp })
            {
                // 回调第一个参数是 BarsRequest 本身,取 bar 要用 req.Bars
                request.Request((req, errorCode, errorMessage) =>
                {
                    if (errorCode == ErrorCode.NoError) tcs.TrySetResult(req.Bars);
                    else tcs.TrySetException(new Exception(errorMessage ?? "BarsRequest failed"));
                });

                Bars result = null;
                try
                {
                    if (tcs.Task.Wait(TimeSpan.FromSeconds(20)))
                        result = tcs.Task.Result;
                }
                catch (Exception ex)
                {
                    WriteJson(ns, 502, "{\"error\":" + JsonQuote("NT8 history: " + ex.GetBaseException().Message) + "}");
                    return;
                }
                if (result == null) { WriteJson(ns, 504, "{\"error\":\"history timeout or request failed\"}"); return; }

                var sb = new StringBuilder("{\"bars\":[");
                int count = 0;
                try { count = result.Count; } catch { }
                // NT8 BarsRequest 按整天/会话取整,可能返回请求区间之外的 bar;
                // 严格过滤到 [from,to]:图表库校验 "returned data should be in the
                // requested range" 失败会升级为全量更新并反复重试(超量下载根因)
                long fromU = ToUnix(from);
                long toU = ToUnix(to);
                bool firstBar = true;
                long lastWritten = -1;
                for (int i = 0; i < count; i++)
                {
                    long bt = BarStartUnix(result, i, intervalSec);
                    if (bt < fromU || bt > toU) continue;
                    if (!firstBar) sb.Append(',');
                    firstBar = false;
                    lastWritten = bt;
                    sb.Append("{\"time\":").Append(bt.ToString(CultureInfo.InvariantCulture))
                      .Append(",\"open\":").Append(F(result.GetOpen(i)))
                      .Append(",\"high\":").Append(F(result.GetHigh(i)))
                      .Append(",\"low\":").Append(F(result.GetLow(i)))
                      .Append(",\"close\":").Append(F(result.GetClose(i)))
                      .Append(",\"volume\":").Append(result.GetVolume(i).ToString(CultureInfo.InvariantCulture))
                      .Append("}");
                }
                sb.Append("]}");
                // 历史末根 bar 时间登记为地平线:随后的实时流帧不得早于它
                if (lastWritten > 0)
                {
                    string floorKey = instr.FullName + "|" + intervalSec;
                    historyFloor.AddOrUpdate(floorKey, lastWritten,
                        (_, old) => Math.Max(old, lastWritten));
                }
                WriteJson(ns, 200, sb.ToString());
            }
        }

        // SSE 实时流:订阅逐笔成交,聚合成 intervalSec 周期的当前 bar,每个 tick 推送一次
        private void HandleStream(TcpClient client, NetworkStream ns, Dictionary<string, string> q)
        {
            string symbol;
            if (!q.TryGetValue("symbol", out symbol) || string.IsNullOrWhiteSpace(symbol))
            { WriteJson(ns, 400, "{\"error\":\"missing symbol\"}"); return; }
            int intervalSec = q.ContainsKey("interval") ? ParseInt(q["interval"], 60) : 60;

            Instrument instr = Instrument.GetInstrument(symbol);
            if (instr == null) { WriteJson(ns, 404, "{\"error\":\"unknown symbol\"}"); return; }

            WriteRaw(ns, "HTTP/1.1 200 OK\r\n" +
                         "Content-Type: text/event-stream; charset=utf-8\r\n" +
                         "Cache-Control: no-cache\r\n" + CorsHeaders() +
                         "Connection: close\r\n\r\n");

            var session = new StreamSession(instr, intervalSec, ns);
            lock (streamLock) streamSessions.Add(session);
            try { session.Run(); }   // 阻塞直到客户端断开
            finally
            {
                lock (streamLock) streamSessions.Remove(session);
                session.Dispose();
            }
        }

        private class StreamSession : IDisposable
        {
            private readonly Instrument instrument;
            private readonly int intervalSec;
            private readonly NetworkStream ns;
            private readonly object sync = new object();

            private long bucket = -1;
            private double open, high, low, close;
            private long volume;
            // >=2h 周期疑似跨桶时置位,由 Run 循环向 NT8 确认真实新桶
            private volatile bool rolloverPending;
            private long lastRefreshAttempt;
            private volatile bool dead;

            public StreamSession(Instrument instr, int intervalSec, NetworkStream ns)
            {
                instrument = instr;
                this.intervalSec = intervalSec;
                this.ns = ns;

                // 先用 BarsRequest 拉当前周期最后一根 bar 做种子:
                // 1) 桶锚点与 /api/history 完全一致;2) OHLC/成交量是真实累计值,
                //    开盘价不会被"订阅时刻的最近成交价"伪造
                SeedFromHistory();

                // NT8 正确写法:MarketData 是属性,订阅其 Update 事件;
                // 官方建议在 instrument 自己的 Dispatcher 线程上订阅
                if (instrument.Dispatcher != null && !instrument.Dispatcher.HasShutdownStarted)
                    instrument.Dispatcher.InvokeAsync(() => instrument.MarketData.Update += OnMarketData);
                else
                    instrument.MarketData.Update += OnMarketData;

                // 直接推送 NT8 的真实种子。休市期间不能把陈旧 Last 伪装成当前 tick。
                lock (sync) { if (bucket >= 0) WriteFrameLocked(); }
            }

            // 同步拉取当前周期最后一根 bar 作为种子;失败则退回 epoch 网格的旧行为
            private void SeedFromHistory()
            {
                try
                {
                    DateTime now = DateTime.Now;
                    var tcs = new TaskCompletionSource<Bars>(TaskCreationOptions.RunContinuationsAsynchronously);
                    using (var req = new BarsRequest(instrument, now.AddSeconds(-10.0 * intervalSec).Date.AddDays(-1), now.Date.AddDays(1))
                        { BarsPeriod = BuildBarsPeriod(intervalSec) })
                    {
                        req.Request((r, ec, em) =>
                        {
                            if (ec == ErrorCode.NoError) tcs.TrySetResult(r.Bars);
                            else tcs.TrySetException(new Exception(em ?? "BarsRequest failed"));
                        });
                        if (!tcs.Task.Wait(TimeSpan.FromSeconds(10))) return;
                        Bars bars = tcs.Task.Result;
                        int n = bars != null ? bars.Count : 0;
                        if (n <= 0) return;
                        lock (sync)
                        {
                            // 末根是未收盘 bar,OHLCV 用它的值,时间换算成左端点
                            bucket = BarStartUnix(bars, n - 1, intervalSec);
                            open = bars.GetOpen(n - 1);
                            high = bars.GetHigh(n - 1);
                            low = bars.GetLow(n - 1);
                            close = bars.GetClose(n - 1);
                            volume = bars.GetVolume(n - 1);
                        }
                    }
                }
                catch { }
            }

            // 在 NT 行情线程上回调,绝不能向外抛异常;断连只打标记
            private void OnMarketData(object sender, MarketDataEventArgs e)
            {
                if (e.MarketDataType != MarketDataType.Last || dead) return;
                EmitTick(e.Time, e.Price, e.Volume);
            }

            private void EmitTick(DateTime time, double price, long tickVolume)
            {
                if (dead) return;

                lock (sync)
                {
                    long t = ToUnix(time);
                    if (bucket >= 0 && t < bucket) return;   // 乱序旧 tick,丢弃

                    if (bucket < 0)
                    {
                        // 无种子(SeedFromHistory 失败):退回 epoch 网格;
                        // 早于历史末根 bar 的帧直接丢弃,避免 time order violation
                        long b = t / intervalSec * intervalSec;
                        if (b < HistoryFloor(instrument.FullName, intervalSec)) return;
                        bucket = b;
                        open = high = low = close = price;
                        volume = 0;
                    }
                    else if (t - bucket >= intervalSec)
                    {
                        if (intervalSec > 3600)
                        {
                            // >=2h 周期 NT8 按会话锚定,桶间距不固定(跨 1h 休市的
                            // bar 时长不等,如 4h 网格里有一根 5h bar),不能用固定
                            // 网格外推——会产生幻影桶。标记待刷新,由 Run 循环向 NT8
                            // 拉真实当前 bar;期间先按旧桶累计(休市段 tick 本属旧桶,
                            // 若确属新桶,刷新后 NT8 的真实 OHLC 会整体覆盖)
                            rolloverPending = true;
                        }
                        else
                        {
                            // <=1h 网格均匀,直接外推
                            bucket = t / intervalSec * intervalSec;
                            open = high = low = close = price;
                            volume = 0;
                        }
                    }
                    close = price;
                    if (price > high) high = price;
                    if (price < low) low = price;
                    volume += tickVolume;
                    WriteFrameLocked();
                }
            }

            // 用当前累积值写一帧;调用方必须已持有 sync
            private void WriteFrameLocked()
            {
                if (bucket < HistoryFloor(instrument.FullName, intervalSec)) return;
                string frame = "data: {\"time\":" + bucket.ToString(CultureInfo.InvariantCulture)
                    + ",\"open\":" + F(open) + ",\"high\":" + F(high)
                    + ",\"low\":" + F(low) + ",\"close\":" + F(close)
                    + ",\"volume\":" + volume.ToString(CultureInfo.InvariantCulture)
                    + "}\n\n";
                try { WriteRaw(ns, frame); }
                catch { dead = true; }
            }

            // >=2h 周期疑似跨桶时,向 NT8 拉取真实当前 bar 并整体采用
            // (桶边界以 NT8 为准,顺便修正休市/DST 造成的任何漂移)
            private void RefreshCurrentBar()
            {
                rolloverPending = false;
                long nowU = ToUnix(DateTime.Now);
                if (nowU - lastRefreshAttempt < 15) return;   // 限流:失败/未换桶时 15s 一次
                lastRefreshAttempt = nowU;
                try
                {
                    DateTime now = DateTime.Now;
                    var tcs = new TaskCompletionSource<Bars>(TaskCreationOptions.RunContinuationsAsynchronously);
                    using (var req = new BarsRequest(instrument, now.AddSeconds(-10.0 * intervalSec).Date.AddDays(-1), now.Date.AddDays(1))
                        { BarsPeriod = BuildBarsPeriod(intervalSec) })
                    {
                        req.Request((r, ec, em) =>
                        {
                            if (ec == ErrorCode.NoError) tcs.TrySetResult(r.Bars);
                            else tcs.TrySetException(new Exception(em ?? "BarsRequest failed"));
                        });
                        if (!tcs.Task.Wait(TimeSpan.FromSeconds(10))) return;
                        Bars bars = tcs.Task.Result;
                        int n = bars != null ? bars.Count : 0;
                        if (n <= 0) return;
                        lock (sync)
                        {
                            // 末根是未收盘 bar,OHLCV 用它的值,时间换算成左端点
                            bucket = BarStartUnix(bars, n - 1, intervalSec);
                            open = bars.GetOpen(n - 1);
                            high = bars.GetHigh(n - 1);
                            low = bars.GetLow(n - 1);
                            close = bars.GetClose(n - 1);
                            volume = bars.GetVolume(n - 1);
                            WriteFrameLocked();   // 立即推一帧,让图表换到/修正当前 bar
                        }
                    }
                }
                catch { }
            }

            public void Run()
            {
                // 保活:每秒检查断连标记与跨桶刷新,每 15 秒发注释行
                // (借写失败检测静默断开)
                int ticks = 0;
                while (!dead)
                {
                    Thread.Sleep(1000);
                    if (rolloverPending) RefreshCurrentBar();
                    if (++ticks < 15) continue;
                    ticks = 0;
                    lock (sync)
                    {
                        try { WriteRaw(ns, ": ping\n\n"); }
                        catch { dead = true; }
                    }
                }
            }

            public void Dispose()
            {
                try
                {
                    if (instrument.Dispatcher != null && !instrument.Dispatcher.HasShutdownStarted)
                        instrument.Dispatcher.InvokeAsync(() => instrument.MarketData.Update -= OnMarketData);
                    else
                        instrument.MarketData.Update -= OnMarketData;
                }
                catch { }
            }
        }

        // ---------------- 交易接口 ----------------

        private Account FindAccount(string name)
        {
            Account acc;
            lock (Account.All)
                acc = Account.All.FirstOrDefault(a => a.Name == name);
            // 找到即订阅:外部连接账户未订阅时 Positions/Orders 恒为空
            if (acc != null) EnsureSubscribed(acc);
            return acc;
        }

        private static bool IsWorkingState(OrderState s)
        {
            return s == OrderState.Working || s == OrderState.Accepted || s == OrderState.Submitted
                || s == OrderState.PartFilled || s == OrderState.TriggerPending || s == OrderState.Suspended
                || s == OrderState.AcceptedByRisk || s == OrderState.Initialized
                || s == OrderState.ChangePending || s == OrderState.ChangeSubmitted
                || s == OrderState.CancelPending || s == OrderState.CancelSubmitted;
        }

        private static Order FindOrder(Account acc, string orderId)
        {
            Order[] snapshot;
            try { snapshot = acc.Orders.ToArray(); } catch { return null; }
            return snapshot.FirstOrDefault(o => o.OrderId == orderId);
        }

        private void HandleAccounts(NetworkStream ns)
        {
            Account[] accounts;
            lock (Account.All) accounts = Account.All.ToArray();
            // 只下发"活"账户:连接处于 Connected,或 NT8 内置仿真账户。
            // Account.All 会残留已关闭/已断开连接的账户,不下发,避免面板账户列表越积越多
            accounts = accounts.Where(acc =>
            {
                if (BuiltinAccounts.Contains(acc.Name)) return true;
                try { return acc.Connection != null && acc.Connection.Status == ConnectionStatus.Connected; }
                catch { return false; }
            }).ToArray();
            var sb = new StringBuilder("{\"accounts\":[");
            bool first = true;
            foreach (var acc in accounts)
            {
                // 列表下发即订阅,持仓/订单数据流随即激活
                EnsureSubscribed(acc);
                string conn = string.Empty;
                try
                {
                    if (acc.Connection != null && acc.Connection.Options != null)
                        conn = acc.Connection.Options.Name;
                }
                catch { }
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":").Append(JsonQuote(acc.Name))
                  .Append(",\"connection\":").Append(JsonQuote(conn));

                // 账户财务(旧版桥没有这些字段,前端按缺失容错):
                // 现金/净清算/已实现盈亏来自 AccountItem;未实现盈亏按持仓逐个用最新价算
                try
                {
                    Currency cur = acc.Denomination;
                    double cash = acc.GetAccountItem(AccountItem.CashValue, cur).Value;
                    double netLiq = acc.GetAccountItem(AccountItem.NetLiquidation, cur).Value;
                    double realized = acc.GetAccountItem(AccountItem.RealizedProfitLoss, cur).Value;
                    double unrealized = 0;
                    try
                    {
                        foreach (var p in acc.Positions)
                        {
                            if (p == null || p.MarketPosition == MarketPosition.Flat) continue;
                            double last = 0;
                            try { last = p.Instrument.MarketData.Last.Price; } catch { }
                            if (last > 0)
                                unrealized += p.GetUnrealizedProfitLoss(PerformanceUnit.Currency, last);
                        }
                    }
                    catch { }
                    sb.Append(",\"currency\":").Append(JsonQuote(cur.ToString()))
                      .Append(",\"cashValue\":").Append(cash.ToString("F2", CultureInfo.InvariantCulture))
                      .Append(",\"netLiquidation\":").Append(netLiq.ToString("F2", CultureInfo.InvariantCulture))
                      .Append(",\"realizedPnl\":").Append(realized.ToString("F2", CultureInfo.InvariantCulture))
                      .Append(",\"unrealizedPnl\":").Append(unrealized.ToString("F2", CultureInfo.InvariantCulture));
                }
                catch { /* 财务数据不可用时只回名称/连接 */ }

                sb.Append("}");
            }
            sb.Append("]}");
            WriteJson(ns, 200, sb.ToString());
        }

        // GET /api/debug -> 自助排障:列出全部账户及其连接状态/持仓数/订单数/读取异常。
        // 迁移部署后持仓不显示时,让对方浏览器直接打开 http://127.0.0.1:8090/api/debug 看原始状态
        private void HandleDebug(NetworkStream ns)
        {
            Account[] all;
            lock (Account.All) all = Account.All.ToArray();

            var sb = new StringBuilder();
            sb.Append("{\"ntTime\":").Append(JsonQuote(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")))
              .Append(",\"connections\":[");
            bool first = true;
            try
            {
                if (Connection.Connections != null)
                    foreach (var c in Connection.Connections)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        string cname = "";
                        try { if (c.Options != null) cname = c.Options.Name; } catch { }
                        sb.Append("{\"name\":").Append(JsonQuote(cname))
                          .Append(",\"status\":").Append(JsonQuote(c.Status.ToString()))
                          .Append("}");
                    }
            }
            catch { }
            sb.Append("],\"accounts\":[");
            first = true;
            foreach (var acc in all)
            {
                string conn = "", connStatus = "", posErr = "", ordErr = "";
                int posTotal = -1, posOpen = -1, ordTotal = -1, ordWorking = -1;
                try
                {
                    if (acc.Connection != null)
                    {
                        if (acc.Connection.Options != null) conn = acc.Connection.Options.Name;
                        connStatus = acc.Connection.Status.ToString();
                    }
                }
                catch { }
                try
                {
                    Position[] ps = acc.Positions.ToArray();
                    posTotal = ps.Length;
                    posOpen = ps.Count(p => p != null && p.MarketPosition != MarketPosition.Flat);
                }
                catch (Exception ex) { posErr = ex.Message; }
                try
                {
                    Order[] os = acc.Orders.ToArray();
                    ordTotal = os.Length;
                    ordWorking = os.Count(o => o != null && IsWorkingState(o.OrderState));
                }
                catch (Exception ex) { ordErr = ex.Message; }

                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":").Append(JsonQuote(acc.Name))
                  .Append(",\"connection\":").Append(JsonQuote(conn))
                  .Append(",\"connectionStatus\":").Append(JsonQuote(connStatus))
                  .Append(",\"builtin\":").Append(BuiltinAccounts.Contains(acc.Name) ? "true" : "false")
                  .Append(",\"positionsTotal\":").Append(posTotal)
                  .Append(",\"positionsOpen\":").Append(posOpen)
                  .Append(",\"ordersTotal\":").Append(ordTotal)
                  .Append(",\"ordersWorking\":").Append(ordWorking);
                if (posErr.Length > 0) sb.Append(",\"positionsError\":").Append(JsonQuote(posErr));
                if (ordErr.Length > 0) sb.Append(",\"ordersError\":").Append(JsonQuote(ordErr));
                sb.Append("}");
            }
            sb.Append("]}");
            WriteJson(ns, 200, sb.ToString());
        }

        private void HandlePositions(NetworkStream ns, Dictionary<string, string> q)
        {
            string accName;
            if (!q.TryGetValue("account", out accName)) { WriteJson(ns, 400, "{\"error\":\"missing account\"}"); return; }
            Account acc = FindAccount(accName);
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }

            Position[] snapshot;
            try { snapshot = acc.Positions.ToArray(); }
            catch (Exception ex)
            {
                snapshot = new Position[0];
                NinjaTrader.Code.Output.Process(
                    "TvBridgeAddOn 读取持仓失败(" + accName + "): " + ex.Message, PrintTo.OutputTab1);
            }

            var sb = new StringBuilder("{\"positions\":[");
            bool first = true;
            var emitted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in snapshot)
            {
                if (p.MarketPosition == MarketPosition.Flat) continue;
                long signed = p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity;
                if (!first) sb.Append(',');
                first = false;
                emitted.Add(p.Instrument.FullName);
                sb.Append("{\"instrument\":").Append(JsonQuote(p.Instrument.FullName))
                  .Append(",\"quantity\":").Append(signed.ToString(CultureInfo.InvariantCulture))
                  .Append(",\"averagePrice\":").Append(F(p.AveragePrice))
                  .Append(",\"marketPosition\":").Append(JsonQuote(p.MarketPosition.ToString()))
                  .Append("}");
            }
            // 兜底:订阅后由 PositionUpdate 事件维护的缓存(Positions 集合仍为空时救命)
            lock (positionCache)
            {
                string prefix = acc.Name + "|";
                foreach (var kv in positionCache)
                {
                    if (!kv.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                    string instrName = kv.Key.Substring(prefix.Length);
                    if (emitted.Contains(instrName)) continue;
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"instrument\":").Append(JsonQuote(instrName))
                      .Append(",\"quantity\":").Append(kv.Value.Quantity.ToString(CultureInfo.InvariantCulture))
                      .Append(",\"averagePrice\":").Append(F(kv.Value.AveragePrice))
                      .Append(",\"marketPosition\":").Append(JsonQuote(kv.Value.MarketPosition ?? ""))
                      .Append("}");
                }
            }
            sb.Append("]}");
            WriteJson(ns, 200, sb.ToString());
        }

        private void HandleOrders(NetworkStream ns, Dictionary<string, string> q)
        {
            string accName;
            if (!q.TryGetValue("account", out accName)) { WriteJson(ns, 400, "{\"error\":\"missing account\"}"); return; }
            Account acc = FindAccount(accName);
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }

            Order[] snapshot;
            try { snapshot = acc.Orders.ToArray(); }
            catch (Exception ex)
            {
                snapshot = new Order[0];
                NinjaTrader.Code.Output.Process(
                    "TvBridgeAddOn 读取订单失败(" + accName + "): " + ex.Message, PrintTo.OutputTab1);
            }

            DateTime cutoff = DateTime.Now.AddHours(-6);
            var list = snapshot
                .Where(o => IsWorkingState(o.OrderState) || o.Time > cutoff)
                .OrderByDescending(o => o.Time)
                .Take(60)
                .ToList();

            var sb = new StringBuilder("{\"orders\":[");
            bool first = true;
            foreach (var o in list)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"orderId\":").Append(JsonQuote(o.OrderId ?? ""))
                  .Append(",\"instrument\":").Append(JsonQuote(o.Instrument != null ? o.Instrument.FullName : ""))
                  .Append(",\"action\":").Append(JsonQuote(o.OrderAction.ToString()))
                  .Append(",\"orderType\":").Append(JsonQuote(o.OrderType.ToString()))
                  .Append(",\"quantity\":").Append(o.Quantity.ToString(CultureInfo.InvariantCulture))
                  .Append(",\"filled\":").Append(o.Filled.ToString(CultureInfo.InvariantCulture))
                  .Append(",\"limitPrice\":").Append(F(o.LimitPrice))
                  .Append(",\"stopPrice\":").Append(F(o.StopPrice))
                  .Append(",\"averageFillPrice\":").Append(F(o.AverageFillPrice))
                  .Append(",\"state\":").Append(JsonQuote(o.OrderState.ToString()))
                  .Append(",\"oco\":").Append(JsonQuote(o.Oco ?? ""))
                  .Append(",\"name\":").Append(JsonQuote(o.Name ?? ""))
                  .Append(",\"time\":").Append(ToUnix(o.Time).ToString(CultureInfo.InvariantCulture))
                  .Append("}");
            }
            sb.Append("]}");
            WriteJson(ns, 200, sb.ToString());
        }

        // BEGIN EXECUTION_ARCHIVE (also compiled by the isolated journal regression runner)
        private sealed class ArchivedExecution
        {
            public string Account, Instrument, ExecutionId, OrderId, Side, Currency;
            public long Time, TimeTicks;
            public int Quantity;
            public double Price;
            public double? Commission, PointValue;

            public string Key
            {
                get { return Account.ToUpperInvariant() + "\n" + ExecutionId; }
            }

            private static string Encode(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")); }
            private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
            private static string Number(double? value) { return value.HasValue ? value.Value.ToString("R", CultureInfo.InvariantCulture) : ""; }
            private static double? ReadNumber(string value)
            {
                if (value.Length == 0) return null;
                double result = double.Parse(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(result) || double.IsInfinity(result)) throw new FormatException("Invalid number");
                return result;
            }

            public string Payload()
            {
                return string.Join("\t", new[] { "1", Encode(Account), Encode(Instrument), Encode(ExecutionId), Encode(OrderId),
                    Side, Time.ToString(CultureInfo.InvariantCulture), TimeTicks.ToString(CultureInfo.InvariantCulture),
                    Quantity.ToString(CultureInfo.InvariantCulture), Price.ToString("R", CultureInfo.InvariantCulture),
                    Number(Commission), Number(PointValue), Encode(Currency) });
            }

            private static string Checksum(string payload)
            {
                using (var sha = SHA256.Create())
                    return Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(payload)));
            }

            public string JournalLine() { string payload = Payload(); return payload + "\t" + Checksum(payload); }

            public static ArchivedExecution Read(string line)
            {
                int split = line.LastIndexOf('\t');
                if (split < 0) throw new FormatException("Missing checksum");
                string payload = line.Substring(0, split);
                if (!string.Equals(Checksum(payload), line.Substring(split + 1), StringComparison.Ordinal))
                    throw new FormatException("Checksum mismatch");
                string[] parts = payload.Split('\t');
                if (parts.Length != 13 || parts[0] != "1") throw new FormatException("Unknown journal version");
                var record = new ArchivedExecution {
                    Account = Decode(parts[1]), Instrument = Decode(parts[2]), ExecutionId = Decode(parts[3]), OrderId = Decode(parts[4]),
                    Side = parts[5], Time = long.Parse(parts[6], CultureInfo.InvariantCulture), TimeTicks = long.Parse(parts[7], CultureInfo.InvariantCulture),
                    Quantity = int.Parse(parts[8], CultureInfo.InvariantCulture), Price = ReadNumber(parts[9]) ?? double.NaN,
                    Commission = ReadNumber(parts[10]), PointValue = ReadNumber(parts[11]), Currency = Decode(parts[12])
                };
                if (record.Account.Length == 0 || record.ExecutionId.Length == 0 || record.Quantity <= 0 || double.IsNaN(record.Price)
                    || (record.Side != "Buy" && record.Side != "Sell" && record.Side != "Unknown")) throw new FormatException("Invalid execution");
                return record;
            }

            public string Json()
            {
                return "{\"account\":" + JsonQuote(Account) + ",\"instrument\":" + JsonQuote(Instrument)
                    + ",\"executionId\":" + JsonQuote(ExecutionId) + ",\"orderId\":" + JsonQuote(OrderId)
                    + ",\"time\":" + Time.ToString(CultureInfo.InvariantCulture)
                    + ",\"timeMs\":" + F((TimeTicks - 621355968000000000L) / 10000.0) + ",\"price\":" + F(Price)
                    + ",\"qty\":" + Quantity.ToString(CultureInfo.InvariantCulture) + ",\"side\":" + JsonQuote(Side)
                    + ",\"commission\":" + (Commission.HasValue ? F(Commission.Value) : "null")
                    + ",\"pointValue\":" + (PointValue.HasValue ? F(PointValue.Value) : "null")
                    + ",\"currency\":" + JsonQuote(Currency) + "}";
            }
        }

        private sealed class ExecutionJournal
        {
            public readonly string Path;
            private readonly object gate = new object();
            private readonly Dictionary<string, ArchivedExecution> records = new Dictionary<string, ArchivedExecution>(StringComparer.Ordinal);
            private readonly Dictionary<string, ArchivedExecution> dirty = new Dictionary<string, ArchivedExecution>(StringComparer.Ordinal);
            public volatile bool Loaded;
            public string Error = "", Warning = "";
            public long LastSavedAt;

            public ExecutionJournal(string path) { Path = path; }

            public bool Load()
            {
                if (Loaded) return true;
                try
                {
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path));
                    int invalid = 0;
                    if (File.Exists(Path))
                        using (var stream = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                        using (var reader = new StreamReader(stream, Encoding.UTF8))
                        {
                            string line;
                            while ((line = reader.ReadLine()) != null)
                            {
                                if (line.Length == 0) continue;
                                try
                                {
                                    var row = ArchivedExecution.Read(line);
                                    lock (gate) records[row.Key] = row;
                                }
                                catch (FormatException) { invalid++; }
                                catch (OverflowException) { invalid++; }
                            }
                        }
                    Warning = invalid == 0 ? "" : "成交归档中有 " + invalid + " 条不完整或校验失败的记录；原始内容保留，其他记录已恢复。";
                    if (File.Exists(Path)) LastSavedAt = ToUnix(File.GetLastWriteTimeUtc(Path));
                    Error = "";
                    Loaded = true;
                    return true;
                }
                catch (Exception ex) { Error = "读取成交归档失败: " + ex.Message; return false; }
            }

            public void Upsert(ArchivedExecution row)
            {
                lock (gate)
                {
                    ArchivedExecution previous;
                    if (records.TryGetValue(row.Key, out previous))
                    {
                        // An early event may omit details. Later execution/commission updates enrich the same fill.
                        // A zero commission is a real value and can correct an earlier nonzero commission.
                        if (!row.Commission.HasValue) row.Commission = previous.Commission;
                        if (!row.PointValue.HasValue) row.PointValue = previous.PointValue;
                        if (string.IsNullOrEmpty(row.Currency)) row.Currency = previous.Currency;
                        if (string.IsNullOrEmpty(row.Instrument)) row.Instrument = previous.Instrument;
                        if (string.IsNullOrEmpty(row.OrderId)) row.OrderId = previous.OrderId;
                        if (row.Side == "Unknown" && previous.Side != "Unknown") row.Side = previous.Side;
                        if (previous.Payload() == row.Payload()) return;
                    }
                    records[row.Key] = row;
                    dirty[row.Key] = row;
                }
            }

            public ArchivedExecution[] Snapshot() { lock (gate) return records.Values.ToArray(); }
            public int Count { get { lock (gate) return records.Count; } }
            public int PendingCount { get { lock (gate) return dirty.Count; } }

            public bool Flush()
            {
                if (!Loaded) return false;
                ArchivedExecution[] batch;
                lock (gate) batch = dirty.Values.ToArray();
                if (batch.Length == 0) return true;
                try
                {
                    using (var stream = new FileStream(Path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read))
                    {
                        // Preserve crash-damaged bytes; separate the next valid record without truncating history.
                        if (stream.Length > 0)
                        {
                            stream.Seek(-1, SeekOrigin.End);
                            if (stream.ReadByte() != '\n') stream.WriteByte((byte)'\n');
                        }
                        stream.Seek(0, SeekOrigin.End);
                        foreach (var row in batch)
                        {
                            byte[] bytes = Encoding.UTF8.GetBytes(row.JournalLine() + "\n");
                            stream.Write(bytes, 0, bytes.Length);
                        }
                        stream.Flush(true);
                    }
                    lock (gate)
                        foreach (var row in batch)
                        {
                            ArchivedExecution current;
                            if (dirty.TryGetValue(row.Key, out current) && ReferenceEquals(current, row)) dirty.Remove(row.Key);
                        }
                    LastSavedAt = ToUnix(DateTime.UtcNow);
                    Error = "";
                    return true;
                }
                catch (Exception ex)
                {
                    // Retain the whole batch for retry. Repeated valid lines are idempotent on restart.
                    Error = "保存成交归档失败，待保存记录仍保留在内存并自动重试: " + ex.Message;
                    return false;
                }
            }
        }
        // END EXECUTION_ARCHIVE

        private ExecutionJournal executionJournal;
        private readonly ConcurrentQueue<ArchivedExecution> executionQueue = new ConcurrentQueue<ArchivedExecution>();
        private readonly AutoResetEvent executionWake = new AutoResetEvent(false);
        private Thread executionThread;
        private volatile bool executionArchiveRunning;
        private string executionCaptureError = "", executionScanError = "";

        private void StartExecutionArchive()
        {
            if (executionArchiveRunning) return;
            executionJournal = new ExecutionJournal(System.IO.Path.Combine(Core.Globals.UserDataDir, "TvBridge", "executions-v1.log"));
            executionArchiveRunning = true;
            executionThread = new Thread(ExecutionArchiveLoop) { IsBackground = true, Name = "TvBridgeExecutions" };
            executionThread.Start();
        }

        private void StopExecutionArchive()
        {
            executionArchiveRunning = false;
            executionWake.Set();
            if (executionThread != null && !executionThread.Join(5000))
                NinjaTrader.Code.Output.Process("TvBridge: 成交归档仍在完成磁盘写入。", PrintTo.OutputTab1);
            if (executionJournal != null && (executionJournal.PendingCount > 0 || !executionQueue.IsEmpty))
                NinjaTrader.Code.Output.Process("TvBridge: 成交归档存在尚未保存的数据。" + executionJournal.Error, PrintTo.OutputTab1);
        }

        private void CaptureExecution(Account account, Execution execution)
        {
            if (account == null || execution == null || !executionArchiveRunning) return;
            try
            {
                // Execution.MarketPosition describes the fill direction, not the resulting account position.
                // A sell closing a long is Short; do not invert it based on IsEntry.
                string side = "Unknown";
                if (execution.Order != null)
                {
                    var action = execution.Order.OrderAction;
                    if (action == OrderAction.Buy || action == OrderAction.BuyToCover) side = "Buy";
                    else if (action == OrderAction.Sell || action == OrderAction.SellShort) side = "Sell";
                }
                if (side == "Unknown")
                {
                    if (execution.MarketPosition == MarketPosition.Long) side = "Buy";
                    else if (execution.MarketPosition == MarketPosition.Short) side = "Sell";
                }
                var row = new ArchivedExecution {
                    Account = account.Name, Instrument = execution.Instrument == null ? "" : execution.Instrument.FullName,
                    ExecutionId = execution.ExecutionId ?? "", OrderId = execution.OrderId ?? "", Side = side,
                    Time = ToUnix(execution.Time), TimeTicks = execution.Time.ToUniversalTime().Ticks,
                    Quantity = execution.Quantity, Price = execution.Price, Currency = ""
                };
                if (row.Quantity <= 0) return;
                if (double.IsNaN(row.Price) || double.IsInfinity(row.Price)) throw new InvalidOperationException("Invalid execution price");
                try { double commission = execution.Commission; if (!double.IsNaN(commission) && !double.IsInfinity(commission)) row.Commission = commission; } catch { }
                try { double pointValue = execution.Instrument.MasterInstrument.PointValue; if (pointValue > 0 && !double.IsInfinity(pointValue)) row.PointValue = pointValue; } catch { }
                try { row.Currency = NormalizeCurrency(account.Denomination.ToString()); } catch { }
                if (row.ExecutionId.Length == 0)
                    row.ExecutionId = "fallback:" + row.OrderId + ":" + row.Instrument + ":" + row.TimeTicks.ToString(CultureInfo.InvariantCulture)
                        + ":" + row.Side + ":" + row.Quantity.ToString(CultureInfo.InvariantCulture) + ":" + F(row.Price);
                executionQueue.Enqueue(row);
                executionWake.Set();
            }
            catch (Exception ex) { executionCaptureError = "采集成交失败(" + account.Name + "): " + ex.Message; }
        }

        private static string NormalizeCurrency(string currency)
        {
            switch (currency)
            {
                case "UsDollar": return "USD";
                case "Euro": return "EUR";
                case "BritishPound": return "GBP";
                case "JapaneseYen": return "JPY";
                case "CanadianDollar": return "CAD";
                case "AustralianDollar": return "AUD";
                case "SwissFranc": return "CHF";
                case "HongKongDollar": return "HKD";
                case "NewZealandDollar": return "NZD";
                default: return currency;
            }
        }

        private void DiscoverExecutionAccounts()
        {
            try
            {
                Account[] accounts;
                lock (Account.All) accounts = Account.All.ToArray();
                var errors = new List<string>();
                foreach (var account in accounts)
                {
                    try
                    {
                        EnsureSubscribed(account);
                        // During a disk read failure keep subscribing to new events, but do not enqueue
                        // the same entire account snapshot every retry and grow the queue without bound.
                        if (!executionJournal.Loaded) continue;
                        Execution[] snapshot;
                        lock (account.Executions) snapshot = account.Executions.ToArray();
                        foreach (var execution in snapshot) CaptureExecution(account, execution);
                    }
                    catch (Exception ex) { errors.Add(account.Name + ": " + ex.Message); }
                }
                executionScanError = string.Join("; ", errors);
            }
            catch (Exception ex) { executionScanError = "扫描账户成交失败: " + ex.Message; }
        }

        private void ExecutionArchiveLoop()
        {
            DateTime nextScan = DateTime.MinValue;
            string reportedError = "";
            while (executionArchiveRunning)
            {
                if (DateTime.UtcNow >= nextScan)
                {
                    DiscoverExecutionAccounts();
                    nextScan = DateTime.UtcNow.AddSeconds(5);
                }
                bool previouslyLoaded = executionJournal.Loaded;
                if (executionJournal.Load())
                {
                    if (!previouslyLoaded) nextScan = DateTime.MinValue;
                    ArchivedExecution record;
                    while (executionQueue.TryDequeue(out record)) executionJournal.Upsert(record);
                    executionJournal.Flush();
                }
                string currentError = executionJournal.Error + executionCaptureError + executionScanError;
                if (currentError.Length > 0 && currentError != reportedError)
                    NinjaTrader.Code.Output.Process("TvBridge 成交归档: " + currentError, PrintTo.OutputTab1);
                reportedError = currentError;
                executionWake.WaitOne(executionJournal.Error.Length > 0 ? 2000 : 250);
            }
            if (executionJournal.Load())
            {
                ArchivedExecution record;
                while (executionQueue.TryDequeue(out record)) executionJournal.Upsert(record);
                executionJournal.Flush();
            }
        }

        private string ExecutionArchiveStatusJson()
        {
            var journal = executionJournal;
            string error = string.Join("; ", new[] { journal == null ? "" : journal.Error, executionCaptureError, executionScanError }.Where(e => e.Length > 0));
            return "{\"version\":1,\"state\":" + JsonQuote(error.Length > 0 ? "error" : journal != null && journal.Loaded ? "ready" : "loading")
                + ",\"path\":" + JsonQuote(journal == null ? "" : journal.Path)
                + ",\"recordCount\":" + (journal == null ? 0 : journal.Count).ToString(CultureInfo.InvariantCulture)
                + ",\"pendingCount\":" + ((journal == null ? 0 : journal.PendingCount) + executionQueue.Count).ToString(CultureInfo.InvariantCulture)
                + ",\"lastSavedAt\":" + (journal == null ? 0 : Interlocked.Read(ref journal.LastSavedAt)).ToString(CultureInfo.InvariantCulture)
                + ",\"error\":" + JsonQuote(error) + ",\"warning\":" + JsonQuote(journal == null ? "" : journal.Warning) + "}";
        }

        // account/symbol are optional, including accounts no longer connected to NT8.
        // Paged responses are newest first; legacy chart requests keep the latest 200 in ascending order.
        private void HandleExecutions(NetworkStream ns, Dictionary<string, string> q)
        {
            string accName = Get(q, "account"), symbol = Get(q, "symbol");
            long fromU = q.ContainsKey("from") ? ParseLong(q["from"], 0) : 0;
            long toU = q.ContainsKey("to") ? ParseLong(q["to"], long.MaxValue) : long.MaxValue;

            ArchivedExecution[] snapshot = executionJournal == null ? new ArchivedExecution[0] : executionJournal.Snapshot();
            var filtered = snapshot.Where(e => (accName.Length == 0 || string.Equals(e.Account, accName, StringComparison.OrdinalIgnoreCase))
                && (symbol.Length == 0 || e.Instrument == symbol) && e.Time >= fromU && e.Time <= toU).ToArray();
            bool paged = q.ContainsKey("offset") || q.ContainsKey("limit");
            int offset = Math.Max(0, ParseInt(Get(q, "offset"), 0));
            int limit = Math.Max(1, Math.Min(500, ParseInt(Get(q, "limit"), 100)));
            var list = paged
                ? filtered.OrderByDescending(e => e.TimeTicks).ThenBy(e => e.Account, StringComparer.Ordinal).ThenBy(e => e.ExecutionId, StringComparer.Ordinal).Skip(offset).Take(limit)
                : filtered.OrderBy(e => e.TimeTicks).ThenBy(e => e.Account, StringComparer.Ordinal).ThenBy(e => e.ExecutionId, StringComparer.Ordinal).Skip(Math.Max(0, filtered.Length - 200));

            var sb = new StringBuilder("{\"executions\":[");
            bool first = true;
            foreach (var e in list)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(e.Json());
            }
            sb.Append("],\"total\":").Append(filtered.Length);
            if (paged)
                sb.Append(",\"nextOffset\":").Append((long)offset + limit < filtered.Length ? (offset + limit).ToString(CultureInfo.InvariantCulture) : "null");
            sb.Append(",\"archive\":").Append(ExecutionArchiveStatusJson()).Append("}");
            WriteJson(ns, 200, sb.ToString());
        }

        // GET /api/brackets?account= -> 待触发括号单(入场单未成交时,止盈/止损价只存在于本注册表)
        private void HandleBrackets(NetworkStream ns, Dictionary<string, string> q)
        {
            string accName;
            if (!q.TryGetValue("account", out accName)) { WriteJson(ns, 400, "{\"error\":\"missing account\"}"); return; }

            var sb = new StringBuilder("{\"brackets\":[");
            lock (bracketLock)
            {
                bool first = true;
                foreach (var kv in pendingBrackets)
                {
                    if (accName.Length > 0 && kv.Value.Acc.Name != accName) continue;
                    if (!IsWorkingState(kv.Key.OrderState)) continue;
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"entryOrderId\":").Append(JsonQuote(kv.Value.Entry.OrderId ?? ""))
                      .Append(",\"instrument\":").Append(JsonQuote(kv.Value.Instrument ?? ""))
                      .Append(",\"tp\":").Append(F(kv.Value.Tp))
                      .Append(",\"sl\":").Append(F(kv.Value.Sl))
                      .Append("}");
                }
            }
            string syncError;
            protectionErrors.TryGetValue(accName, out syncError);
            sb.Append("],\"syncError\":").Append(JsonQuote(syncError ?? "")).Append("}");
            WriteJson(ns, 200, sb.ToString());
        }

        // POST {account, symbol, action:BUY|SELL, orderType:MARKET|LIMIT|STOPMARKET|STOPLIMIT,
        //       quantity, limitPrice, stopPrice, tif:DAY|GTC,
        //       tp/sl(止盈/止损绝对价,可选),
        //       tpAmount/slAmount(止盈/止损金额$,可选,市价单用——成交后按实际均价换算目标价)}
        private void HandlePlaceOrder(NetworkStream ns, string body)
        {
            var d = ParseFlatJson(body);
            Account acc = FindAccount(Get(d, "account"));
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }
            Instrument instr = Instrument.GetInstrument(Get(d, "symbol"));
            if (instr == null) { WriteJson(ns, 404, "{\"error\":\"unknown symbol\"}"); return; }

            string action = Get(d, "action").ToUpperInvariant();
            OrderAction oa = action == "BUY" ? OrderAction.Buy : OrderAction.Sell;
            if (action != "BUY" && action != "SELL") { WriteJson(ns, 400, "{\"error\":\"bad action\"}"); return; }

            OrderType ot;
            switch (Get(d, "orderType").ToUpperInvariant())
            {
                case "MARKET": ot = OrderType.Market; break;
                case "LIMIT": ot = OrderType.Limit; break;
                case "STOPMARKET": ot = OrderType.StopMarket; break;
                case "STOPLIMIT": ot = OrderType.StopLimit; break;
                default: WriteJson(ns, 400, "{\"error\":\"bad orderType\"}"); return;
            }

            int qty = (int)ParseDouble(Get(d, "quantity"), 0);
            if (qty <= 0) { WriteJson(ns, 400, "{\"error\":\"bad quantity\"}"); return; }
            double limitPrice = ParseDouble(Get(d, "limitPrice"), 0);
            double stopPrice = ParseDouble(Get(d, "stopPrice"), 0);
            double tp = ParseDouble(Get(d, "tp"), 0);
            double sl = ParseDouble(Get(d, "sl"), 0);
            // 金额模式(草稿市价单):成交价未知,成交后按实际均价换算止盈/止损价
            double tpAmount = ParseDouble(Get(d, "tpAmount"), 0);
            double slAmount = ParseDouble(Get(d, "slAmount"), 0);
            TimeInForce tif = Get(d, "tif").ToUpperInvariant() == "DAY" ? TimeInForce.Day : TimeInForce.Gtc;

            if ((ot == OrderType.Limit || ot == OrderType.StopLimit) && limitPrice <= 0)
            { WriteJson(ns, 400, "{\"error\":\"limit order needs limitPrice\"}"); return; }
            if ((ot == OrderType.StopMarket || ot == OrderType.StopLimit) && stopPrice <= 0)
            { WriteJson(ns, 400, "{\"error\":\"stop order needs stopPrice\"}"); return; }

            Order entry = acc.CreateOrder(instr, oa, ot, OrderEntry.Manual, tif, qty,
                limitPrice, stopPrice, string.Empty, "TV Entry", Core.Globals.MaxDate, null);
            if (entry == null) { WriteJson(ns, 500, "{\"error\":\"CreateOrder failed\"}"); return; }

            // 有止盈/止损价(或金额)时,等入场单完全成交后自动挂 OCO 括号单
            if (tp > 0 || sl > 0 || tpAmount > 0 || slAmount > 0)
                RegisterBracketOnFill(acc, instr, oa, qty, tp, sl, tpAmount, slAmount, entry, tif);

            acc.Submit(new[] { entry });
            WriteJson(ns, 200, "{\"ok\":true,\"orderId\":" + JsonQuote(entry.OrderId ?? "") + "}");
        }

        // 入场单成交后自动挂 OCO 止盈(限价)+ 止损(市价止损)。
        // tp/sl 为绝对价(LMT/STP 场景);tpAmount/slAmount 为美元金额(MKT 场景),
        // 金额模式在成交瞬间取实际成交均价换算目标价,保证金额风险不受滑点影响
        // Register before Submit using the Order object: some providers assign/change OrderId on submission.
        private void RegisterBracketOnFill(Account acc, Instrument instr, OrderAction entryAction,
            int qty, double tp, double sl, double tpAmount, double slAmount, Order entry, TimeInForce tif)
        {
            lock (bracketLock)
                pendingBrackets[entry] = new PendingBracket { Acc = acc, Entry = entry,
                    Instrument = instr.FullName, Tp = tp, Sl = sl, TpAmount = tpAmount, SlAmount = slAmount };
        }

        private static bool IsManagedProtection(Order o)
        {
            return o != null && !string.IsNullOrEmpty(o.Oco) && (o.Name == "TV TP" || o.Name == "TV SL");
        }

        // One worker per account. NT8 callbacks can arrive in different orders; wait for the current
        // event batch, then read the latest position. A subsequent event always schedules another pass.
        private void QueueProtectionSync(Account acc)
        {
            lock (bracketLock)
            {
                long rev;
                protectionRevisions.TryGetValue(acc, out rev);
                protectionRevisions[acc] = rev + 1;
                if (!protectionWorkers.Add(acc)) return;
            }
            Task.Run(async () =>
            {
                while (running)
                {
                    await Task.Delay(75);
                    if (!running) break;
                    long revision;
                    lock (bracketLock) revision = protectionRevisions[acc];
                    try { ReconcileProtection(acc); }
                    catch (Exception ex)
                    {
                        protectionErrors[acc.Name] = "止盈止损数量同步失败: " + ex.GetBaseException().Message;
                        NinjaTrader.Code.Output.Process("TvBridge " + protectionErrors[acc.Name], PrintTo.OutputTab1);
                    }
                    lock (bracketLock)
                    {
                        if (protectionRevisions[acc] != revision) continue;
                        protectionWorkers.Remove(acc);
                        return;
                    }
                }
                lock (bracketLock) protectionWorkers.Remove(acc);
            });
        }

        private void ReconcileProtection(Account acc)
        {
            Order[] snapshot;
            Position[] positions;
            lock (acc.Orders) snapshot = acc.Orders.ToArray();
            lock (acc.Positions) positions = acc.Positions.ToArray();
            var quantities = new Dictionary<string, int>();
            lock (positionCache)
                foreach (var kv in positionCache)
                    if (kv.Key.StartsWith(acc.Name + "|", StringComparison.Ordinal))
                        quantities[kv.Key.Substring(acc.Name.Length + 1)] = kv.Value.Quantity;
            foreach (var p in positions)
                if (p.Instrument != null)
                    quantities[p.Instrument.FullName] = p.MarketPosition == MarketPosition.Flat ? 0
                        : p.Quantity * (p.MarketPosition == MarketPosition.Long ? 1 : -1);

            var managed = snapshot.Where(o => IsManagedProtection(o) && IsWorkingState(o.OrderState)).ToList();
            PendingBracket[] pending;
            lock (bracketLock) pending = pendingBrackets.Values.Where(p => p.Acc == acc).ToArray();
            foreach (var p in pending)
            {
                int signed;
                quantities.TryGetValue(p.Instrument, out signed);
                int direction = p.Entry.OrderAction == OrderAction.Buy ? 1 : -1;
                if (!p.Activated && p.Entry.Filled > 0 && signed * direction > 0)
                {
                    // Existing protection keeps its prices when adding to a position, including
                    // entries with another bracket preset. Do not create a second full-size OCO pair.
                    bool covered = managed.Any(o => o.Instrument.FullName == p.Instrument
                        && (o.OrderAction == OrderAction.Buy ? -1 : 1) == direction
                        && o.OrderState != OrderState.CancelPending && o.OrderState != OrderState.CancelSubmitted);
                    if (!covered)
                    {
                        var instr = p.Entry.Instrument;
                        double fill = p.Entry.AverageFillPrice;
                        double pv = instr.MasterInstrument.PointValue;
                        double tp = p.Tp, sl = p.Sl;
                        if (pv <= 0 || fill <= 0) throw new Exception("无法读取入场均价/合约点值");
                        if (p.TpAmount > 0) tp = instr.MasterInstrument.RoundToTickSize(fill + direction * p.TpAmount / (pv * p.Entry.Quantity));
                        if (p.SlAmount > 0) sl = instr.MasterInstrument.RoundToTickSize(fill - direction * p.SlAmount / (pv * p.Entry.Quantity));
                        string oco = "tv" + Guid.NewGuid().ToString("N");
                        OrderAction exit = direction > 0 ? OrderAction.Sell : OrderAction.Buy;
                        var created = new List<Order>();
                        if (tp > 0) created.Add(acc.CreateOrder(instr, exit, OrderType.Limit, OrderEntry.Manual,
                            p.Entry.TimeInForce, Math.Abs(signed), tp, 0, oco, "TV TP", Core.Globals.MaxDate, null));
                        if (sl > 0) created.Add(acc.CreateOrder(instr, exit, OrderType.StopMarket, OrderEntry.Manual,
                            p.Entry.TimeInForce, Math.Abs(signed), 0, sl, oco, "TV SL", Core.Globals.MaxDate, null));
                        if (created.Any(o => o == null)) throw new Exception("CreateOrder 创建保护单失败");
                        // Mark before submission to prevent retries from duplicating an accepted leg.
                        p.Activated = true;
                        if (created.Count > 0) acc.Submit(created.ToArray());
                        managed.AddRange(created);
                    }
                    else p.Activated = true;
                }
                if (!IsWorkingState(p.Entry.OrderState) && (p.Activated || p.Entry.Filled == 0
                    || (p.PositionObserved && signed * direction <= 0)))
                    lock (bracketLock) pendingBrackets.Remove(p.Entry);
            }

            foreach (var instrumentOrders in managed.GroupBy(o => o.Instrument.FullName))
            {
                int signed;
                quantities.TryGetValue(instrumentOrders.Key, out signed);
                var matching = new List<Order>();
                foreach (var o in instrumentOrders)
                {
                    int protectedDirection = o.OrderAction == OrderAction.Buy ? -1 : 1;
                    if (signed == 0 || Math.Sign(signed) != protectedDirection)
                    {
                        if (o.OrderState != OrderState.CancelPending && o.OrderState != OrderState.CancelSubmitted)
                            acc.Cancel(new[] { o });
                    }
                    else matching.Add(o);
                }
                var groups = matching.GroupBy(o => o.Oco).OrderBy(g => g.Key, StringComparer.Ordinal).ToArray();
                if (groups.Length == 0) continue;
                // Each OCO pair covers its allocated slice. TP and SL are alternatives, not additive.
                var weights = groups.Select(g => g.Max(o => Math.Max(0, o.Quantity - o.Filled))).ToArray();
                int total = weights.Sum();
                if (total <= 0) continue;
                int target = Math.Abs(signed);
                var exact = weights.Select(w => (double)w * target / total).ToArray();
                var allocations = exact.Select(x => (int)Math.Floor(x)).ToArray();
                int extra = target - allocations.Sum();
                foreach (int i in Enumerable.Range(0, groups.Length).OrderByDescending(i => exact[i] - allocations[i]).Take(extra))
                    allocations[i]++;
                for (int i = 0; i < groups.Length; i++)
                {
                    var changes = new List<Order>();
                    foreach (var o in groups[i])
                    {
                        if (o.OrderState != OrderState.Working && o.OrderState != OrderState.Accepted && o.OrderState != OrderState.PartFilled) continue;
                        if (allocations[i] == 0) { acc.Cancel(new[] { o }); continue; }
                        int desired = o.Filled + allocations[i]; // QuantityChanged is TOTAL, including filled contracts.
                        if (o.Quantity == desired) continue;
                        o.QuantityChanged = desired;
                        o.LimitPriceChanged = o.LimitPrice;
                        o.StopPriceChanged = o.StopPrice;
                        changes.Add(o);
                    }
                    if (changes.Count > 0) acc.Change(changes.ToArray());
                }
            }
        }


        // POST {account, orderId}
        private void HandleCancelOrder(NetworkStream ns, string body)
        {
            var d = ParseFlatJson(body);
            Account acc = FindAccount(Get(d, "account"));
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }
            Order order = FindOrder(acc, Get(d, "orderId"));
            if (order == null) { WriteJson(ns, 404, "{\"error\":\"unknown order\"}"); return; }
            acc.Cancel(new[] { order });
            WriteJson(ns, 200, "{\"ok\":true}");
        }

        // POST {account, orderId, limitPrice?, stopPrice?} —— 拖拽改价
        private void HandleChangeOrder(NetworkStream ns, string body)
        {
            var d = ParseFlatJson(body);
            Account acc = FindAccount(Get(d, "account"));
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }
            Order order = FindOrder(acc, Get(d, "orderId"));
            if (order == null) { WriteJson(ns, 404, "{\"error\":\"unknown order\"}"); return; }

            double limitPrice = ParseDouble(Get(d, "limitPrice"), 0);
            double stopPrice = ParseDouble(Get(d, "stopPrice"), 0);
            // AddOn 层改单必须写 *Changed 属性(直接改 LimitPrice/StopPrice 会被静默忽略)
            if (limitPrice > 0) order.LimitPriceChanged = limitPrice;
            if (stopPrice > 0) order.StopPriceChanged = stopPrice;
            // OCO 括号子单(TP/SL)不改数量时,NT8 校验会拿 QuantityChanged=0 报
            // "order quantity can't be less than 1" —— 显式带上原数量规避
            try { if (order.Quantity > 0) order.QuantityChanged = order.Quantity; } catch { }
            try
            {
                NinjaTrader.Code.Output.Process(
                    string.Format("TvBridge Change: id={0} state={1} qty={2} filled={3} limitChanged={4} stopChanged={5}",
                        order.OrderId, order.OrderState, order.Quantity, order.Filled, limitPrice, stopPrice),
                    PrintTo.OutputTab1);
                acc.Change(new[] { order });
                WriteJson(ns, 200, "{\"ok\":true}");
            }
            catch (Exception ex)
            {
                WriteJson(ns, 500, "{\"error\":" + JsonQuote("change failed: " + ex.Message) + "}");
            }
        }

        // POST {account, symbol} —— 平仓:先撤该合约全部工作中订单(含 OCO 止盈止损),再反向市价平仓
        private void HandleClosePosition(NetworkStream ns, string body)
        {
            var d = ParseFlatJson(body);
            Account acc = FindAccount(Get(d, "account"));
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }
            string symbol = Get(d, "symbol");

            Position[] positions;
            try { positions = acc.Positions.ToArray(); } catch { positions = new Position[0]; }
            Position pos = positions.FirstOrDefault(p =>
                p.MarketPosition != MarketPosition.Flat &&
                p.Instrument != null && p.Instrument.FullName == symbol);
            if (pos == null) { WriteJson(ns, 404, "{\"error\":\"no position\"}"); return; }

            Order[] orders;
            try { orders = acc.Orders.ToArray(); } catch { orders = new Order[0]; }
            var working = orders.Where(o =>
                o.Instrument != null && o.Instrument.FullName == symbol && IsWorkingState(o.OrderState)).ToArray();
            if (working.Length > 0) acc.Cancel(working);

            OrderAction closeAction = pos.MarketPosition == MarketPosition.Long ? OrderAction.Sell : OrderAction.Buy;
            Order close = acc.CreateOrder(pos.Instrument, closeAction, OrderType.Market, OrderEntry.Manual,
                TimeInForce.Day, pos.Quantity, 0, 0, string.Empty, "TV Close", Core.Globals.MaxDate, null);
            if (close == null) { WriteJson(ns, 500, "{\"error\":\"CreateOrder failed\"}"); return; }
            acc.Submit(new[] { close });
            WriteJson(ns, 200, "{\"ok\":true}");
        }

        // 简单扁平 JSON 解析(仅支持 "key":"value" 或 "key":数字,满足本项目受控入参)
        private static Dictionary<string, string> ParseFlatJson(string json)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(json)) return d;
            foreach (Match m in Regex.Matches(json,
                "\"([^\"]+)\"\\s*:\\s*(\"([^\"]*)\"|-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?|true|false|null)"))
            {
                d[m.Groups[1].Value] = m.Groups[3].Success ? m.Groups[3].Value : m.Groups[2].Value;
            }
            return d;
        }

        private static string Get(Dictionary<string, string> d, string key)
        {
            string v; return d.TryGetValue(key, out v) ? v : string.Empty;
        }

        private static double ParseDouble(string s, double dflt)
        {
            double v;
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : dflt;
        }

        // ---------------- 工具方法 ----------------

        private static BarsPeriod BuildBarsPeriod(int intervalSec)
        {
            if (intervalSec < 60)
                return new BarsPeriod { BarsPeriodType = BarsPeriodType.Second, Value = intervalSec, BaseBarsPeriodType = BarsPeriodType.Second, BaseBarsPeriodValue = intervalSec };
            if (intervalSec % 604800 == 0)
            {
                int v = intervalSec / 604800;
                return new BarsPeriod { BarsPeriodType = BarsPeriodType.Week, Value = v, BaseBarsPeriodType = BarsPeriodType.Week, BaseBarsPeriodValue = v };
            }
            if (intervalSec % 86400 == 0)
            {
                int v = intervalSec / 86400;
                return new BarsPeriod { BarsPeriodType = BarsPeriodType.Day, Value = v, BaseBarsPeriodType = BarsPeriodType.Day, BaseBarsPeriodValue = v };
            }
            int m = Math.Max(1, intervalSec / 60);
            return new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = m, BaseBarsPeriodType = BarsPeriodType.Minute, BaseBarsPeriodValue = m };
        }

        private static long ToUnix(DateTime t)
        {
            if (t.Kind == DateTimeKind.Unspecified) t = DateTime.SpecifyKind(t, DateTimeKind.Local);
            return new DateTimeOffset(t.ToUniversalTime()).ToUnixTimeSeconds();
        }

        private static DateTime FromUnix(long unix)
        {
            return DateTimeOffset.FromUnixTimeSeconds(unix).LocalDateTime;
        }

        private static int ParseInt(string s, int dflt) { int v; return int.TryParse(s, out v) ? v : dflt; }
        private static long ParseLong(string s, long dflt) { long v; return long.TryParse(s, out v) ? v : dflt; }

        private static string F(double d)
        {
            return d.ToString("R", CultureInfo.InvariantCulture);
        }

        private static string JsonQuote(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append("\"").ToString();
        }

        private static string CorsHeaders()
        {
            return "Access-Control-Allow-Origin: *\r\n";
        }

        private static void WriteJson(NetworkStream ns, int statusCode, string body)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body);
            string statusText = statusCode == 200 ? "OK" : statusCode == 204 ? "No Content" : "Error";
            string head = string.Format(
                "HTTP/1.1 {0} {1}\r\nContent-Type: application/json; charset=utf-8\r\n{2}Content-Length: {3}\r\nConnection: close\r\n\r\n",
                statusCode, statusText, CorsHeaders(), payload.Length);
            WriteRaw(ns, head);
            ns.Write(payload, 0, payload.Length);
            ns.Flush();
        }

        private static void WriteRaw(NetworkStream ns, string text)
        {
            byte[] payload = Encoding.UTF8.GetBytes(text);
            ns.Write(payload, 0, payload.Length);
            ns.Flush();
        }
    }
}
