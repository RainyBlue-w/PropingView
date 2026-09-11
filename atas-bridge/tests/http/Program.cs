using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using TvAtasBridge;

var assertions = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
    assertions++;
}

var writes = 0;
var streamClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var server = new BridgeHttpServer(0, (path, query, body, token) =>
{
    if (path == "/api/missing") throw new BridgeRequestException(404, "没有此端点");
    if (path == "/api/order/place") Interlocked.Increment(ref writes);
    return Task.FromResult<object>(new { path, query, body = body.Clone() });
}, async (_, writer, token) =>
{
    try
    {
        await writer.WriteAsync("data: {\"time\":123,\"close\":10}\n\n");
        await Task.Delay(Timeout.Infinite, token);
    }
    finally { streamClosed.TrySetResult(); }
}, (query, token) =>
{
    if (!query.ContainsKey("symbol")) throw new BridgeRequestException(400, "缺少合约");
    return Task.CompletedTask;
});

using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{server.BoundPort}"), Timeout = TimeSpan.FromSeconds(8) };
using (var response = await client.GetAsync("/api/accounts?account=%E4%B8%AD%E6%96%87+Sim%261"))
{
    Check(response.StatusCode == HttpStatusCode.OK, "GET succeeds");
    using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    Check(json.RootElement.GetProperty("query").GetProperty("account").GetString() == "中文 Sim&1", "query UTF8 and encoded delimiters");
}

var payload = "{\"account\":\"中文 模拟账户\",\"quantity\":2}";
using (var response = await client.PostAsync("/api/order/place", new StringContent(payload, Encoding.UTF8, "application/json")))
{
    Check(response.StatusCode == HttpStatusCode.OK, "mock POST accepted");
    using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    Check(json.RootElement.GetProperty("body").GetProperty("account").GetString() == "中文 模拟账户", "Content-Length uses UTF8 bytes");
}

using (var request = new HttpRequestMessage(HttpMethod.Post, "/api/order/place"))
{
    request.Headers.Add("Origin", "https://unrelated.example");
    request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
    using var response = await client.SendAsync(request);
    Check(response.StatusCode == HttpStatusCode.Forbidden, "foreign browser origins rejected");
    Check(!response.Headers.Contains("Access-Control-Allow-Origin"), "no CORS permission on rejection");
}

using (var request = new HttpRequestMessage(HttpMethod.Get, "/api/accounts"))
{
    request.Headers.Host = "rebind.example";
    using var response = await client.SendAsync(request);
    Check(response.StatusCode == HttpStatusCode.Forbidden, "unrecognized Host rejected");
}

using (var request = new HttpRequestMessage(HttpMethod.Options, "/api/order/place"))
{
    request.Headers.Add("Origin", "http://localhost:7100");
    using var response = await client.SendAsync(request);
    Check(response.StatusCode == HttpStatusCode.NoContent, "local preflight succeeds");
    Check(response.Headers.GetValues("Access-Control-Allow-Origin").Single() == "http://localhost:7100", "CORS echoes exact local origin");
}

using (var response = await client.GetAsync("/api/order/place"))
    Check(response.StatusCode == HttpStatusCode.MethodNotAllowed, "GET cannot trade");
using (var response = await client.PostAsync("/api/order/place", new StringContent(payload)))
    Check(response.StatusCode == HttpStatusCode.UnsupportedMediaType, "simple text POST cannot trade");
using (var response = await client.PostAsync("/api/order/place", new StringContent("broken", Encoding.UTF8, "application/json")))
    Check(response.StatusCode == HttpStatusCode.BadRequest, "invalid JSON cannot trade");
Check(writes == 1, "rejected requests never reach order callback");
using (var response = await client.GetAsync("/api/missing"))
{
    Check(response.StatusCode == HttpStatusCode.NotFound, "service error keeps status");
    Check((await response.Content.ReadAsStringAsync()).Contains("error"), "service error is JSON");
}

async Task<string> Raw(string request)
{
    using var socket = new TcpClient();
    await socket.ConnectAsync(IPAddress.Loopback, server.BoundPort);
    await socket.GetStream().WriteAsync(Encoding.ASCII.GetBytes(request));
    using var reader = new StreamReader(socket.GetStream());
    return await reader.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(8));
}
Check((await Raw("POST /api/order/place HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9999999\r\nContent-Type: application/json\r\n\r\n")).StartsWith("HTTP/1.1 413"), "oversized body rejected without waiting for it");
Check((await Raw("GET /api/accounts HTTP/1.1\r\nHost: localhost\r\nHost: localhost\r\n\r\n")).StartsWith("HTTP/1.1 400"), "ambiguous duplicate headers rejected");

