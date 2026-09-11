using System.Text.Json;
using CopyTrading;

// Fake bridge only. This process has no network client or access to a trading platform.
int checks = 0;
void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; }
async Task Reject(Func<Task> action, string text)
{
    try { await action(); throw new Exception("Expected rejection: " + text); }
    catch (Exception ex) when (ex.Message.Contains(text, StringComparison.Ordinal)) { checks++; }
}
async Task<(CopyEngine Engine, FakeBridge Bridge, MemoryStore Store, FakeTime Clock)> Setup(decimal multiplier = 1, bool cross = false)
{
    var clock = new FakeTime(); var bridge = new FakeBridge(clock); var store = new MemoryStore();
    var engine = new CopyEngine(bridge, store, clock); await engine.InitializeAsync();
    var config = Config(multiplier, cross); await engine.SaveRuleAsync(config); await engine.StartAsync("one");
    return (engine, bridge, store, clock);
}
RuleConfig Config(decimal multiplier = 1, bool cross = false) => new()
{
    Id = "one", Name = "Test copier", Leader = FakeBridge.Leader,
    Followers = [new() { Account = cross ? FakeBridge.Cross : FakeBridge.Follower, Multiplier = multiplier,
        MaxOrderQuantity = 10, Mappings = cross ? [new("NQ 09-26", "NQU6@CME")] : [] }],
};

