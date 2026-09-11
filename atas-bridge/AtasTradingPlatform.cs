using ATAS.DataFeedsCore;

namespace TvAtasBridge;

internal interface IAtasTradingPlatform
{
    IDataFeedConnector[] GetConnectors();
    Security ResolveSecurity(string symbol, IDataFeedConnector connector);
    string SymbolName(Security security);
    string[] ChartSymbols(IDataFeedConnector connector, Security security);
    string ConnectionName(IDataFeedConnector connector);
    Guid ConnectionId(IDataFeedConnector connector);
}

internal sealed class LiveAtasTradingPlatform(AtasPlatformAccess access) : IAtasTradingPlatform
{
    public IDataFeedConnector[] GetConnectors() => access.GetConnectors();
    public Security ResolveSecurity(string symbol, IDataFeedConnector connector) => access.ResolveSecurity(symbol, connector);
    public string SymbolName(Security security) => access.SymbolName(security);
    public string[] ChartSymbols(IDataFeedConnector connector, Security security) => access.ChartSymbols(connector, security);
    // Settings IDs survive process restarts; a connector instance ID is not an archive identity.
    public Guid ConnectionId(IDataFeedConnector connector) => access.Connectors.TryGetSettings(connector)?.Id
        ?? throw new InvalidOperationException("ATAS 连接缺少持久化标识，暂不能安全关联账户归档。 ");
    public string ConnectionName(IDataFeedConnector connector) => access.Connectors.TryGetSettings(connector)?.Name
        ?? connector.GetType().Name.Replace("Connector", "");
}
