using System.Reflection;
using System.Text.Json;
using ATAS.DataFeedsCore;
using TvAtasBridge;

internal static class ServiceTests
{
    public static async Task Run(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "TvAtasServiceTests-" + Guid.NewGuid().ToString("N"));
        var c = DispatchProxy.Create<IDataFeedConnector, FakeConnector>();
        var fake = (FakeConnector)c;
        var platform = new FakePlatform(c);
        var first = new Portfolio { AccountID = "A", Balance = 50000 };
        var second = new Portfolio { AccountID = "B", Balance = 10000 };
        var nq = new Security { SecurityId = "NQU6@CME", Code = "NQU6", TickSize = .25m, TickCost = 5, LotSize = 1 };
        var es = new Security { SecurityId = "ESU6@CME", Code = "ESU6", TickSize = .25m, TickCost = 12.5m, LotSize = 1 };
        fake.Portfolios.AddRange([first, second]); fake.Securities.AddRange([nq, es]);
        fake.Positions.Add(new Position { Portfolio = first, AccountID = "A", Security = es, SecurityId = es.SecurityId, Volume = 2, AveragePrice = 6000 });
        fake.Positions.Add(new Position { Portfolio = second, AccountID = "B", Security = nq, SecurityId = nq.SecurityId, Volume = -1, AveragePrice = 20000 });
        var service = new AtasTradingService(platform, directory, startWorker: false);
        async Task<JsonElement> Call(string path, object? body = null, string? account = null)
        {
            var query = new Dictionary<string, string>();
            if (account is not null) query["account"] = account;
            return JsonSerializer.SerializeToElement(await service.HandleAsync(path, query,
                JsonSerializer.SerializeToElement(body), CancellationToken.None), ExecutionJournal.Json);
        }
        try
        {
            var accounts = (await Call("/api/accounts")).GetProperty("accounts");
            check(accounts.GetArrayLength() == 2, "all connector accounts are exposed");
            var account = accounts[0].GetProperty("name").GetString()!;
            var positions = (await Call("/api/positions", account: account)).GetProperty("positions");
            check(positions.GetArrayLength() == 1 && positions[0].GetProperty("instrument").GetString() == es.SecurityId,
                "all contracts included, other accounts excluded");
            check(positions[0].GetProperty("chartSymbols").EnumerateArray().Select(s => s.GetString()).SequenceEqual(new[] { es.SecurityId, es.SecurityId + "#chart-alias" }),
                "position response exposes chart aliases while retaining the native instrument");
            platform.FailChartSymbols = true;
            var fallbackPositions = (await Call("/api/positions", account: account)).GetProperty("positions");
            check(fallbackPositions.GetArrayLength() == 1 && fallbackPositions[0].GetProperty("chartSymbols").GetArrayLength() == 1 &&
                fallbackPositions[0].GetProperty("chartSymbols")[0].GetString() == es.SecurityId && fallbackPositions[0].GetProperty("averagePrice").GetDecimal() == 6000,
                "display alias failure preserves native position and average price");
            platform.FailChartSymbols = false;
            var entryResult = await Call("/api/order/place", new { account, symbol = nq.SecurityId, action = "BUY", orderType = "LIMIT", quantity = 4, limitPrice = 20000, tp = 20010, sl = 19990 });
            var entry = fake.Orders.Single();
            var entrySnapshot = (await Call("/api/orders", account: account)).GetProperty("orders")[0];
            check(entrySnapshot.GetProperty("instrument").GetString() == nq.SecurityId && entrySnapshot.GetProperty("chartSymbols").GetArrayLength() == 2 && ReferenceEquals(entry.Security, nq),
                "order chart aliases never replace the native order security or instrument");
            check(fake.Calls.Count == 1, "pending entry creates no live protection orders");
            var pending = (await Call("/api/brackets", account: account)).GetProperty("brackets");
            check(pending.GetArrayLength() == 1 && pending[0].GetProperty("tp").GetDecimal() == 20010, "unfilled entry exposes dashed preview prices");
            fake.Fill(c, entry, 2, 20000, updatePosition: false);
            await Call("/api/accounts");
            check(fake.Orders.Count == 1, "entry fill before position update cannot create oversized protection");
            fake.SetPosition(first, nq, 2);
            await Call("/api/accounts");
            check(fake.Orders.Count == 3 && fake.Orders.Skip(1).All(o => o.Unfilled == 2), "partial entry protects only confirmed net quantity");
            var target = fake.Orders.Single(o => o.Comment!.EndsWith("|TP"));
            var stop = fake.Orders.Single(o => o.Comment!.EndsWith("|SL"));
            fake.Fill(c, entry, 2, 20001, updatePosition: true);
            await Call("/api/accounts");
            check(target.Unfilled == 4 && stop.Unfilled == 4, "subsequent entry fill expands both protection legs");
            var modifications = fake.Calls.Count(x => x == "modify");
            fake.Fill(c, target, 1, 20010, updatePosition: false);
            await Call("/api/accounts");
            check(fake.Calls.Count(x => x == "modify") == modifications && target.Unfilled == 3, "partial exit before position update cannot increase exit quantity");
            fake.SetPosition(first, nq, 3);
            await Call("/api/accounts");
            check(target.Unfilled == 3 && stop.Unfilled == 3, "partial exit reduces sibling to confirmed remaining position");
            var addResult = await Call("/api/order/place", new { account, symbol = nq.SecurityId, action = "BUY", orderType = "MARKET", quantity = 2 });
            var add = fake.Orders.Last();
            fake.Fill(c, add, 2, 20002, updatePosition: true);
            fake.DelayModify = true;
            await Call("/api/accounts");
            var delayedCalls = fake.Calls.Count(x => x == "modify");
            await Call("/api/accounts");
            check(fake.Calls.Count(x => x == "modify") == delayedCalls, "unacknowledged modification is not submitted twice");
            fake.AcknowledgeModifications();
            fake.DelayModify = false;
            await Call("/api/accounts");
            check(target.Unfilled == 5 && stop.Unfilled == 5, "late modification acknowledgment preserves net protection");
            service.Dispose(); await service.CompleteDisposalAsync();
            fake.InstanceId = Guid.NewGuid();
            service = new AtasTradingService(platform, directory, startWorker: false);
            var restored = (await Call("/api/accounts")).GetProperty("accounts")[0].GetProperty("name").GetString();
            check(restored == account, "account archive identity survives connector instance recreation");
            var restoredOrders = fake.Orders.Count;
            await Call("/api/brackets", account: account);
            check(fake.Orders.Count == restoredOrders, "restart validates existing protection without duplicating orders");
            var history = (await Call("/api/executions", account: account)).GetProperty("executions");
            check(history.GetArrayLength() == 4, "all fills survive service restart and snapshot overlap");
            service.Dispose(); await service.CompleteDisposalAsync();
            fake.Orders.Remove(target);
            service = new AtasTradingService(platform, directory, startWorker: false);
            var beforeMissing = fake.Calls.Count;
            var missing = await Call("/api/brackets", account: account);
            check(fake.Calls.Count == beforeMissing && !string.IsNullOrWhiteSpace(missing.GetProperty("syncError").GetString()),
                "restart reports missing protection even if saved position and fill totals are unchanged");
            check(service.SyncError is not null && service.ProtectionError(account) is not null &&
                string.IsNullOrEmpty(JsonSerializer.SerializeToElement(service.ArchiveStatus, ExecutionJournal.Json).GetProperty("warning").GetString()),
                "protection errors use trading status without contaminating the execution archive");
            fake.Orders.Add(target);
            var otherAccount = (await Call("/api/accounts")).GetProperty("accounts")[1].GetProperty("name").GetString();
            var beforeInvalid = fake.Calls.Count;
            try { await Call("/api/order/cancel", new { account = otherAccount, orderId = entryResult.GetProperty("orderId").GetString() }); throw new Exception("cross-account operation accepted"); }
            catch (ArgumentException) { }
            check(fake.Calls.Count == beforeInvalid, "cross-account order cancel rejected before connector call");
            await Call("/api/position/close", new { account, symbol = nq.SecurityId });
            check(fake.Positions.Single(p => p.Portfolio == first && p.Security == nq).Volume == 0 &&
                fake.Positions.Single(p => p.Portfolio == first && p.Security == es).Volume == 2,
                "close cancels instrument orders then closes only selected account contract");
            fake.ServerOco = false;
            var beforeUnsupported = fake.Calls.Count;
            try { await Call("/api/order/place", new { account, symbol = nq.SecurityId, action = "BUY", orderType = "MARKET", quantity = 1, tp = 20010, sl = 19990 }); throw new Exception("unsupported OCO accepted"); }
            catch (InvalidOperationException) { }
            check(fake.Calls.Count == beforeUnsupported, "unsupported OCO rejects attachment before naked entry is sent");
            await Call("/api/order/place", new { account, symbol = nq.SecurityId, action = "BUY", orderType = "MARKET", quantity = 1 });
            fake.Fill(c, fake.Orders.Last(), 1, 20003, updatePosition: true);
            service.Dispose(); await service.CompleteDisposalAsync();
            var finalJournal = new ExecutionJournal(directory);
            var finalRows = JsonSerializer.SerializeToElement(finalJournal.Query(account, null, 0, long.MaxValue, 0, null), ExecutionJournal.Json);
            check(finalRows.GetProperty("total").GetInt32() == 5, "dispose drains the final queued fill before durable flush");
            fake.ServerOco = true;
            fake.SetPosition(first, nq, 0);
            service = new AtasTradingService(platform, directory, startWorker: false);
            await Call("/api/order/place", new { account, symbol = nq.SecurityId, action = "BUY", orderType = "LIMIT", quantity = 1, limitPrice = 20000, tp = 20010, sl = 19990 });
            var fastEntry = fake.Orders.Last();
            fake.AfterRegister = o => { if (o.Comment!.EndsWith("|TP")) fake.Fill(c, o, 1, 20010, updatePosition: false); };
            fake.Fill(c, fastEntry, 1, 20000, updatePosition: true);
            var beforeFastExit = fake.Orders.Count;
            await Call("/api/accounts");
            check(fake.Orders.Count == beforeFastExit + 1, "a target filling during registration prevents a stale sibling exit submission");
            fake.SetPosition(first, nq, 0);
            await Call("/api/accounts");
        }
        finally { service.Dispose(); await service.CompleteDisposalAsync(); Directory.Delete(directory, recursive: true); }
    }

    private sealed class FakePlatform(IDataFeedConnector connector) : IAtasTradingPlatform
    {
        public bool FailChartSymbols;
        public IDataFeedConnector[] GetConnectors() => [connector];
        public Guid ConnectionId(IDataFeedConnector _) => new("01234567-89ab-cdef-0123-456789abcdef");
        public string ConnectionName(IDataFeedConnector _) => "Fake";
        public Security ResolveSecurity(string symbol, IDataFeedConnector c) => c.Securities.Single(s => s.SecurityId == symbol);
        public string SymbolName(Security security) => security.SecurityId;
        public string[] ChartSymbols(IDataFeedConnector _, Security security) => FailChartSymbols
            ? throw new InvalidOperationException("Synthetic display metadata failure") : [security.SecurityId, security.SecurityId + "#chart-alias"];
    }
}

