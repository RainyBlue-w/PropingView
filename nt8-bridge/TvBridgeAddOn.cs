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

        // 自选股列表(NT8 合约名)。改成你实际订阅行情的合约。
        // 注意合约到期月:到期后这里需要换成新的主力合约(前端图表里也可直接输入任意合约名)。
        private static readonly string[] Watchlist =
        {
            "ES 09-26",   // E-mini 标普500
            "MES 09-26",  // 微型标普500
            "NQ 09-26",   // E-mini 纳指100
            "MNQ 09-26",  // 微型纳指100
            "GC 12-26",   // 黄金
            "MGC 12-26",  // 微型黄金
            "CL 10-26",   // WTI 原油(月度合约,注意换月)
            "6E 09-26",   // 欧元外汇期货
        };
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
        }
        private readonly object bracketLock = new object();
        private readonly Dictionary<string, PendingBracket> pendingBrackets =
            new Dictionary<string, PendingBracket>();

        // 每个 合约|周期 /api/history 已返回的最新 bar 时间(unix 秒):
        // 实时流不得发出比这更早的帧(库会报 "time order violation" 并丢弃)。
        // 注意只登记历史值、实时帧绝不回写:外推失误产生的幻影桶若写回,
        // 会永久抬高地平线,之后所有新会话都被钳到幻影桶上
        private static readonly ConcurrentDictionary<string, long> historyFloor =
            new ConcurrentDictionary<string, long>();

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
                StartServer();
            }
            else if (State == State.Terminated)
            {
                StopServer();
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
                        case "/api/symbols": HandleSymbols(ns);  break;
                        case "/api/resolve": HandleResolve(ns, q); break;
                        case "/api/history": HandleHistory(ns, q); break;
                        // ---- 交易接口 ----
                        case "/api/accounts":  HandleAccounts(ns);   break;
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
                + "\"time\":" + ToUnix(DateTime.Now).ToString(CultureInfo.InvariantCulture)
                + "}";
            WriteJson(ns, 200, json);
        }

        private void HandleSymbols(NetworkStream ns)
        {
            var sb = new StringBuilder("{\"symbols\":[");
            bool first = true;
            foreach (string name in Watchlist)
            {
                string entry = BuildSymbolJson(name);
                if (entry == null) continue;   // NT8 中不存在的合约跳过
                if (!first) sb.Append(',');
                first = false;
                sb.Append(entry);
            }
            sb.Append("]}");
            WriteJson(ns, 200, sb.ToString());
        }

        // 按名称解析任意 NT8 合约,供前端搜索框直接输入的合约使用(无需改 Watchlist)
        private void HandleResolve(NetworkStream ns, Dictionary<string, string> q)
        {
            string symbol;
            if (!q.TryGetValue("symbol", out symbol) || string.IsNullOrWhiteSpace(symbol))
            { WriteJson(ns, 400, "{\"error\":\"missing symbol\"}"); return; }

            string entry = BuildSymbolJson(symbol);
            if (entry == null) { WriteJson(ns, 404, "{\"error\":\"unknown symbol\"}"); return; }
            WriteJson(ns, 200, entry);
        }

        private static string BuildSymbolJson(string name)
        {
            Instrument instr = null;
            try { instr = Instrument.GetInstrument(name); } catch { }
            if (instr == null) return null;

            double tick = 0.01;
            double pointValue = 1;
            string desc = name;
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

            return "{\"symbol\":" + JsonQuote(name)
                 + ",\"name\":" + JsonQuote(desc)
                 + ",\"tickSize\":" + tick.ToString("R", CultureInfo.InvariantCulture)
                 + ",\"pointValue\":" + pointValue.ToString("R", CultureInfo.InvariantCulture)
                 + ",\"type\":" + JsonQuote(type)
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
            DateTime to = toUnix > 0 ? FromUnix(toUnix) : DateTime.Now;

            BarsPeriod bp = BuildBarsPeriod(intervalSec);
            var tcs = new TaskCompletionSource<Bars>(TaskCreationOptions.RunContinuationsAsynchronously);

            var request = new BarsRequest(instr, from, to) { BarsPeriod = bp };
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
            catch { result = null; }
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

                // 立即推送最近成交价更新当前 bar 的 close,避免切换合约后
                // 一直等下一笔 tick 才刷新(种子已就位,不会污染 open)
                // 用 DateTime.Now 而非 last.Time:陈旧成交时间会让快照 bar
                // 落后于图表已有 bar,触发 time order violation 被库丢弃
                try
                {
                    var last = instrument.MarketData.Last;
                    if (last != null && last.Price > 0)
                        EmitTick(DateTime.Now, last.Price, 0);
                }
                catch { }
            }

            // 同步拉取当前周期最后一根 bar 作为种子;失败则退回 epoch 网格的旧行为
            private void SeedFromHistory()
            {
                try
                {
                    DateTime now = DateTime.Now;
                    var tcs = new TaskCompletionSource<Bars>(TaskCreationOptions.RunContinuationsAsynchronously);
                    var req = new BarsRequest(instrument, now.AddSeconds(-10.0 * intervalSec), now)
                        { BarsPeriod = BuildBarsPeriod(intervalSec) };
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
                    var req = new BarsRequest(instrument, now.AddSeconds(-10.0 * intervalSec), now)
                        { BarsPeriod = BuildBarsPeriod(intervalSec) };
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

        private static Account FindAccount(string name)
        {
            lock (Account.All)
                return Account.All.FirstOrDefault(a => a.Name == name);
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
            var sb = new StringBuilder("{\"accounts\":[");
            bool first = true;
            foreach (var acc in accounts)
            {
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

        private void HandlePositions(NetworkStream ns, Dictionary<string, string> q)
        {
            string accName;
            if (!q.TryGetValue("account", out accName)) { WriteJson(ns, 400, "{\"error\":\"missing account\"}"); return; }
            Account acc = FindAccount(accName);
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }

            Position[] snapshot;
            try { snapshot = acc.Positions.ToArray(); } catch { snapshot = new Position[0]; }

            var sb = new StringBuilder("{\"positions\":[");
            bool first = true;
            foreach (var p in snapshot)
            {
                if (p.MarketPosition == MarketPosition.Flat) continue;
                long signed = p.MarketPosition == MarketPosition.Long ? p.Quantity : -p.Quantity;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"instrument\":").Append(JsonQuote(p.Instrument.FullName))
                  .Append(",\"quantity\":").Append(signed.ToString(CultureInfo.InvariantCulture))
                  .Append(",\"averagePrice\":").Append(F(p.AveragePrice))
                  .Append(",\"marketPosition\":").Append(JsonQuote(p.MarketPosition.ToString()))
                  .Append("}");
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
            try { snapshot = acc.Orders.ToArray(); } catch { snapshot = new Order[0]; }

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

        // GET /api/executions?account=&symbol=&from=&to= -> 成交历史(图上 marks 用)
        // NT8 的成交/订单记录存在本地数据库,默认永久保留(除非手动清库);
        // 这里按请求区间过滤,最多返回最近 200 条
        private void HandleExecutions(NetworkStream ns, Dictionary<string, string> q)
        {
            string accName;
            if (!q.TryGetValue("account", out accName)) { WriteJson(ns, 400, "{\"error\":\"missing account\"}"); return; }
            Account acc = FindAccount(accName);
            if (acc == null) { WriteJson(ns, 404, "{\"error\":\"unknown account\"}"); return; }

            string symbol = q.ContainsKey("symbol") ? q["symbol"] : "";
            long fromU = q.ContainsKey("from") ? ParseLong(q["from"], 0) : 0;
            long toU = q.ContainsKey("to") ? ParseLong(q["to"], long.MaxValue) : long.MaxValue;

            Execution[] snapshot;
            try { snapshot = acc.Executions.ToArray(); } catch { snapshot = new Execution[0]; }

            var filtered = new List<Execution>();
            foreach (var e in snapshot)
            {
                if (!string.IsNullOrEmpty(symbol) && (e.Instrument == null || e.Instrument.FullName != symbol)) continue;
                long t;
                try { t = ToUnix(e.Time); } catch { continue; }
                if (t < fromU || t > toU) continue;
                filtered.Add(e);
            }
            // 时间升序后取最近 200 条,防止超大区间撑爆响应
            var list = filtered.OrderBy(e => e.Time).Skip(Math.Max(0, filtered.Count - 200));

            var sb = new StringBuilder("{\"executions\":[");
            bool first = true;
            foreach (var e in list)
            {
                // 买卖方向:优先取订单动作;Order 缺失时由 入场/持仓方向 推断
                // (入场+多 / 出场+空 = Buy;入场+空 / 出场+多 = Sell)
                string side;
                try
                {
                    if (e.Order != null)
                        side = e.Order.OrderAction == OrderAction.Buy ? "Buy" : "Sell";
                    else
                        side = e.IsEntry == (e.MarketPosition == MarketPosition.Long) ? "Buy" : "Sell";
                }
                catch { side = "Buy"; }
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"time\":").Append(ToUnix(e.Time).ToString(CultureInfo.InvariantCulture))
                  .Append(",\"price\":").Append(F(e.Price))
                  .Append(",\"qty\":").Append(e.Quantity.ToString(CultureInfo.InvariantCulture))
                  .Append(",\"side\":").Append(JsonQuote(side))
                  .Append(",\"orderId\":").Append(JsonQuote(e.OrderId ?? ""))
                  .Append("}");
            }
            sb.Append("]}");
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
                // 先清理:入场单已成交(括号单已真正挂出)/撤销/拒绝的注册项
                var stale = new List<string>();
                foreach (var kv in pendingBrackets)
                {
                    Order o = null;
                    try { o = kv.Value.Acc.Orders.FirstOrDefault(x => x.OrderId == kv.Key); }
                    catch { }
                    if (o == null || !IsWorkingState(o.OrderState)) stale.Add(kv.Key);
                }
                foreach (var k in stale) pendingBrackets.Remove(k);

                bool first = true;
                foreach (var kv in pendingBrackets)
                {
                    if (accName.Length > 0 && kv.Value.Acc.Name != accName) continue;
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"entryOrderId\":").Append(JsonQuote(kv.Key))
                      .Append(",\"instrument\":").Append(JsonQuote(kv.Value.Instrument ?? ""))
                      .Append(",\"tp\":").Append(F(kv.Value.Tp))
                      .Append(",\"sl\":").Append(F(kv.Value.Sl))
                      .Append("}");
                }
            }
            sb.Append("]}");
            WriteJson(ns, 200, sb.ToString());
        }

        // POST {account, symbol, action:BUY|SELL, orderType:MARKET|LIMIT|STOPMARKET|STOPLIMIT,
        //       quantity, limitPrice, stopPrice, tif:DAY|GTC, tp(止盈价,可选), sl(止损价,可选)}
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
            TimeInForce tif = Get(d, "tif").ToUpperInvariant() == "DAY" ? TimeInForce.Day : TimeInForce.Gtc;

            if ((ot == OrderType.Limit || ot == OrderType.StopLimit) && limitPrice <= 0)
            { WriteJson(ns, 400, "{\"error\":\"limit order needs limitPrice\"}"); return; }
            if ((ot == OrderType.StopMarket || ot == OrderType.StopLimit) && stopPrice <= 0)
            { WriteJson(ns, 400, "{\"error\":\"stop order needs stopPrice\"}"); return; }

            Order entry = acc.CreateOrder(instr, oa, ot, OrderEntry.Manual, tif, qty,
                limitPrice, stopPrice, string.Empty, "TV Entry", Core.Globals.MaxDate, null);
            if (entry == null) { WriteJson(ns, 500, "{\"error\":\"CreateOrder failed\"}"); return; }

            // 有止盈/止损价时,等入场单完全成交后自动挂 OCO 括号单
            if (tp > 0 || sl > 0) RegisterBracketOnFill(acc, instr, oa, qty, tp, sl, entry, tif);

            acc.Submit(new[] { entry });
            WriteJson(ns, 200, "{\"ok\":true,\"orderId\":" + JsonQuote(entry.OrderId ?? "") + "}");
        }

        // 入场单成交后自动挂 OCO 止盈(限价)+ 止损(市价止损)
        private void RegisterBracketOnFill(Account acc, Instrument instr, OrderAction entryAction,
            int qty, double tp, double sl, Order entry, TimeInForce tif)
        {
            // 注册待触发括号单,供 /api/brackets 查询(入场单成交前止盈止损价只存在这里)
            lock (bracketLock)
            {
                pendingBrackets[entry.OrderId ?? ""] = new PendingBracket
                {
                    Acc = acc,
                    Instrument = instr != null ? instr.FullName : "",
                    Tp = tp,
                    Sl = sl,
                };
            }

            EventHandler<ExecutionEventArgs> handler = null;
            handler = (s, e) =>
            {
                try
                {
                    if (e.Execution == null || e.Execution.Order != entry) return;
                    if (e.Execution.Order.OrderState != OrderState.Filled) return;
                    acc.ExecutionUpdate -= handler;
                    lock (bracketLock) { pendingBrackets.Remove(entry.OrderId ?? ""); }

                    int filledQty = e.Execution.Order.Filled > 0 ? e.Execution.Order.Filled : qty;
                    OrderAction exit = entryAction == OrderAction.Buy ? OrderAction.Sell : OrderAction.Buy;
                    string oco = "tv" + DateTime.Now.ToString("HHmmssfff");
                    var bracket = new List<Order>();

                    if (tp > 0)
                    {
                        Order tpOrder = acc.CreateOrder(instr, exit, OrderType.Limit, OrderEntry.Manual,
                            tif, filledQty, tp, 0, oco, "TV TP", Core.Globals.MaxDate, null);
                        if (tpOrder != null) bracket.Add(tpOrder);
                    }
                    if (sl > 0)
                    {
                        Order slOrder = acc.CreateOrder(instr, exit, OrderType.StopMarket, OrderEntry.Manual,
                            tif, filledQty, 0, sl, oco, "TV SL", Core.Globals.MaxDate, null);
                        if (slOrder != null) bracket.Add(slOrder);
                    }
                    if (bracket.Count > 0) acc.Submit(bracket.ToArray());
                }
                catch (Exception ex)
                {
                    NinjaTrader.Code.Output.Process("TvBridgeAddOn 挂括号单失败: " + ex.Message, PrintTo.OutputTab1);
                }
            };
            acc.ExecutionUpdate += handler;
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
