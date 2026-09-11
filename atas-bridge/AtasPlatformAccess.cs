using System.Diagnostics;
using ATAS.DataFeedsCore;
using ATAS.Indicators;
using OFT.Core.DataProvider;
using OFT.Core.Models;
using OFT.Platform.Core.Managers.Connections;
using OFT.Platform.Core.Managers.Instruments;
using OFT.Platform.Core.Providers;
using OFT.Plarform.Core.Extensions;
using Utils.Common.Collections.Synchronized;
using PlatformInstrument = OFT.Platform.Models.Instrument;

namespace TvAtasBridge;

/// <summary>
/// Compatibility adapter for the verified ATAS X 8.0 beta builds. These builds predate the public
/// multi-instrument indicator API. Resolve existing, typed platform services
/// through its public service locator ("Plarform" is ATAS's namespace spelling);
/// never construct a second connection or fall back to chart-only account data.
/// </summary>
public sealed class AtasPlatformAccess
{
    private sealed record Catalog(Contract[] Contracts, Dictionary<ContractIdentifier, string> Names, long Stamp);
    private readonly object _catalogGate = new();
    private Catalog? _catalog;
    private sealed record ChartCatalog(Dictionary<Security, string[]> Symbols, long Stamp);
    private readonly object _chartCatalogGate = new();
    private readonly Dictionary<IDataFeedConnector, ChartCatalog> _chartCatalogs = new(ReferenceEqualityComparer.Instance);
    public static IReadOnlyList<string> SupportedVersions { get; } = Array.AsReadOnly(new[] { "8.0.14.646", "8.0.15.643" });
    public static string RuntimeVersion => FileVersionInfo.GetVersionInfo(typeof(MarketDataAdapter).Assembly.Location).FileVersion ?? "unknown";
    public IIndicatorDataProvider DataProvider { get; }
    public MarketDataAdapter Adapter { get; }
    public IInstrumentsManager Instruments { get; }
    public IConnectorsManager Connectors { get; }
    public ICachedHistoryMarketDataProvider History { get; }
    public string Version { get; }

    public AtasPlatformAccess(IIndicatorDataProvider dataProvider)
    {
        DataProvider = dataProvider ?? throw new ArgumentNullException(nameof(dataProvider));
        Version = RequireSupportedRuntime();
        Adapter = Service<MarketDataAdapter>(dataProvider);
        Instruments = Service<IInstrumentsManager>(dataProvider);
        Connectors = Service<IConnectorsManager>(dataProvider);
        History = Service<ICachedHistoryMarketDataProvider>(dataProvider);
    }

    public static string RequireSupportedRuntime()
    {
        var version = RuntimeVersion;
        if (!SupportedVersions.Contains(version, StringComparer.Ordinal))
            throw new InvalidOperationException($"ATAS X 版本 {version} 尚未验证；此桥接已验证版本为 {string.Join("、", SupportedVersions)}。请针对当前安装版本更新数据桥。");
        return version;
    }

