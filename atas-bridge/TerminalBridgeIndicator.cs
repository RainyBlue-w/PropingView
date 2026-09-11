using System.ComponentModel;
using System.Text.Json;
using ATAS.Indicators;

namespace TvAtasBridge;

[DisplayName("TradingView Terminal Bridge")]
[Description("将 ATAS X 的行情、账户和交易接入本机 TradingView 终端（127.0.0.1:8091）。任意图表加载一次即可。")]
public sealed class TerminalBridgeIndicator : Indicator
{
    private static readonly object Gate = new();
    private static readonly List<TerminalBridgeIndicator> Instances = [];
    private static TerminalBridgeIndicator? _owner;
    private static TerminalBridgeHost? _host;
    private static Task _previousShutdown = Task.CompletedTask;
    private bool _initialized;

    public TerminalBridgeIndicator() : base(true)
    {
        Name = "TradingView Terminal Bridge";
        DenyToChangePanel = true;
        if (DataSeries[0] is ValueDataSeries series)
        {
            series.VisualType = VisualMode.Hide;
            series.ShowCurrentValue = false;
            series.ScaleIt = false;
        }
    }

    protected override void OnInitialize()
    {
        base.OnInitialize();
        _initialized = true;
        Register();
    }

    protected override void OnDataProviderChanged(IIndicatorDataProvider? oldDataProvider, IIndicatorDataProvider? newDataProvider)
    {
        base.OnDataProviderChanged(oldDataProvider, newDataProvider);
        if (!_initialized) return;
        // All services are platform singletons. Changing this chart's symbol or
        // timeframe must not restart the global journal/protection worker.
        Register();
    }

    protected override void OnCalculate(int bar, decimal value)
    {
        // ATAS can attach the data provider after indicator initialization.
        if (_initialized && DataProvider is not null && _host is null) Register();
    }

    private void Register()
    {
        lock (Gate)
        {
            if (!_initialized || IsDisposed) return;
            if (!Instances.Contains(this)) Instances.Add(this);
            if (_host is not null) return;
            var candidate = Instances.FirstOrDefault(i => i._initialized && !i.IsDisposed && i.DataProvider is not null);
            if (candidate is null) return;
            _owner = candidate;
            // Multiple charts share one process-wide listener and execution journal.
            // Removing the owner transfers the host to another attached indicator.
            _host = new TerminalBridgeHost(candidate.DataProvider!, _previousShutdown);
        }
    }

    protected override void OnDispose()
    {
        lock (Gate)
        {
            _initialized = false;
            Instances.Remove(this);
            if (ReferenceEquals(_owner, this))
            {
                _owner = Instances.FirstOrDefault(i => i._initialized && !i.IsDisposed && i.DataProvider is not null);
                if (_owner is null) StopHost();
            }
        }
        base.OnDispose();
    }

    private static void StopHost()
    {
        if (_host is not null)
        {
            _host.Dispose();
            _previousShutdown = _host.Completion;
        }
        _host = null;
        _owner = null;
    }
}

internal sealed class TerminalBridgeHost : IDisposable
{
    internal const int Port = 8091;
    private readonly string _dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TradingViewTerminal", "ATAS");
    private BridgeHttpServer? _server;
    private AtasTradingService? _trading;
    private AtasMarketService? _market;
    private string? _startupError;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _initialization;
    private int _disposed;
    internal Task Completion { get; private set; } = Task.CompletedTask;

    public TerminalBridgeHost(IIndicatorDataProvider provider, Task previousShutdown)
    {
        _initialization = InitializeAsync(provider, previousShutdown);
    }

