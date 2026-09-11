using System.Net;
using System.Net.NetworkInformation;
using System.Text.Json;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using BadHttpRequestException = Microsoft.AspNetCore.Http.BadHttpRequestException;

namespace CopyTrading;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NT8Terminal", "CopyTrading");
        var port = 8092;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--data-dir" && i + 1 < args.Length) directory = Path.GetFullPath(args[++i]);
            else if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[++i], out var selected) && selected is > 0 and <= 65535) port = selected;
            else { Console.Error.WriteLine("Usage: CopyTrading [--port 8092] [--data-dir directory]"); return 2; }
        }
        try
        {
            // Keep the named handle alive for the process lifetime. Multiple data
            // directories or listening ports must not create competing dispatchers.
            using var singleton = new Mutex(false, @"Local\NT8Terminal.CopyTrading.v1", out var created);
            if (!created) { Console.Error.WriteLine("Another copy trading service instance is already running for this session."); return 1; }
            Directory.CreateDirectory(directory);
            // The same persisted intent log must never be driven by two independent workers.
            using var instance = new FileStream(Path.Combine(directory, "service.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            using var bridge = new BridgeClient();
            var engine = new CopyEngine(bridge, new JsonStateStore(directory));
            await engine.InitializeAsync().ConfigureAwait(false);
            await using var app = CopyService.CreateApp(engine, bridge, port);
            Console.WriteLine($"Copy trading service: http://127.0.0.1:{port}; persisted rules require explicit start.");
            await app.RunAsync().ConfigureAwait(false);
            return 0;
        }
        catch (IOException) { Console.Error.WriteLine("Cannot open copy trading storage, or another instance already uses this directory."); return 1; }
        catch (Exception error) { Console.Error.WriteLine("Copy trading service failed: " + error.GetType().Name); return 1; }
    }
}

public static class CopyService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static WebApplication CreateApp(CopyEngine engine, ITradingBridge bridge, int port = 8092, bool enablePolling = true)
    {
        if (port is < 0 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(options => options.SingleLine = true);
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Listen(IPAddress.Loopback, port, listen => listen.Protocols = HttpProtocols.Http1);
            options.Limits.MaxRequestBodySize = 64 * 1024;
            options.Limits.MaxConcurrentConnections = 64;
            options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
            options.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(15);
        });
        if (enablePolling) builder.Services.AddHostedService(_ => new EngineWorker(engine));
        var app = builder.Build();
        var localHosts = LocalHosts();
        app.Use(async (context, next) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!localHosts.Contains(context.Request.Host.Host))
            { await Error(context, 403, "请求主机不属于本机。"); return; }
            var origin = context.Request.Headers.Origin.ToString();
            if (origin.Length != 0)
            {
                if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || !localHosts.Contains(uri.Host))
                { await Error(context, 403, "请求来源不属于本机终端。"); return; }
            }
            if (context.Request.Headers["Sec-Fetch-Site"].ToString().Equals("cross-site", StringComparison.OrdinalIgnoreCase))
            { await Error(context, 403, "拒绝跨站访问跟单服务。"); return; }
            if (HttpMethods.IsOptions(context.Request.Method))
            {
                context.Response.StatusCode = 204;
                return;
            }
            if (HttpMethods.IsPost(context.Request.Method) && !context.Request.HasJsonContentType())
            { await Error(context, 415, "跟单操作必须使用 application/json。"); return; }
            try { await next(context).ConfigureAwait(false); }
            catch (ArgumentException error) { await Error(context, 400, error.Message); }
            catch (JsonException) { await Error(context, 400, "请求 JSON 无效。"); }
            catch (BadHttpRequestException error) { await Error(context, error.StatusCode, "请求内容或长度无效。"); }
            catch (InvalidOperationException error) { await Error(context, 409, error.Message); }
            catch (HttpRequestException) { await Error(context, 503, "本机数据桥请求失败。"); }
            catch (OperationCanceledException) { if (!context.RequestAborted.IsCancellationRequested) await Error(context, 504, "本机数据桥请求超时。"); }
            catch (IOException) { await Error(context, 500, "跟单状态无法可靠保存，请检查本机储存。"); }
            catch (Exception error)
            {
                app.Logger.LogError("Copy trading request failed: {ErrorType}", error.GetType().Name);
                await Error(context, 500, "跟单服务内部错误。");
            }
        });

        app.MapGet("/api/status", async () => Results.Json(await engine.SnapshotAsync().ConfigureAwait(false), Json));
        app.MapGet("/api/accounts", async () => Results.Json(new { accounts = await bridge.GetAccountsAsync().ConfigureAwait(false) }, Json));
        app.MapGet("/api/symbols", async (string provider) =>
        {
            if (bridge is not BridgeClient client) throw new InvalidOperationException("当前数据桥不支持合约目录查询。");
            return Results.Json(await client.GetSymbolsAsync(provider).ConfigureAwait(false), Json);
        });
        app.MapGet("/api/resolve", async (string provider, string symbol) => Results.Json(await bridge.ResolveAsync(provider, symbol).ConfigureAwait(false), Json));
        app.MapPost("/api/rules", async (HttpRequest request) =>
        {
            if (!request.HasJsonContentType()) throw new BadHttpRequestException("JSON content type required", 415);
            var config = await request.ReadFromJsonAsync<RuleConfig>(Json).ConfigureAwait(false) ?? throw new ArgumentException("缺少规则配置。");
            await engine.SaveRuleAsync(config).ConfigureAwait(false);
            return Results.Json(await engine.SnapshotAsync().ConfigureAwait(false), Json);
        });
        app.MapPost("/api/rules/{id}/start", async (string id) =>
        { await engine.StartAsync(id).ConfigureAwait(false); return Results.Json(await engine.SnapshotAsync().ConfigureAwait(false), Json); });
        app.MapPost("/api/rules/{id}/stop", async (string id) =>
        { await engine.StopAsync(id).ConfigureAwait(false); return Results.Json(await engine.SnapshotAsync().ConfigureAwait(false), Json); });
        app.MapPost("/api/rules/{id}/delete", async (string id) =>
        { await engine.DeleteAsync(id).ConfigureAwait(false); return Results.Json(await engine.SnapshotAsync().ConfigureAwait(false), Json); });
        app.MapPost("/api/stop-all", async () =>
        { await engine.StopAllAsync().ConfigureAwait(false); return Results.Json(await engine.SnapshotAsync().ConfigureAwait(false), Json); });
        return app;
    }

    private static async Task Error(HttpContext context, int status, string message)
    {
        if (context.Response.HasStarted) { context.Abort(); return; }
        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new { error = message }, Json).ConfigureAwait(false);
    }

    private static HashSet<string> LocalHosts()
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "::1", "[::1]", Environment.MachineName, Dns.GetHostName() };
        foreach (var network in NetworkInterface.GetAllNetworkInterfaces())
            foreach (var address in network.GetIPProperties().UnicastAddresses) result.Add(address.Address.ToString());
        return result;
    }

    private sealed class EngineWorker(CopyEngine engine) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
            try
            {
                while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
                    await engine.PollAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        }
    }
}
