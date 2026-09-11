using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using ATAS.DataFeedsCore;

namespace TvAtasBridge;

/// <summary>
/// Trades through each portfolio's actual connector, never the chart's selected ITradingManager.
/// The gate serializes HTTP operations and reconciliation. Connector callbacks only queue snapshots.
/// </summary>
internal sealed class AtasTradingService : IDisposable
{
    private readonly IAtasTradingPlatform _access;
    private readonly ExecutionJournal _journal;
    private readonly string _protectionPath;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentQueue<(IDataFeedConnector Connector, MyTrade Trade)> _fills = new();
    private readonly ConcurrentQueue<OrderFailure> _failures = new();
    private readonly Dictionary<(string Account, string Order, OrderOperation Operation), OrderFailure> _operationFailures = new();
    private long _failureSequence;
    private readonly object _eventLock = new();
    private bool _acceptEvents = true;
    private readonly HashSet<IDataFeedConnector> _subscribed = new(ReferenceEqualityComparer.Instance);
    private readonly List<Protection> _protections = [];
    private readonly Dictionary<string, Order> _submitted = new(StringComparer.Ordinal);
    private readonly Dictionary<string, decimal> _expectedPositions = new(StringComparer.Ordinal);
    private readonly HashSet<string> _seenFills = new(StringComparer.Ordinal);
    private readonly Dictionary<string, decimal> _knownFilled = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (decimal TotalQuantity, decimal Price, DateTime Until)> _pendingModifications = new(StringComparer.Ordinal);
    private readonly Task _worker;
    private string? _syncError;
    private string? _synchronizationError;
    private string? _protectionLoadError;
    private string? _protectionSaveError;
    private string? _globalProtectionError;
    private Dictionary<string, string> _accountProtectionErrors = new(StringComparer.Ordinal);
    private bool _disposed;

    public AtasTradingService(AtasPlatformAccess access, string dataDir) : this(new LiveAtasTradingPlatform(access), dataDir) { }

    internal AtasTradingService(IAtasTradingPlatform access, string dataDir, bool startWorker = true)
    {
        _access = access;
        _journal = new ExecutionJournal(dataDir);
        _protectionPath = Path.Combine(dataDir, "protections.json");
        LoadProtections();
        RefreshProtectionErrors();
        _worker = startWorker ? Task.Run(RunAsync) : Task.CompletedTask;
    }

    public bool Connected => _access.GetConnectors().Any(c => c.IsConnected && c.IsSupportedTradingFunctions);
    public bool TradingSupported => _access.GetConnectors().Any(c => c.IsSupportedTradingFunctions);
    public string ConnectionName => "ATAS X";
    public object ArchiveStatus => _journal.Status;
    public string? SyncError => _syncError;
    public string? ProtectionError(string account) => JoinErrors(_globalProtectionError, _accountProtectionErrors.GetValueOrDefault(account));
    internal Task Disposal { get; private set; } = Task.CompletedTask;

    private sealed class Protection
    {
        public string Account { get; set; } = "";
        public string Symbol { get; set; } = "";
        public string Entry { get; set; } = "";
        public int Direction { get; set; }
        public decimal Tp { get; set; }
        public decimal Sl { get; set; }
        public decimal TpAmount { get; set; }
        public decimal SlAmount { get; set; }
        public string? TargetOrder { get; set; }
        public string? StopOrder { get; set; }
        public string Oco { get; set; } = "TVB-" + Guid.NewGuid().ToString("N");
        public bool Activated { get; set; }
        public bool Closed { get; set; }
        public decimal LastPosition { get; set; }
        public decimal LastFilled { get; set; }
        public bool TargetDisabled { get; set; }
        public bool StopDisabled { get; set; }
        public string? Error { get; set; }
        [System.Text.Json.Serialization.JsonIgnore] public bool Recovered { get; set; }
    }

    private enum OrderOperation { Register, Cancel, Modify }
    private sealed record OrderFailure(string Account, string Order, OrderOperation Operation, string Reason, long Sequence);
    private sealed class OrderRejectedException(string message) : InvalidOperationException(message);

    private async Task RunAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        try
        {
            do
            {
                await _gate.WaitAsync(_stop.Token).ConfigureAwait(false);
                try { await SynchronizeAsync().ConfigureAwait(false); }
                catch (Exception e) { _synchronizationError = e.Message; RefreshProtectionErrors(); }
                finally { _gate.Release(); }
            } while (await timer.WaitForNextTickAsync(_stop.Token).ConfigureAwait(false));
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
    }

    private void OnTrades(IDataFeedConnector connector, IEnumerable<MyTrade> trades)
    {
        lock (_eventLock)
        {
            if (!_acceptEvents) return;
            foreach (var trade in trades) _fills.Enqueue((connector, trade.Clone()));
        }
    }

    private void OnRegisterFailed(IDataFeedConnector connector, string message, Order order) => QueueFailure(connector, order, OrderOperation.Register, message);
    private void OnCancelFailed(IDataFeedConnector connector, string message, Order order) => QueueFailure(connector, order, OrderOperation.Cancel, message);
    private void OnModifyFailed(IDataFeedConnector connector, Order order, Order replacement, string message) => QueueFailure(connector, order, OrderOperation.Modify, message);

    private void QueueFailure(IDataFeedConnector connector, Order order, OrderOperation operation, string reason)
    {
        lock (_eventLock)
        {
            if (!_acceptEvents) return;
            _failures.Enqueue(new(AccountKey(connector, order.AccountID ?? order.Portfolio?.AccountID ?? ""),
                OrderKey(order), operation, reason, Interlocked.Increment(ref _failureSequence)));
        }
    }

