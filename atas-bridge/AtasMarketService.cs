using System.Globalization;
using System.Text.Json;
using System.Threading.Channels;
using ATAS.Indicators;
using OFT.Core.Candles;
using OFT.Core.Candles.Creators;
using OFT.Core.DataProvider.Requests;
using OFT.Core.Models;

namespace TvAtasBridge;

public sealed record AtasBar(long Time, decimal Open, decimal High, decimal Low, decimal Close, decimal Volume);

/// <summary>Independent contract history requests and native ATAS candle building from live ticks.</summary>
public sealed class AtasMarketService : IDisposable
{
    private readonly AtasPlatformAccess _platform;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _historyRequests = new(4);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private string? _lastError;
    public bool Connected => _platform.GetConnectors().Any(c => c.IsConnected && c.MarketDataStreamEnabled);
    public string Version => _platform.Version;
    public string? LastError => _lastError;
    public string ConnectionName => string.Join(", ", _platform.GetConnectors().Where(c => c.IsConnected).Select(c => c.LoggerName).Distinct());

    public AtasMarketService(AtasPlatformAccess platform) => _platform = platform;
    public AtasMarketService(IIndicatorDataProvider provider) : this(new AtasPlatformAccess(provider)) { }

    public async Task<object> HandleAsync(string path, IReadOnlyDictionary<string, string> query, CancellationToken cancellationToken)
    {
        using var request = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        try
        {
            object result = path switch
            {
                "/api/symbols" => Symbols(),
                "/api/resolve" => Resolve(Required(query, "symbol")),
                "/api/history" => await HistoryResponseAsync(query, request.Token),
                _ => throw new BridgeRequestException(404, "未知行情接口")
            };
            _lastError = null;
            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _lastError = ex.Message;
            throw;
        }
    }

    private object Symbols()
    {
        var contracts = _platform.GetContracts();
        var names = AtasPlatformAccess.CatalogSymbols(contracts);
        return new { symbols = contracts.Select(c => SymbolInfo(c, names[c.Identifier])).ToArray() };
    }

    private object Resolve(string symbol)
    {
        var contract = _platform.ResolveContract(symbol);
        return SymbolInfo(contract, _platform.SymbolName(contract));
    }

    private static object SymbolInfo(Contract contract, string symbol) => new
    {
        symbol,
        name = string.IsNullOrWhiteSpace(contract.Name) ? contract.Code : contract.Name,
        tickSize = contract.TickSize,
        pointValue = contract.TickSize > 0 ? contract.TickCost / contract.TickSize : 0m,
        type = contract.Type.ToString().Contains("Futures", StringComparison.OrdinalIgnoreCase) ? "futures"
            : contract.Type.ToString().Contains("Crypto", StringComparison.OrdinalIgnoreCase) ? "crypto"
            : contract.Type == InstrumentTypes.Forex ? "forex" : "stock",
        exchange = contract.Exchange,
        description = contract.Name,
    };

    private async Task<object> HistoryResponseAsync(IReadOnlyDictionary<string, string> query, CancellationToken cancellationToken)
    {
        var contract = _platform.ResolveContract(Required(query, "symbol"));
        var interval = Interval(query);
        var from = Unix(query, "from");
        var to = Unix(query, "to");
        if (from > to || from > DateTime.UtcNow) return new { bars = Array.Empty<AtasBar>() };
        if ((to - from).TotalSeconds / interval > 100_000)
            throw new BridgeRequestException(400, "单次历史请求超过 100000 根，请缩小时间范围");
        var session = AtasPlatformAccess.Session(contract);
        var candles = await LoadHistoryAsync(contract, session, interval, from, to, cancellationToken);
        var bars = candles.Select(c => ToBar(c, session, interval))
            .Where(c => c.Time >= new DateTimeOffset(from).ToUnixTimeSeconds() && c.Time <= new DateTimeOffset(to).ToUnixTimeSeconds())
            .GroupBy(c => c.Time).Select(g => g.Last()).OrderBy(c => c.Time).ToArray();
        return new { bars, historyWindowVersion = 1 };
    }

