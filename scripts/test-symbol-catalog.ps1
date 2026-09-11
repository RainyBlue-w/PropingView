param([switch]$CompileNative)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$sourcePath = Join-Path $workspace 'nt8-bridge/TvBridgeAddOn.cs'
$source = [IO.File]::ReadAllText($sourcePath)
$catalogStart = $source.IndexOf('        private void HandleSymbols(')
$catalogEnd = $source.IndexOf('        private void HandleResolve(', $catalogStart)
$resolveEnd = $source.IndexOf('        private static string BuildSymbolJson(', $catalogEnd)
$jsonStart = $source.IndexOf('        private static string BuildSymbolJson(')
$jsonEnd = $source.IndexOf('        private void HandleHistory(', $jsonStart)
if ($catalogStart -lt 0 -or $catalogEnd -lt 0 -or $jsonStart -lt 0 -or $jsonEnd -lt 0) {
    throw 'Cannot locate production symbol catalog methods'
}
$methods = $source.Substring($catalogStart, $resolveEnd - $catalogStart) + $source.Substring($jsonStart, $jsonEnd - $jsonStart)
$testDirectory = Join-Path $workspace '.tmp-webbridge/symbol-catalog'
[IO.Directory]::CreateDirectory($testDirectory) | Out-Null
$template = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Sockets;
using System.Text;

