using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;

namespace CopyTrading;

/// <summary>Local bridge transport. Trading writes are sent once; failures are never retried here.</summary>
public sealed class BridgeClient : IGuardedTradingBridge, IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly bool _ownsClient;
    private readonly IReadOnlyDictionary<string, Uri> _origins;
    private const int PageSize = 500;
    private const int MaxPages = 200;

    public BridgeClient(HttpClient? http = null, Uri? nt8 = null, Uri? atas = null)
    {
        _ownsClient = http is null;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        _origins = new Dictionary<string, Uri>(StringComparer.Ordinal)
        {
            ["nt8"] = ValidateOrigin(nt8 ?? new Uri("http://127.0.0.1:8090/")),
            ["atas"] = ValidateOrigin(atas ?? new Uri("http://127.0.0.1:8091/")),
        };
    }

    private static Uri ValidateOrigin(Uri uri)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttp || !uri.IsLoopback
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new ArgumentException("数据桥地址必须是本机 HTTP 回环地址。");
        return new Uri(uri.AbsoluteUri.TrimEnd('/') + "/");
    }

    private Uri Address(string provider, string path)
    {
        if (!_origins.TryGetValue(provider, out var origin)) throw new ArgumentException("未知数据桥。");
        return new Uri(origin, path.TrimStart('/'));
    }

    private async Task<JsonElement> ReadAsync(string provider, string path)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var response = await _http.GetAsync(Address(provider, path), timeout.Token).ConfigureAwait(false);
        var document = await ReadResponseAsync(response, timeout.Token).ConfigureAwait(false);
        return document;
    }

    private static async Task<JsonElement> ReadResponseAsync(HttpResponseMessage response, CancellationToken token)
    {
        if (response.Content.Headers.ContentLength > 16 * 1024 * 1024)
            throw new InvalidOperationException("数据桥响应过大，无法确认完整数据。");
        JsonElement data;
        try { data = await response.Content.ReadFromJsonAsync<JsonElement>(Json, token).ConfigureAwait(false); }
        catch (JsonException) { throw new InvalidOperationException($"数据桥返回无效数据（HTTP {(int)response.StatusCode}）。"); }
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(Text(data, "error") ?? $"数据桥请求失败（HTTP {(int)response.StatusCode}）。");
        return data;
    }

    private async Task<JsonElement> ConnectedStatusAsync(string provider)
    {
        var status = await ReadAsync(provider, "api/status").ConfigureAwait(false);
        if (!Flag(status, "connected") || (provider == "atas" && Text(status, "provider") != "atas")
            || (Text(status, "provider") is { } declared && declared != provider))
            throw new InvalidOperationException($"{provider.ToUpperInvariant()} 数据桥未连接或来源不符。");
        return status;
    }

    private async Task<IReadOnlyList<AccountInfo>> AccountsFromAsync(string provider)
    {
        await ConnectedStatusAsync(provider).ConfigureAwait(false);
        var response = await ReadAsync(provider, "api/accounts").ConfigureAwait(false);
        return Rows(response, "accounts").Where(row => !row.TryGetProperty("connected", out var connected) || connected.ValueKind == JsonValueKind.True)
            .Select(row => new AccountInfo(provider, RequiredText(row, "name"), Text(row, "displayName") ?? RequiredText(row, "name"),
                Text(row, "connection") ?? "本地账户")).ToArray();
    }

    public async Task<IReadOnlyList<AccountInfo>> GetAccountsAsync()
    {
        async Task<IReadOnlyList<AccountInfo>> Available(string provider)
        {
            try { return await AccountsFromAsync(provider).ConfigureAwait(false); }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or InvalidOperationException or JsonException)
            { return Array.Empty<AccountInfo>(); }
        }
        var groups = await Task.WhenAll(Available("nt8"), Available("atas")).ConfigureAwait(false);
        return groups.SelectMany(group => group).ToArray();
    }

    private async Task EnsureAccountAsync(AccountRef account)
    {
        if (account is null || string.IsNullOrWhiteSpace(account.Name)) throw new ArgumentException("缺少账户标识。");
        var accounts = await AccountsFromAsync(account.Provider).ConfigureAwait(false);
        if (accounts.Count(candidate => candidate.Name == account.Name) != 1)
            throw new InvalidOperationException("所选账户未连接、不存在或标识不唯一。");
    }

    public async Task<IReadOnlyList<Position>> GetPositionsAsync(AccountRef account)
    {
        await EnsureAccountAsync(account).ConfigureAwait(false);
        var response = await ReadAsync(account.Provider, "api/positions?account=" + Uri.EscapeDataString(account.Name)
            + (account.Provider == "nt8" ? "&copyStrict=true" : "")).ConfigureAwait(false);
        RequireStrictSnapshot(account, response);
        return Rows(response, "positions").Select(row => new Position(RequiredText(row, "instrument"), Number(row, "quantity"))).ToArray();
    }

    public async Task<IReadOnlyList<WorkingOrder>> GetOrdersAsync(AccountRef account)
    {
        await EnsureAccountAsync(account).ConfigureAwait(false);
        var response = await ReadAsync(account.Provider, "api/orders?account=" + Uri.EscapeDataString(account.Name)
            + (account.Provider == "nt8" ? "&copyStrict=true" : "")).ConfigureAwait(false);
        RequireStrictSnapshot(account, response);
        var orders = Rows(response, "orders").ToArray();
        return orders.Where(row => !new[] { "Filled", "Cancelled", "Canceled", "Rejected", "Expired" }
                .Contains(RequiredText(row, "state"), StringComparer.OrdinalIgnoreCase))
            .Select(row => new WorkingOrder(Text(row, "orderId") ?? "", RequiredText(row, "instrument"))).ToArray();
    }

    private static void RequireStrictSnapshot(AccountRef account, JsonElement data)
    {
        if (account.Provider == "nt8" && !Flag(data, "copyStrict"))
            throw new InvalidOperationException("NT8 数据桥尚不支持跟单所需的完整账户快照，请更新源码并在 NT8 编译。");
    }

    private static void RequireArchive(JsonElement response)
    {
        if (!response.TryGetProperty("archive", out var archive) || Text(archive, "state") != "ready"
            || !string.IsNullOrWhiteSpace(Text(archive, "error")) || !string.IsNullOrWhiteSpace(Text(archive, "warning")))
            throw new InvalidOperationException("成交归档未就绪或存在异常，不能确认完整成交记录。");
    }

    public async Task<IReadOnlyList<Execution>> GetExecutionsAsync(AccountRef account, long fromMs)
    {
        await EnsureAccountAsync(account).ConfigureAwait(false);
        var status = await ConnectedStatusAsync(account.Provider).ConfigureAwait(false);
        if (!status.TryGetProperty("executionArchiveVersion", out var version) || version.GetInt32() != 1)
            throw new InvalidOperationException("数据桥不支持所需成交归档版本，请更新数据桥。");
        RequireArchive(status);
        var from = Math.Max(0, fromMs / 1000 - 2);
        var to = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
        var range = "api/executions?account=" + Uri.EscapeDataString(account.Name)
            + "&from=" + from.ToString(CultureInfo.InvariantCulture) + "&to=" + to.ToString(CultureInfo.InvariantCulture)
            + "&limit=" + PageSize;
        async Task<(Execution[] Rows, int? Next, long Total)> Page(int offset)
        {
            var data = await ReadAsync(account.Provider, range + "&offset=" + offset).ConfigureAwait(false);
            RequireArchive(data);
            var rows = Rows(data, "executions").Select(row => new Execution(Text(row, "executionId") ?? "", Text(row, "orderId") ?? "",
                RequiredText(row, "instrument"), Text(row, "side") ?? "Unknown", Number(row, "qty"), Number(row, "price"),
                row.TryGetProperty("timeMs", out var ms) && ms.ValueKind == JsonValueKind.Number
                    ? checked((long)decimal.Truncate(ms.GetDecimal())) : checked((long)(Number(row, "time") * 1000)))).ToArray();
            if (!data.TryGetProperty("total", out var totalValue) || !totalValue.TryGetInt64(out var total) || total < 0
                || !data.TryGetProperty("nextOffset", out var nextValue))
                throw new InvalidOperationException("成交分页缺少完整性标识。");
            var next = nextValue.ValueKind == JsonValueKind.Null ? (int?)null : nextValue.GetInt32();
            if (rows.Length > PageSize || next is { } nextOffset && (nextOffset <= offset || nextOffset != offset + rows.Length)
                || rows.Length == 0 && next is not null)
                throw new InvalidOperationException("成交分页游标无效，已停止读取。");
            return (rows, next, total);
        }
        static string Identity(Execution execution) => JsonSerializer.Serialize(new { execution.ExecutionId, execution.Instrument, execution.OrderId,
            Fallback = execution.ExecutionId.Length == 0 ? JsonSerializer.Serialize(execution) : null });
        static string Head(Execution[] rows) => JsonSerializer.Serialize(rows);

        for (var attempt = 0; attempt < 3; attempt++)
        {
            var found = new Dictionary<string, Execution>(StringComparer.Ordinal);
            var first = await Page(0).ConfigureAwait(false);
            var current = first;
            var offset = 0;
            var pages = 0;
            var count = 0L;
            do
            {
                if (++pages > MaxPages) throw new InvalidOperationException("成交分页超过读取上限，不能截断跟单数据。");
                foreach (var execution in current.Rows) found[Identity(execution)] = execution;
                count += current.Rows.Length;
                if (current.Next is null) break;
                offset = current.Next.Value;
                current = await Page(offset).ConfigureAwait(false);
            } while (true);
            var verify = await Page(0).ConfigureAwait(false);
            if (Head(first.Rows) == Head(verify.Rows) && first.Total == verify.Total && count == first.Total)
                return found.Values.OrderBy(row => row.TimeMs).ThenBy(row => row.ExecutionId, StringComparer.Ordinal).ToArray();
        }
        throw new InvalidOperationException("读取期间成交分页持续变化，无法确认完整数据，请重新核对。");
    }

    public async Task<SymbolDetails> ResolveAsync(string provider, string symbol)
    {
        await ConnectedStatusAsync(provider).ConfigureAwait(false);
        var data = await ReadAsync(provider, "api/resolve?symbol=" + Uri.EscapeDataString(symbol)).ConfigureAwait(false);
        var details = new SymbolDetails(RequiredText(data, "symbol"), Number(data, "tickSize"), Number(data, "pointValue"));
        if (details.TickSize <= 0 || details.PointValue <= 0) throw new InvalidOperationException("合约缺少有效最小跳动或点值。");
        return details;
    }

    public async Task<JsonElement> GetSymbolsAsync(string provider)
    {
        await ConnectedStatusAsync(provider).ConfigureAwait(false);
        var data = await ReadAsync(provider, "api/symbols").ConfigureAwait(false);
        _ = Rows(data, "symbols");
        return data;
    }

    public Task<OrderReceipt> PlaceMarketAsync(AccountRef account, string symbol, string action, int quantity) =>
        PlaceMarketAsync(account, symbol, action, quantity, static () => { });

    public async Task<OrderReceipt> PlaceMarketAsync(AccountRef account, string symbol, string action, int quantity, Action beforeSend)
    {
        if (quantity <= 0 || action is not ("BUY" or "SELL")) throw new ArgumentException("无效跟单数量或方向。");
        ArgumentNullException.ThrowIfNull(beforeSend);
        await EnsureAccountAsync(account).ConfigureAwait(false);
        var resolved = await ResolveAsync(account.Provider, symbol).ConfigureAwait(false);
        if (!string.Equals(resolved.Symbol, symbol, StringComparison.Ordinal))
            throw new InvalidOperationException("目标合约已被数据桥重新解释，请核对原生合约映射。");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var address = Address(account.Provider, "api/order/place");
        var payload = new { account = account.Name, symbol, action, quantity, orderType = "MARKET", tif = "DAY" };
        // Never retry this POST, including timeouts and responses with an empty order ID.
        // The engine checks stop/expiry here, after every asynchronous preflight step.
        beforeSend();
        using var response = await _http.PostAsJsonAsync(address, payload, Json, timeout.Token).ConfigureAwait(false);
        var data = await ReadResponseAsync(response, timeout.Token).ConfigureAwait(false);
        if (!Flag(data, "ok")) throw new InvalidOperationException("数据桥未确认跟单请求结果。");
        var orderId = Text(data, "orderId");
        if (string.IsNullOrWhiteSpace(orderId)) throw new InvalidOperationException("跟单请求已发送，但订单标识尚未确认；请核对账户，禁止自动重发。");
        return new OrderReceipt(orderId);
    }

    private static string? Text(JsonElement data, string name) => data.ValueKind == JsonValueKind.Object
        && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string RequiredText(JsonElement data, string name) => Text(data, name) is { Length: > 0 } value
        ? value : throw new InvalidOperationException("数据桥响应缺少 " + name + "。");
    private static bool Flag(JsonElement data, string name) => data.ValueKind == JsonValueKind.Object
        && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    private static decimal Number(JsonElement data, string name) => data.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number) ? number
        : throw new InvalidOperationException("数据桥响应缺少有效数值 " + name + "。");
    private static JsonElement.ArrayEnumerator Rows(JsonElement data, string name) => data.ValueKind == JsonValueKind.Object
        && data.TryGetProperty(name, out var rows) && rows.ValueKind == JsonValueKind.Array ? rows.EnumerateArray()
        : throw new InvalidOperationException("数据桥响应缺少 " + name + " 列表。");
    public void Dispose() { if (_ownsClient) _http.Dispose(); }
}