    private async Task<VolumeCandle[]> LoadHistoryAsync(Contract contract, ITimeZoneTradingSession session, int interval,
        DateTime fromUtc, DateTime toUtc, CancellationToken cancellationToken)
    {
        var request = new CandlesMarketDataRequest
        {
            Contract = contract,
            // HTTP bounds identify candle opens. Fetch the surrounding candle/session
            // completely before trimming exported bars; overnight daily opens are on
            // the previous calendar date and a weekly bar spans several trading days.
            From = session.GetMarketTimeFromUtc(interval >= 86400 ? fromUtc.AddSeconds(-interval) : fromUtc),
            To = session.GetMarketTimeFromUtc(toUtc >= DateTime.UtcNow.AddSeconds(-interval)
                ? DateTime.UtcNow : toUtc.AddSeconds(interval)),
            TradingSession = session,
            CandleType = interval < 60 ? CandleTypes.Seconds : CandleTypes.TimeFrame,
            Period = interval < 60 ? interval : interval / 60,
        };
        if (!_platform.History.CanProcessRequest(request))
            throw new BridgeRequestException(503, $"ATAS 当前行情源不支持 {_platform.SymbolName(contract)} 的指定历史请求；请检查数据权限和历史范围");
        await _historyRequests.WaitAsync(cancellationToken);
        try
        {
            // The platform's cache routes to the entitled server/connector and enforces its own depth limits.
            // Missing provider data remains missing; never fill gaps with synthetic flat candles.
            var result = await _platform.History.GetCandlesAsync(request, cancellationToken, null).ConfigureAwait(false);
            return result.OrderBy(c => c.OpenTime).ToArray();
        }
        finally { _historyRequests.Release(); }
    }

    public void ValidateStream(IReadOnlyDictionary<string, string> query)
    {
        try
        {
            if (!Connected) throw new BridgeRequestException(503, "ATAS 行情连接已断开");
            var contract = _platform.ResolveContract(Required(query, "symbol"));
            _ = AtasPlatformAccess.Session(contract);
            _ = Interval(query);
            if (_platform.Adapter.TryGetInstrument(contract) is null)
                throw new BridgeRequestException(404, "ATAS 未能创建该合约的行情上下文");
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            throw;
        }
    }

