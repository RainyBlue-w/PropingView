using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using CopyTrading;

var checks = 0;
void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Console.WriteLine("PASS " + message); }
async Task Fails(Func<Task> action, string message)
{
    try { await action(); } catch (Exception error) when (error is InvalidOperationException or ArgumentException or TaskCanceledException) { Check(true, message); return; }
    throw new Exception("Expected rejection: " + message);
}
using var handler = new MockHandler();
using var http = new HttpClient(handler);
using var bridge = new BridgeClient(http, new Uri("http://127.0.0.1:18990/"), new Uri("http://127.0.0.1:18991/"));
var leader = new AccountRef("nt8", "Lead");
var follower = new AccountRef("atas", "fixture-guid:Follow");
await Fails(() => Task.FromResult(new BridgeClient(http, new Uri("http://example.org/"))), "bridge origins cannot leave loopback");
handler.Nt8Online = false;
var accounts = await bridge.GetAccountsAsync();
Check(accounts.Count == 1 && accounts[0].Provider == "atas", "one bridge offline leaves the other account group available");
Check(accounts[0].Group == "Fixture", "account group contains the connection name without a duplicated provider prefix");
await Fails(async () => { await bridge.GetPositionsAsync(leader); }, "specific offline accounts fail instead of appearing flat");
handler.Nt8Online = true;
handler.Strict = false;
await Fails(async () => { await bridge.GetOrdersAsync(leader); }, "old NT8 snapshots without strict marker cannot enable copying");
handler.Strict = true;
handler.OrderCount = 80;
Check((await bridge.GetOrdersAsync(leader)).Count == 80, "strict NT8 orders are complete beyond the old 60-row limit");
Check(handler.Calls.Last(call => call.Path == "/api/orders").Query["copyStrict"] == "true", "NT8 order snapshots explicitly request strict mode");
handler.OrderCount = 0;
Check((await bridge.GetPositionsAsync(leader)).Count == 0, "verified empty strict positions are accepted");
Check(handler.Calls.Last(call => call.Path == "/api/positions").Query["copyStrict"] == "true", "NT8 position snapshots explicitly request strict mode");

var from = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 60000;
handler.FillCount = 601;
handler.InsertOnSecondPage = true;
var fills = await bridge.GetExecutionsAsync(leader, from);
Check(fills.Count == 602 && fills.Select(fill => fill.ExecutionId).Distinct().Count() == 602, "concurrent head insertion restarts pagination without missing or duplicating executions");
var pageCalls = handler.Calls.Where(call => call.Path == "/api/executions").ToArray();
Check(pageCalls.Select(call => call.Query["to"]).Distinct().Count() == 1, "all execution pages and retries share a fixed upper time bound");
Check(long.Parse(pageCalls[0].Query["from"]) == from / 1000 - 2, "execution reads include a two-second overlap");
Check(fills.Zip(fills.Skip(1)).All(pair => pair.First.TimeMs <= pair.Second.TimeMs), "transport returns execution time order");
handler.ArchiveWarning = true;
await Fails(async () => { await bridge.GetExecutionsAsync(leader, from); }, "archive warnings prevent using incomplete source history");
handler.ArchiveWarning = false;
handler.BrokenCursor = true;
await Fails(async () => { await bridge.GetExecutionsAsync(leader, from); }, "non-progressing pagination fails instead of truncating");
handler.BrokenCursor = false;
handler.UnstableHead = true;
await Fails(async () => { await bridge.GetExecutionsAsync(leader, from); }, "persistently changing history stops after bounded retries");
handler.UnstableHead = false;
handler.FillCount = 0;
Check((await bridge.ResolveAsync("atas", "ESU6@CME")).Symbol == "ESU6@CME", "native target symbol resolution stays provider scoped");
Check(handler.Calls.Last(call => call.Path == "/api/resolve").Port == 18991, "ATAS metadata cannot route to NT8");

var beforeGuard = handler.Writes;
var guardError = new InvalidOperationException("mock stop immediately before dispatch");
var guardCalls = 0;
try
{
    await ((IGuardedTradingBridge)bridge).PlaceMarketAsync(follower, "ESU6@CME", "BUY", 1, () =>
    {
        guardCalls++;
        Check(handler.Calls.Last().Path == "/api/resolve", "dispatch guard runs after account and symbol preflight");
        throw guardError;
    });
    throw new Exception("guard must abort dispatch");
}
catch (InvalidOperationException error) { Check(ReferenceEquals(error, guardError), "dispatch guard rejection is not caught or wrapped by the transport"); }
Check(guardCalls == 1 && handler.Writes == beforeGuard, "a stop guard rejects dispatch before any market POST");