    private async Task InitializeAsync(IIndicatorDataProvider provider, Task previousShutdown)
    {
        try
        {
            // An immediately re-added indicator must wait until the old worker has
            // flushed its final fills before it reopens the same journal files.
            await previousShutdown.ConfigureAwait(false);
            _stop.Token.ThrowIfCancellationRequested();
            // A DLL reload has separate static state. Wait for the old assembly's
            // listener to release its port before opening the shared journal.
            _server = await BridgeHttpServer.StartAsync(Port, HandleAsync, StreamAsync,
                ValidateStreamAsync, _stop.Token, RecordStartupError).ConfigureAwait(false);
            _stop.Token.ThrowIfCancellationRequested();
            _startupError = null;
            // Keep status available if platform service initialization fails.
            var access = new AtasPlatformAccess(provider);
            _market = new AtasMarketService(access);
            _trading = new AtasTradingService(access, _dataDirectory);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception ex)
        {
            RecordStartupError(ex);
        }
    }

    private void RecordStartupError(Exception ex)
    {
        _startupError = ex.Message;
        try
        {
            Directory.CreateDirectory(_dataDirectory);
            File.AppendAllText(Path.Combine(_dataDirectory, "bridge-errors.log"), $"{DateTimeOffset.UtcNow:O} {ex}\n");
        }
        catch { /* File errors must never interrupt the ATAS chart. */ }
    }

    private Task<object> HandleAsync(string path, IReadOnlyDictionary<string, string> query, JsonElement body, CancellationToken token)
    {
        if (Volatile.Read(ref _disposed) != 0)
            throw new BridgeRequestException(503, "ATAS 桥正在更新，请稍后重试");
        if (path is "/api/status" or "/api/debug")
        {
            return Task.FromResult<object>(new
            {
                provider = "atas",
                connected = _startupError is null && ((_trading?.Connected ?? false) || (_market?.Connected ?? false)),
                connectionName = _trading?.ConnectionName ?? "ATAS X",
                version = _market?.Version ?? AtasPlatformAccess.RuntimeVersion,
                supportedVersions = AtasPlatformAccess.SupportedVersions,
                bridgeVersion = 4,
                chartSymbolVersion = 1,
                historyWindowVersion = 1,
                executionArchiveVersion = 1,
                tradingSupported = _startupError is null && (_trading?.TradingSupported ?? false),
                archive = _trading?.ArchiveStatus,
                error = _startupError,
                marketError = _market?.LastError,
                tradingError = _trading?.SyncError,
            });
        }
        if (_startupError is not null || _market is null || _trading is null)
            throw new BridgeRequestException(503, _startupError ?? "ATAS 桥正在初始化");
        return path is "/api/symbols" or "/api/resolve" or "/api/history"
            ? _market.HandleAsync(path, query, token)
            : _trading.HandleAsync(path, query, body, token);
    }

    private Task StreamAsync(IReadOnlyDictionary<string, string> query, StreamWriter writer, CancellationToken token)
    {
        if (Volatile.Read(ref _disposed) != 0)
            throw new BridgeRequestException(503, "ATAS 桥正在更新，请稍后重试");
        if (_startupError is not null || _market is null)
            throw new BridgeRequestException(503, _startupError ?? "ATAS 行情桥正在初始化");
        return _market.StreamAsync(query, writer, token);
    }

    private Task ValidateStreamAsync(IReadOnlyDictionary<string, string> query, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (Volatile.Read(ref _disposed) != 0)
            throw new BridgeRequestException(503, "ATAS 桥正在更新，请稍后重试");
        if (_startupError is not null || _market is null)
            throw new BridgeRequestException(503, _startupError ?? "ATAS 行情桥正在初始化");
        _market.ValidateStream(query);
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stop.Cancel();
        Completion = FinishDisposalAsync();
    }

    private async Task FinishDisposalAsync()
    {
        try
        {
            await _initialization.ConfigureAwait(false);
            _trading?.Dispose();
            _market?.Dispose();
            if (_trading is not null) await _trading.Disposal.ConfigureAwait(false);
        }
        finally
        {
            // The port is the handoff boundary across DLL load contexts: the next
            // bridge may start its worker only after our final flush completes.
            _server?.Dispose();
            _stop.Dispose();
        }
    }
}