    private async Task SynchronizeAsync()
    {
        var connectors = _access.GetConnectors();
        foreach (var removed in _subscribed.Where(c => !connectors.Contains(c)).ToArray()) Unsubscribe(removed);
        foreach (var connector in connectors)
        {
            if (!_subscribed.Add(connector)) continue;
            connector.NewMyTrades += OnTrades;
            connector.OrdersRegisterFailed += OnRegisterFailed;
            connector.OrdersCancelFailed += OnCancelFailed;
            connector.OrderModifyFailed += OnModifyFailed;
            // Subscribe before taking the initial snapshot; the durable journal deduplicates overlap.
            foreach (var trade in connector.MyTrades.ToArray())
            {
                Archive(connector, trade);
                ObserveFill(connector, trade, updatePosition: false);
            }
            foreach (var position in connector.Positions.ToArray())
                _expectedPositions[PositionKey(connector, position.AccountID, position.Security)] = position.Volume;
        }
        DrainFills();
        _journal.Flush();
        var changed = DrainFailures();
        foreach (var protection in _protections.Where(p => !p.Closed).ToArray())
        {
            try { changed |= await SynchronizeProtectionAsync(protection).ConfigureAwait(false); }
            catch (Exception error) { protection.Error = error.Message; changed = true; }
        }
        if (changed) SaveProtections();
        _synchronizationError = null;
        RefreshProtectionErrors();
    }

    private void Archive(IDataFeedConnector connector, MyTrade trade)
    {
        var account = trade.Portfolio?.AccountID ?? trade.AccountID;
        var security = trade.Security ?? trade.Order?.Security;
        if (string.IsNullOrEmpty(account) || trade.Volume <= 0) return;
        var ms = UnixMs(trade.Time);
        // An exchange execution ID is authoritative; legacy feeds without it use exact fill identity.
        var id = !string.IsNullOrEmpty(trade.Id) ? trade.Id : "derived:" + JsonSerializer.Serialize(new object[]
            { trade.OrderId ?? "", ms, trade.Price, trade.Volume, trade.OrderDirection.ToString() });
        _journal.Add(new BridgeExecution(ms / 1000, ms, trade.Price, trade.Volume,
            trade.OrderDirection == OrderDirections.Buy ? "Buy" : "Sell",
            trade.Order is null ? trade.OrderId ?? "" : OrderKey(trade.Order), id,
            security is null ? trade.SecurityId ?? "" : Symbol(security), AccountKey(connector, account),
            trade.Commission, security is { TickSize: > 0, TickCost: > 0 } ? security.TickCost / security.TickSize : null,
            Currency(trade.Portfolio?.Currency?.ToString()), account));
    }