enum InstrumentType { Future, Stock, Forex, Option }
class MasterInstrument {
    public static List<MasterInstrument> All = new List<MasterInstrument>();
    public string Name;
    public List<DateTime> RolloverCollection = new List<DateTime>();
    public Func<DateTime, DateTime> CurrentExpiry = _ => Core.Globals.MinDate;
    public int ExpiryCalls;
    public DateTime GetNextExpiry(DateTime now) { ExpiryCalls++; return CurrentExpiry(now); }
    public InstrumentType InstrumentType = InstrumentType.Future;
    public double TickSize = .25, PointValue = 20;
    public string Description = "Test contract";
}
class Instrument {
    public static List<Instrument> All = new List<Instrument>();
    public string FullName;
    public DateTime Expiry;
    public MasterInstrument MasterInstrument = new MasterInstrument();
    public static Func<string, Instrument> Factory;
    public static Instrument GetInstrument(string name) {
        return All.FirstOrDefault(i => i != null && i.FullName == name) ?? (Factory == null ? null : Factory(name));
    }
}
namespace Core { static class Globals { public static DateTime MinDate = new DateTime(1800, 1, 1), MaxDate = DateTime.MaxValue; } }
class SymbolCatalogTests {
    string response;
    int statusCode;
    static int passed;
    void WriteJson(NetworkStream stream, int status, string json) {
        statusCode = status;
        response = json;
    }
    static string JsonQuote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
    /* PRODUCTION_METHODS */
    static Instrument Contract(string name, DateTime expiry, InstrumentType type = InstrumentType.Future) {
        return new Instrument { FullName = name, Expiry = expiry, MasterInstrument = new MasterInstrument { InstrumentType = type } };
    }
    static void Check(bool condition, string message) {
        if (!condition) throw new Exception(message);
        passed++;
        Console.WriteLine("PASS " + message);
    }
    static void Main() {
        var now = new DateTime(2026, 9, 11, 12, 0, 0);
        var nq = Contract("NQ 09-26", new DateTime(2026, 9, 1));
        var es = Contract("ES 09-26", new DateTime(2026, 9, 1));
        Check(!IsPastFuturesContractMonth(nq, now) && !IsPastFuturesContractMonth(es, now), "September NQ and ES remain listed after September 1");
        Check(!IsPastFuturesContractMonth(nq, new DateTime(2026, 9, 30, 23, 59, 59)), "current contract month remains listed through month end");
        Check(IsPastFuturesContractMonth(nq, new DateTime(2026, 10, 1)), "previous contract month is filtered at the next month boundary");
        Check(!IsPastFuturesContractMonth(Contract("NQ 12-26", new DateTime(2026, 12, 1)), now), "future contract months remain listed");
        Check(IsPastFuturesContractMonth(Contract("NQ 06-26", new DateTime(2026, 6, 1)), now), "historical contract months remain filtered");
        Check(IsPastFuturesContractMonth(Contract("NQ 12-25", new DateTime(2025, 12, 1)), new DateTime(2026, 1, 1)), "contract filtering handles year rollover");
        Check(!IsPastFuturesContractMonth(Contract("NQ ##-##", Core.Globals.MinDate), now), "continuous or unspecified-expiry contracts remain listed");
        Check(!IsPastFuturesContractMonth(Contract("AAPL", new DateTime(2020, 1, 1), InstrumentType.Stock), now)
            && !IsPastFuturesContractMonth(Contract("EURUSD", new DateTime(2020, 1, 1), InstrumentType.Forex), now)
            && !IsPastFuturesContractMonth(Contract("OPTION", new DateTime(2020, 1, 1), InstrumentType.Option), now), "futures month filtering does not remove non-futures");
        var month = new DateTime(DateTime.Now.Year, DateTime.Now.Month, 1);
        Instrument.All = new List<Instrument> { null,
            Contract("NQ CURRENT", month), Contract("ES CURRENT", month),
            Contract("NQ HISTORICAL", month.AddMonths(-1)), Contract("NQ NEXT", month.AddMonths(1)),
            Contract("NQ CONTINUOUS", Core.Globals.MinDate), Contract("AAPL", month.AddYears(-2), InstrumentType.Stock),
            new Instrument { FullName = "MISSING MASTER", MasterInstrument = null }
        };
        var test = new SymbolCatalogTests();
        test.HandleSymbols(null);
        Check(test.response.Contains("\"symbol\":\"NQ CURRENT\"") && test.response.Contains("\"symbol\":\"ES CURRENT\"")
            && test.response.Contains("\"symbol\":\"NQ NEXT\"") && test.response.Contains("\"symbol\":\"NQ CONTINUOUS\"")
            && test.response.Contains("\"symbol\":\"AAPL\"") && !test.response.Contains("HISTORICAL") && !test.response.Contains("MISSING MASTER"),
            "production /symbols includes current native identifiers and applies only intended exclusions");
        Check(test.response.IndexOf("AAPL", StringComparison.Ordinal) < test.response.IndexOf("ES CURRENT", StringComparison.Ordinal)
            && test.response.IndexOf("ES CURRENT", StringComparison.Ordinal) < test.response.IndexOf("NQ CURRENT", StringComparison.Ordinal),
            "production /symbols preserves canonical name sorting");
        TestCurrentContracts();
        Console.WriteLine(passed + " NT8 symbol catalog checks passed; synthetic instruments only");
    }
    static void TestCurrentContracts() {
        var september = new DateTime(2026, 9, 1);
        var december = new DateTime(2026, 12, 1);
        var rollover = new DateTime(2026, 9, 10);
        var nq = new MasterInstrument { Name = "NQ", CurrentExpiry = t => t < rollover ? september : december };
        var es = new MasterInstrument { Name = "ES", CurrentExpiry = t => september };
        var unknown = new MasterInstrument { Name = "UNKNOWN" };
        var invalid = new MasterInstrument { Name = "INVALID", CurrentExpiry = t => Core.Globals.MaxDate };
        var broken = new MasterInstrument { Name = "BROKEN", CurrentExpiry = t => { throw new Exception("missing schedule"); } };
        var stock = Contract("AAPL", Core.Globals.MinDate, InstrumentType.Stock);
        var nqSep = new Instrument { FullName = "NQ 09-26", Expiry = september, MasterInstrument = nq };
        var nqDec = new Instrument { FullName = "NQ 12-26", Expiry = december, MasterInstrument = nq };
        var esSep = new Instrument { FullName = "ES 09-26", Expiry = september, MasterInstrument = es };
        var continuous = new Instrument { FullName = "NQ ##-##", Expiry = Core.Globals.MinDate, MasterInstrument = nq };
        var root = new Instrument { FullName = "NQ", Expiry = Core.Globals.MinDate, MasterInstrument = nq };
        Instrument.All = new List<Instrument> { stock, nqSep, esSep, continuous, root };
        Instrument.Factory = name => name == nqDec.FullName ? nqDec : null;
        MasterInstrument.All = new List<MasterInstrument> { nq, nq, es, null, unknown, invalid, broken };
        var before = GetCurrentContractCatalog(rollover.AddTicks(-1));
        Check(before.Count(i => i.MasterInstrument == nq) == 1 && before.Contains(nqSep), "search uses one NT8-selected month per root before rollover");
        nq.ExpiryCalls = 0;
        var after = GetCurrentContractCatalog(rollover);
        Check(after.Contains(nqDec) && !after.Contains(nqSep) && !after.Contains(continuous), "rollover follows NT8 selection rather than the nearest calendar month");
        Check(nq.ExpiryCalls == 1, "each master is resolved once despite duplicate entries");
        Check(!Instrument.All.Contains(nqDec) && after.Contains(nqDec), "NT8 resolves its current contract even when not instantiated in Instrument.All");
        Check(after.Contains(esSep) && after.Contains(stock), "each root uses its own rollover schedule and non-futures remain available");
        Check(after.Length == 3, "invalid or unavailable expiry schedules do not guess a lead contract");
        Instrument.Factory = name => name == nqDec.FullName ? esSep : null;
        Check(GetCurrentContract(nq, rollover) == null, "native lookup returning another product cannot become the lead contract");
        Instrument.Factory = name => name == nqDec.FullName ? new Instrument { FullName = "NQ 03-27", Expiry = december.AddMonths(3), MasterInstrument = nq } : null;
        Check(GetCurrentContract(nq, rollover) == null, "native lookup returning another month cannot become the lead contract");
        Instrument.Factory = name => name == nqDec.FullName ? nqDec : null;
        nq.CurrentExpiry = t => december;
        var test = new SymbolCatalogTests();
        var query = new Dictionary<string, string> { { "currentOnly", "true" } };
        test.HandleSymbols(null, query);
        Check(test.statusCode == 200 && test.response.Contains("\"currentOnly\":true") && test.response.Contains("\"symbolCatalogVersion\":2")
            && test.response.Contains("NQ 12-26") && !test.response.Contains("NQ 09-26") && !test.response.Contains("NQ ##-##"),
            "search catalog exposes its policy and excludes non-current futures");
        query["symbol"] = "NQ 09-26";
        test.HandleResolve(null, query);
        Check(test.statusCode == 404, "exact old-month search cannot bypass the current-only catalog");
        query["symbol"] = "NQ 12-26";
        test.HandleResolve(null, query);
        Check(test.statusCode == 200 && test.response.Contains("\"currentOnly\":true") && test.response.Contains("NQ 12-26"), "exact current-month search returns the native symbol with policy marker");
        query["symbol"] = "NQ";
        test.HandleResolve(null, query);
        Check(test.statusCode == 200 && test.response.Contains("NQ 12-26"), "root-only search resolves the NT8-selected month");
        query["symbol"] = "AAPL";
        test.HandleResolve(null, query);
        Check(test.statusCode == 200 && test.response.Contains("AAPL"), "non-futures direct search remains available");
        test.HandleResolve(null, new Dictionary<string, string> { { "symbol", "NQ 09-26" } });
        Check(test.statusCode == 200 && test.response.Contains("NQ 09-26") && !test.response.Contains("currentOnly"), "ordinary resolution still supports historical charts and trade details");
    }
}
'@
$generated = Join-Path $testDirectory 'SymbolCatalogTests.cs'
[IO.File]::WriteAllText($generated, $template.Replace('/* PRODUCTION_METHODS */', $methods))
$compiler = 'C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/MSBuild/Current/Bin/Roslyn/csc.exe'
$testExecutable = Join-Path $testDirectory 'SymbolCatalogTests.exe'
& $compiler /nologo /target:exe "/out:$testExecutable" $generated
if ($LASTEXITCODE -ne 0) { throw 'Symbol catalog test compilation failed' }
& $testExecutable
if ($LASTEXITCODE -ne 0) { throw 'Symbol catalog tests failed' }

if ($CompileNative) {
    $nativeBin = 'D:/Program Files/NinjaTrader 8/bin'
    $framework = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319'
    $nativeOutput = Join-Path $testDirectory 'TvBridge-symbol-catalog-check.dll'
    $references = @(
        (Join-Path $nativeBin 'NinjaTrader.Core.dll'),
        (Join-Path $nativeBin 'NinjaTrader.Gui.dll'),
        (Join-Path $framework 'WPF/WindowsBase.dll'),
        (Join-Path $framework 'WPF/PresentationCore.dll'),
        (Join-Path $framework 'WPF/PresentationFramework.dll')
    )
    $referenceArguments = @($references | ForEach-Object { '/reference:' + $_ })
    & $compiler /nologo /target:library "/out:$nativeOutput" @referenceArguments $sourcePath
    if ($LASTEXITCODE -ne 0) { throw 'Native NT8 symbol catalog bridge compilation failed' }
    Write-Output 'PASS full bridge compiles against installed NT8 assemblies; no deployment or live calls'
}
