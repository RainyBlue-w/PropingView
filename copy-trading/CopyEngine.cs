using System.Text.Json;
using System.Collections.Concurrent;

namespace CopyTrading;

/// <summary>
/// Single-writer, fill-driven copier. Every market request has a durable intent and is
/// submitted at most once. A failed/uncertain request stops the group; it is never retried.
/// </summary>
public sealed class CopyEngine(ITradingBridge bridge, IStateStore store, TimeProvider? time = null)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly TimeProvider clock = time ?? TimeProvider.System;
    private PersistedState state = new();
    private readonly Dictionary<string, SymbolDetails> resolved = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> stopRequests = new(StringComparer.Ordinal);
    private int stopAllRequests;
    private bool initialized;
    private bool storageFault;
    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();
    private static string AccountKey(AccountRef account) => account.Provider.ToUpperInvariant() + " · " + account.Name;
    private static string ExecutionKey(Execution row) => JsonSerializer.Serialize(new[] { row.Instrument, row.ExecutionId });
    private static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, JsonStateStore.Json), JsonStateStore.Json)!;

    public async Task InitializeAsync()
    {
        await gate.WaitAsync();
        try
        {
            if (initialized) return;
            state = store.Load();
            foreach (var rule in state.Rules)
            {
                Validate(rule.Config);
                if (rule.Status == "running" || rule.Pending != null)
                {
                    rule.Status = "error";
                    rule.Error = rule.Pending != null
                        ? "服务重启，存在未确认的复制请求。请核对真实订单和持仓；系统不会重新发送。"
                        : "服务已重启，跟随已暂停。请核对账户后重新启用。";
                    Log(rule, "error", rule.Error);
                }
            }
            Persist();
            initialized = true;
        }
        finally { gate.Release(); }
    }

    public async Task<CopySnapshot> SnapshotAsync()
    {
        await gate.WaitAsync();
        try
        {
            EnsureInitialized();
            return new(1, state.Rules.Select(r => new RuleView(Clone(r.Config), r.Status, r.Error, r.StartedAt, r.LastPollAt, r.CopiedOrders)).ToArray(),
                state.Logs.TakeLast(200).Reverse().ToArray());
        }
        finally { gate.Release(); }
    }

    public async Task SaveRuleAsync(RuleConfig config)
    {
        await gate.WaitAsync();
        try
        {
            EnsureWritable();
            config = Clone(config);
            config.Name = config.Name?.Trim() ?? "";
            if (string.IsNullOrWhiteSpace(config.Id)) config.Id = Guid.NewGuid().ToString("N");
            Validate(config);
            var old = state.Rules.Find(r => r.Config.Id == config.Id);
            if (old?.Status == "running") throw new InvalidOperationException("请先停用该规则再编辑。");
            if (old == null)
            {
                if (state.Rules.Count >= 20) throw new ArgumentException("最多保存 20 条跟随规则。");
                state.Rules.Add(new() { Config = config });
            }
            else old.Config = config;
            Persist();
        }
        finally { gate.Release(); }
    }

    public async Task StartAsync(string id)
    {
        await gate.WaitAsync();
        try
        {
            EnsureWritable();
            var rule = Find(id);
            if (rule.Status == "running") return;
            Validate(rule.Config);
            var accounts = Accounts(rule.Config).ToHashSet();
            if (state.Rules.Any(other => other != rule && other.Status == "running" && Accounts(other.Config).Any(accounts.Contains)))
                throw new InvalidOperationException("账户已用于另一条运行规则，不能重复跟随或形成循环。");
            try
            {
                var available = await bridge.GetAccountsAsync();
                foreach (var account in Accounts(rule.Config))
                {
                    if (!available.Any(a => a.Provider == account.Provider && a.Name == account.Name))
                        throw new InvalidOperationException($"账户未连接：{account.Provider} · {account.Name}");
                    await RequireFlatAsync(account);
                }
                foreach (var follower in rule.Config.Followers)
                    foreach (var mapping in follower.Mappings)
                    {
                        await ResolveExact(rule.Config.Leader.Provider, mapping.SourceSymbol);
                        await ResolveExact(follower.Account.Provider, mapping.TargetSymbol);
                    }
                // Capture a baseline, then check the leader remained flat across the read.
                // Late historic records older than this boundary cannot become new signals.
                var boundary = Now;
                var baseline = await bridge.GetExecutionsAsync(rule.Config.Leader, boundary - 2000);
                if (baseline.Any(e => e.TimeMs >= boundary))
                    throw new InvalidOperationException("启用检查期间主账户发生了成交，请等账户空仓且没有新交易后再启用。");
                await RequireFlatAsync(rule.Config.Leader);
                foreach (var follower in rule.Config.Followers) await RequireFlatAsync(follower.Account);
                rule.Seen = baseline.Select(ExecutionKey).ToHashSet(StringComparer.Ordinal);
                rule.SourcePositions.Clear();
                rule.Followers = rule.Config.Followers.Select(f => new FollowerRuntime { Account = f.Account }).ToList();
                rule.StartedAt = boundary;
                rule.LastPollAt = Now;
                rule.Pending = null;
                rule.Error = null;
                rule.Status = "running";
                Log(rule, "info", "已启用成交跟随，从新成交开始；历史成交和已有仓位不复制。");
                Persist();
            }
            catch (Exception ex) { Fault(rule, ex.Message); throw; }
        }
        finally { gate.Release(); }
    }

    public async Task StopAsync(string id)
    {
        stopRequests[id] = 0;
        await gate.WaitAsync();
        try
        {
            EnsureInitialized();
            var rule = Find(id);
            rule.Status = "stopped";
            Log(rule, "info", "已停用跟随，账户现有持仓和订单保持不变。");
            Persist();
        }
        finally { stopRequests.TryRemove(id, out _); gate.Release(); }
    }

    public async Task StopAllAsync()
    {
        Interlocked.Increment(ref stopAllRequests);
        await gate.WaitAsync();
        try
        {
            EnsureInitialized();
            foreach (var rule in state.Rules.Where(r => r.Status == "running"))
            {
                rule.Status = "stopped";
                Log(rule, "info", "已全部停用，账户现有持仓和订单保持不变。");
            }
            Persist();
        }
        finally { Interlocked.Decrement(ref stopAllRequests); gate.Release(); }
    }

    public async Task DeleteAsync(string id)
    {
        await gate.WaitAsync();
        try
        {
            EnsureWritable();
            var rule = Find(id);
            if (rule.Status == "running") throw new InvalidOperationException("请先停用规则再删除。");
            state.Rules.Remove(rule);
            Persist();
        }
        finally { gate.Release(); }
    }

    public async Task PollAsync()
    {
        await gate.WaitAsync();
        try
        {
            EnsureInitialized();
            if (storageFault) return;
            foreach (var rule in state.Rules.Where(r => r.Status == "running").ToArray())
            {
                if (storageFault) break;
                try
                {
                    CheckStopRequested(rule);
                    if (Now - rule.LastPollAt > 15000)
                        throw new InvalidOperationException("跟随检查中断超过 15 秒，已暂停以免补发过时交易。");
                    // Re-read an overlapping window. Seen IDs survive restart; each bridge
                    // completes and validates pagination before any order can be sent.
                    var from = Math.Max(rule.StartedAt!.Value - 2000, rule.LastPollAt!.Value - 15000);
                    var rows = await bridge.GetExecutionsAsync(rule.Config.Leader, from);
                    var fresh = rows.Where(e => e.TimeMs >= rule.StartedAt && !rule.Seen.Contains(ExecutionKey(e)))
                        .OrderBy(e => e.TimeMs).ThenBy(e => e.ExecutionId, StringComparer.Ordinal).ToArray();
                    foreach (var row in fresh)
                    {
                        CheckStopRequested(rule);
                        // Duplicate identities inside one API response also count only once.
                        if (rule.Seen.Contains(ExecutionKey(row))) continue;
                        ValidateExecution(row);
                        if (Now - row.TimeMs > 15000 || row.TimeMs > Now + 2000)
                            throw new InvalidOperationException("成交时间已过期或超前，已暂停跟随，请核对平台时间和账户。");
                        await FollowAsync(rule, row);
                    }
                    // Check manual target changes even when the leader is idle.
                    foreach (var target in rule.Followers) await VerifyTargetAsync(target);
                    rule.LastPollAt = Now;
                    // Keep the de-duplication ledger bounded by the rolling read window.
                    // Never prune a row still visible in that window.
                    if (rule.Seen.Count > 5000)
                        rule.Seen.IntersectWith(rows.Select(ExecutionKey));
                }
                catch (StopRequestedException)
                {
                    // Stop checks only run before submission, or after the previous
                    // request was confirmed. This intent was never sent.
                    rule.Pending = null;
                }
                catch (Exception ex) { Fault(rule, ex.Message); }
            }
        }
        finally { gate.Release(); }
    }

    private async Task FollowAsync(RuleRuntime rule, Execution row)
    {
        decimal sign = row.Side.Equals("Buy", StringComparison.OrdinalIgnoreCase) ? 1 : -1;
        var sourceNet = rule.SourcePositions.GetValueOrDefault(row.Instrument) + sign * row.Qty;
        var plans = new List<(FollowerConfig Config, FollowerRuntime Runtime, string Symbol, decimal Desired, int Delta)>();
        // Validate all targets before submitting the first request in this fill.
        foreach (var config in rule.Config.Followers)
        {
            var target = rule.Followers.Single(r => r.Account == config.Account);
            var mapping = config.Mappings.Find(m => m.SourceSymbol == row.Instrument);
            var symbol = mapping?.TargetSymbol ?? (config.Account.Provider == rule.Config.Leader.Provider ? row.Instrument : null);
            if (symbol == null) throw new InvalidOperationException($"缺少跨桥合约映射：{row.Instrument} → {config.Account.Provider}。");
            if (target.TargetSources.TryGetValue(symbol, out var previousSource) && previousSource != row.Instrument)
                throw new InvalidOperationException($"多个源合约映射到 {symbol}，已暂停以免持仓混合。");
            await ResolveExact(rule.Config.Leader.Provider, row.Instrument);
            await ResolveExact(config.Account.Provider, symbol);
            await VerifyTargetAsync(target);
            var desired = decimal.Truncate(sourceNet * config.Multiplier);
            var delta = desired - target.Positions.GetValueOrDefault(symbol);
            if (Math.Abs(delta) > config.MaxOrderQuantity || Math.Abs(delta) > int.MaxValue)
                throw new InvalidOperationException($"{config.Account.Name} 的复制数量 {Math.Abs(delta)} 超过最大单笔手数 {config.MaxOrderQuantity}。");
            plans.Add((config, target, symbol, desired, (int)delta));
        }
        rule.Seen.Add(ExecutionKey(row));
        rule.SourcePositions[row.Instrument] = sourceNet;
        Persist();
        foreach (var plan in plans)
        {
            CheckStopRequested(rule);
            if (Now - row.TimeMs > 15000)
                throw new InvalidOperationException("等待其他跟随账户期间成交已过期，已暂停，请核对账户。");
            // Previous targets may have taken time to settle; the next account can
            // have changed manually while we waited. Never dispatch from that old snapshot.
            await VerifyTargetAsync(plan.Runtime);
            CheckStopRequested(rule);
            if (Now - row.TimeMs > 15000)
                throw new InvalidOperationException("目标账户核对期间成交已过期，已暂停，请核对账户。");
            plan.Runtime.TargetSources[plan.Symbol] = row.Instrument;
            if (plan.Delta == 0)
            {
                Log(rule, "info", "按净持仓倍率计算后无需增减仓。", row, plan.Config.Account, plan.Symbol, 0);
                Persist();
                continue;
            }
            var quantity = Math.Abs(plan.Delta);
            var action = plan.Delta > 0 ? "BUY" : "SELL";
            rule.Pending = new() { ExecutionId = row.ExecutionId, Account = plan.Config.Account, Symbol = plan.Symbol, Action = action, Quantity = quantity };
            // Durable write BEFORE dispatch. A crash at any subsequent step requires
            // operator reconciliation, not a retry (bridge APIs have no idempotency key).
            Log(rule, "info", "正在发送复制市价单。", row, plan.Config.Account, plan.Symbol, quantity);
            Persist();
            CheckStopRequested(rule);
            OrderReceipt receipt;
            void BeforeSend()
            {
                CheckStopRequested(rule);
                if (Now - row.TimeMs > 15000) throw new InvalidOperationException("发送前成交已过期，已暂停跟随。");
            }
            try
            {
                BeforeSend();
                receipt = bridge is IGuardedTradingBridge guarded
                    ? await guarded.PlaceMarketAsync(plan.Config.Account, plan.Symbol, action, quantity, BeforeSend)
                    : await bridge.PlaceMarketAsync(plan.Config.Account, plan.Symbol, action, quantity);
            }
            catch (StopRequestedException) { throw; }
            catch (Exception ex) { throw new InvalidOperationException("复制下单失败或结果未确认，请核对目标账户；不会自动重发。" + ex.Message, ex); }
            rule.Pending.OrderId = receipt.OrderId;
            Persist();
            if (string.IsNullOrWhiteSpace(receipt.OrderId))
                throw new InvalidOperationException("平台未返回复制订单编号，请核对目标账户；不会自动重发。");
            var expected = new Dictionary<string, decimal>(plan.Runtime.Positions, StringComparer.Ordinal) { [plan.Symbol] = plan.Desired };
            bool confirmed = false;
            for (int attempt = 0; attempt < 20; attempt++)
            {
                var positions = await bridge.GetPositionsAsync(plan.Config.Account);
                var orders = await bridge.GetOrdersAsync(plan.Config.Account);
                if (PositionsMatch(positions, expected) && orders.Count == 0) { confirmed = true; break; }
                await Task.Delay(100);
            }
            if (!confirmed) throw new InvalidOperationException($"复制订单 {receipt.OrderId} 的成交与目标持仓尚未确认，已暂停，请在平台核对。");
            plan.Runtime.Positions[plan.Symbol] = plan.Desired;
            rule.Pending = null;
            rule.CopiedOrders++;
            Log(rule, "info", "复制订单已确认成交。", row, plan.Config.Account, plan.Symbol, quantity, receipt.OrderId);
            Persist();
        }
    }

    private async Task VerifyTargetAsync(FollowerRuntime target)
    {
        var positions = await bridge.GetPositionsAsync(target.Account);
        var orders = await bridge.GetOrdersAsync(target.Account);
        if (!PositionsMatch(positions, target.Positions) || orders.Count != 0)
            throw new InvalidOperationException($"跟随账户 {target.Account.Name} 的持仓或订单发生额外变化，已暂停，请核对账户。");
    }

    private async Task RequireFlatAsync(AccountRef account)
    {
        if ((await bridge.GetPositionsAsync(account)).Any(p => p.Quantity != 0) || (await bridge.GetOrdersAsync(account)).Count != 0)
            throw new InvalidOperationException($"启用前，账户 {account.Name} 必须空仓且没有工作中订单。");
    }

    private async Task<SymbolDetails> ResolveExact(string provider, string symbol)
    {
        var key = provider + "\n" + symbol;
        if (resolved.TryGetValue(key, out var value)) return value;
        value = await bridge.ResolveAsync(provider, symbol);
        if (value.Symbol != symbol || value.TickSize <= 0 || value.PointValue <= 0)
            throw new InvalidOperationException($"合约 {symbol} 未被 {provider} 精确识别，请使用平台返回的完整合约名称。");
        resolved[key] = value;
        return value;
    }

    private static bool PositionsMatch(IReadOnlyList<Position> actual, Dictionary<string, decimal> expected)
    {
        var amounts = actual.GroupBy(p => p.Instrument, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Sum(p => p.Quantity), StringComparer.Ordinal);
        return amounts.All(p => p.Value == expected.GetValueOrDefault(p.Key)) && expected.All(p => p.Value == amounts.GetValueOrDefault(p.Key));
    }

    private static IEnumerable<AccountRef> Accounts(RuleConfig rule) => new[] { rule.Leader }.Concat(rule.Followers.Select(f => f.Account));
    private static void Validate(RuleConfig rule)
    {
        if (rule == null || string.IsNullOrWhiteSpace(rule.Name) || rule.Name.Length > 100 || string.IsNullOrWhiteSpace(rule.Id) || rule.Id.Length > 100)
            throw new ArgumentException("请填写有效规则名称。");
        if (rule.Followers == null || rule.Followers.Count is < 1 or > 20 || rule.Followers.Any(f => f == null))
            throw new ArgumentException("请选择 1 至 20 个跟随账户。");
        foreach (var account in Accounts(rule))
            if (account == null || account.Provider is not ("nt8" or "atas") || string.IsNullOrWhiteSpace(account.Name) || account.Name == "SIM-REPLAY")
                throw new ArgumentException("请选择有效的 NT8 或 ATAS 账户。");
        if (Accounts(rule).Distinct().Count() != rule.Followers.Count + 1)
            throw new ArgumentException("主账户不能跟随自身，跟随账户不能重复。");
        foreach (var follower in rule.Followers)
        {
            if (follower.Multiplier <= 0 || follower.Multiplier > 100 || follower.MaxOrderQuantity is < 1 or > 10000)
                throw new ArgumentException("数量倍率须大于 0 且不超过 100，最大单笔手数须为 1 至 10000 的整数。");
            if (follower.Mappings == null || follower.Mappings.Count > 100 || follower.Mappings.Any(m => m == null || string.IsNullOrWhiteSpace(m.SourceSymbol) || string.IsNullOrWhiteSpace(m.TargetSymbol)))
                throw new ArgumentException("请填写完整的源合约和目标合约映射。");
            if (follower.Mappings.Select(m => m.SourceSymbol).Distinct().Count() != follower.Mappings.Count || follower.Mappings.Select(m => m.TargetSymbol).Distinct().Count() != follower.Mappings.Count)
                throw new ArgumentException("每个源合约、目标合约只能出现一次。");
            if (follower.Account.Provider != rule.Leader.Provider && follower.Mappings.Count == 0)
                throw new ArgumentException("跨 NT8 / ATAS 跟随必须填写明确的合约映射。");
        }
    }

    private static void ValidateExecution(Execution row)
    {
        if (string.IsNullOrWhiteSpace(row.ExecutionId) || string.IsNullOrWhiteSpace(row.Instrument) || row.Qty <= 0 || row.Qty != decimal.Truncate(row.Qty)
            || !(row.Side.Equals("Buy", StringComparison.OrdinalIgnoreCase) || row.Side.Equals("Sell", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("源成交缺少有效编号、整数数量或买卖方向，已暂停跟随。");
    }

    private RuleRuntime Find(string id) => state.Rules.Find(r => r.Config.Id == id) ?? throw new ArgumentException("未找到跟随规则。");
    private sealed class StopRequestedException : Exception;
    private void CheckStopRequested(RuleRuntime rule)
    {
        if (Volatile.Read(ref stopAllRequests) != 0 || stopRequests.ContainsKey(rule.Config.Id)) throw new StopRequestedException();
    }
    private void EnsureInitialized() { if (!initialized) throw new InvalidOperationException("复制交易服务尚未就绪。"); }
    private void EnsureWritable() { EnsureInitialized(); if (storageFault) throw new IOException("本地状态保存异常，跟随已停止。请修复存储并重启服务。"); }
    private void Persist()
    {
        try { store.Save(state); }
        catch
        {
            storageFault = true;
            foreach (var rule in state.Rules.Where(r => r.Status == "running"))
            {
                rule.Status = "error";
                rule.Error = "本地状态保存失败，已停止发送复制订单。请核对账户并修复存储。";
            }
            throw;
        }
    }

    private void Fault(RuleRuntime rule, string message)
    {
        rule.Status = "error";
        rule.Error = message;
        Log(rule, "error", message);
        try { Persist(); } catch { /* Persist already disabled every running rule. */ }
    }

    private void Log(RuleRuntime rule, string level, string message, Execution? source = null, AccountRef? follower = null, string? target = null, int? quantity = null, string? orderId = null)
    {
        state.Logs.Add(new(Guid.NewGuid().ToString("N"), Now, rule.Config.Id, level, message, source?.ExecutionId,
            follower == null ? null : AccountKey(follower), source?.Instrument, target, quantity, orderId));
        if (state.Logs.Count > 2000) state.Logs.RemoveRange(0, state.Logs.Count - 2000);
    }
}
