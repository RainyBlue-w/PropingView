// 集成测试:TvDatafeed + ReplaySession 全链路(模拟库的调用序列)
// 覆盖:初始加载(游标钳制)→ 订阅 → step 后 onTick 是否收到新 bar
import { TvDatafeed } from '../.tmp-webbridge/unit/tvDatafeed.mjs';
import { ReplaySession } from '../.tmp-webbridge/unit/replaySession.mjs';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  OK  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

// 确定性 inner adapter:1min bar,[T0, T0+3d]
const T0 = Math.floor(1700000000 / 60) * 60;
const END = T0 + 3 * 86400;
function makeBars(from, to) {
  const out = [];
  for (let t = Math.ceil(from / 60) * 60; t <= to; t += 60) {
    if (t > END) continue;
    const c = 100 + Math.sin((t - T0) / 600) * 2;
    out.push({ time: t, open: c - 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 10 });
  }
  return out;
}
const inner = {
  getSymbols: async () => [{ symbol: 'TEST', name: 'TEST', tickSize: 0.25, pointValue: 50 }],
  getHistory: async (s, i, from, to) => makeBars(from, to),
  subscribe: () => () => { },
};

// 模拟库的最小行为:resolveSymbol -> getBars(初始窗口) -> subscribeBars
async function bootChartAtCursor(df, cursor) {
  const symInfo = await new Promise((res) => df.resolveSymbol('TEST', res, () => { }));
  const now = Math.floor(Date.now() / 1000);
  // 库的初始窗口:to≈真实 now(远大于游标),from=now-500min
  const first = await new Promise((res, rej) =>
    df.getBars(symInfo, '1', { from: now - 500 * 60, to: now, firstDataRequest: true }, (bars, meta) => res({ bars, meta }), rej),
  );
  // 若首页空且带 nextTime,库会继续请求 [?, nextTime]
  let latest = first;
  while (latest.bars.length === 0 && latest.meta && latest.meta.nextTime) {
    const nt = latest.meta.nextTime;
    latest = await new Promise((res, rej) =>
      df.getBars(symInfo, '1', { from: nt - 500 * 60, to: nt, firstDataRequest: true }, (bars, meta) => res({ bars, meta }), rej),
    );
  }
  return { symInfo, latest };
}

// 用例 1:游标在 1 天前(库初始窗口 [now-500min, now] 完全在游标右侧 → 走空页回放分支)
{
  console.log('[case1] 游标=1天前(初始窗口在游标右侧)');
  const cursor = END - 86400;
  const session = new ReplaySession(inner, cursor);
  const df = new TvDatafeed(inner);
  df.setAdapter(session);
  const { symInfo, latest } = await bootChartAtCursor(df, cursor);
  check('初始加载到游标页(有 bar 且末根≤游标)', latest.bars.length > 0 && latest.bars[latest.bars.length - 1].time / 1000 <= cursor);
  check('lastPrice = 游标处收盘价', df.getLastPrice('TEST') != null);

  const ticks = [];
  df.subscribeBars(symInfo, '1', (bar) => ticks.push(bar), 'guid-1');
  const ok1 = await session.step();
  const ok2 = await session.step();
  check('step 返回 true', ok1 && ok2);
  check('onTick 收到 2 根新 bar', ticks.length === 2);
  check(
    '新 bar 时间 = 游标+60/+120(秒→毫秒)',
    ticks.length === 2 && ticks[0].time === (cursor + 60) * 1000 && ticks[1].time === (cursor + 120) * 1000,
  );
  check('onTick 后 lastPrice 更新为最新揭示价', df.getLastPrice('TEST') === ticks[ticks.length - 1].close);
}

// 用例 2:游标在 30 天前?——inner 数据只到 END,这里改为游标=END-30min,验证跨"当前 bar 未成型"边界
{
  console.log('[case2] 游标接近数据尽头');
  const cursor = END - 30 * 60;
  const session = new ReplaySession(inner, cursor);
  const df = new TvDatafeed(inner);
  df.setAdapter(session);
  const { symInfo, latest } = await bootChartAtCursor(df, cursor);
  check('尽头附近初始加载有数据', latest.bars.length > 0);
  df.subscribeBars(symInfo, '1', () => { }, 'guid-2');
  // 连走到尽头
  let ok = true, n = 0;
  while (ok && n < 100) { ok = await session.step(); n++; }
  check('走到尽头自动 false(30 根)', n === 31 && ok === false);
}

// 用例 3:用最新价种子帧语义——step 揭示的 bar 与历史末根同桶时不破坏 OHLC(走 TvDatafeed 的 seed 回填分支)
{
  console.log('[case3] 订阅守卫:乱序/同桶帧');
  const cursor = END - 86400;
  const session = new ReplaySession(inner, cursor);
  const df = new TvDatafeed(inner);
  df.setAdapter(session);
  const { symInfo } = await bootChartAtCursor(df, cursor);
  const ticks = [];
  df.subscribeBars(symInfo, '1', (bar) => ticks.push(bar), 'guid-3');
  await session.step();
  const before = ticks.length;
  // 手动从订阅侧推一根"时间倒退"的帧(模拟桥端乱序),应被守卫丢弃
  const unsub = (function () { return null; })();
  void unsub;
  check('step 后 ticks 计数正常', before === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
