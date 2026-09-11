$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$source = [IO.File]::ReadAllText((Join-Path $workspace 'nt8-bridge/TvBridgeAddOn.cs'))
$start = $source.IndexOf('        private void HandlePositions(')
$end = $source.IndexOf('        // BEGIN EXECUTION_ARCHIVE', $start)
$stateStart = $source.IndexOf('        private static bool IsWorkingState(')
$stateEnd = $source.IndexOf('        private static Order FindOrder(', $stateStart)
$cacheStart = $source.IndexOf('        private class CachedPosition')
$cacheEnd = $source.IndexOf('        private void EnsureSubscribed(', $cacheStart)
if (@($start, $end, $stateStart, $stateEnd, $cacheStart, $cacheEnd) | Where-Object { $_ -lt 0 }) {
    throw 'Cannot locate production snapshot methods'
}
$methods = $source.Substring($start, $end - $start) + $source.Substring($stateStart, $stateEnd - $stateStart) + $source.Substring($cacheStart, $cacheEnd - $cacheStart)
$directory = Join-Path $workspace '.tmp-webbridge/copy-snapshot-tests'
[IO.Directory]::CreateDirectory($directory) | Out-Null
$template = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

enum OrderState { Working, Accepted, Submitted, PartFilled, TriggerPending, Suspended, AcceptedByRisk, Initialized,
    ChangePending, ChangeSubmitted, CancelPending, CancelSubmitted, Filled, Cancelled, Rejected }