public class FakeConnector : DispatchProxy
{
    public List<Portfolio> Portfolios { get; } = [];
    public List<Security> Securities { get; } = [];
    public List<Position> Positions { get; } = [];
    public List<Order> Orders { get; } = [];
    public List<MyTrade> Trades { get; } = [];
    public List<string> Calls { get; } = [];
    public Guid InstanceId = Guid.NewGuid();
    public bool ServerOco = true;
    public bool DelayModify;
    public Action<Order>? AfterRegister;
    public Func<string, Order, string?>? Reject;
    private readonly Dictionary<string, Delegate?> _events = [];
    private readonly List<(Order Original, Order Replacement)> _modifications = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        args ??= [];
        switch (method!.Name)
        {
            case "get_Id": return InstanceId;
            case "get_IsConnected": case "get_IsSupportedTradingFunctions": case "get_IsSupportedStopOrders": return true;
            case "get_IsSupportedServerOCO": return ServerOco;
            case "get_Portfolios": return Portfolios;
            case "get_Securities": return Securities;
            case "get_Positions": return Positions;
            case "get_Orders": return Orders;
            case "get_MyTrades": return Trades;
            case "RegisterOrderAsync":
                var order = (Order)args[0]!; order.Id = Guid.NewGuid().ToString("N"); order.State = OrderStates.Active;
                Orders.Add(order); Calls.Add("register");
                if (Rejection("register", order) is { } registerError) return registerError;
                AfterRegister?.Invoke(order); return Task.CompletedTask;
            case "ModifyOrderAsync":
                Calls.Add("modify");
                if (Rejection("modify", (Order)args[0]!, (Order)args[1]!) is { } modifyError) return modifyError;
                _modifications.Add(((Order)args[0]!, (Order)args[1]!));
                if (!DelayModify) AcknowledgeModifications(); return Task.CompletedTask;
            case "CancelOrderAsync":
                Calls.Add("cancel");
                if (Rejection("cancel", (Order)args[0]!) is { } cancelError) return cancelError;
                ((Order)args[0]!).State = OrderStates.Done; return Task.CompletedTask;
            case "ClosePositionAsync": Calls.Add("close"); ((Position)args[0]!).Volume = 0; return Task.CompletedTask;
        }
        if (method.Name.StartsWith("add_"))
        { var key = method.Name[4..]; _events[key] = Delegate.Combine(_events.GetValueOrDefault(key), (Delegate?)args[0]); return null; }
        if (method.Name.StartsWith("remove_"))
        { var key = method.Name[7..]; _events[key] = Delegate.Remove(_events.GetValueOrDefault(key), (Delegate?)args[0]); return null; }
        throw new NotSupportedException("Fake blocks unconfigured connector operation: " + method.Name);
    }
    public void AcknowledgeModifications()
    {
        foreach (var (a, b) in _modifications)
        { a.Price = b.Price; a.TriggerPrice = b.TriggerPrice; a.QuantityToFill = b.QuantityToFill; a.Unfilled = b.Unfilled; }
        _modifications.Clear();
    }
    private Task? Rejection(string operation, Order order, Order? replacement = null)
    {
        if (Reject?.Invoke(operation, order) is not { } reason) return null;
        if (operation == "register") order.State = OrderStates.Failed;
        EmitFailure(operation, order, reason, replacement);
        // The callback carries the detailed venue reason, while the task may carry a generic error.
        return Task.FromException(new InvalidOperationException("Generic connector operation failure"));
    }
    public void EmitFailure(string operation, Order order, string reason, Order? replacement = null)
    {
        var connector = (IDataFeedConnector)(object)this;
        if (operation == "register" && _events.GetValueOrDefault("OrdersRegisterFailed") is ConnectorEventHandler<string, Order> register)
            register(connector, reason, order);
        if (operation == "cancel" && _events.GetValueOrDefault("OrdersCancelFailed") is ConnectorEventHandler<string, Order> cancel)
            cancel(connector, reason, order);
        if (operation == "modify" && _events.GetValueOrDefault("OrderModifyFailed") is ConnectorEventHandler<Order, Order, string> modify)
            modify(connector, order, replacement ?? order.Clone(), reason);
    }
    public void Fill(IDataFeedConnector connector, Order order, decimal qty, decimal price, bool updatePosition)
    {
        order.Unfilled -= qty; if (order.Unfilled == 0) order.State = OrderStates.Done;
        var trade = new MyTrade { Id = Guid.NewGuid().ToString("N"), OrderId = order.Id!, Order = order,
            Portfolio = order.Portfolio!, AccountID = order.AccountID!, Security = order.Security!, SecurityId = order.SecurityId!,
            Volume = qty, Price = price, Time = DateTime.UtcNow, OrderDirection = order.Direction };
        Trades.Add(trade);
        if (updatePosition)
        {
            var current = Positions.FirstOrDefault(p => p.Portfolio == order.Portfolio && p.Security == order.Security)?.Volume ?? 0;
            SetPosition(order.Portfolio!, order.Security!, current + (order.Direction == OrderDirections.Buy ? qty : -qty));
        }
        if (_events.GetValueOrDefault("NewMyTrades") is ConnectorEventHandler<IEnumerable<MyTrade>> handler) handler(connector, [trade]);
    }
    public void SetPosition(Portfolio portfolio, Security security, decimal volume)
    {
        var position = Positions.FirstOrDefault(p => p.Portfolio == portfolio && p.Security == security);
        if (position is null) { position = new Position { Portfolio = portfolio, AccountID = portfolio.AccountID, Security = security, SecurityId = security.SecurityId }; Positions.Add(position); }
        position.Volume = volume;
    }
}
