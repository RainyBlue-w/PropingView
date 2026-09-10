// Read-only comparison: identical time range queried directly and inside a wider NT8 request.
import fs from 'node:fs';
const base = process.env.NT8_BRIDGE_URL || 'http://127.0.0.1:8090';
const symbol = process.argv[2] || 'NQ SEP26';
const to = Math.floor(Date.parse(process.argv[3] || '2026-09-04T08:00:00Z') / 1000);
const from = to - 8 * 3600;
async function history(a, b) {
  const q = new URLSearchParams({ symbol, interval: '60', from: String(a), to: String(b) });
  const r = await fetch(`${base}/api/history?${q}`, { signal: AbortSignal.timeout(30000) });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d.bars;
}
const narrow = await history(from, to);
const wide = (await history(from - 2 * 86400, to + 86400)).filter(b => b.time >= from && b.time <= to);
const times = new Set(narrow.map(b => b.time));
const gaps = bars => bars.flatMap((b, i) => i && b.time - bars[i - 1].time > 60
  ? [{ from: new Date(bars[i - 1].time * 1000).toISOString(), to: new Date(b.time * 1000).toISOString(), seconds: b.time - bars[i - 1].time }] : []);
const result = { symbol, from, to, narrowCount: narrow.length, wideCount: wide.length,
  missingInNarrow: wide.filter(b => !times.has(b.time)).map(b => b.time),
  narrowGaps: gaps(narrow), wideGaps: gaps(wide) };
fs.mkdirSync('.tmp-webbridge', { recursive: true });
fs.writeFileSync('.tmp-webbridge/history-diagnosis.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, missingInNarrow: result.missingInNarrow.length }, null, 2));