    public async Task StreamAsync(IReadOnlyDictionary<string, string> query, StreamWriter writer, CancellationToken cancellationToken)
    {
        using var stream = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        var token = stream.Token;
        var contract = _platform.ResolveContract(Required(query, "symbol"));
        var session = AtasPlatformAccess.Session(contract);
        var interval = Interval(query);
        var instrument = _platform.Adapter.TryGetInstrument(contract)
            ?? throw new BridgeRequestException(404, "ATAS 未能创建该合约的行情上下文");
        var ticks = Channel.CreateBounded<LiveTick>(new BoundedChannelOptions(200_000) { SingleReader = true, SingleWriter = false, FullMode = BoundedChannelFullMode.Wait });
        void OnTicks(IEnumerable<ATAS.Types.Tick> incoming)
        {
            foreach (var tick in incoming)
            {
                // Copy values on ATAS's callback thread. The native mutable Tick never crosses threads.
                if (!tick.IsPrint) continue;
                var copy = new LiveTick(tick.Time, tick.Price * (decimal)instrument.TickSize, tick.Volume);
                if (!ticks.Writer.TryWrite(copy))
                {
                    _lastError = "行情接收队列已满，正在重新连接并补取历史";
                    ticks.Writer.TryComplete(new IOException(_lastError));
                    break;
                }
            }
        }
        instrument.OnNewTick += OnTicks;
        try
        {
            // Subscribe through ATAS's shared instrument adapter; do not disconnect its global feed on disposal.
            // In this ATAS build Instrument.Subscribe is idempotent under its own lock,
            // not a reference-count increment. ATAS owns the one global contract pipeline.
            await _platform.Adapter.Subscribe(instrument).WaitAsync(token);
            var cutOff = DateTime.UtcNow;
            var seeds = await LoadHistoryAsync(contract, session, interval, cutOff.AddSeconds(-Math.Max(interval * 2L, 600)), cutOff, token);
            var creator = CreateCandleBuilder(contract, session, interval);
            var seed = seeds.LastOrDefault();
            if (seed != null)
            {
                // History objects belong to ATAS's shared cache. Clone before the live creator mutates a candle.
                creator.LastCandle = CloneCandle(seed);
                creator.Add(creator.LastCandle);
                await EmitAsync(writer, ToBar(seed, session, interval), token);
            }
            // Native CloseTime is the last included print's timestamp, not the bar end.
            // A server can return a current candle newer than the request start; use the
            // actual included frontier so buffered prints are not added a second time.
            var cutOffMarket = seed?.CloseTime ?? DateTime.MinValue;
            while (!token.IsCancellationRequested)
            {
                using var pulse = CancellationTokenSource.CreateLinkedTokenSource(token);
                pulse.CancelAfter(TimeSpan.FromSeconds(10));
                bool available;
                try { available = await ticks.Reader.WaitToReadAsync(pulse.Token); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    if (!Connected || instrument.MarketDataSource?.Connector is { IsConnected: false })
                        throw new IOException("ATAS 合约行情连接已断开");
                    await WriteStreamFrameAsync(writer, ": heartbeat\n\n", token);
                    continue;
                }
                if (!available) break;
                AtasBar? last = null;
                while (ticks.Reader.TryRead(out var tick))
                {
                    if (tick.Time <= cutOffMarket) continue;
                    creator.Process(new Trade { Contract = contract, Time = tick.Time, Price = tick.Price, Volume = tick.Volume, Direction = TradeDirections.Between });
                    if (creator.LastCandle == null) continue;
                    var bar = ToBar(creator.LastCandle, session, interval);
                    if (last != null && last.Time != bar.Time) await EmitAsync(writer, last, token);
                    last = bar;
                }
                if (last != null) await EmitAsync(writer, last, token);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _lastError = ex.Message;
            throw;
        }
        finally { instrument.OnNewTick -= OnTicks; ticks.Writer.TryComplete(); }
    }

    private static TradesCandleCreator CreateCandleBuilder(Contract contract, ITimeZoneTradingSession session, int interval)
    {
        TradesCandleCreator creator = interval < 60 ? new SecondsCandleCreator(contract, interval)
            : new TimeFrameCandleCreator(contract, TimeSpan.FromSeconds(interval));
        creator.TradingSession = session;
        creator.MaxCandles = 3;
        creator.UpdatePriceInfosForEachChange = false;
        return creator;
    }

    private static VolumeCandle CloneCandle(VolumeCandle c) => new()
    {
        Contract = c.Contract, OpenTime = c.OpenTime, CloseTime = c.CloseTime,
        OpenPrice = c.OpenPrice, HighPrice = c.HighPrice, LowPrice = c.LowPrice, ClosePrice = c.ClosePrice,
        BidVolume = c.BidVolume, AskVolume = c.AskVolume, BetweenVolume = c.BetweenVolume, Ticks = c.Ticks,
        OpenInterest = c.OpenInterest, MinOpenInterest = c.MinOpenInterest, MaxOpenInterest = c.MaxOpenInterest,
    };

    public static AtasBar ToBar(VolumeCandle candle, ITimeZoneTradingSession session, int interval)
    {
        var utc = DateTime.SpecifyKind(session.GetUtcFromMarketTime(candle.OpenTime), DateTimeKind.Utc);
        // TradingView daily/weekly bars identify the trading date at 00:00 UTC.
        // Intraday bars retain the exact exchange/session aligned timestamp.
        if (interval >= 86400)
        {
            var working = session.GetWorkingDateTime(candle.OpenTime);
            // Futures often open on the previous evening. Use the session's closing
            // trading date; a session ending exactly at midnight belongs to the prior day.
            var tradingDate = working is { } range ? range.Item2.AddTicks(-1).Date : candle.OpenTime.Date;
            if (interval == 604800)
                tradingDate = tradingDate.AddDays(-(((int)tradingDate.DayOfWeek + 6) % 7));
            utc = DateTime.SpecifyKind(tradingDate, DateTimeKind.Utc);
        }
        return new(new DateTimeOffset(utc).ToUnixTimeSeconds(), candle.OpenPrice, candle.HighPrice, candle.LowPrice, candle.ClosePrice, candle.Volume);
    }

    private static Task EmitAsync(StreamWriter writer, AtasBar bar, CancellationToken cancellationToken)
        => WriteStreamFrameAsync(writer, "data: " + JsonSerializer.Serialize(bar, Json) + "\n\n", cancellationToken);

    private static async Task WriteStreamFrameAsync(StreamWriter writer, string frame, CancellationToken cancellationToken)
    {
        try
        {
            await writer.WriteAsync(frame.AsMemory(), cancellationToken);
            await writer.FlushAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or System.Net.Sockets.SocketException or ObjectDisposedException)
        {
            // Refreshing or switching a chart closes its downstream SSE connection.
            // End only this subscription through StreamAsync's cancellation path;
            // history/provider IO failures outside this write boundary still report LastError.
            throw new OperationCanceledException("网页行情订阅已断开", ex, cancellationToken);
        }
    }
    private static string Required(IReadOnlyDictionary<string, string> query, string key) => query.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
        ? value : throw new BridgeRequestException(400, "缺少参数 " + key);
    private static int Interval(IReadOnlyDictionary<string, string> query)
    {
        if (!int.TryParse(Required(query, "interval"), NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
            || seconds < 1 || seconds > 604800 || (seconds >= 60 && seconds % 60 != 0))
            throw new BridgeRequestException(400, "周期须为 1–59 秒或整分钟，最大一周");
        return seconds;
    }
    private static DateTime Unix(IReadOnlyDictionary<string, string> query, string key)
    {
        if (!double.TryParse(Required(query, key), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
            || !double.IsFinite(seconds) || seconds < 0 || seconds > 253402300799)
            throw new BridgeRequestException(400, key + " 必须是有效 Unix 秒时间");
        return DateTime.UnixEpoch.AddSeconds(seconds);
    }
    public void Dispose() { _stop.Cancel(); }
    private sealed record LiveTick(DateTime Time, decimal Price, decimal Volume);
}
