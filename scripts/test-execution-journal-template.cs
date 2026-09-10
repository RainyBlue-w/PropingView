// The runner injects the complete production journal, collector, worker and GET handler.
// All files live in a unique workspace test directory. NT8/account/network objects are fakes.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using NetworkStream = ResponseCapture;

enum OrderAction { Buy, Sell, BuyToCover, SellShort }
enum MarketPosition { Flat, Long, Short }
enum Currency { UsDollar }
enum PrintTo { OutputTab1 }
namespace NinjaTrader.Code { static class Output { public static void Process(string s, object tab) {} } }
static class Core { public static class Globals { public static string UserDataDir; } }
class MasterInstrument { public double PointValue = 20; }
class Instrument { public string FullName = "NQ SEP26"; public MasterInstrument MasterInstrument = new MasterInstrument(); }
class Order { public OrderAction OrderAction; }
class Execution {
    public string ExecutionId, OrderId; public Instrument Instrument = new Instrument();
    public DateTime Time = new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);
    public int Quantity = 1; public double Price = 100, Commission; public bool IsEntry = true;
    public MarketPosition MarketPosition = MarketPosition.Long; public Order Order;
}
class Account {
    public static readonly List<Account> All = new List<Account>();
    public string Name; public Currency Denomination = Currency.UsDollar;
    public readonly List<Execution> Executions = new List<Execution>(); public bool Subscribed;
}
class ResponseCapture { public string Body; public int Code; }

class ExecutionJournalTests
{
    private int assertions;
    private static string F(double n) { return n.ToString("R", CultureInfo.InvariantCulture); }
    private static long ToUnix(DateTime date) { return new DateTimeOffset(date.ToUniversalTime()).ToUnixTimeSeconds(); }
    private static string JsonQuote(string value) {
        var result = new StringBuilder("\"");
        foreach (char c in value ?? "") {
            if (c == '\\' || c == '"') result.Append('\\').Append(c);
            else if (c < 32) result.Append("\\u").Append(((int)c).ToString("x4"));
            else result.Append(c);
        }
        return result.Append('"').ToString();
    }
    private static string Get(Dictionary<string, string> d, string key) { string value; return d.TryGetValue(key, out value) ? value : ""; }
    private static long ParseLong(string s, long fallback) { long result; return long.TryParse(s, out result) ? result : fallback; }
    private static int ParseInt(string s, int fallback) { int result; return int.TryParse(s, out result) ? result : fallback; }
    private static void WriteJson(ResponseCapture capture, int code, string body) { capture.Code = code; capture.Body = body; }
    private void EnsureSubscribed(Account account) { account.Subscribed = true; }

    /* PRODUCTION_ARCHIVE */

