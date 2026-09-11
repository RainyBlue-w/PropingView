using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace TvAtasBridge;

public sealed class BridgeRequestException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

internal sealed class BridgeHttpServer : IDisposable
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stop;
    private readonly HashSet<TcpClient> _clients = [];
    private readonly HashSet<string> _hosts = new(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "[::1]", "::1", Dns.GetHostName() };
    private readonly Func<string, IReadOnlyDictionary<string, string>, JsonElement, CancellationToken, Task<object>> _handle;
    private readonly Func<IReadOnlyDictionary<string, string>, StreamWriter, CancellationToken, Task> _stream;
    private readonly Func<IReadOnlyDictionary<string, string>, CancellationToken, Task>? _prepareStream;
    internal int BoundPort => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public BridgeHttpServer(int port,
        Func<string, IReadOnlyDictionary<string, string>, JsonElement, CancellationToken, Task<object>> handle,
        Func<IReadOnlyDictionary<string, string>, StreamWriter, CancellationToken, Task> stream,
        Func<IReadOnlyDictionary<string, string>, CancellationToken, Task>? prepareStream = null)
    {
        _handle = handle;
        _stream = stream;
        _prepareStream = prepareStream;
        _listener = new TcpListener(IPAddress.Loopback, port);
        _stop = new CancellationTokenSource();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                foreach (var ip in nic.GetIPProperties().UnicastAddresses) _hosts.Add(ip.Address.ToString());
            _listener.Start();
        }
        catch
        {
            // A failed bind is not a live server; release it before a later retry.
            _listener.Stop();
            _stop.Dispose();
            throw;
        }
        _ = AcceptAsync();
    }

    internal static async Task<BridgeHttpServer> StartAsync(int port,
        Func<string, IReadOnlyDictionary<string, string>, JsonElement, CancellationToken, Task<object>> handle,
        Func<IReadOnlyDictionary<string, string>, StreamWriter, CancellationToken, Task> stream,
        Func<IReadOnlyDictionary<string, string>, CancellationToken, Task>? prepareStream = null,
        CancellationToken cancellationToken = default,
        Action<Exception>? onBindRetry = null)
    {
        var reportedCollision = false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BridgeHttpServer server;
            try { server = new BridgeHttpServer(port, handle, stream, prepareStream); }
            catch (SocketException error) when (error.SocketErrorCode == SocketError.AddressAlreadyInUse)
            {
                if (!reportedCollision)
                {
                    reportedCollision = true;
                    onBindRetry?.Invoke(error);
                }
                await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken).ConfigureAwait(false);
                continue;
            }
            if (cancellationToken.IsCancellationRequested)
            {
                server.Dispose();
                cancellationToken.ThrowIfCancellationRequested();
            }
            return server;
        }
    }

    private async Task AcceptAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                lock (_clients)
                {
                    if (_clients.Count >= 64) { client.Dispose(); continue; }
                    _clients.Add(client);
                }
                _ = ServeAsync(client);
            }
        }
        catch (Exception) when (_stop.IsCancellationRequested) { }
    }

    private async Task ServeAsync(TcpClient client)
    {
        string? origin = null;
        var sent = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(40));
        using var socket = client;
        await using var network = client.GetStream();
        await using var writer = new StreamWriter(network, new UTF8Encoding(false), 4096, true) { NewLine = "\r\n", AutoFlush = true };
        try
        {
            // Read bytes rather than StreamReader: Content-Length counts UTF-8 bytes.
            var header = new List<byte>();
            var single = new byte[1];
            while (header.Count < 16384)
            {
                if (await network.ReadAsync(single, timeout.Token) == 0) return;
                header.Add(single[0]);
                if (header.Count >= 4 && header[^4] == 13 && header[^3] == 10 && header[^2] == 13 && header[^1] == 10) break;
            }
            if (header.Count >= 16384) throw new BridgeRequestException(431, "请求头过长");
            var lines = Encoding.ASCII.GetString(header.ToArray()).Split("\r\n");
            var requestLine = lines[0].Split(' ');
            if (requestLine.Length != 3 || !requestLine[1].StartsWith('/')) throw new BridgeRequestException(400, "无效 HTTP 请求");
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in lines.Skip(1).Where(l => l.Length > 0))
            {
                var colon = line.IndexOf(':');
                if (colon <= 0 || !headers.TryAdd(line[..colon].Trim(), line[(colon + 1)..].Trim())) throw new BridgeRequestException(400, "无效或重复的请求头");
            }
            if (!headers.TryGetValue("Host", out var host) || !Uri.TryCreate("http://" + host, UriKind.Absolute, out var hostUri) || !_hosts.Contains(hostUri.Host))
                throw new BridgeRequestException(403, "不允许此请求主机");
            if (headers.TryGetValue("Origin", out var requestedOrigin))
            {
                if (!Uri.TryCreate(requestedOrigin, UriKind.Absolute, out var originUri) || originUri.Scheme is not ("http" or "https") || !_hosts.Contains(originUri.Host))
                    throw new BridgeRequestException(403, "此网页来源不允许连接本地桥");
                origin = requestedOrigin;
            }
            var method = requestLine[0];
            if (method == "OPTIONS") { sent = true; await ReplyAsync(writer, 204, null, origin); return; }
            if (method is not ("GET" or "POST")) throw new BridgeRequestException(405, "仅支持 GET 和 POST");
            if (headers.ContainsKey("Transfer-Encoding")) throw new BridgeRequestException(400, "不支持分块请求体");
            var uri = new Uri("http://localhost" + requestLine[1]);
            var path = uri.AbsolutePath;
            var isWrite = path.StartsWith("/api/order/", StringComparison.Ordinal) || path == "/api/position/close";
            if ((isWrite && method != "POST") || (!isWrite && method != "GET")) throw new BridgeRequestException(405, "端点请求方法不匹配");
            var query = ParseQuery(uri.Query);
            var length = 0;
            if (headers.TryGetValue("Content-Length", out var lengthText) && (!int.TryParse(lengthText, out length) || length < 0 || length > 65536))
                throw new BridgeRequestException(413, "请求体超过限制");
            if (method == "POST" && (!headers.GetValueOrDefault("Content-Type", "").StartsWith("application/json", StringComparison.OrdinalIgnoreCase) || length == 0))
                throw new BridgeRequestException(415, "交易请求必须使用 JSON");
            var bytes = new byte[length];
            await network.ReadExactlyAsync(bytes, timeout.Token);
            using var body = JsonDocument.Parse(length == 0 ? "{}"u8.ToArray() : bytes);
            if (path == "/api/stream")
            {
                if (_prepareStream is not null) await _prepareStream(query, timeout.Token);
                sent = true;
                await writer.WriteAsync("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: close\r\nX-Accel-Buffering: no\r\n" + Cors(origin) + "\r\n");
                timeout.CancelAfter(Timeout.InfiniteTimeSpan);
                await _stream(query, writer, timeout.Token);
                return;
            }
            var result = await _handle(path, query, body.RootElement, timeout.Token);
            sent = true;
            await ReplyAsync(writer, 200, result, origin);
        }
        catch (Exception ex)
        {
            if (!sent && !_stop.IsCancellationRequested)
            {
                var status = ex is BridgeRequestException error ? error.Status
                    : ex is JsonException or ArgumentException ? 400
                    : ex is OperationCanceledException ? 504
                    : ex is InvalidOperationException ? 409 : 503;
                try { await ReplyAsync(writer, status, new { error = ex.Message }, origin); } catch { }
            }
        }
        finally { lock (_clients) _clients.Remove(client); }
    }

    private static string Cors(string? origin) => origin is null ? "" : $"Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n";
    private static async Task ReplyAsync(StreamWriter writer, int status, object? payload, string? origin)
    {
        var body = payload is null ? "" : JsonSerializer.Serialize(payload, Json);
        var reason = status == 200 ? "OK" : status == 204 ? "No Content" : "Error";
        await writer.WriteAsync($"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\n" + Cors(origin) + "\r\n" + body);
    }

    internal static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2);
            result[Uri.UnescapeDataString(pair[0].Replace('+', ' '))] = pair.Length > 1 ? Uri.UnescapeDataString(pair[1].Replace('+', ' ')) : "";
        }
        return result;
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        lock (_clients) { foreach (var client in _clients) client.Dispose(); _clients.Clear(); }
    }
}
