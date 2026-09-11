namespace CopyTrading;

public sealed record AccountRef(string Provider, string Name);
public sealed record AccountInfo(string Provider, string Name, string DisplayName, string Group);
public sealed record Position(string Instrument, decimal Quantity);
public sealed record WorkingOrder(string OrderId, string Instrument);
public sealed record Execution(string ExecutionId, string OrderId, string Instrument, string Side, decimal Qty, decimal Price, long TimeMs);
public sealed record SymbolDetails(string Symbol, decimal TickSize, decimal PointValue);
public sealed record OrderReceipt(string OrderId);
public sealed record SymbolMapping(string SourceSymbol, string TargetSymbol);

public sealed class FollowerConfig
{
    public AccountRef Account { get; set; } = new("", "");
    public decimal Multiplier { get; set; } = 1;
    public int MaxOrderQuantity { get; set; } = 10;
    public List<SymbolMapping> Mappings { get; set; } = [];
}

public sealed class RuleConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public AccountRef Leader { get; set; } = new("", "");
    public List<FollowerConfig> Followers { get; set; } = [];
}

public interface ITradingBridge
{
    Task<IReadOnlyList<AccountInfo>> GetAccountsAsync();
    Task<IReadOnlyList<Position>> GetPositionsAsync(AccountRef account);
    Task<IReadOnlyList<WorkingOrder>> GetOrdersAsync(AccountRef account);
    Task<IReadOnlyList<Execution>> GetExecutionsAsync(AccountRef account, long fromMs);
    Task<SymbolDetails> ResolveAsync(string provider, string symbol);
    Task<OrderReceipt> PlaceMarketAsync(AccountRef account, string symbol, string action, int quantity);
}

public interface IGuardedTradingBridge : ITradingBridge
{
    // Invoked after asynchronous preflight and immediately before the HTTP POST.
    Task<OrderReceipt> PlaceMarketAsync(AccountRef account, string symbol, string action, int quantity, Action beforeSend);
}

public sealed record CopyLog(string Id, long Time, string RuleId, string Level, string Message,
    string? SourceExecutionId = null, string? FollowerAccount = null, string? SourceSymbol = null,
    string? TargetSymbol = null, int? Quantity = null, string? TargetOrderId = null);
public sealed record RuleView(RuleConfig Config, string Status, string? Error, long? StartedAt, long? LastPollAt, int CopiedOrders);
public sealed record CopySnapshot(int Version, IReadOnlyList<RuleView> Rules, IReadOnlyList<CopyLog> Logs);

// The on-disk state includes write-ahead intents, never exposed as commands to replay.
public sealed class DispatchIntent
{
    public string ExecutionId { get; set; } = "";
    public AccountRef Account { get; set; } = new("", "");
    public string Symbol { get; set; } = "";
    public string Action { get; set; } = "";
    public int Quantity { get; set; }
    public string? OrderId { get; set; }
}

public sealed class FollowerRuntime
{
    public AccountRef Account { get; set; } = new("", "");
    public Dictionary<string, decimal> Positions { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> TargetSources { get; set; } = new(StringComparer.Ordinal);
}

public sealed class RuleRuntime
{
    public RuleConfig Config { get; set; } = new();
    public string Status { get; set; } = "stopped";
    public string? Error { get; set; }
    public long? StartedAt { get; set; }
    public long? LastPollAt { get; set; }
    public int CopiedOrders { get; set; }
    public HashSet<string> Seen { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, decimal> SourcePositions { get; set; } = new(StringComparer.Ordinal);
    public List<FollowerRuntime> Followers { get; set; } = [];
    public DispatchIntent? Pending { get; set; }
}

public sealed class PersistedState
{
    public int Version { get; set; } = 1;
    public List<RuleRuntime> Rules { get; set; } = [];
    public List<CopyLog> Logs { get; set; } = [];
}

public interface IStateStore
{
    PersistedState Load();
    void Save(PersistedState state);
}