var beforeWrites = handler.Writes;
handler.TimeoutPost = true;
await Fails(async () => { await bridge.PlaceMarketAsync(follower, "ESU6@CME", "BUY", 1); }, "uncertain POST timeout is surfaced");
Check(handler.Writes == beforeWrites + 1, "a failed market request is sent once only");
handler.TimeoutPost = false;
handler.EmptyReceipt = true;
await Fails(async () => { await bridge.PlaceMarketAsync(follower, "ESU6@CME", "BUY", 1); }, "empty native order ID remains an unconfirmed request");
Check(handler.Writes == beforeWrites + 2, "unconfirmed receipt is never automatically resent");
handler.EmptyReceipt = false;
var receipt = await bridge.PlaceMarketAsync(follower, "ESU6@CME", "SELL", 2);
var write = handler.Calls.Last(call => call.Method == "POST");
using (var body = JsonDocument.Parse(write.Body!))
    Check(receipt.OrderId.Length > 0 && write.Port == 18991 && body.RootElement.GetProperty("account").GetString() == follower.Name
        && body.RootElement.GetProperty("symbol").GetString() == "ESU6@CME" && body.RootElement.GetProperty("orderType").GetString() == "MARKET"
        && !body.RootElement.TryGetProperty("tp", out _) && !body.RootElement.TryGetProperty("sl", out _), "mock copied fills preserve raw account/native symbol and do not attach duplicate protection");

var engine = new CopyEngine(bridge, new MemoryStore());
await engine.InitializeAsync();
await using var app = CopyService.CreateApp(engine, bridge, 0, enablePolling: false);
await app.StartAsync();
using var service = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
Check((await service.GetAsync("/api/status")).StatusCode == HttpStatusCode.OK, "HTTP status route returns the engine snapshot");
Check((await service.GetAsync("/api/accounts")).StatusCode == HttpStatusCode.OK, "HTTP account route returns both mocked bridges");
var malformed = await service.PostAsync("/api/rules", new StringContent("{", Encoding.UTF8, "application/json"));
Check(malformed.StatusCode == HttpStatusCode.BadRequest, "malformed JSON returns 400");
var wrongType = await service.PostAsync("/api/stop-all", new StringContent("{}", Encoding.UTF8, "text/plain"));
Check(wrongType.StatusCode == HttpStatusCode.UnsupportedMediaType, "simple cross-site form content cannot mutate rules");
using (var crossSite = new HttpRequestMessage(HttpMethod.Post, "/api/stop-all") { Content = JsonContent.Create(new { }) })
{
    crossSite.Headers.TryAddWithoutValidation("Origin", "https://example.org");
    Check((await service.SendAsync(crossSite)).StatusCode == HttpStatusCode.Forbidden, "foreign browser origins cannot control the copier");
}
using (var fetchSite = new HttpRequestMessage(HttpMethod.Post, "/api/stop-all") { Content = JsonContent.Create(new { }) })
{
    fetchSite.Headers.TryAddWithoutValidation("Sec-Fetch-Site", "cross-site");
    Check((await service.SendAsync(fetchSite)).StatusCode == HttpStatusCode.Forbidden, "cross-site fetch requests cannot control the copier");
}
var rule = new RuleConfig { Id = "http-fixture", Name = "HTTP fixture", Leader = leader,
    Followers = [new FollowerConfig { Account = follower, Multiplier = 1, MaxOrderQuantity = 10, Mappings = [new("NQ 09-26", "ESU6@CME")] }] };
