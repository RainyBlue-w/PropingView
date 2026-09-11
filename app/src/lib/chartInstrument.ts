/** Display matching only. Never infer equivalence by removing an ATAS contract ID:
 * the bridge supplies aliases verified against the account connector's native Security.
 * Original instrument names and order IDs remain the identifiers sent for trading.
 */
export function matchesChartInstrument(row: { instrument: string; chartSymbols?: string[] }, symbol: string): boolean {
  // TradingView uppercases chart.symbol(), including the native ATAS ID suffix.
  // Compare the complete identifier, as the bridge resolver does; keep every ID/market component.
  const chartSymbol = symbol.toUpperCase();
  const matches = (candidate: string) => typeof candidate === 'string' && candidate.toUpperCase() === chartSymbol;
  return matches(row.instrument) || (Array.isArray(row.chartSymbols) && row.chartSymbols.some(matches));
}
