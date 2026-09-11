using System.Text.Json;

namespace TvAtasBridge;

internal sealed record BridgeExecution(
    long Time, long TimeMs, decimal Price, decimal Qty, string Side,
    string OrderId, string ExecutionId, string Instrument, string Account,
    decimal? Commission, decimal? PointValue, string? Currency, string? AccountDisplayName = null);

/// <summary>Append-only local fills, independent of ATAS's finite in-memory history.</summary>
internal sealed class ExecutionJournal
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Dictionary<string, BridgeExecution> _records = new(StringComparer.Ordinal);
    private readonly Dictionary<string, BridgeExecution> _pending = new(StringComparer.Ordinal);
    private readonly string _path;
    private string? _error;
    private string? _warning;
    private long? _lastSavedAt;

    public ExecutionJournal(string directory)
    {
        _path = Path.Combine(directory, "executions.jsonl");
        try
        {
            Directory.CreateDirectory(directory);
            if (!File.Exists(_path)) return;
            var invalid = 0;
            foreach (var line in File.ReadLines(_path))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var execution = JsonSerializer.Deserialize<BridgeExecution>(line, Json);
                    if (execution is not null && execution.Qty > 0 && !string.IsNullOrEmpty(execution.ExecutionId))
                        _records[Key(execution)] = execution;
                    else invalid++;
                }
                catch (JsonException) { invalid++; }
            }
            if (invalid != 0) _warning = $"成交归档有 {invalid} 行损坏；完整记录已保留。";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            _error = "无法读取 ATAS 成交归档：" + error.Message;
        }
    }

    private static string Key(BridgeExecution e) => JsonSerializer.Serialize(new[] { e.Account, e.Instrument, e.ExecutionId });

    public void Add(BridgeExecution execution)
    {
        var key = Key(execution);
        if (_records.TryGetValue(key, out var existing) && existing == execution) return;
        _records[key] = execution;
        _pending[key] = execution;
    }

    public void Flush()
    {
        if (_pending.Count == 0) return;
        try
        {
            // Prefixing each append with a newline also isolates a torn last record after a crash.
            using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), leaveOpen: true);
            writer.WriteLine();
            foreach (var record in _pending.Values) writer.WriteLine(JsonSerializer.Serialize(record, Json));
            writer.Flush();
            stream.Flush(flushToDisk: true);
            _pending.Clear();
            _lastSavedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            _error = null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            _error = "无法保存 ATAS 成交归档：" + error.Message;
        }
    }

    public object Status => StatusWithWarning(null);
    public object StatusWithWarning(string? extraWarning) => new
    {
        version = 1, state = _error is null ? "ready" : "error", path = _path,
        recordCount = _records.Count, pendingCount = _pending.Count, lastSavedAt = _lastSavedAt,
        error = _error, warning = string.Join(" ", new[] { _warning, extraWarning }.Where(s => !string.IsNullOrWhiteSpace(s))),
    };

    public object Query(string? account, string? symbol, long from, long to, int offset, int? limit, string? warning = null)
    {
        var rows = _records.Values.Where(e =>
            (string.IsNullOrEmpty(account) || e.Account == account) &&
            (string.IsNullOrEmpty(symbol) || e.Instrument.Equals(symbol, StringComparison.OrdinalIgnoreCase)) &&
            e.Time >= from && e.Time <= to)
            .OrderByDescending(e => e.TimeMs).ThenByDescending(e => e.ExecutionId, StringComparer.Ordinal).ToArray();
        var page = limit is null ? rows : rows.Skip(offset).Take(limit.Value).ToArray();
        return new { executions = page, total = rows.Length,
            nextOffset = limit is not null && offset + page.Length < rows.Length ? (int?)(offset + page.Length) : null,
            archive = StatusWithWarning(warning) };
    }
}

internal static class ProtectionMath
{
    public static decimal RoundPrice(decimal price, decimal tick)
    {
        if (tick <= 0) throw new InvalidOperationException("ATAS 尚未提供有效最小价格变动。请先加载该合约。 ");
        return decimal.Round(price / tick, 0, MidpointRounding.AwayFromZero) * tick;
    }

    public static decimal AmountPrice(decimal fill, decimal amount, decimal quantity, decimal tick, decimal tickCost, int direction)
    {
        if (amount <= 0 || quantity <= 0 || tickCost <= 0)
            throw new ArgumentException("金额、成交数量和每跳价值必须大于零。 ");
        // At least one tick away from the fill, even when the requested amount is below one tick.
        var ticks = Math.Max(1, decimal.Round(amount / (quantity * tickCost), 0, MidpointRounding.AwayFromZero));
        return RoundPrice(fill + direction * ticks * tick, tick);
    }

    public static decimal DesiredQuantity(decimal position, int protectedDirection) =>
        Math.Sign(position) == protectedDirection ? Math.Abs(position) : 0;
}