Check((await service.PostAsJsonAsync("/api/rules", rule)).StatusCode == HttpStatusCode.OK, "HTTP saves a stopped copy rule");
var beforeStart = handler.Writes;
Check((await service.PostAsJsonAsync("/api/rules/http-fixture/start", new { })).StatusCode == HttpStatusCode.OK, "HTTP explicit start verifies accounts and establishes an empty mock baseline");
Check(handler.Writes == beforeStart, "saving and starting a rule does not place an order");
Check((await service.PostAsJsonAsync("/api/rules/http-fixture/delete", new { })).StatusCode == HttpStatusCode.Conflict, "running rules cannot be deleted");
Check((await service.PostAsJsonAsync("/api/stop-all", new { })).StatusCode == HttpStatusCode.OK, "HTTP stop-all route disables active rules");
Check((await service.PostAsJsonAsync("/api/rules/http-fixture/delete", new { })).StatusCode == HttpStatusCode.OK, "HTTP stopped rule deletion succeeds");
Check((await service.GetAsync("/api/rules/http-fixture/start")).StatusCode == HttpStatusCode.MethodNotAllowed, "GET cannot trigger a trading-rule mutation");
await app.StopAsync();
Console.WriteLine($"{checks} copy transport/HTTP checks passed; native bridge requests are fully mocked.");

record RequestLog(string Method, int Port, string Path, Dictionary<string, string> Query, string? Body);
sealed class MockHandler : HttpMessageHandler
{
    public List<RequestLog> Calls { get; } = [];
    public bool Nt8Online = true, Strict = true, InsertOnSecondPage, ArchiveWarning, BrokenCursor, UnstableHead, TimeoutPost, EmptyReceipt;
    public int FillCount, OrderCount, Writes;
    private long Stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        if (!uri.IsLoopback || uri.Port is not (18990 or 18991)) throw new Exception("Fixture blocks all non-mocked bridge requests");
        var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(pair => pair.Split('=', 2))
            .ToDictionary(pair => Uri.UnescapeDataString(pair[0]), pair => Uri.UnescapeDataString(pair.Length > 1 ? pair[1] : ""));
        Calls.Add(new(request.Method.Method, uri.Port, uri.AbsolutePath, query, request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));
        var provider = uri.Port == 18990 ? "nt8" : "atas";
        object archive = new { state = "ready", recordCount = FillCount, pendingCount = 0, warning = ArchiveWarning ? "fixture incomplete archive" : "" };
        object data;
        switch (uri.AbsolutePath)
        {
            case "/api/status": data = new { provider, connected = provider != "nt8" || Nt8Online, executionArchiveVersion = 1, copySnapshotVersion = 1, archive }; break;
            case "/api/accounts": data = new { accounts = new[] { new { name = provider == "nt8" ? "Lead" : "fixture-guid:Follow", displayName = "Test", connection = "Fixture", connected = true } } }; break;
            case "/api/positions": data = Strict ? (object)new { positions = Array.Empty<object>(), copyStrict = true } : new { positions = Array.Empty<object>() }; break;
            case "/api/orders":
                var orders = Enumerable.Range(0, OrderCount).Select(i => new { orderId = "work-" + i, instrument = "NQ 09-26", state = "Working" }).ToArray();
                data = Strict ? (object)new { orders, copyStrict = true } : new { orders }; break;
            case "/api/executions":
                var offset = int.Parse(query["offset"]);
                if (InsertOnSecondPage && offset > 0) { FillCount++; InsertOnSecondPage = false; }
                if (UnstableHead && offset == 0) Stamp++;
                var rows = Enumerable.Range(0, FillCount).Reverse().Skip(offset).Take(500).Select(i => new {
                    executionId = "fill-" + i, orderId = "order-" + i, instrument = "NQ 09-26", side = "Buy", qty = 1, price = 25000,
                    timeMs = Stamp - (FillCount - i) * 10, time = (Stamp - (FillCount - i) * 10) / 1000,
                }).ToArray();
                data = new { executions = rows, total = FillCount, nextOffset = BrokenCursor ? 0 : offset + rows.Length < FillCount ? (int?)(offset + rows.Length) : null, archive }; break;
            case "/api/resolve": data = new { symbol = query["symbol"], tickSize = .25m, pointValue = 20m }; break;
            case "/api/symbols": data = new { symbols = new[] { new { symbol = "NQ 09-26", name = "Fixture", tickSize = .25m, pointValue = 20m } } }; break;
            case "/api/order/place":
                Writes++;
                if (TimeoutPost) throw new TaskCanceledException("mock venue acknowledgment timeout");
                data = new { ok = true, orderId = EmptyReceipt ? "" : "mock-order-" + Writes }; break;
            default: throw new Exception("Unexpected fixture endpoint: " + uri.AbsolutePath);
        }
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(data, options: Json) };
    }
}
sealed class MemoryStore : IStateStore
{
    private PersistedState state = new();
    public PersistedState Load() => state;
    public void Save(PersistedState value) => state = value;
}
