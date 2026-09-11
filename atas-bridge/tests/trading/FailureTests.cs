using System.Reflection;
using System.Text.Json;
using ATAS.DataFeedsCore;
using TvAtasBridge;

internal static class FailureTests
{
    public static async Task Run(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "TvAtasFailureTests-" + Guid.NewGuid().ToString("N"));
        var connector = DispatchProxy.Create<IDataFeedConnector, FakeConnector>();
        var fake = (FakeConnector)connector;
        var platform = new FakePlatform(connector);
        var a = new Portfolio { AccountID = "A", Balance = 10000 };
        var b = new Portfolio { AccountID = "B", Balance = 10000 };
        var security = new Security { SecurityId = "NQU6@CME", Code = "NQU6", TickSize = .25m, TickCost = 5, LotSize = 1 };
        fake.Portfolios.AddRange([a, b]); fake.Securities.Add(security);
        var service = new AtasTradingService(platform, directory, startWorker: false);
        async Task<JsonElement> Call(string path, object? body = null, string? account = null)
        {
            var query = new Dictionary<string, string>();
            if (account is not null) query["account"] = account;
            return JsonSerializer.SerializeToElement(await service.HandleAsync(path, query,
                JsonSerializer.SerializeToElement(body), CancellationToken.None), ExecutionJournal.Json);
        }
        static bool NoWarning(object status) => string.IsNullOrEmpty(JsonSerializer.SerializeToElement(status, ExecutionJournal.Json).GetProperty("warning").GetString());
        async Task ExpectReason(string path, object body, string reason, string name)
        {
            try { await Call(path, body); throw new Exception("Expected operation rejection"); }
            catch (InvalidOperationException e) { check(e.Message == reason, name); }
        }
        try
        {
            var accounts = (await Call("/api/accounts")).GetProperty("accounts");
            var accountA = accounts[0].GetProperty("name").GetString()!;
            var accountB = accounts[1].GetProperty("name").GetString()!;
            const string hoursReason = "Reason: Current time is outside trading hours allowed";
            fake.EmitFailure("register", new Order { Id = "manual", AccountID = "A", Portfolio = a }, hoursReason);
            await Call("/api/accounts");
            check(service.SyncError is null && service.ProtectionError(accountA) is null && NoWarning(service.ArchiveStatus),
                "manual ordinary rejection with no protection creates no persistent protection or archive alert");
            var archive = (await Call("/api/executions", account: accountA)).GetProperty("archive");
            check(string.IsNullOrEmpty(archive.GetProperty("warning").GetString()), "ordinary rejections do not pollute execution-page archive warnings");

            fake.Reject = (operation, _) => operation == "register" ? hoursReason : null;
            await ExpectReason("/api/order/place", new { account = accountA, symbol = security.SecurityId, action = "BUY", orderType = "MARKET", quantity = 1 },
                hoursReason, "entry POST returns exact venue reason instead of a generic task failure");
            check(service.SyncError is null && NoWarning(service.ArchiveStatus), "ordinary bridge entry rejection is not a protection failure");
            await ExpectReason("/api/order/place", new { account = accountA, symbol = security.SecurityId, action = "BUY", orderType = "LIMIT", quantity = 1, limitPrice = 20000, tp = 20010, sl = 19990 },
                hoursReason, "rejected entry with attachments retains the exact venue reason");
            var rejectedBrackets = (await Call("/api/brackets", account: accountA)).GetProperty("brackets");
            check(rejectedBrackets.GetArrayLength() == 0 && service.SyncError is null,
                "definitively rejected unfilled entry retires its unused protection intent");

            fake.Reject = null;
            await Call("/api/order/place", new { account = accountA, symbol = security.SecurityId, action = "BUY", orderType = "LIMIT", quantity = 1, limitPrice = 20000, tp = 20010, sl = 19990 });
            var entry = fake.Orders.Last();
            const string targetReason = "Reason: protective target rejected by venue";
            fake.Reject = (operation, order) => operation == "register" && order.Comment!.EndsWith("|TP") ? targetReason : null;
            fake.Fill(connector, entry, 1, 20000, updatePosition: true);
            await Call("/api/accounts");
            var failedTarget = fake.Orders.Last();
            var persisted = await File.ReadAllTextAsync(Path.Combine(directory, "protections.json"));
            check(service.SyncError?.Contains(targetReason) == true && service.ProtectionError(accountA)?.Contains(targetReason) == true && persisted.Contains(targetReason),
                "actual protective-leg rejection stays visible and is durably frozen");
            check(service.ProtectionError(accountB) is null && NoWarning(service.ArchiveStatus),
                "another account and the execution archive do not inherit a protective-leg error");
            fake.EmitFailure("register", new Order { Id = failedTarget.Id, Comment = failedTarget.Comment, AccountID = "B", Portfolio = b }, "foreign-account rejection");
            await Call("/api/accounts");
            var bBrackets = await Call("/api/brackets", account: accountB);
            check(service.SyncError?.Contains(targetReason) == true && !service.SyncError.Contains("foreign-account rejection") &&
                bBrackets.GetProperty("syncError").ValueKind == JsonValueKind.Null,
                "equal order IDs in another account cannot overwrite or inherit a protection error");
            var beforePoll = fake.Calls.Count;
            await Call("/api/accounts");
            check(service.SyncError?.Contains(targetReason) == true && fake.Calls.Count == beforePoll,
                "successful polling cannot clear or retry an unresolved protective failure");
            service.Dispose(); await service.Disposal;
            service = new AtasTradingService(platform, directory, startWorker: false);
            await Call("/api/accounts");
            check(service.SyncError?.Contains(targetReason) == true, "protective rejection survives plugin restart");
            fake.Reject = null;
            await Call("/api/position/close", new { account = accountA, symbol = security.SecurityId });
            await Call("/api/accounts");
            check(service.SyncError is null && service.ProtectionError(accountA) is null,
                "confirmed close clears resolved protection errors from status and account scope");

            var normal = await Call("/api/order/place", new { account = accountA, symbol = security.SecurityId, action = "BUY", orderType = "LIMIT", quantity = 1, limitPrice = 20000 });
            var orderId = normal.GetProperty("orderId").GetString();
            fake.Reject = (operation, _) => operation == "modify" ? "venue change reason" : operation == "cancel" ? "venue cancel reason" : null;
            await ExpectReason("/api/order/change", new { account = accountA, orderId, limitPrice = 20001 }, "venue change reason", "modify POST keeps its own precise rejection reason");
            await ExpectReason("/api/order/cancel", new { account = accountA, orderId }, "venue cancel reason", "cancel POST keeps its own precise rejection reason");
            check(service.SyncError is null && NoWarning(service.ArchiveStatus), "ordinary modify and cancel failures remain request-local");
            fake.Reject = null;
            await Call("/api/order/change", new { account = accountA, orderId, limitPrice = 20002 });
            check(service.SyncError is null, "a later successful operation cannot reuse an earlier rejection reason");

            service.Dispose(); await service.Disposal;
            await File.WriteAllTextAsync(Path.Combine(directory, "protections.json"), "{damaged");
            service = new AtasTradingService(platform, directory, startWorker: false);
            await Call("/api/accounts"); await Call("/api/accounts");
            check(service.SyncError?.Contains("归档加载失败") == true && service.ProtectionError(accountA)?.Contains("归档加载失败") == true,
                "a damaged protection archive remains a global unresolved error after successful polling");
            check(await File.ReadAllTextAsync(Path.Combine(directory, "protections.json")) == "{damaged" && NoWarning(service.ArchiveStatus),
                "a damaged protection archive is preserved and is distinct from the execution journal");
        }
        finally { service.Dispose(); await service.Disposal; Directory.Delete(directory, recursive: true); }
    }

    private sealed class FakePlatform(IDataFeedConnector connector) : IAtasTradingPlatform
    {
        public IDataFeedConnector[] GetConnectors() => [connector];
        public Guid ConnectionId(IDataFeedConnector _) => new("01234567-89ab-cdef-0123-456789abcdef");
        public string ConnectionName(IDataFeedConnector _) => "Failure test";
        public Security ResolveSecurity(string symbol, IDataFeedConnector c) => c.Securities.Single(s => s.SecurityId == symbol);
        public string SymbolName(Security security) => security.SecurityId;
        public string[] ChartSymbols(IDataFeedConnector _, Security security) => [security.SecurityId];
    }
}
