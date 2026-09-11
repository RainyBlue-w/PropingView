using System.Text.Json;
using TvAtasBridge;
using System.Reflection;
using System.Runtime.Loader;
using ATAS.DataFeedsCore;
using Utils.Common.Collections.Synchronized;

// Load entity dependencies only. The connector used below is always a DispatchProxy fake;
// no platform services, account connections or ATAS host are constructed.
AssemblyLoadContext.Default.Resolving += (_, name) =>
{
    var sdkDirectory = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
        .Single(a => a.Key == "AtasPath").Value!;
    var dependency = Path.Combine(sdkDirectory, name.Name + ".dll");
    return File.Exists(dependency) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(dependency) : null;
};

static void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    Console.WriteLine("PASS " + name);
}

await ServiceTests.Run(Check);
await FailureTests.Run(Check);
await LifecycleTests.Run(Check);
ChartSymbolTests.Run(Check);

Check(ProtectionMath.DesiredQuantity(5, 1) == 5, "scale in increases protection to net position");
Check(ProtectionMath.DesiredQuantity(2, 1) == 2, "scale out reduces protection to net position");
Check(ProtectionMath.DesiredQuantity(0, 1) == 0, "flat position cancels protection");
Check(ProtectionMath.DesiredQuantity(-2, 1) == 0, "reversal cancels former long protection");
Check(ProtectionMath.AmountPrice(20000.25m, 100, 2, .25m, 5, 1) == 20002.75m,
    "amount target uses actual fill and filled quantity");
Check(ProtectionMath.AmountPrice(20000.25m, 1, 2, .25m, 5, -1) == 20000m,
    "small stop amounts remain at least one tick from fill");

