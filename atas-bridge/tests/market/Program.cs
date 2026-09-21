using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using OFT.Core.Candles;
using OFT.Core.Candles.Creators;
using OFT.Core.Models;
using TvAtasBridge;

// Resolve vendor types from the local installation. Do not copy or distribute ATAS DLLs.
var atasDirectory = args.FirstOrDefault() ?? @"D:\Program Files\ATAS X";
AssemblyLoadContext.Default.Resolving += (_, name) =>
{
    var path = Path.Combine(atasDirectory, name.Name + ".dll");
    return File.Exists(path) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(path) : null;
};
MarketTests.Run();

static class MarketTests
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static void Run()
    {
        // Exercise the same version gate as indicator startup against the actual
        // installed DLLs. Candle-only tests previously missed an updated host being rejected.
        var runtimeVersion = AtasPlatformAccess.RequireSupportedRuntime();
        Assert(runtimeVersion == AtasPlatformAccess.RuntimeVersion && runtimeVersion == typeof(VolumeCandle).Assembly.GetName().Version?.ToString(),
            "installed ATAS SDK passes the startup version gate and reports its actual version");
        var session = Session(false);
        var contract = Contract(session, 42);
        var create = typeof(AtasMarketService).GetMethod("CreateCandleBuilder", BindingFlags.Static | BindingFlags.NonPublic)!;
        var clone = typeof(AtasMarketService).GetMethod("CloneCandle", BindingFlags.Static | BindingFlags.NonPublic)!;
        TradesCandleCreator Creator(int interval) => (TradesCandleCreator)create.Invoke(null, [contract, session, interval])!;
        var creator = Creator(60);
        var seed = new VolumeCandle { Contract = contract, OpenTime = Time(9, 30, 0), CloseTime = Time(9, 30, 30), OpenPrice = 100, HighPrice = 103, LowPrice = 99, ClosePrice = 102, AskVolume = 5, BidVolume = 5 };
        creator.LastCandle = (VolumeCandle)clone.Invoke(null, [seed])!;
        creator.Add(creator.LastCandle);
        creator.Process(Tick(contract, Time(9, 30, 31), 104, 2));
        Assert(creator.LastCandle.OpenPrice == 100 && creator.LastCandle.HighPrice == 104 && creator.LastCandle.LowPrice == 99 && creator.LastCandle.Volume == 12, "seed keeps OHLC and adds exact volume");
        Assert(seed.ClosePrice == 102 && seed.Volume == 10, "shared history seed is never mutated");
        creator.Process(Tick(contract, Time(9, 31, 4), 105, 3));
        Assert(creator.LastCandle.OpenTime == Time(9, 31, 0) && creator.LastCandle.Volume == 3, "native minute boundary");
        var bar = AtasMarketService.ToBar(creator.LastCandle, session, 60);
        Assert(bar.Time == new DateTimeOffset(2026, 9, 11, 13, 31, 0, TimeSpan.Zero).ToUnixTimeSeconds(), "summer market time to UTC");
        var winter = new VolumeCandle { OpenTime = new DateTime(2026, 12, 11, 9, 31, 0) };
        Assert(AtasMarketService.ToBar(winter, session, 60).Time == new DateTimeOffset(2026, 12, 11, 14, 31, 0, TimeSpan.Zero).ToUnixTimeSeconds(), "winter DST conversion");
        var sec = Creator(5);
        sec.Process(Tick(contract, Time(9, 31, 7), 1, 1));
        Assert(sec.LastCandle!.OpenTime.Second == 5, "native 5-second boundary");
        var hour = Creator(3600);
        hour.Process(Tick(contract, Time(9, 31, 7), 1, 1));
        Assert(hour.LastCandle!.OpenTime == Time(9, 0, 0), "native hourly boundary");
        var overnight = Session(true);
        var overnightContract = Contract(overnight, 44);
        var daily = (TradesCandleCreator)create.Invoke(null, [overnightContract, overnight, 86400])!;
        daily.Process(Tick(overnightContract, Time(9, 31, 7), 1, 1));
        Assert(AtasMarketService.ToBar(daily.LastCandle!, overnight, 86400).Time == new DateTimeOffset(2026, 9, 11, 0, 0, 0, TimeSpan.Zero).ToUnixTimeSeconds(), "overnight daily uses trading date at UTC midnight");
        var weekly = (TradesCandleCreator)create.Invoke(null, [overnightContract, overnight, 604800])!;
        weekly.Process(Tick(overnightContract, Time(9, 31, 7), 1, 1));
        Assert(AtasMarketService.ToBar(weekly.LastCandle!, overnight, 604800).Time == new DateTimeOffset(2026, 9, 7, 0, 0, 0, TimeSpan.Zero).ToUnixTimeSeconds(), "weekly uses Monday UTC midnight");
        var distinct = new[] { contract, Contract(session, 42), Contract(session, 43) };
        var names = AtasPlatformAccess.CatalogSymbols(distinct);
        Assert(names.Count == 2 && names.Values.Distinct().Count() == 2 && names.Values.All(n => n.Contains("#atas-id=")), "duplicate contracts deduplicate and ambiguous names remain selectable");
        var single = AtasPlatformAccess.CatalogSymbols([contract, Contract(session, 42)]);
        Assert(single.Count == 1 && !single.Values.Single().Contains("#atas-id="), "unambiguous native symbol stays readable");
        StreamOutputTests().GetAwaiter().GetResult();
        Console.WriteLine("PASS ATAS market smoke: synthetic contracts only; no connections or orders");
    }

    private static async Task StreamOutputTests()
    {
        var emit = typeof(AtasMarketService).GetMethod("EmitAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        var frame = typeof(AtasMarketService).GetMethod("WriteStreamFrameAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        var bar = new AtasBar(123, 10, 12, 9, 11, 4);
        Task Send(StreamWriter writer, bool heartbeat, CancellationToken token = default) => heartbeat
            ? (Task)frame.Invoke(null, [writer, ": heartbeat\n\n", token])!
            : (Task)emit.Invoke(null, [writer, bar, token])!;

        using (var bytes = new MemoryStream())
        using (var writer = new StreamWriter(bytes, new System.Text.UTF8Encoding(false), 1024, true))
        {
            await Send(writer, false);
            await Send(writer, true);
            var output = System.Text.Encoding.UTF8.GetString(bytes.ToArray());
            Assert(output == "data: {\"time\":123,\"open\":10,\"high\":12,\"low\":9,\"close\":11,\"volume\":4}\n\n: heartbeat\n\n",
                "bars and heartbeats keep SSE framing and flush before returning");
        }

        foreach (var heartbeat in new[] { false, true })
        foreach (var failFlush in new[] { false, true })
        foreach (var error in new Exception[] {
            new IOException("Unable to write data to the transport connection", new System.Net.Sockets.SocketException(10053)),
            new System.Net.Sockets.SocketException(10054),
            new ObjectDisposedException("closed client stream") })
        {
            using var writer = new FailingStreamWriter(error, failFlush);
            var task = Send(writer, heartbeat);
            try { await task; throw new Exception("Disconnected SSE write unexpectedly succeeded"); }
            catch (OperationCanceledException canceled)
            {
                Assert(task.IsCanceled && ReferenceEquals(canceled.InnerException, error),
                    $"{(heartbeat ? "heartbeat" : "bar")} {(failFlush ? "flush" : "write")} {error.GetType().Name} cancels only the client subscription");
            }
        }

        var unexpected = new InvalidOperationException("unexpected writer failure");
        using (var writer = new FailingStreamWriter(unexpected, false))
        {
            try { await Send(writer, false); throw new Exception("Unexpected writer error was ignored"); }
            catch (InvalidOperationException error)
            { Assert(ReferenceEquals(error, unexpected), "non-transport failures remain errors"); }
        }
        using (var cancellation = new CancellationTokenSource())
        using (var bytes = new MemoryStream())
        using (var writer = new StreamWriter(bytes))
        {
            cancellation.Cancel();
            try { await Send(writer, true, cancellation.Token); throw new Exception("Canceled SSE write succeeded"); }
            catch (OperationCanceledException error)
            { Assert(error.CancellationToken == cancellation.Token, "bridge shutdown preserves its cancellation token"); }
        }
    }

    private sealed class FailingStreamWriter(Exception error, bool failFlush) : StreamWriter(new MemoryStream())
    {
        public override Task WriteAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default)
            => failFlush ? Task.CompletedTask : Task.FromException(error);
        public override Task FlushAsync(CancellationToken cancellationToken)
            => failFlush ? Task.FromException(error) : Task.CompletedTask;
    }

    private static DateTime Time(int h, int m, int s) => new(2026, 9, 11, h, m, s);
    private static Trade Tick(Contract contract, DateTime time, decimal price, decimal volume) => new() { Contract = contract, Time = time, Price = price, Volume = volume, Direction = TradeDirections.Buy };
    private static Contract Contract(TradingSession session, long id) => new() { Id = id, Code = "TEST", TickSize = .25m, TickCost = 12.5m, Instrument = new Instrument { Id = 1, Type = InstrumentTypes.UsFutures, Code = "TEST", Exchange = new Exchange { Code = "TESTEX", DefaultTradingSession = session } } };
    private static TradingSession Session(bool overnight)
    {
        var session = new TradingSession { IsMarketDataTimeInUtc = false, TimeZone = "Eastern Standard Time", FirstDayOfWeek = DayOfWeek.Monday };
        for (var day = 0; day < 7; day++) session.WorkingTimes.Add(new TradingSessionWorkingTime { StartDay = (DayOfWeek)day, StartTime = overnight ? TimeSpan.FromHours(18) : TimeSpan.Zero, EndDay = (DayOfWeek)((day + 1) % 7), EndTime = overnight ? TimeSpan.FromHours(17) : TimeSpan.Zero });
        return session;
    }
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); Console.WriteLine("PASS " + message); }
}