enum MarketPosition { Flat, Long, Short }
enum PrintTo { OutputTab1 }
class Instrument { public string FullName; }
class Position { public Instrument Instrument; public MarketPosition MarketPosition; public int Quantity; public double AveragePrice; }
class Order {
    public string OrderId, OrderAction = "Buy", OrderType = "Limit", Oco = "", Name = "Fixture";
    public Instrument Instrument;
    public OrderState OrderState;
    public int Quantity = 1, Filled = 0;
    public double LimitPrice = 100, StopPrice = 0, AverageFillPrice = 0;
    public DateTime Time;
}
class SnapshotCollection<T> : IEnumerable<T> {
    public bool ThrowOnRead;
    public List<T> Items = new List<T>();
    public IEnumerator<T> GetEnumerator() { if (ThrowOnRead) throw new InvalidOperationException("fixture snapshot unavailable"); return Items.GetEnumerator(); }
    IEnumerator IEnumerable.GetEnumerator() { return GetEnumerator(); }
}
class Account {
    public string Name = "Fixture";
    public SnapshotCollection<Order> Orders = new SnapshotCollection<Order>();
    public SnapshotCollection<Position> Positions = new SnapshotCollection<Position>();
}
namespace NinjaTrader.Code { static class Output { public static void Process(string value, PrintTo tab) { } } }
class SnapshotTests {
    readonly Account account = new Account();
    int status;
    string response;
    static int passed;
    Account FindAccount(string name) { return account.Name == name ? account : null; }
    void WriteJson(NetworkStream stream, int code, string body) { status = code; response = body; }
    static string JsonQuote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
    static string F(double value) { return value.ToString("R", CultureInfo.InvariantCulture); }
    static long ToUnix(DateTime value) { return (value.ToUniversalTime().Ticks - 621355968000000000L) / 10000000; }
    /* PRODUCTION_SNAPSHOTS */
    static void Check(bool condition, string description) {
        if (!condition) throw new Exception(description);
        passed++;
        Console.WriteLine("PASS " + description);
    }
    Dictionary<string, string> Query(bool strict) {
        var result = new Dictionary<string, string> { { "account", account.Name } };
        if (strict) result["copyStrict"] = "true";
        return result;
    }
    void Orders() {
        var nq = new Instrument { FullName = "NQ 09-26" };
        var pending = new[] { OrderState.Working, OrderState.Accepted, OrderState.Submitted, OrderState.PartFilled, OrderState.TriggerPending,
            OrderState.Suspended, OrderState.AcceptedByRisk, OrderState.Initialized, OrderState.ChangePending, OrderState.ChangeSubmitted,
            OrderState.CancelPending, OrderState.CancelSubmitted };
        account.Orders.Items = Enumerable.Range(0, 85).Select(i => new Order { OrderId = "work-" + i, Instrument = nq,
            Time = DateTime.Now.AddDays(-2).AddSeconds(i), OrderState = pending[i % pending.Length] }).ToList();
        account.Orders.Items.AddRange(Enumerable.Range(0, 10).Select(i => new Order { OrderId = "recent-terminal-" + i, Instrument = nq,
            Time = DateTime.Now.AddSeconds(-i), OrderState = OrderState.Filled }));
        account.Orders.Items.Add(new Order { OrderId = "old-terminal", Instrument = nq, Time = DateTime.Now.AddDays(-3), OrderState = OrderState.Cancelled });
        HandleOrders(null, Query(true));
        Check(status == 200 && Regex.Matches(response, "\"orderId\":").Count == 85, "strict orders include every working order beyond 60");
        Check(!response.Contains("terminal") && pending.All(state => response.Contains("\"state\":\"" + state + "\"")), "strict orders retain pending and partial states while excluding final orders");
        Check(response.Contains("\"copyStrict\":true"), "strict orders identify a complete snapshot");
        account.Orders.Items.Add(new Order { OrderId = "unknown-state", Instrument = nq, Time = DateTime.Now.AddDays(-4), OrderState = (OrderState)999 });
        HandleOrders(null, Query(true));
        Check(status == 200 && Regex.Matches(response, "\"orderId\":").Count == 86 && response.Contains("unknown-state")
            && response.Contains("\"state\":\"999\"") && response.Contains("\"copyStrict\":true"), "strict snapshots retain unknown order states instead of incorrectly reporting no pending order");
        HandleOrders(null, Query(false));
        Check(status == 200 && Regex.Matches(response, "\"orderId\":").Count == 60 && response.Contains("recent-terminal-") && !response.Contains("old-terminal"), "ordinary orders preserve the recent 60-row behavior");
        Check(!response.Contains("copyStrict"), "ordinary orders preserve the legacy response shape");
        account.Orders.ThrowOnRead = true;
        HandleOrders(null, Query(true));
        Check(status == 503 && response.Contains("error") && !response.Contains("\"orders\""), "strict order read failure never becomes an empty success");
        HandleOrders(null, Query(false));
        Check(status == 200 && response == "{\"orders\":[]}", "ordinary order read failure keeps the legacy fallback");
        account.Orders.ThrowOnRead = false;
        account.Orders.Items.Clear();
        HandleOrders(null, Query(true));
        Check(status == 200 && response == "{\"orders\":[],\"copyStrict\":true}", "an actually empty strict order snapshot remains usable");
    }
    void Positions() {
        account.Positions.Items = new List<Position> {
            new Position { Instrument = new Instrument { FullName = "NQ 09-26" }, MarketPosition = MarketPosition.Long, Quantity = 2, AveragePrice = 25000 },
            new Position { Instrument = new Instrument { FullName = "ES 09-26" }, MarketPosition = MarketPosition.Short, Quantity = 1, AveragePrice = 6500 },
            new Position { Instrument = new Instrument { FullName = "YM 09-26" }, MarketPosition = MarketPosition.Flat, Quantity = 0, AveragePrice = 0 }
        };
        positionCache[account.Name + "|NQ 09-26"] = new CachedPosition { Quantity = 2, AveragePrice = 25000, MarketPosition = "Long" };
        positionCache[account.Name + "|RTY 09-26"] = new CachedPosition { Quantity = 3, AveragePrice = 2100, MarketPosition = "Long" };
        positionCache["Other|OTHER 09-26"] = new CachedPosition { Quantity = 99, AveragePrice = 1, MarketPosition = "Long" };
        HandlePositions(null, Query(true));
        Check(status == 200 && response.Contains("\"copyStrict\":true") && Regex.Matches(response, "\"instrument\":").Count == 3,
            "strict positions combine the native snapshot and the subscribed event cache");
        Check(response.Contains("\"instrument\":\"NQ 09-26\",\"quantity\":2") && response.Contains("\"instrument\":\"ES 09-26\",\"quantity\":-1")
            && response.Contains("\"instrument\":\"RTY 09-26\",\"quantity\":3"), "strict position quantities preserve long/short signs and cache-only positions");
        Check(Regex.Matches(response, "NQ 09-26").Count == 1 && !response.Contains("OTHER") && !response.Contains("YM 09-26"), "cache merge deduplicates matching positions and never crosses accounts");
        positionCache[account.Name + "|NQ 09-26"].Quantity = 1;
        HandlePositions(null, Query(true));
        Check(status == 503 && !response.Contains("\"positions\""), "inconsistent native and cached quantity blocks strict snapshots");
        positionCache[account.Name + "|NQ 09-26"].Quantity = -2;
        HandlePositions(null, Query(true));
        Check(status == 503, "inconsistent native and cached direction also blocks strict snapshots");
        HandlePositions(null, Query(false));
        Check(status == 200 && response.Contains("\"instrument\":\"NQ 09-26\",\"quantity\":2") && !response.Contains("copyStrict"), "ordinary positions preserve native-first cache compatibility");
        account.Positions.ThrowOnRead = true;
        HandlePositions(null, Query(true));
        Check(status == 503 && response.Contains("error") && !response.Contains("\"positions\""), "strict position read errors cannot fall back to a misleading cache-only success");
        HandlePositions(null, Query(false));
        Check(status == 200 && response.Contains("RTY 09-26") && response.Contains("\"quantity\":-2"), "ordinary positions retain the existing event-cache fallback after read failure");
        account.Positions.ThrowOnRead = false;
        account.Positions.Items.Clear();
        HandlePositions(null, Query(true));
        Check(status == 200 && response.Contains("RTY 09-26") && response.Contains("NQ 09-26"), "an empty platform collection does not erase externally tracked cache positions");
        positionCache.Clear();
        HandlePositions(null, Query(true));
        Check(status == 200 && response == "{\"positions\":[],\"copyStrict\":true}", "genuinely empty native and cached strict positions report flat");
    }
    static void Main() {
        var test = new SnapshotTests();
        test.Orders(); test.Positions();
        Console.WriteLine(passed + " NT8 copy snapshot checks passed; synthetic collections only");
    }
}
'@
$generated = Join-Path $directory 'CopySnapshotTests.cs'
[IO.File]::WriteAllText($generated, $template.Replace('/* PRODUCTION_SNAPSHOTS */', $methods))
$compiler = 'C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/MSBuild/Current/Bin/Roslyn/csc.exe'
$executable = Join-Path $directory 'CopySnapshotTests.exe'
& $compiler /nologo /target:exe "/out:$executable" $generated
if ($LASTEXITCODE -ne 0) { throw 'Copy snapshot tests did not compile' }
& $executable
if ($LASTEXITCODE -ne 0) { throw 'Copy snapshot tests failed' }