try
{
{
    var (engine, bridge, _, _) = await Setup();
    Check(bridge.Sent.Count == 0, "Enable never sends orders");
    bridge.Fill("a", "Buy", 2); await engine.PollAsync();
    Check(bridge.Sent.Single().Qty == 2 && bridge.Sent.Single().Action == "BUY", "Copy initial buy");
    await engine.PollAsync(); await engine.PollAsync();
    Check(bridge.Sent.Count == 1, "Overlapping polls do not duplicate fills");
    bridge.Fill("b", "Buy", 1); await engine.PollAsync();
    bridge.Fill("c", "Sell", 2); await engine.PollAsync();
    bridge.Fill("d", "Sell", 3); await engine.PollAsync();
    bridge.Fill("e", "Buy", 2); await engine.PollAsync();
    Check(bridge.Sent.Select(s => s.Qty).SequenceEqual([2, 1, 2, 3, 2]), "Add, partial exit, reverse, close preserve deltas");
    Check(bridge.Net(FakeBridge.Follower, "NQ 09-26") == 0, "Follower flat after source closes");
    Check((await engine.SnapshotAsync()).Rules[0].CopiedOrders == 5, "Only confirmed market fills count");
}
{
    var (engine, bridge, _, _) = await Setup(.5m);
    bridge.Fill("a", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 0, "Half multiplier retains cumulative fractional exposure");
    bridge.Fill("b", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Single().Qty == 1, "Two one-lot partial fills combine into one target lot");
    bridge.Fill("c", "Sell", 1); await engine.PollAsync();
    Check(bridge.Sent.Last().Action == "SELL" && bridge.Net(FakeBridge.Follower, "NQ 09-26") == 0, "Scaling rounds net position, not each independent exit");
    bridge.Fill("d", "Sell", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 2, "Final fractional reduction does not open a short");
}
{
    var (engine, bridge, _, _) = await Setup(2, true);
    bridge.Fill("a", "Sell", 2); await engine.PollAsync();
    Check(bridge.Sent.Single() == new Sent(FakeBridge.Cross, "NQU6@CME", "SELL", 4), "Cross bridge preserves explicit native symbol and account");
    bridge.Fill("b", "Buy", 2); await engine.PollAsync();
    Check(bridge.Net(FakeBridge.Cross, "NQU6@CME") == 0, "Stop/target exit copied once without attached target bracket");
}
{
    var clock = new FakeTime(); var bridge = new FakeBridge(clock); var store = new MemoryStore(); var engine = new CopyEngine(bridge, store, clock);
    bridge.Fill("old", "Buy", 1); bridge.Positions.Clear(); clock.Advance(10);
    await engine.InitializeAsync(); await engine.SaveRuleAsync(Config()); await engine.StartAsync("one");
    await engine.PollAsync(); Check(bridge.Sent.Count == 0, "Baseline history excluded");
    bridge.Fill("late-old", "Buy", 1, millisecondsAgo: 30000); bridge.Positions.Clear();
    await engine.PollAsync(); Check(bridge.Sent.Count == 0, "Late imported pre-activation history excluded");
    bridge.Fill("new", "Buy", 1); bridge.Executions.Add(bridge.Executions.Last());
    await engine.PollAsync(); Check(bridge.Sent.Count == 1, "Duplicate identity in one response sends once");
}
{
    var (engine, bridge, _, _) = await Setup();
    var rule = Config(); rule.Name = "Edited";
    await Reject(() => engine.SaveRuleAsync(rule), "先停用");
    await Reject(() => engine.DeleteAsync("one"), "先停用");
    var cycle = Config(); cycle.Id = "two"; cycle.Leader = FakeBridge.Follower; cycle.Followers[0].Account = FakeBridge.Leader;
    await engine.SaveRuleAsync(cycle);
    await Reject(() => engine.StartAsync("two"), "形成循环");
    var self = Config(); self.Id = "self"; self.Followers[0].Account = FakeBridge.Leader;
    await Reject(() => engine.SaveRuleAsync(self), "自身");
    var duplicate = Config(); duplicate.Id = "duplicates"; duplicate.Followers.Add(duplicate.Followers[0]);
    await Reject(() => engine.SaveRuleAsync(duplicate), "重复");
    var badMap = Config(cross: true); badMap.Id = "badMap"; badMap.Followers[0].Mappings.Clear();
    await Reject(() => engine.SaveRuleAsync(badMap), "映射");
    await engine.StopAllAsync(); bridge.Fill("after-stop", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 0, "Stop-all never flattens or dispatches subsequent fills");
}
{
    var (engine, bridge, _, _) = await Setup();
    await engine.StopAsync("one"); bridge.SetNet(FakeBridge.Follower, "NQ 09-26", 1);
    await Reject(() => engine.StartAsync("one"), "空仓");
    Check(bridge.Sent.Count == 0, "Preexisting target position never caught up or flattened");
    bridge.Positions.Clear(); bridge.Working.Add((FakeBridge.Leader, new("manual", "NQ 09-26")));
    await Reject(() => engine.StartAsync("one"), "工作中订单");
}
{
    var (engine, bridge, _, _) = await Setup();
    bridge.SetNet(FakeBridge.Follower, "ES 09-26", 1); await engine.PollAsync();
    Check((await engine.SnapshotAsync()).Rules[0].Status == "error", "Manual follower position change pauses even without source fills");
    Check(bridge.Sent.Count == 0, "Never offsets an unrelated manual trade");
}
{
    var (engine, bridge, _, _) = await Setup();
    bridge.Fill("oversized", "Buy", 11); await engine.PollAsync();
    Check(bridge.Sent.Count == 0 && (await engine.SnapshotAsync()).Rules[0].Error!.Contains("最大单笔"), "Size cap checked before any submission");
}
{
    var (engine, bridge, _, _) = await Setup();
    bridge.Fill("invalid", "Unknown", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 0 && (await engine.SnapshotAsync()).Rules[0].Status == "error", "Unknown side never defaults to sell");
}
{
    var (engine, bridge, _, _) = await Setup(cross: true);
    bridge.Fill("unmapped", "Buy", 1, symbol: "ES 09-26"); await engine.PollAsync();
    Check(bridge.Sent.Count == 0 && (await engine.SnapshotAsync()).Rules[0].Error!.Contains("映射"), "No root/month guessing across providers");
}
{
    var (engine, bridge, store, _) = await Setup();
    bridge.FailPost = true; bridge.Fill("timeout", "Buy", 1); await engine.PollAsync(); await engine.PollAsync();
    Check(bridge.Sent.Count == 1, "Uncertain POST submitted at most once");
    Check(store.Load().Rules[0].Pending?.ExecutionId == "timeout", "Pending intent persisted before an uncertain request");
    var restarted = new CopyEngine(bridge, store); await restarted.InitializeAsync(); await restarted.PollAsync();
    Check(bridge.Sent.Count == 1 && (await restarted.SnapshotAsync()).Rules[0].Status == "error", "Restart never replays an uncertain request");
}
{
    var (engine, bridge, _, _) = await Setup();
    bridge.EmptyOrderId = true; bridge.Fill("empty-id", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 1 && (await engine.SnapshotAsync()).Rules[0].Error!.Contains("订单编号"), "Empty platform acknowledgement pauses without retry");
}
{
    var (engine, bridge, store, _) = await Setup();
    store.FailWrites = true; bridge.Fill("disk-full", "Buy", 1); await engine.PollAsync(); await engine.PollAsync();
    Check(bridge.Sent.Count == 0, "A failed durable write prevents all dispatch");
    Check((await engine.SnapshotAsync()).Rules[0].Status == "error", "Storage fault visible and disables copier");
}
{
    var (engine, bridge, _, clock) = await Setup();
    clock.Advance(16000); bridge.Fill("stale", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 0 && (await engine.SnapshotAsync()).Rules[0].Error!.Contains("15 秒"), "Do not catch up after an interrupted poll loop");
}
{
    var (engine, bridge, _, _) = await Setup();
    bridge.FailRead = true; await engine.PollAsync(); bridge.FailRead = false; bridge.Fill("reconnected", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 0 && (await engine.SnapshotAsync()).Rules[0].Status == "error", "Reconnection cannot implicitly re-enable copier");
}
{
    var (engine, bridge, store, _) = await Setup();
    var restarted = new CopyEngine(bridge, store); await restarted.InitializeAsync();
    bridge.Fill("after-restart", "Buy", 1); await restarted.PollAsync();
    Check(bridge.Sent.Count == 0 && (await restarted.SnapshotAsync()).Rules[0].Status == "error", "Even a clean previous running state starts paused");
}
{
    var (engine, bridge, _, _) = await Setup();
    await engine.StopAsync("one");
    var config = Config(); config.Followers.Add(new() { Account = FakeBridge.Cross, Mappings = [new("NQ 09-26", "NQU6@CME")] });
    await engine.SaveRuleAsync(config); await engine.StartAsync("one");
    Task? stopped = null;
    bridge.OnPost = sent => { if (sent.Account == FakeBridge.Follower) stopped = engine.StopAsync("one"); };
    bridge.Fill("during-stop", "Buy", 1); await engine.PollAsync(); await stopped!;
    Check(bridge.Sent.Count == 1, "Pending stop blocks remaining followers after an in-flight request");
    Check((await engine.SnapshotAsync()).Rules[0].Status == "stopped", "Stop finishes with persisted stopped state");
}
{
    var (engine, bridge, _, _) = await Setup();
    await engine.StopAsync("one");
    var config = Config(); config.Followers.Add(new() { Account = FakeBridge.Cross, Mappings = [new("NQ 09-26", "NQU6@CME")] });
    await engine.SaveRuleAsync(config); await engine.StartAsync("one");
    bridge.OnPost = sent => { if (sent.Account == FakeBridge.Follower) bridge.SetNet(FakeBridge.Cross, "NQU6@CME", 1); };
    bridge.Fill("manual-between-followers", "Buy", 1); await engine.PollAsync();
    Check(bridge.Sent.Count == 1 && (await engine.SnapshotAsync()).Rules[0].Status == "error", "Recheck next target after previous target settles");
}
{
    var (engine, bridge, _, _) = await Setup();
    await engine.StopAsync("one");
    bridge.BeforeRead = () => bridge.Fill("entry-during-baseline", "Buy", 1);
    bridge.AfterRead = () => bridge.Fill("exit-during-baseline", "Sell", 1);
    await Reject(() => engine.StartAsync("one"), "检查期间");
    Check(bridge.Sent.Count == 0, "Initialization cannot swallow entry then copy only its exit");
}
{
    var (engine, bridge, store, _) = await Setup();
    var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    bridge.PreflightAsync = async () => { waiting.SetResult(); await proceed.Task; };
    bridge.Fill("stop-during-preflight", "Buy", 1);
    var poll = engine.PollAsync(); await waiting.Task;
    var stopped = engine.StopAllAsync(); proceed.SetResult(); await poll; await stopped;
    Check(bridge.Sent.Count == 0, "Stop during asynchronous preflight blocks the actual POST");
    Check(store.Load().Rules[0].Pending == null, "Unsent paused intent is cleared without an uncertain-order warning");
}
{
    var directory = Path.Combine(Path.GetTempPath(), "copy-state-test-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(directory);
    var store = new JsonStateStore(directory); var state = new PersistedState();
    state.Rules.Add(new() { Config = Config() }); store.Save(state);
    state.Rules[0].CopiedOrders = 1; store.Save(state);
    Check(store.Load().Rules[0].CopiedOrders == 1 && File.Exists(Path.Combine(directory, "state.json.bak")), "Atomic disk state replacement retains backup");
    File.WriteAllText(Path.Combine(directory, "state.json"), "{broken");
    try { store.Load(); throw new Exception("Corrupt state was accepted"); } catch (JsonException) { checks++; }
    // Only explicitly-created files are removed; no recursive deletion.
    foreach (var file in Directory.EnumerateFiles(directory)) File.Delete(file);
    Directory.Delete(directory);
}
Console.WriteLine($"PASS {checks} copy engine checks; fake bridge only, no real orders.");
}
catch (Exception error) { Console.Error.WriteLine(error); return 1; }
return 0;

sealed class FakeTime : TimeProvider
{
    private DateTimeOffset now = new(2026, 9, 11, 12, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => now;
    public void Advance(int ms) => now = now.AddMilliseconds(ms);
}
sealed class MemoryStore : IStateStore
{
    private string json = JsonSerializer.Serialize(new PersistedState());
    public bool FailWrites;
    public PersistedState Load() => JsonSerializer.Deserialize<PersistedState>(json)!;
    public void Save(PersistedState state) { if (FailWrites) throw new IOException("disk full"); json = JsonSerializer.Serialize(state); }
}
sealed record Sent(AccountRef Account, string Symbol, string Action, int Qty);
sealed class FakeBridge(FakeTime clock) : IGuardedTradingBridge
{
    public static readonly AccountRef Leader = new("nt8", "leader");
    public static readonly AccountRef Follower = new("nt8", "follower");
    public static readonly AccountRef Cross = new("atas", "stable-key:TDL");
    public List<Execution> Executions = [];
    public Dictionary<(AccountRef, string), decimal> Positions = [];
    public List<(AccountRef, WorkingOrder)> Working = [];
    public List<Sent> Sent = [];
    public bool FailPost, FailRead, EmptyOrderId;
    public Action<Sent>? OnPost;
    public Action? BeforeRead, AfterRead;
    public Func<Task>? PreflightAsync;
    public decimal Net(AccountRef account, string symbol) => Positions.GetValueOrDefault((account, symbol));
    public void SetNet(AccountRef account, string symbol, decimal amount) => Positions[(account, symbol)] = amount;
    public void Fill(string id, string side, int qty, string symbol = "NQ 09-26", int millisecondsAgo = 0)
    {
        clock.Advance(10);
        Executions.Add(new(id, "source-" + id, symbol, side, qty, 25000, clock.GetUtcNow().ToUnixTimeMilliseconds() - millisecondsAgo));
        SetNet(Leader, symbol, Net(Leader, symbol) + (side == "Buy" ? qty : -qty));
    }
    public Task<IReadOnlyList<AccountInfo>> GetAccountsAsync() => Task.FromResult<IReadOnlyList<AccountInfo>>(
        new[] { Leader, Follower, Cross }.Select(a => new AccountInfo(a.Provider, a.Name, a.Name, "Fake")).ToArray());
    public Task<IReadOnlyList<Position>> GetPositionsAsync(AccountRef account) => Task.FromResult<IReadOnlyList<Position>>(
        Positions.Where(p => p.Key.Item1 == account && p.Value != 0).Select(p => new Position(p.Key.Item2, p.Value)).ToArray());
    public Task<IReadOnlyList<WorkingOrder>> GetOrdersAsync(AccountRef account) => Task.FromResult<IReadOnlyList<WorkingOrder>>(Working.Where(w => w.Item1 == account).Select(w => w.Item2).ToArray());
    public Task<IReadOnlyList<Execution>> GetExecutionsAsync(AccountRef account, long fromMs)
    {
        if (FailRead) throw new IOException("offline");
        BeforeRead?.Invoke();
        var rows = Executions.Where(e => e.TimeMs >= fromMs).ToArray();
        AfterRead?.Invoke();
        return Task.FromResult<IReadOnlyList<Execution>>(rows);
    }
    public Task<SymbolDetails> ResolveAsync(string provider, string symbol) => Task.FromResult(new SymbolDetails(symbol, .25m, 20));
    public Task<OrderReceipt> PlaceMarketAsync(AccountRef account, string symbol, string action, int quantity)
        => PlaceMarketAsync(account, symbol, action, quantity, () => { });
    public async Task<OrderReceipt> PlaceMarketAsync(AccountRef account, string symbol, string action, int quantity, Action beforeSend)
    {
        if (PreflightAsync != null) await PreflightAsync();
        beforeSend();
        Sent.Add(new(account, symbol, action, quantity));
        OnPost?.Invoke(Sent.Last());
        if (FailPost) throw new TimeoutException("timeout after possible acceptance");
        SetNet(account, symbol, Net(account, symbol) + (action == "BUY" ? quantity : -quantity));
        return new OrderReceipt(EmptyOrderId ? "" : "copy-" + Sent.Count);
    }
}