    private static T Service<T>(object context) where T : class
    {
        try { return ResolveExtension.Resolve<T>(context) ?? throw new InvalidOperationException("服务返回空值"); }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"ATAS {RuntimeVersion} 全局服务 {typeof(T).Name} 尚未就绪：{ex.Message}", ex);
        }
    }

    public IDataFeedConnector[] GetConnectors() => Connectors.Connectors.ToArray();
    public Contract[] GetContracts() => GetCatalog(true).Contracts;

    private Catalog GetCatalog(bool refresh = false)
    {
        lock (_catalogGate)
        {
            if (!refresh && _catalog != null && Environment.TickCount64 - _catalog.Stamp < 1000) return _catalog;
            var contracts = Instruments.Contracts.Where(c => !c.IsDeleted && c.TickSize > 0).DistinctBy(c => c.Identifier).ToArray();
            return _catalog = new Catalog(contracts, CatalogSymbols(contracts), Environment.TickCount64);
        }
    }

    private static string BaseSymbolName(Contract contract) => !string.IsNullOrWhiteSpace(contract.SecurityId)
        ? contract.SecurityId : "ATAS:" + contract.Identifier;

    public static Dictionary<ContractIdentifier, string> CatalogSymbols(IEnumerable<Contract> contracts)
    {
        var names = new Dictionary<ContractIdentifier, string>();
        foreach (var group in contracts.DistinctBy(c => c.Identifier).GroupBy(BaseSymbolName, StringComparer.OrdinalIgnoreCase))
        {
            var ambiguous = group.Skip(1).Any();
            foreach (var contract in group)
                names[contract.Identifier] = group.Key + (ambiguous ? "#atas-id=" + contract.Identifier : "");
        }
        return names;
    }

    public string SymbolName(Contract contract)
    {
        if (GetCatalog().Names.TryGetValue(contract.Identifier, out var name)) return name;
        return GetCatalog(true).Names.GetValueOrDefault(contract.Identifier, BaseSymbolName(contract));
    }

    public string SymbolName(Security security)
    {
        var instrument = PlatformInstrument.GetInstrument(security);
        var contract = instrument?.ContractDescription ?? Instruments.TryGetContractBySecurityId(security.SecurityId);
        return contract == null ? security.SecurityId : SymbolName(contract);
    }

    /// <summary>Display aliases only: separate native contracts can reference the same connector security.</summary>
    public string[] ChartSymbols(IDataFeedConnector connector, Security security)
    {
        var canonical = SymbolName(security);
        try
        {
            lock (_chartCatalogGate)
            {
                if (!_chartCatalogs.TryGetValue(connector, out var catalog) || Environment.TickCount64 - catalog.Stamp >= 1000)
                {
                    // Capture the naming catalog once; account polling must not scan it for every position.
                    var names = GetCatalog().Names;
                    var instruments = Instruments.PlatformInstruments;
                    catalog = new ChartCatalog(BuildChartSymbolIndex(connector, instruments.Select(instrument =>
                        (names.GetValueOrDefault(instrument.ContractDescription.Identifier, BaseSymbolName(instrument.ContractDescription)),
                         instrument.SecuritiesByConnector))), Environment.TickCount64);
                    _chartCatalogs[connector] = catalog;
                }
                return catalog.Symbols.TryGetValue(security, out var aliases)
                    ? new[] { canonical }.Concat(aliases).Distinct(StringComparer.Ordinal).ToArray()
                    : [canonical];
            }
        }
        catch
        {
            // Missing display metadata must never hide an otherwise valid native position/order.
            lock (_chartCatalogGate)
                _chartCatalogs[connector] = new ChartCatalog(new(ReferenceEqualityComparer.Instance), Environment.TickCount64);
            return [canonical];
        }
    }

    internal static Dictionary<Security, string[]> BuildChartSymbolIndex(IDataFeedConnector connector,
        IEnumerable<(string Symbol, SyncDictionary<IDataFeedConnector, Security> Securities)> instruments)
    {
        var symbols = new Dictionary<Security, HashSet<string>>(ReferenceEqualityComparer.Instance);
        foreach (var (symbol, securities) in instruments)
        {
            // The native SyncDictionary.TryGetValue takes its internal SyncRoot lock.
            // Never join by SecurityId: equal text from a different security/connector is insufficient.
            if (!securities.TryGetValue(connector, out var security) || security is null || string.IsNullOrWhiteSpace(symbol)) continue;
            if (!symbols.TryGetValue(security, out var aliases)) symbols.Add(security, aliases = new(StringComparer.Ordinal));
            aliases.Add(symbol);
        }
        return symbols.ToDictionary(pair => pair.Key, pair => pair.Value.ToArray(), (IEqualityComparer<Security>)ReferenceEqualityComparer.Instance);
    }

    public Contract ResolveContract(string symbol)
    {
        symbol = symbol.Trim();
        if (symbol.Length == 0) throw new BridgeRequestException(400, "缺少合约 symbol");
        var all = GetContracts();
        var names = CatalogSymbols(all);
        var exact = all.Where(c => Equal(names[c.Identifier], symbol)).ToArray();
        if (exact.Length == 1) return exact[0];
        var aliases = all.Where(c => Equal(BaseSymbolName(c), symbol) || Equal(c.Code, symbol) || Equal(c.SecurityCode, symbol)).ToArray();
        if (aliases.Length == 1) return aliases[0];
        if (exact.Length > 1 || aliases.Length > 1)
            throw new BridgeRequestException(409, $"合约 {symbol} 对应多个市场，请从搜索结果选择完整合约标识");
        throw new BridgeRequestException(404, $"ATAS 合约目录中没有 {symbol}；请确认连接已完成合约列表加载");
    }

    public Security ResolveSecurity(string symbol, IDataFeedConnector connector)
    {
        var exact = connector.Securities.Where(s => Equal(SymbolName(s), symbol) || Equal(s.SecurityId, symbol)).ToArray();
        if (exact.Length == 1) return exact[0];
        var contract = ResolveContract(symbol);
        var instrument = Instruments.TryGetInstrument(contract);
        if (instrument != null && instrument.SecuritiesByConnector.TryGetValue(connector, out var security) && security != null) return security;
        var mapped = connector.Securities.Where(s => Equal(s.Code, contract.SecurityCode) && Equal(s.Exchange, contract.Exchange)).ToArray();
        if (mapped.Length == 1) return mapped[0];
        throw new BridgeRequestException(409, $"该账户连接尚未映射合约 {symbol}，请先在 ATAS 中加载该合约");
    }

    public static ITimeZoneTradingSession Session(Contract contract) => contract.Instrument?.Exchange?.DefaultTradingSession
        ?? throw new BridgeRequestException(503, $"合约 {BaseSymbolName(contract)} 缺少交易所时区/交易时段，无法安全转换行情时间");

    public static bool Equal(string? a, string? b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
}