using (var response = await client.GetAsync("/api/stream?interval=60"))
{
    Check(response.StatusCode == HttpStatusCode.BadRequest, "SSE parameters validated before sending 200 headers");
    Check(response.Content.Headers.ContentType?.MediaType == "application/json", "SSE startup errors remain readable JSON errors");
}

using (var response = await client.GetAsync("/api/stream?symbol=ES&interval=60", HttpCompletionOption.ResponseHeadersRead))
{
    Check(response.Content.Headers.ContentType?.MediaType == "text/event-stream", "SSE response type");
    using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
    Check((await reader.ReadLineAsync())?.Contains("\"time\":123") == true, "SSE flushes before stream closes");
    server.Dispose();
    await streamClosed.Task.WaitAsync(TimeSpan.FromSeconds(3));
    Check(streamClosed.Task.IsCompletedSuccessfully, "bridge shutdown cancels live subscriptions");
}
// Hot reload may create the replacement before the old assembly releases its socket.
// Exercise only ephemeral loopback ports; no request reaches an account or market service.
var bindHandleCalls = 0;
var bindStreamCalls = 0;
Task<object> BoundHandle(string path, IReadOnlyDictionary<string, string> query, JsonElement body, CancellationToken token)
{
    Interlocked.Increment(ref bindHandleCalls);
    return Task.FromResult<object>(new { ok = true });
}
Task BoundStream(IReadOnlyDictionary<string, string> query, StreamWriter writer, CancellationToken token)
{
    Interlocked.Increment(ref bindStreamCalls);
    return Task.CompletedTask;
}
using (var occupied = new TcpListener(IPAddress.Loopback, 0) { ExclusiveAddressUse = true })
{
    occupied.Start();
    var port = ((IPEndPoint)occupied.LocalEndpoint).Port;
    var collisions = 0;
    var firstCollision = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var pending = BridgeHttpServer.StartAsync(port, BoundHandle, BoundStream, onBindRetry: error =>
    {
        Check(error is SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse }, "only address-in-use collision is reported for retry");
        Interlocked.Increment(ref collisions);
        firstCollision.TrySetResult();
    });
    await firstCollision.Task.WaitAsync(TimeSpan.FromSeconds(3));
    await Task.Delay(550);
    Check(!pending.IsCompleted && collisions == 1, "occupied loopback port retries without repeated diagnostics");
    occupied.Stop();
    using var rebound = await pending.WaitAsync(TimeSpan.FromSeconds(3));
    Check(rebound.BoundPort == port, "replacement binds after the previous listener releases its port");
    using var probe = new TcpClient();
    await probe.ConnectAsync(IPAddress.Loopback, rebound.BoundPort);
    Check(probe.Connected && bindHandleCalls == 0 && bindStreamCalls == 0, "binding and accepting alone invoke no HTTP or stream handlers");
}
using (var occupied = new TcpListener(IPAddress.Loopback, 0) { ExclusiveAddressUse = true })
using (var cancellation = new CancellationTokenSource())
{
    occupied.Start();
    var port = ((IPEndPoint)occupied.LocalEndpoint).Port;
    var firstCollision = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var pending = BridgeHttpServer.StartAsync(port, BoundHandle, BoundStream,
        cancellationToken: cancellation.Token, onBindRetry: _ => firstCollision.TrySetResult());
    await firstCollision.Task.WaitAsync(TimeSpan.FromSeconds(3));
    cancellation.Cancel();
    try { using var unexpected = await pending.WaitAsync(TimeSpan.FromSeconds(3)); throw new Exception("Canceled bind returned a listener"); }
    catch (OperationCanceledException) { Check(pending.IsCanceled, "cancel stops the pending bind retry"); }
    occupied.Stop();
    await Task.Delay(350);
    using var stillFree = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };
    stillFree.Start();
    Check(((IPEndPoint)stillFree.LocalEndpoint).Port == port, "canceled retry never opens a listener after the port becomes free");
}
using (var canceled = new CancellationTokenSource())
{
    canceled.Cancel();
    try { using var unexpected = await BridgeHttpServer.StartAsync(0, BoundHandle, BoundStream, cancellationToken: canceled.Token); throw new Exception("Pre-canceled bind succeeded"); }
    catch (OperationCanceledException) { Check(true, "already canceled startup never allocates a listener"); }
}
var unrelatedRetries = 0;
try { using var unexpected = await BridgeHttpServer.StartAsync(-1, BoundHandle, BoundStream, onBindRetry: _ => unrelatedRetries++); throw new Exception("Invalid port was accepted"); }
catch (ArgumentOutOfRangeException) { Check(unrelatedRetries == 0, "non-collision failures propagate without retry"); }
Check(bindHandleCalls == 0 && bindStreamCalls == 0, "all bind lifecycle tests remain read-only socket probes");
Console.WriteLine($"ATAS HTTP: {assertions} assertions passed (mock callbacks and ephemeral loopback ports only).");