    private void Assert(bool condition, string description) { assertions++; if (!condition) throw new Exception(description); }
    private static ArchivedExecution Row(string account, string id, long time = 1000, double? commission = 0) {
        return new ArchivedExecution { Account = account, ExecutionId = id, OrderId = "order-" + id, Instrument = "NQ SEP26",
            Side = "Buy", Time = time, TimeTicks = 621355968000000000L + time * TimeSpan.TicksPerSecond, Price = 123.25, Quantity = 2,
            Commission = commission, PointValue = 20, Currency = "USD" };
    }
    private static bool Until(Func<bool> condition) {
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < deadline) { if (condition()) return true; Thread.Sleep(20); }
        return condition();
    }
    private void Run(string directory)
    {
        var path = System.IO.Path.Combine(directory, "executions.log");
        var journal = new ExecutionJournal(path);
        Assert(journal.Load(), "new journal loads");
        journal.Upsert(Row("Sim101", "same"));
        journal.Upsert(Row("Sim101", "same"));
        journal.Upsert(Row("Live101", "same"));
        Assert(journal.Count == 2 && journal.PendingCount == 2, "dedupe is per account and execution ID");
        Assert(journal.Flush() && journal.PendingCount == 0, "flush drains durable records");
        long originalLength = new FileInfo(path).Length;
        journal.Upsert(Row("Sim101", "same"));
        Assert(journal.Flush() && new FileInfo(path).Length == originalLength, "duplicate unchanged event never grows journal");
        var missingSide = Row("Sim101", "same");
        missingSide.Side = "Unknown";
        journal.Upsert(missingSide);
        Assert(journal.PendingCount == 0 && journal.Snapshot().Single(r => r.Account == "Sim101").Side == "Buy",
            "later unknown direction never replaces a previously known fill direction");
        journal.Upsert(Row("Sim101", "same", commission: 2.25));
        Assert(journal.Flush(), "later commission update persists");
        var restart = new ExecutionJournal(path);
        Assert(restart.Load() && restart.Count == 2 && restart.Snapshot().Single(r => r.Account == "Sim101").Commission == 2.25,
            "restart loads updated commission without duplicate fill");
        restart.Upsert(Row("Sim101", "same", commission: null));
        Assert(restart.PendingCount == 0, "missing later commission preserves known commission");
        restart.Upsert(Row("Sim101", "same", commission: 0));
        Assert(restart.Flush() && restart.Snapshot().Single(r => r.Account == "Sim101").Commission == 0,
            "explicit zero commission correction is preserved");
        var special = Row("账户\twith\nnewlines\\\"", "id\n雪");
        restart.Upsert(special);
        Assert(restart.Flush() && ArchivedExecution.Read(special.JournalLine()).Payload() == special.Payload(),
            "Unicode, tab, newline and quoting survive the journal codec");
        for (int i = 0; i < 231; i++) restart.Upsert(Row("Bulk", "fill-" + i, 2000 + i));
        Assert(restart.Flush() && restart.Count == 234, "archive retains more than legacy 200 record response cap");

        File.AppendAllText(path, "partially-written-record-without-newline");
        var damaged = new ExecutionJournal(path);
        Assert(damaged.Load() && damaged.Count == 234 && damaged.Warning.Length > 0, "crash-damaged tail recovers all complete records and exposes warning");
        damaged.Upsert(Row("AfterCrash", "new"));
        Assert(damaged.Flush() && File.ReadAllText(path).Contains("partially-written-record-without-newline\n"),
            "append preserves and separates invalid tail instead of truncating history");
        var recovered = new ExecutionJournal(path);
        Assert(recovered.Load() && recovered.Count == 235, "valid appended fill loads after damaged tail");
        recovered.Upsert(Row("Retry", "blocked"));
        using (var locked = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None)) {
            Assert(!recovered.Flush() && recovered.PendingCount == 1 && recovered.Error.Length > 0,
                "disk lock failure retains pending fill and exposes save error");
        }
        Assert(recovered.Flush() && recovered.PendingCount == 0 && recovered.Error == "", "retry succeeds when file becomes writable");
        var retryRestart = new ExecutionJournal(path);
        Assert(retryRestart.Load() && retryRestart.Count == 236, "retried fill survives restart");
        var corrupted = Row("Corrupted", "bad").JournalLine().Replace("123.25", "999.25");
        File.AppendAllText(path, corrupted + "\n" + Row("GoodAfterCorruption", "good").JournalLine() + "\n");
        var middleDamage = new ExecutionJournal(path);
        Assert(middleDamage.Load() && middleDamage.Count == 237 && !middleDamage.Snapshot().Any(r => r.Account == "Corrupted"),
            "checksum rejects corrupted middle row without losing later complete records");

        executionJournal = middleDamage;
        var response = new ResponseCapture();
        HandleExecutions(response, new Dictionary<string, string> { { "offset", "0" }, { "limit", "100" } });
        Assert(response.Code == 200 && response.Body.Contains("\"total\":237") && response.Body.Contains("\"nextOffset\":100"),
            "GET executions supports all accounts with paged total");
        Assert(response.Body.IndexOf("fill-230", StringComparison.Ordinal) < response.Body.IndexOf("fill-229", StringComparison.Ordinal),
            "paged executions sort newest first");
        Assert(response.Body.Contains("\"pointValue\":20") && response.Body.Contains("\"currency\":\"USD\"")
            && response.Body.Contains("\"archive\":{\"version\":1"), "GET returns metadata and archive state");
        HandleExecutions(response, new Dictionary<string, string> { { "account", "bulk" }, { "symbol", "NQ SEP26" },
            { "from", "2010" }, { "to", "2012" }, { "limit", "100" } });
        Assert(response.Body.Contains("\"total\":3") && response.Body.Contains("\"nextOffset\":null"), "account, symbol and inclusive time filters work");
        HandleExecutions(response, new Dictionary<string, string> { { "account", "Bulk" }, { "offset", "200" }, { "limit", "100" } });
        Assert(response.Body.Contains("\"total\":231") && response.Body.Contains("fill-30") && !response.Body.Contains("fill-31"),
            "last page has expected records without truncating history");
        HandleExecutions(response, new Dictionary<string, string> { { "account", "Bulk" } });
        Assert(response.Body.Contains("fill-31") && !response.Body.Contains("\"fill-30\"")
            && response.Body.IndexOf("fill-31", StringComparison.Ordinal) < response.Body.IndexOf("fill-230", StringComparison.Ordinal),
            "legacy unpaged API returns latest 200 ascending");
        HandleExecutions(response, new Dictionary<string, string> { { "account", "RemovedAccount" }, { "limit", "100" } });
        Assert(response.Code == 200 && response.Body.Contains("\"total\":0"), "queries never depend on account still existing in NT8");
        var early = Row("SameSecond", "z-entry", 3000);
        early.TimeTicks += 123 * TimeSpan.TicksPerMillisecond;
        var later = Row("SameSecond", "a-exit", 3000);
        later.TimeTicks += 987 * TimeSpan.TicksPerMillisecond;
        executionJournal.Upsert(early);
        executionJournal.Upsert(later);
        HandleExecutions(response, new Dictionary<string, string> { { "account", "SameSecond" }, { "limit", "100" } });
        Assert(response.Body.IndexOf("a-exit", StringComparison.Ordinal) < response.Body.IndexOf("z-entry", StringComparison.Ordinal)
            && response.Body.Contains("\"timeMs\":3000123") && response.Body.Contains("\"timeMs\":3000987"),
            "same-second execution ordering and source millisecond precision survive JSON for frontend FIFO");

        Core.Globals.UserDataDir = System.IO.Path.Combine(directory, "worker");
        var startup = new Account { Name = "Startup" };
        startup.Executions.Add(new Execution { ExecutionId = "boot-fill", OrderId = "boot-order", Commission = 1.25 });
        Account.All.Add(startup);
        StartExecutionArchive();
        Assert(Until(() => executionJournal.Loaded && executionJournal.Count == 1 && executionJournal.PendingCount == 0),
            "startup discovers and persists account fills without any HTTP request");
        Assert(startup.Subscribed, "startup discovery activates execution subscription");
        var live = new Execution { ExecutionId = "event", OrderId = "event-order", Order = new Order { OrderAction = OrderAction.SellShort } };
        CaptureExecution(startup, live);
        live.Price = 99999;
        Assert(Until(() => executionJournal.Count == 2 && executionJournal.PendingCount == 0), "execution event wakes background writer");
        var saved = executionJournal.Snapshot().Single(r => r.ExecutionId == "event");
        Assert(saved.Price == 100 && saved.Side == "Sell" && saved.Currency == "USD" && saved.PointValue == 20,
            "event captures immutable price, side, currency and point value before NT8 mutates object");
        var late = new Account { Name = "Late" };
        late.Executions.Add(new Execution { ExecutionId = "late-fill" });
        lock (Account.All) Account.All.Add(late);
        Assert(Until(() => executionJournal.Count == 3 && executionJournal.PendingCount == 0), "periodic scan discovers accounts added after startup");
        Assert(late.Subscribed, "newly discovered account is subscribed");
        CaptureExecution(startup, new Execution { ExecutionId = "orderless-close-long", IsEntry = false, MarketPosition = MarketPosition.Short });
        CaptureExecution(startup, new Execution { ExecutionId = "orderless-close-short", IsEntry = false, MarketPosition = MarketPosition.Long });
        CaptureExecution(startup, new Execution { ExecutionId = "orderless-flat", IsEntry = false, MarketPosition = MarketPosition.Flat });
        Assert(Until(() => executionJournal.Count == 6 && executionJournal.PendingCount == 0), "orderless exits and unknown direction remain durably captured");
        var directions = executionJournal.Snapshot().ToDictionary(row => row.ExecutionId, row => row.Side);
        Assert(directions["orderless-close-long"] == "Sell", "orderless close of long uses execution Short as Sell, independent of IsEntry");
        Assert(directions["orderless-close-short"] == "Buy", "orderless close of short uses execution Long as Buy, independent of IsEntry");
        Assert(directions["orderless-flat"] == "Unknown", "unexpected Flat execution remains Unknown, never fabricated Buy or Sell");
        CaptureExecution(startup, new Execution { ExecutionId = "shutdown-fill" });
        StopExecutionArchive();
        var closed = new ExecutionJournal(executionJournal.Path);
        Assert(closed.Load() && closed.Count == 7, "shutdown drains queued event to disk");
        Assert(closed.Snapshot().Single(row => row.ExecutionId == "orderless-flat").Side == "Unknown", "version 1 journal restores Unknown direction without dropping the fill");
        Assert(executionJournal.Path.StartsWith(Core.Globals.UserDataDir, StringComparison.Ordinal), "journal lives under NT8 UserDataDir");
        Console.WriteLine("Execution journal: " + assertions + " assertions passed (isolated files and account fakes).");
    }
    public static void Main(string[] args) { new ExecutionJournalTests().Run(args[0]); }
}