var directory = Path.Combine(Path.GetTempPath(), "TvAtasBridgeTests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
try
{
    var journal = new ExecutionJournal(directory);
    var fill = new BridgeExecution(100, 100123, 123, 1, "Buy", "order", "fill", "NQU6", "Feed:A", null, 20, "USD");
    journal.Add(fill);
    journal.Add(fill);
    journal.Add(fill with { Account = "Feed:B" });
    journal.Add(fill with { ExecutionId = "later", TimeMs = 100987 });
    journal.Flush();
    var recovered = new ExecutionJournal(directory);
    var result = JsonSerializer.SerializeToElement(recovered.Query(null, null, 0, 200, 0, 2), ExecutionJournal.Json);
    Check(result.GetProperty("total").GetInt32() == 3, "journal deduplicates reconnection while isolating accounts");
    Check(result.GetProperty("executions")[0].GetProperty("timeMs").GetInt64() == 100987, "millisecond execution order preserved");
    Check(result.GetProperty("nextOffset").GetInt32() == 2, "execution pagination retains all records");
    File.AppendAllText(Path.Combine(directory, "executions.jsonl"), "{truncated");
    var torn = new ExecutionJournal(directory);
    torn.Add(fill with { ExecutionId = "after-crash", Time = 110, TimeMs = 110000 });
    torn.Flush();
    var afterCrash = new ExecutionJournal(directory);
    var recoveredRows = JsonSerializer.SerializeToElement(afterCrash.Query("Feed:A", "NQU6", 0, 200, 0, null), ExecutionJournal.Json);
    Check(recoveredRows.GetProperty("total").GetInt32() == 3, "torn final append cannot consume the next valid fill");
    Check(recoveredRows.GetProperty("archive").GetProperty("warning").GetString() is not null, "corrupt record reported without losing good history");
}
finally
{
    // Only remove the exact newly-created isolated test directory.
    Directory.Delete(directory, recursive: true);
}

internal static class LifecycleTests
{
    public static async Task Run(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "TvAtasLifecycleTests-" + Guid.NewGuid().ToString("N"));
        var connector = DispatchProxy.Create<IDataFeedConnector, FakeConnector>();
        var fake = (FakeConnector)connector;
        var portfolio = new Portfolio { AccountID = "LifecycleOnly", Balance = 10000 };
        var security = new Security { SecurityId = "NQU6@CME", Code = "NQU6", TickSize = .25m, TickCost = 5, LotSize = 1 };
        fake.Portfolios.Add(portfolio);
        fake.Securities.Add(security);
        var service = new AtasTradingService(new FakePlatform(connector), directory, startWorker: false);
        var gate = (SemaphoreSlim)(typeof(AtasTradingService).GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new Exception("Trading service synchronization gate is missing")).GetValue(service)!;
        var gateHeld = false;
        try
        {
            var query = new Dictionary<string, string>();
            var accountSnapshot = await service.HandleAsync("/api/accounts", query, JsonSerializer.SerializeToElement<object?>(null), CancellationToken.None);
            var account = JsonSerializer.SerializeToElement(accountSnapshot, ExecutionJournal.Json).GetProperty("accounts")[0].GetProperty("name").GetString()!;
            var payload = JsonSerializer.SerializeToElement(new { account, symbol = security.SecurityId, action = "BUY", orderType = "LIMIT", quantity = 1, limitPrice = 20000 });
            // Prove this otherwise-valid payload reaches only the fake connector before disposal.
            await service.HandleAsync("/api/order/place", query, payload, CancellationToken.None);
            var registrations = fake.Calls.Count(call => call == "register");
            check(registrations == 1, "lifecycle fixture permits a valid order through the fake connector before shutdown");

            await gate.WaitAsync();
            gateHeld = true;
            // HandleAsync executes synchronously up to its unavailable semaphore, so no timing sleep is needed.
            var queued = service.HandleAsync("/api/order/place", query, payload, CancellationToken.None);
            check(!queued.IsCompleted, "order request is queued behind the service gate before disposal");
            service.Dispose();
            check(!service.Disposal.IsCompleted, "disposal waits for gate ownership before draining the journal");
            gate.Release();
            gateHeld = false;

            var queuedRejected = false;
            try { await queued.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException) { queuedRejected = true; }
            await service.Disposal.WaitAsync(TimeSpan.FromSeconds(5));
            check(queuedRejected && fake.Calls.Count(call => call == "register") == registrations,
                "a queued POST is canceled at disposal and cannot register an order after gate release");

            var lateRejected = false;
            try { await service.HandleAsync("/api/order/place", query, payload, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException) { lateRejected = true; }
            check(lateRejected && fake.Calls.Count(call => call == "register") == registrations && fake.Orders.Count == registrations,
                "POST after completed disposal is rejected without a connector call or a new order");
        }
        finally
        {
            if (gateHeld) gate.Release();
            service.Dispose();
            await service.Disposal.WaitAsync(TimeSpan.FromSeconds(5));
            // Remove only the unique temporary directory created for this fake-only fixture.
            Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class FakePlatform(IDataFeedConnector connector) : IAtasTradingPlatform
    {
        public IDataFeedConnector[] GetConnectors() => [connector];
        public Guid ConnectionId(IDataFeedConnector _) => new("c269dbde-7b52-4cd7-a8b1-6f4b4b67e0f5");
        public string ConnectionName(IDataFeedConnector _) => "Lifecycle test";
        public Security ResolveSecurity(string symbol, IDataFeedConnector source) => source.Securities.Single(security => security.SecurityId == symbol);
        public string SymbolName(Security security) => security.SecurityId;
        public string[] ChartSymbols(IDataFeedConnector _, Security security) => [security.SecurityId];
    }
}

internal static class ChartSymbolTests
{
    public static void Run(Action<bool, string> check)
    {
        var connector = DispatchProxy.Create<IDataFeedConnector, FakeConnector>();
        var otherConnector = DispatchProxy.Create<IDataFeedConnector, FakeConnector>();
        var security = new Security { SecurityId = "MNQU6@CME" };
        var differentSecurity = new Security { SecurityId = security.SecurityId };
        SyncDictionary<IDataFeedConnector, Security> Mapping(IDataFeedConnector source, Security value)
        {
            var map = new SyncDictionary<IDataFeedConnector, Security>();
            map[source] = value;
            return map;
        }
        var instruments = new (string Symbol, SyncDictionary<IDataFeedConnector, Security> Securities)[]
        {
            ("MNQU6@CME#atas-id=first", Mapping(connector, security)),
            ("MNQU6@CME#atas-id=delayed", Mapping(connector, security)),
            ("MNQU6@CME#atas-id=first", Mapping(connector, security)),
            ("MNQU6@CME#atas-id=different-security", Mapping(connector, differentSecurity)),
            ("MNQU6@CME#atas-id=different-connector", Mapping(otherConnector, security)),
        };
        var index = AtasPlatformAccess.BuildChartSymbolIndex(connector, instruments);
        check(index[security].ToHashSet().SetEquals(["MNQU6@CME#atas-id=first", "MNQU6@CME#atas-id=delayed"]),
            "same native security across two chart instruments yields both aliases without duplicates");
        check(index.Count == 2 && index[differentSecurity].SequenceEqual(["MNQU6@CME#atas-id=different-security"]),
            "same SecurityId on a different native security object is never merged");
        var otherIndex = AtasPlatformAccess.BuildChartSymbolIndex(otherConnector, instruments);
        check(otherIndex.Count == 1 && otherIndex[security].SequenceEqual(["MNQU6@CME#atas-id=different-connector"]),
            "chart aliases are scoped to the exact connector mapping");
    }
}