    public async Task<object> HandleAsync(string path, IReadOnlyDictionary<string, string> query, JsonElement body, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        using var requestStop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        await _gate.WaitAsync(requestStop.Token).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            requestStop.Token.ThrowIfCancellationRequested();
            await SynchronizeAsync().ConfigureAwait(false);
            ObjectDisposedException.ThrowIf(_disposed, this);
            requestStop.Token.ThrowIfCancellationRequested();
            var account = query.GetValueOrDefault("account", "");
            switch (path)
            {
                case "/api/accounts": return Accounts();
                case "/api/positions": return Positions(account);
                case "/api/orders": return Orders(account);
                case "/api/brackets": return new { brackets = _protections.Where(p => !p.Closed && p.Account == account)
                    .Select(p => new { entryOrderId = p.Entry, instrument = p.Symbol, tp = p.Tp, sl = p.Sl }).ToArray(), syncError = ProtectionError(account) };
                case "/api/executions":
                    return _journal.Query(account, query.GetValueOrDefault("symbol", ""),
                        QueryLong(query, "from", 0), QueryLong(query, "to", long.MaxValue),
                        (int)Math.Clamp(QueryLong(query, "offset", 0), 0, int.MaxValue),
                        query.ContainsKey("limit") ? (int)Math.Clamp(QueryLong(query, "limit", 100), 1, 1000) : null);
                case "/api/order/place": return await PlaceAsync(body).ConfigureAwait(false);
                case "/api/order/cancel": return await CancelAsync(body).ConfigureAwait(false);
                case "/api/order/change": return await ChangeAsync(body).ConfigureAwait(false);
                case "/api/position/close": return await CloseAsync(body).ConfigureAwait(false);
                default: throw new ArgumentException("未知 ATAS 交易端点。 ");
            }
        }
        finally { RefreshProtectionErrors(); _gate.Release(); }
    }

    private object Accounts() => new { accounts = _access.GetConnectors().SelectMany(c => c.Portfolios.Select(p => new
    {
        name = AccountKey(c, p.AccountID), displayName = p.AccountID,
        connection = ConnectorName(c), currency = Currency(p.Currency?.ToString()),
        cashValue = p.Balance, realizedPnl = p.ClosedPnL, unrealizedPnl = p.OpenPnL,
        connected = c.IsConnected,
    })).ToArray() };

    private object Positions(string account)
    {
        var (connector, portfolio) = ResolveAccount(account);
        return new { positions = connector.Positions.Where(p => p.AccountID == portfolio.AccountID && p.Volume != 0).Select(p => new
        {
            instrument = Symbol(p.Security), chartSymbols = ChartSymbols(connector, p.Security), quantity = p.Volume, averagePrice = p.AveragePrice,
            marketPosition = p.Volume > 0 ? "Long" : "Short",
        }).ToArray() };
    }

    private object Orders(string account)
    {
        var (connector, portfolio) = ResolveAccount(account);
        return new { orders = AccountOrders(connector, portfolio).Where(IsWorking).Select(o => new
        {
            orderId = OrderKey(o), instrument = o.Security is null ? o.SecurityId ?? "" : Symbol(o.Security),
            chartSymbols = o.Security is null ? new[] { o.SecurityId ?? "" } : ChartSymbols(connector, o.Security),
            action = o.Direction == OrderDirections.Buy ? "Buy" : "Sell",
            orderType = o.Type switch { OrderTypes.Stop => "StopMarket", OrderTypes.StopLimit => "StopLimit", _ => o.Type.ToString() },
            quantity = o.QuantityToFill, filled = Filled(o), limitPrice = o.Price, stopPrice = o.TriggerPrice,
            averageFillPrice = AverageFill(connector, o), state = o.State == OrderStates.None ? "Submitted" : Filled(o) > 0 ? "PartFilled" : "Working",
            oco = o.OCOGroup ?? "", name = o.Comment ?? "", time = UnixMs(o.Time) / 1000,
        }).ToArray() };
    }

    private async Task<object> PlaceAsync(JsonElement body)
    {
        var account = Text(body, "account");
        var (connector, portfolio) = ResolveAccount(account, trading: true);
        var symbol = Text(body, "symbol");
        var security = ResolveSecurity(connector, symbol);
        _expectedPositions.TryAdd(PositionKey(connector, portfolio.AccountID, security), connector.Positions
            .Where(p => p.AccountID == portfolio.AccountID && SameSecurity(p.Security, security)).Sum(p => p.Volume));
        var direction = Text(body, "action").ToUpperInvariant() switch
        { "BUY" => OrderDirections.Buy, "SELL" => OrderDirections.Sell, _ => throw new ArgumentException("买卖方向无效。") };
        var type = Text(body, "orderType").ToUpperInvariant() switch
        {
            "MARKET" => OrderTypes.Market, "LIMIT" => OrderTypes.Limit, "STOPMARKET" => OrderTypes.Stop,
            "STOPLIMIT" => OrderTypes.StopLimit, _ => throw new ArgumentException("委托类型无效。"),
        };
        var qty = Number(body, "quantity", required: true);
        ValidateQuantity(security, qty);
        var limit = Number(body, "limitPrice");
        var stop = Number(body, "stopPrice");
        if (type is OrderTypes.Limit or OrderTypes.StopLimit) ValidatePrice(security, limit);
        if (type is OrderTypes.Stop or OrderTypes.StopLimit)
        {
            if (!connector.IsSupportedStopOrders) throw new InvalidOperationException("此 ATAS 连接不支持止损委托。 ");
            ValidatePrice(security, stop);
        }
        var tp = Number(body, "tp"); var sl = Number(body, "sl");
        var tpAmount = Number(body, "tpAmount"); var slAmount = Number(body, "slAmount");
        var attached = tp > 0 || sl > 0 || tpAmount > 0 || slAmount > 0;
        if (tpAmount > 0 && tp > 0 || slAmount > 0 && sl > 0) throw new ArgumentException("止盈止损价格和金额不能同时指定。 ");
        if ((tpAmount > 0 || slAmount > 0) && type != OrderTypes.Market) throw new ArgumentException("按金额止盈止损仅支持市价入场。 ");
        if ((tpAmount > 0 || slAmount > 0) && (security.TickCost <= 0 || security.IsInverseFutures))
            throw new InvalidOperationException("此合约尚无可用于金额止盈止损的每跳价值。 ");
        if ((tp > 0 || tpAmount > 0) && (sl > 0 || slAmount > 0) && !connector.IsSupportedServerOCO)
            throw new InvalidOperationException("此 ATAS 连接不支持服务器 OCO，不能同时附加止盈和止损；入场单未提交。 ");
        if ((sl > 0 || slAmount > 0) && !connector.IsSupportedStopOrders)
            throw new InvalidOperationException("此 ATAS 连接不支持止损委托；入场单未提交。 ");
        if (tp > 0) ValidatePrice(security, tp);
        if (sl > 0) ValidatePrice(security, sl);
        var canonical = Symbol(security);
        if (attached && _protections.Any(p => !p.Closed && p.Account == account && p.Symbol == canonical))
            throw new InvalidOperationException("此账户合约已有止盈止损。加减仓请不附加新止盈止损，原保护单会随净持仓调整。 ");
        var entryReference = type == OrderTypes.Market ? security.LastTradePrice.GetValueOrDefault() : type == OrderTypes.Limit ? limit : stop;
        if (entryReference > 0) ValidateProtection(direction == OrderDirections.Buy ? 1 : -1, entryReference, tp, sl);
        var tif = body.TryGetProperty("tif", out var tifValue) ? tifValue.GetString() : "DAY";
        var timeInForce = tif switch { "DAY" => TimeInForce.Day, "GTC" => TimeInForce.GoodTillCancel, _ => throw new ArgumentException("有效期只支持 DAY / GTC。 ") };
        var order = NewOrder(portfolio, security, direction, type, qty, limit, stop, timeInForce, "Entry");
        Protection? protection = null;
        if (attached)
        {
            protection = new Protection { Account = account, Symbol = canonical, Entry = OrderKey(order),
                Direction = direction == OrderDirections.Buy ? 1 : -1, Tp = tp, Sl = sl, TpAmount = tpAmount, SlAmount = slAmount };
            _protections.Add(protection);
            SaveProtections(); // Must be durable before the entry can reach the venue.
        }
        _submitted[OrderKey(order)] = order;
        try { await ExecuteOrderAsync(connector, order, OrderOperation.Register, () => connector.RegisterOrderAsync(order)).ConfigureAwait(false); }
        catch (OrderRejectedException e)
        {
            if (protection is not null)
            {
                if (Filled(order) == 0) protection.Closed = true;
                else protection.Error = e.Message;
                SaveProtections();
            }
            throw;
        }
        catch (Exception e)
        {
            if (protection is not null) { protection.Error = "入场提交结果未确认，请在 ATAS 核实后处理：" + e.Message; SaveProtections(); }
            throw new InvalidOperationException("ATAS 未确认入场结果；请先检查订单，避免重复提交。 " + e.Message, e);
        }
        if (order.State == OrderStates.Failed)
        {
            if (protection is not null) { protection.Closed = true; SaveProtections(); }
            throw new InvalidOperationException("ATAS 已拒绝此入场委托。 ");
        }
        return new { ok = true, orderId = OrderKey(order) };
    }

    private async Task<object> CancelAsync(JsonElement body)
    {
        var account = Text(body, "account");
        var (connector, portfolio) = ResolveAccount(account, trading: true);
        var key = Text(body, "orderId");
        var order = FindOrder(connector, portfolio, key) ?? throw new ArgumentException("找不到该账户的订单。 ");
        if (!IsWorking(order)) throw new InvalidOperationException("该订单已经终结。 ");
        await ExecuteOrderAsync(connector, order, OrderOperation.Cancel, () => connector.CancelOrderAsync(order)).ConfigureAwait(false);
        if (IsWorking(order)) throw new InvalidOperationException("撤单已提交但尚未确认，请刷新订单后核实。 ");
        var changed = false;
        foreach (var p in _protections.Where(p => !p.Closed && p.Account == account))
        {
            if (p.TargetOrder == key) { p.TargetDisabled = true; changed = true; }
            if (p.StopOrder == key) { p.StopDisabled = true; changed = true; }
            if ((p.Tp == 0 || p.TargetDisabled) && (p.Sl == 0 || p.StopDisabled)) p.Closed = true;
        }
        if (changed) SaveProtections();
        return new { ok = true };
    }

    private async Task<object> ChangeAsync(JsonElement body)
    {
        var account = Text(body, "account");
        var (connector, portfolio) = ResolveAccount(account, trading: true);
        var key = Text(body, "orderId");
        var order = FindOrder(connector, portfolio, key) ?? throw new ArgumentException("找不到该账户的订单。 ");
        if (!IsWorking(order) || order.Security is null) throw new InvalidOperationException("此订单暂时不可修改。 ");
        var replacement = order.Clone();
        var changed = false;
        if (body.TryGetProperty("limitPrice", out _) && order.Type is OrderTypes.Limit or OrderTypes.StopLimit)
        { replacement.Price = Number(body, "limitPrice", required: true); ValidatePrice(order.Security, replacement.Price); changed = true; }
        if (body.TryGetProperty("stopPrice", out _) && order.Type is OrderTypes.Stop or OrderTypes.StopLimit)
        { replacement.TriggerPrice = Number(body, "stopPrice", required: true); ValidatePrice(order.Security, replacement.TriggerPrice); changed = true; }
        if (!changed) throw new ArgumentException("没有可应用于此订单类型的价格变更。 ");
        await ExecuteOrderAsync(connector, order, OrderOperation.Modify, () => connector.ModifyOrderAsync(order, replacement)).ConfigureAwait(false);
        if (replacement.State == OrderStates.Failed) throw new InvalidOperationException("ATAS 拒绝了订单修改。 ");
        var protectionChanged = false;
        foreach (var p in _protections.Where(p => !p.Closed && p.Account == account))
        {
            if (p.TargetOrder == key) { p.Tp = replacement.Price; p.TpAmount = 0; protectionChanged = true; }
            if (p.StopOrder == key) { p.Sl = replacement.TriggerPrice; p.SlAmount = 0; protectionChanged = true; }
        }
        if (protectionChanged) SaveProtections();
        return new { ok = true };
    }

    private async Task<object> CloseAsync(JsonElement body)
    {
        var account = Text(body, "account");
        var (connector, portfolio) = ResolveAccount(account, trading: true);
        var security = ResolveSecurity(connector, Text(body, "symbol"));
        var positions = connector.Positions.Where(p => p.AccountID == portfolio.AccountID && SameSecurity(p.Security, security) && p.Volume != 0).ToArray();
        if (positions.Length == 0) throw new InvalidOperationException("该账户没有此合约持仓。 ");
        // Confirm every working order is gone before closing; pending entries must not reopen the position.
        foreach (var order in AccountOrders(connector, portfolio).Where(o => o.Security is not null && SameSecurity(o.Security, security) && IsWorking(o)))
        {
            await ExecuteOrderAsync(connector, order, OrderOperation.Cancel, () => connector.CancelOrderAsync(order)).ConfigureAwait(false);
            if (IsWorking(order)) throw new InvalidOperationException("该合约工作订单尚未撤销，暂未提交平仓。 ");
        }
        var protections = _protections.Where(p => !p.Closed && p.Account == account && p.Symbol == Symbol(security)).ToArray();
        try
        {
            foreach (var position in positions)
            {
                _stop.Token.ThrowIfCancellationRequested();
                await WaitForVenueAsync(connector.ClosePositionAsync(position)).ConfigureAwait(false);
            }
            if (connector.Positions.Any(p => p.AccountID == portfolio.AccountID && SameSecurity(p.Security, security) && p.Volume != 0))
                throw new InvalidOperationException("ATAS 尚未确认持仓已平，请在 ATAS 核实剩余持仓。 ");
            foreach (var p in protections) p.Closed = true;
        }
        catch (Exception e)
        {
            foreach (var p in protections) p.Error = "平仓未确认，请在 ATAS 检查持仓保护：" + e.Message;
            if (protections.Length > 0) SaveProtections();
            throw;
        }
        if (protections.Length > 0) SaveProtections();
        return new { ok = true };
    }

    private async Task<bool> SynchronizeProtectionAsync(Protection p)
    {
        (IDataFeedConnector connector, Portfolio portfolio) resolved;
        try { resolved = ResolveAccount(p.Account); }
        catch (ArgumentException) { return false; } // A configured connector may temporarily disappear while reconnecting.
        var (connector, portfolio) = resolved;
        if (!connector.IsConnected || !connector.IsSupportedTradingFunctions) return false;
        var entry = FindOrder(connector, portfolio, p.Entry);
        if (entry?.Security is null)
        {
            if (p.Recovered) throw new InvalidOperationException("恢复的止盈止损找不到原始入场单，请在 ATAS 核实保护订单。 ");
            return false;
        }
        var security = entry.Security;
        var net = connector.Positions.Where(pos => pos.AccountID == portfolio.AccountID && SameSecurity(pos.Security, security)).Sum(pos => pos.Volume);
        var positionKey = PositionKey(connector, portfolio.AccountID, security);
        if (_expectedPositions.TryGetValue(positionKey, out var expected) && net != expected) return false;
        var filled = Filled(entry);
        if (filled > KnownFilled(connector, portfolio, entry)) return false;
        if (!p.Activated && filled == 0)
        {
            if (entry.State is OrderStates.Done or OrderStates.Failed) { p.Closed = true; return true; }
            return false;
        }
        // Do not create exits while the connector still exposes the pre-fill position snapshot.
        var hasProtection = p.Activated || p.TargetOrder is not null || p.StopOrder is not null;
        if (!hasProtection && (net == 0 || Math.Sign(net) != p.Direction)) return false;
        var desired = ProtectionMath.DesiredQuantity(net, p.Direction);
        if (hasProtection && desired == 0)
        {
            await CancelProtectionAsync(connector, portfolio, p).ConfigureAwait(false);
            // A partially-filled entry can still re-open a flat position, so cancel its remainder too.
            if (IsWorking(entry)) await ExecuteOrderAsync(connector, entry, OrderOperation.Cancel, () => connector.CancelOrderAsync(entry)).ConfigureAwait(false);
            if (IsWorking(entry)) throw new InvalidOperationException("仓位已平，原入场余单尚未确认撤销。 ");
            p.Closed = true; return true;
        }
        if (p.Error is not null) return false; // Never retry ambiguous submissions, but still clean up when flat.
        var target = p.TargetOrder is null ? null : FindOrder(connector, portfolio, p.TargetOrder);
        var stop = p.StopOrder is null ? null : FindOrder(connector, portfolio, p.StopOrder);
        if (target is not null && Filled(target) > KnownFilled(connector, portfolio, target) ||
            stop is not null && Filled(stop) > KnownFilled(connector, portfolio, stop)) return false;
        // Respect cancellations made directly in ATAS. Never silently recreate a removed protection.
        if (target is { State: OrderStates.Done } && Filled(target) == 0) p.TargetDisabled = true;
        if (stop is { State: OrderStates.Done } && Filled(stop) == 0) p.StopDisabled = true;
        if (p.TargetDisabled && p.StopDisabled) { p.Closed = true; return true; }
        // Reconcile from actual working quantities every time, including restart and late modify acks.
        if ((p.TpAmount > 0 || p.SlAmount > 0) && filled > 0)
        {
            var average = AverageFill(connector, entry);
            if (average <= 0) return false; // The venue fill price is authoritative, not the quote at click time.
            if (p.TpAmount > 0) p.Tp = ProtectionMath.AmountPrice(average, p.TpAmount, filled, security.TickSize, security.TickCost, p.Direction);
            if (p.SlAmount > 0) p.Sl = ProtectionMath.AmountPrice(average, p.SlAmount, filled, security.TickSize, security.TickCost, -p.Direction);
        }
        if (p.Tp > 0 && !p.TargetDisabled)
            if (!await EnsureProtectionOrderAsync(connector, portfolio, security, p, target, desired, targetLeg: true).ConfigureAwait(false)) return false;
        if (p.Sl > 0 && !p.StopDisabled)
            if (!await EnsureProtectionOrderAsync(connector, portfolio, security, p, stop, desired, targetLeg: false).ConfigureAwait(false)) return false;
        var changed = !p.Activated || p.Recovered || p.LastPosition != net || p.LastFilled != filled;
        p.LastPosition = net; p.LastFilled = filled; p.Activated = true; p.Recovered = false;
        return changed;
    }

    private async Task<bool> EnsureProtectionOrderAsync(IDataFeedConnector connector, Portfolio portfolio, Security security, Protection p, Order? order, decimal quantity, bool targetLeg)
    {
        // An exit may fill during the awaited registration of the other OCO leg.
        // Recheck both streams immediately before every venue operation.
        DrainFills();
        var currentNet = connector.Positions.Where(pos => pos.AccountID == portfolio.AccountID && SameSecurity(pos.Security, security)).Sum(pos => pos.Volume);
        if (currentNet != quantity * p.Direction || _expectedPositions.GetValueOrDefault(PositionKey(connector, portfolio.AccountID, security), currentNet) != currentNet)
            return false;
        var key = targetLeg ? p.TargetOrder : p.StopOrder;
        if (key is not null && order is null) throw new InvalidOperationException("保护订单提交状态不明确，请在 ATAS 核实；桥接不会重复下单。 ");
        if (order is { State: OrderStates.Failed }) throw new InvalidOperationException("ATAS 拒绝了保护订单，请在 ATAS 处理当前持仓。 ");
        if (order is not null && !IsWorking(order))
        {
            // A filled child can race a delayed position update. Never recreate it from that stale snapshot.
            if (Filled(order) > 0) throw new InvalidOperationException("保护订单已成交，等待核实剩余仓位；请在 ATAS 检查其余保护。 ");
            return true;
        }
        var price = targetLeg ? p.Tp : p.Sl;
        if (order is null)
        {
            order = NewOrder(portfolio, security, p.Direction > 0 ? OrderDirections.Sell : OrderDirections.Buy,
                targetLeg ? OrderTypes.Limit : OrderTypes.Stop, quantity, targetLeg ? price : 0, targetLeg ? 0 : price,
                TimeInForce.GoodTillCancel, targetLeg ? "TP" : "SL");
            order.OCOGroup = connector.IsSupportedServerOCO ? p.Oco : null;
            order.AutoCancel = true;
            if (targetLeg) p.TargetOrder = OrderKey(order); else p.StopOrder = OrderKey(order);
            SaveProtections(); // An interrupted submission must be found, never sent twice on restart.
            _submitted[OrderKey(order)] = order;
            await ExecuteOrderAsync(connector, order, OrderOperation.Register, () => connector.RegisterOrderAsync(order)).ConfigureAwait(false);
            if (order.State == OrderStates.Failed) throw new InvalidOperationException("ATAS 拒绝了保护订单，请在 ATAS 处理当前持仓。 ");
            return true;
        }
        var desiredTotal = quantity + Filled(order);
        var modificationKey = p.Account + "|" + OrderKey(order);
        if (_pendingModifications.TryGetValue(modificationKey, out var pending))
        {
            if (order.QuantityToFill == pending.TotalQuantity && (targetLeg ? order.Price : order.TriggerPrice) == pending.Price)
                _pendingModifications.Remove(modificationKey);
            else if (DateTime.UtcNow < pending.Until) return false;
            else throw new InvalidOperationException("ATAS 尚未确认止盈止损数量修改，请在 ATAS 核实保护单；桥接不会重复改单。 ");
        }
        if (order.Unfilled == quantity && (targetLeg ? order.Price : order.TriggerPrice) == price) return true;
        var replacement = order.Clone();
        replacement.QuantityToFill = desiredTotal;
        replacement.Unfilled = quantity;
        if (targetLeg) replacement.Price = price; else replacement.TriggerPrice = price;
        _pendingModifications[modificationKey] = (desiredTotal, price, DateTime.UtcNow.AddSeconds(5));
        await ExecuteOrderAsync(connector, order, OrderOperation.Modify, () => connector.ModifyOrderAsync(order, replacement)).ConfigureAwait(false);
        if (replacement.State == OrderStates.Failed) throw new InvalidOperationException("ATAS 拒绝同步止盈止损数量，请在 ATAS 检查保护数量。 ");
        return true;
    }

    private async Task CancelProtectionAsync(IDataFeedConnector connector, Portfolio portfolio, Protection p)
    {
        foreach (var key in new[] { p.TargetOrder, p.StopOrder })
        {
            var order = key is null ? null : FindOrder(connector, portfolio, key);
            if (order is null || !IsWorking(order)) continue;
            await ExecuteOrderAsync(connector, order, OrderOperation.Cancel, () => connector.CancelOrderAsync(order)).ConfigureAwait(false);
            if (IsWorking(order)) throw new InvalidOperationException("已平仓，但 ATAS 尚未确认保护单撤销。 ");
        }
    }

    private (IDataFeedConnector Connector, Portfolio Portfolio) ResolveAccount(string account, bool trading = false)
    {
        var matches = _access.GetConnectors().SelectMany(c => c.Portfolios.Select(p => (Connector: c, Portfolio: p)))
            .Where(x => AccountKey(x.Connector, x.Portfolio.AccountID) == account).ToArray();
        if (matches.Length != 1) throw new ArgumentException("ATAS 账户不存在或账户标识不唯一。 ");
        var result = matches[0];
        if (trading && (!result.Connector.IsConnected || !result.Connector.IsSupportedTradingFunctions))
            throw new InvalidOperationException("此 ATAS 账户未连接或不支持交易。 ");
        if (trading && (result.Portfolio.IsLocked || result.Portfolio.IsSuspended))
            throw new InvalidOperationException("此 ATAS 账户当前禁止交易。 ");
        return result;
    }

    private Security ResolveSecurity(IDataFeedConnector connector, string symbol) => _access.ResolveSecurity(symbol, connector);

    private Order[] AccountOrders(IDataFeedConnector connector, Portfolio portfolio) => connector.Orders
        .Concat(_submitted.Values.Where(o => ReferenceEquals(o.Portfolio, portfolio)))
        .Where(o => (o.AccountID ?? o.Portfolio?.AccountID) == portfolio.AccountID)
        .GroupBy(OrderKey, StringComparer.Ordinal).Select(g => g.First()).ToArray();
    private Order? FindOrder(IDataFeedConnector connector, Portfolio portfolio, string key) => AccountOrders(connector, portfolio).FirstOrDefault(o => OrderKey(o) == key);
    private static bool IsWorking(Order order) => order.State is OrderStates.None or OrderStates.Active;
    private static decimal Filled(Order order) => order.State == OrderStates.None ? 0 : Math.Max(0, order.QuantityToFill - order.Unfilled);
    private bool SameSecurity(Security a, Security b) => ReferenceEquals(a, b) || Symbol(a) == Symbol(b);
    private string Symbol(Security security) => _access.SymbolName(security);
    private string[] ChartSymbols(IDataFeedConnector connector, Security security)
    {
        var canonical = Symbol(security);
        try { return new[] { canonical }.Concat(_access.ChartSymbols(connector, security)).Where(s => !string.IsNullOrWhiteSpace(s)).Distinct(StringComparer.Ordinal).ToArray(); }
        catch { return [canonical]; }
    }
    private string AccountKey(IDataFeedConnector connector, string account) => _access.ConnectionId(connector).ToString("N") + ":" + account;
    private string ConnectorName(IDataFeedConnector connector) => _access.ConnectionName(connector);

    private static string OrderKey(Order order) => order.Comment is { } comment && comment.StartsWith("TVB:", StringComparison.Ordinal)
        ? comment.Split('|')[0] : !string.IsNullOrEmpty(order.Id) ? order.Id : "ext:" + order.ExtId.ToString(CultureInfo.InvariantCulture);
    private static decimal AverageFill(IDataFeedConnector connector, Order order)
    {
        var trades = connector.MyTrades.Where(t => ReferenceEquals(t.Order, order) ||
            !string.IsNullOrEmpty(order.Id) && t.OrderId == order.Id && (t.AccountID ?? t.Portfolio?.AccountID) == (order.AccountID ?? order.Portfolio?.AccountID)).ToArray();
        var quantity = trades.Sum(t => t.Volume);
        return quantity > 0 ? trades.Sum(t => t.Price * t.Volume) / quantity : 0;
    }

    private static Order NewOrder(Portfolio portfolio, Security security, OrderDirections direction, OrderTypes type,
        decimal quantity, decimal limit, decimal stop, TimeInForce tif, string role) => new()
    {
        Portfolio = portfolio, AccountID = portfolio.AccountID, Security = security, SecurityId = security.SecurityId,
        Direction = direction, Type = type, QuantityToFill = quantity, Unfilled = quantity,
        Price = limit, TriggerPrice = stop, TimeInForce = tif, Time = DateTime.UtcNow,
        Comment = "TVB:" + Guid.NewGuid().ToString("N") + "|" + role,
    };

    private static string? Currency(string? currency) => currency is "UsDollar" or "USD" ? "USD" : currency;
    private static long UnixMs(DateTime time) => new DateTimeOffset(time.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(time, DateTimeKind.Utc) : time).ToUnixTimeMilliseconds();
    private static string Text(JsonElement body, string name) => body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
        ? value.GetString()! : throw new ArgumentException($"缺少有效的 {name}。 ");
    private static decimal Number(JsonElement body, string name, bool required = false)
    {
        if (!body.TryGetProperty(name, out var value)) return required ? throw new ArgumentException($"缺少 {name}。 ") : 0;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDecimal(out var number) || number < 0 || required && number == 0) throw new ArgumentException($"{name} 必须是有效正数。 ");
        return number;
    }
    private static long QueryLong(IReadOnlyDictionary<string, string> query, string name, long fallback) =>
        query.TryGetValue(name, out var text) && long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result) ? result : fallback;
    private static void ValidateQuantity(Security security, decimal qty)
    {
        if (qty <= 0 || security.LotSize > 0 && qty % security.LotSize != 0 ||
            security.LotMinSize is > 0 && qty < security.LotMinSize || security.LotMaxSize is > 0 && qty > security.LotMaxSize)
            throw new ArgumentException("数量不符合此 ATAS 合约的最小数量或递增单位。 ");
    }
    private static void ValidatePrice(Security security, decimal price)
    {
        if (price <= 0 || ProtectionMath.RoundPrice(price, security.TickSize) != price ||
            security.MinPrice > 0 && price < security.MinPrice || security.MaxPrice > 0 && price > security.MaxPrice)
            throw new ArgumentException("价格不符合此 ATAS 合约的最小跳动或价格范围。 ");
    }
    private static void ValidateProtection(int direction, decimal entry, decimal tp, decimal sl)
    {
        if (tp > 0 && direction * (tp - entry) <= 0 || sl > 0 && direction * (sl - entry) >= 0)
            throw new ArgumentException("止盈止损价格与入场方向不符。 ");
    }

    private void LoadProtections()
    {
        try
        {
            if (!File.Exists(_protectionPath)) return;
            var saved = JsonSerializer.Deserialize<List<Protection>>(File.ReadAllText(_protectionPath), ExecutionJournal.Json);
            if (saved is null) throw new JsonException("空的止盈止损记录");
            foreach (var p in saved.Where(p => !p.Closed)) { p.Recovered = true; _protections.Add(p); }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        { _protectionLoadError = "止盈止损归档加载失败，请在 ATAS 检查保护单：" + e.Message; }
    }
    private void SaveProtections()
    {
        // Never replace a file we failed to recover with an incomplete in-memory list.
        if (_protectionLoadError is not null) throw new InvalidOperationException(_protectionLoadError);
        try
        {
            var temp = _protectionPath + ".tmp";
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, _protections.Where(p => !p.Closed).ToArray(), ExecutionJournal.Json);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temp, _protectionPath, overwrite: true);
            _protectionSaveError = null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _protectionSaveError = "止盈止损归档保存失败：" + e.Message;
            throw;
        }
        finally { RefreshProtectionErrors(); }
    }

    private bool DrainFailures()
    {
        var changed = false;
        while (_failures.TryDequeue(out var failure))
        {
            _operationFailures[(failure.Account, failure.Order, failure.Operation)] = failure;
            foreach (var p in _protections.Where(p => !p.Closed && p.Account == failure.Account &&
                (p.TargetOrder == failure.Order || p.StopOrder == failure.Order)))
            {
                var leg = p.TargetOrder == failure.Order ? "止盈" : "止损";
                var action = failure.Operation switch { OrderOperation.Register => "委托", OrderOperation.Cancel => "撤单", _ => "改单" };
                var error = $"{leg}{action}失败：{failure.Reason}";
                if (p.Error == error) continue;
                p.Error = error;
                changed = true;
            }
        }
        // Failure reasons serve only the matching in-flight request; they are not a persistent alert feed.
        if (_operationFailures.Count > 256)
            foreach (var key in _operationFailures.OrderBy(x => x.Value.Sequence).Take(_operationFailures.Count - 256).Select(x => x.Key).ToArray())
                _operationFailures.Remove(key);
        RefreshProtectionErrors();
        return changed;
    }

    private async Task ExecuteOrderAsync(IDataFeedConnector connector, Order order, OrderOperation operation, Func<Task> send)
    {
        _stop.Token.ThrowIfCancellationRequested();
        var account = AccountKey(connector, order.AccountID ?? order.Portfolio?.AccountID ?? "");
        var key = OrderKey(order);
        var afterSequence = Volatile.Read(ref _failureSequence);
        Exception? requestError = null;
        try { await WaitForVenueAsync(send()).ConfigureAwait(false); }
        catch (Exception e) { requestError = e; }
        var changed = DrainFailures();
        if (changed) SaveProtections();
        if (_operationFailures.TryGetValue((account, key, operation), out var failure) && failure.Sequence > afterSequence)
            throw new OrderRejectedException(failure.Reason);
        if (requestError is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(requestError).Throw();
    }

    private void RefreshProtectionErrors()
    {
        _globalProtectionError = JoinErrors(_protectionLoadError, _protectionSaveError, _synchronizationError);
        var errors = _protections.Where(p => !p.Closed && !string.IsNullOrWhiteSpace(p.Error)).ToArray();
        _accountProtectionErrors = errors.GroupBy(p => p.Account, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => JoinErrors(g.Select(p => $"{p.Symbol}：{p.Error}").ToArray())!, StringComparer.Ordinal);
        _syncError = JoinErrors(new[] { _globalProtectionError }.Concat(errors.Select(p =>
            $"{p.Account[(p.Account.IndexOf(':') + 1)..]} / {p.Symbol}：{p.Error}")).ToArray());
    }

    private static string? JoinErrors(params string?[] errors)
    {
        var text = string.Join("；", errors.Where(e => !string.IsNullOrWhiteSpace(e)).Distinct(StringComparer.Ordinal));
        return text.Length == 0 ? null : text;
    }
    private void Unsubscribe(IDataFeedConnector connector)
    {
        connector.NewMyTrades -= OnTrades;
        connector.OrdersRegisterFailed -= OnRegisterFailed;
        connector.OrdersCancelFailed -= OnCancelFailed;
        connector.OrderModifyFailed -= OnModifyFailed;
        _subscribed.Remove(connector);
    }
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _stop.Cancel();
        // Do not cancel live orders merely because the chart/plugin is removed.
        // The worker owns final persistence and can finish without blocking the ATAS GUI thread.
        Disposal = CompleteDisposalAsync();
    }

    internal async Task CompleteDisposalAsync()
    {
        await _worker.ConfigureAwait(false);
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            lock (_eventLock)
            {
                _acceptEvents = false;
                foreach (var connector in _subscribed.ToArray()) Unsubscribe(connector);
                DrainFills();
                if (DrainFailures()) SaveProtections();
            }
            _journal.Flush();
        }
        finally { _gate.Release(); }
    }

    private string PositionKey(IDataFeedConnector connector, string account, Security security) => AccountKey(connector, account) + "|" + Symbol(security);
    private string FillKey(IDataFeedConnector connector, MyTrade trade) => AccountKey(connector, trade.Portfolio?.AccountID ?? trade.AccountID ?? "") + "|" +
        (trade.Security is { } security ? Symbol(security) : trade.SecurityId ?? "") + "|" +
        (!string.IsNullOrEmpty(trade.Id) ? trade.Id : JsonSerializer.Serialize(new object[] { trade.OrderId ?? "", UnixMs(trade.Time), trade.Price, trade.Volume, trade.OrderDirection.ToString() }));
    private void DrainFills()
    {
        while (_fills.TryDequeue(out var fill))
        {
            Archive(fill.Connector, fill.Trade);
            ObserveFill(fill.Connector, fill.Trade, updatePosition: true);
        }
    }
    private void ObserveFill(IDataFeedConnector connector, MyTrade trade, bool updatePosition)
    {
        if (!_seenFills.Add(FillKey(connector, trade))) return;
        var account = trade.Portfolio?.AccountID ?? trade.AccountID;
        if (string.IsNullOrEmpty(account)) return;
        var order = trade.Order;
        var orderKey = AccountKey(connector, account) + "|" + (order is null ? trade.OrderId : OrderKey(order));
        _knownFilled[orderKey] = _knownFilled.GetValueOrDefault(orderKey) + trade.Volume;
        var security = trade.Security ?? order?.Security;
        if (!updatePosition || security is null) return;
        var key = PositionKey(connector, account, security);
        _expectedPositions[key] = _expectedPositions.GetValueOrDefault(key) +
            (trade.OrderDirection == OrderDirections.Buy ? trade.Volume : -trade.Volume);
    }
    private decimal KnownFilled(IDataFeedConnector connector, Portfolio portfolio, Order order) =>
        _knownFilled.GetValueOrDefault(AccountKey(connector, portfolio.AccountID) + "|" + OrderKey(order));
    private Task WaitForVenueAsync(Task task) => task.WaitAsync(TimeSpan.FromSeconds(8), _stop.Token);
}
