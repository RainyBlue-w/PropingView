// 回放核心逻辑 Node 单元测试(无浏览器):
// ReplaySession(游标钳制/步进揭示/空窗跳页) + SimTrading(市价/限价/止损/OCO/盈亏/平仓)
import { ReplaySession } from '../.tmp-webbridge/unit/replaySession.mjs';
import { SimTrading, SIM_ACCOUNT } from '../.tmp-webbridge/unit/simTrading.mjs';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  OK  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

// ---- 确定性 inner adapter:1min bar,[T0, T0+3*86400],价格围绕 100 波动;挖一个 1 小时的洞当空窗 ----
const T0 = Math.floor(1700000000 / 60) * 60; // 分钟对齐,bar 时间落在整分钟网格上
const END = T0 + 3 * 86400;
const HOLE_START = T0 + 3600 * 5, HOLE_END = T0 + 3600 * 6; // 第 5~6 小时无数据
function makeBars(from, to) {
  const out = [];
  for (let t = Math.ceil(from / 60) * 60; t <= to; t += 60) {
    if (t > END) continue; // 数据尽头
    if (t >= HOLE_START && t < HOLE_END) continue; // 空窗
    const c = 100 + Math.sin((t - T0) / 600) * 2;
    out.push({ time: t, open: c - 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 10 });
  }
  return out;
}
const inner = {
  getSymbols: async () => [{ symbol: 'TEST', name: 'TEST' }],
  getHistory: async (s, i, from, to) => makeBars(from, to),
  subscribe: () => () => { },
};

async function testSession() {
  console.log('[ReplaySession]');
  const cursor = T0 + 3600; // 游标在 1 小时处
  const s = new ReplaySession(inner, cursor);

  // 钳制:越过游标的窗口只返回 ≤ 游标的 bar
  const clamped = await s.getHistory('TEST', 60, cursor - 300, cursor + 99999);
  check('getHistory 钳到游标(末根=cursor)', clamped.length > 0 && clamped[clamped.length - 1].time <= cursor);
  // 完全在游标右侧的窗口返回空
  const right = await s.getHistory('TEST', 60, cursor + 60, cursor + 3600);
  check('游标右侧窗口返回空', right.length === 0);

  // 订阅 + 步进:每步揭示恰好一根,时间单调
  const revealed = [];
  const revealCb = [];
  s.subscribe('TEST', 60, (b) => revealed.push(b));
  s.onBarRevealed((sym, iv, b) => revealCb.push(b));
  const ok1 = await s.step();
  check('step 揭示下一根', ok1 === true && revealed.length === 1 && revealed[0].time === cursor + 60);
  check('onBarRevealed 同步触发', revealCb.length === 1);
  check('游标推进', s.getCursor() === cursor + 60);

  // 连走到空窗前(注意前面已步进过一根,从当前游标动态算步数)
  const stepsToHole = (HOLE_START - 60 - s.getCursor()) / 60;
  for (let i = 0; i < stepsToHole; i++) await s.step();
  check('空窗前游标位置正确', s.getCursor() === HOLE_START - 60);
  // 跨过空窗:下一步应揭示 HOLE_END 处的 bar(跳页)
  const before = revealed.length;
  const ok2 = await s.step();
  check('step 跳过空窗', ok2 === true && revealed.length === before + 1 && revealed[revealed.length - 1].time === HOLE_END);

  // 时间步长窗口:1min 图 step(300) 应揭示 5 根
  {
    const s = new ReplaySession(inner, cursor);
    const revealed = [];
    s.subscribe('TEST', 60, (b) => revealed.push(b));
    await s.step(300);
    check('step(300) 一次揭示 5 根,游标 +300s', revealed.length === 5 && s.getCursor() === cursor + 300);
  }
  // 步长窗口与休市段:窗口内有几根揭几根;窗口全空则跳到休市后第一根
  {
    const s3 = new ReplaySession(inner, HOLE_START - 120);
    const rev3 = [];
    s3.subscribe('TEST', 60, (b) => rev3.push(b));
    await s3.step(300); // 窗口 (HOLE_START-120, HOLE_START+180]:只有 HOLE_START-60 一根
    check('窗口内部分揭示(休市前最后 1 根)', rev3.length === 1 && s3.getCursor() === HOLE_START - 60);
    await s3.step(300); // 窗口 (HOLE_START-60, HOLE_START+240]:全在洞内 → 跳到洞后第一根
    check('窗口全空跳到休市后第一根', rev3.length === 2 && s3.getCursor() === HOLE_END);
  }

  // 到数据尽头
  const s2 = new ReplaySession(inner, END - 60);
  s2.subscribe('TEST', 60, () => { });
  await s2.step(); // 揭示 END
  check('尽头前最后一根', s2.getCursor() === END);
  const endOk = await s2.step();
  check('数据尽头 step 返回 false', endOk === false);
}

async function testSim() {
  console.log('[SimTrading]');
  let lastPrice = 100;
  let cursorTime = T0;
  const sim = new SimTrading({
    getLastPrice: () => lastPrice,
    pointValueOf: () => 50, // ES 风格
    getCursorTime: () => cursorTime,
  });

  // 市价买 2 @100
  const r1 = await sim.placeOrder({ account: SIM_ACCOUNT, symbol: 'TEST', action: 'BUY', orderType: 'MARKET', quantity: 2 });
  check('市价单立即成交', r1.ok === true);
  let pos = (await sim.getPositions(SIM_ACCOUNT)).positions.find((p) => p.instrument === 'TEST');
  check('市价买入后持仓 +2 @100', pos && pos.quantity === 2 && pos.averagePrice === 100);

  // 限价买 1 @99(市价下方,挂单)
  const r2 = await sim.placeOrder({ account: SIM_ACCOUNT, symbol: 'TEST', action: 'BUY', orderType: 'LIMIT', quantity: 1, limitPrice: 99 });
  check('限价单挂出', r2.ok === true && (await sim.getOrders(SIM_ACCOUNT)).orders.length === 1);

  // bar 触及 99:low=98.5 → 成交于 min(open,99)
  cursorTime += 60;
  sim.onBar('TEST', { time: cursorTime, open: 99.4, high: 100, low: 98.5, close: 99.8, volume: 1 });
  pos = (await sim.getPositions(SIM_ACCOUNT)).positions.find((p) => p.instrument === 'TEST');
  check('限价单被 bar 触及成交,持仓 3', pos && pos.quantity === 3);
  check('加权均价正确', pos && Math.abs(pos.averagePrice - (100 * 2 + 99) / 3) < 1e-9);

  // 带 TP/SL 市价买 1(均价线检查)+ OCO 子单
  cursorTime += 60;
  await sim.placeOrder({ account: SIM_ACCOUNT, symbol: 'TEST', action: 'BUY', orderType: 'MARKET', quantity: 1, tp: 101, sl: 98.5 });
  const ords = (await sim.getOrders(SIM_ACCOUNT)).orders;
  check('OCO 子单挂出(TP+SL)', ords.length === 2 && ords.some((o) => o.name === 'TP') && ords.some((o) => o.name === 'SL'));
  check('OCO 同组', ords[0].oco && ords[0].oco === ords[1].oco);

  // TP 触发(high=101.2 ≥ 101)→ 按全部 4 手持仓卖出后平仓,SL 应被 OCO 撤掉
  cursorTime += 60;
  sim.onBar('TEST', { time: cursorTime, open: 100.6, high: 101.2, low: 100.2, close: 101, volume: 1 });
  const ords2 = (await sim.getOrders(SIM_ACCOUNT)).orders;
  check('TP 成交后 SL 被 OCO 撤销', ords2.length === 0);
  pos = (await sim.getPositions(SIM_ACCOUNT)).positions.find((p) => p.instrument === 'TEST');
  check('TP 按全部持仓数量出场后平仓', !pos);

  // 止损单:卖 2 stop @99;bar 跳空低开 98.8 → 按更差的开盘价 98.8 成交
  await sim.placeOrder({ account: SIM_ACCOUNT, symbol: 'TEST', action: 'SELL', orderType: 'STOPMARKET', quantity: 2, stopPrice: 99 });
  cursorTime += 60;
  sim.onBar('TEST', { time: cursorTime, open: 98.8, high: 99.2, low: 98.4, close: 98.9, volume: 1 });
  pos = (await sim.getPositions(SIM_ACCOUNT)).positions.find((p) => p.instrument === 'TEST');
  check('止损跳空按开盘价成交,新开空仓 2', pos && pos.quantity === -2 && pos.averagePrice === 98.8);

  // 已实现盈亏核对:TP 卖 4 @101(成本 99.75),后续止损入场开空仓不产生已实现盈亏
  const avgCost = (100 * 2 + 99 + 100) / 4; // 4 手混合成本
  const expectRealized = (101 - avgCost) * 4 * 50;
  const acc = (await sim.getAccounts()).accounts[0];
  check('已实现盈亏正确', Math.abs((acc.realizedPnl ?? 0) - expectRealized) < 0.01);

  // 成交流水:getExecutions 忽略 from/to(回放游标可能早于拉取窗口)
  // 成交笔数按"次数"而非手数:市价2 + 限价1 + 带括号市价1 + TP出场1 + 止损出场1 = 5 笔
  const execs = (await sim.getExecutions(SIM_ACCOUNT, 'TEST', 0, 0)).executions;
  check('成交流水 5 笔(市价2/限价1/括号1/TP1/止损1)', execs.length === 5);

  // 平仓:反向市价,持仓归零,工作单清空
  lastPrice = 100.5;
  await sim.closePosition(SIM_ACCOUNT, 'TEST');
  pos = (await sim.getPositions(SIM_ACCOUNT)).positions.find((p) => p.instrument === 'TEST');
  check('平仓后无持仓', !pos);
  check('平仓后工作单清空', (await sim.getOrders(SIM_ACCOUNT)).orders.length === 0);

  // 改单到已穿越价位 → 立即成交
  const r3 = await sim.placeOrder({ account: SIM_ACCOUNT, symbol: 'TEST', action: 'BUY', orderType: 'LIMIT', quantity: 1, limitPrice: 99 });
  check('改单前限价单在挂', (await sim.getOrders(SIM_ACCOUNT)).orders.length === 1);
  await sim.changeOrder(SIM_ACCOUNT, r3.orderId, { limitPrice: 101 }); // 市价 100.5 < 101 → 立即可成交
  check('改到可成交价立即成交', (await sim.getOrders(SIM_ACCOUNT)).orders.length === 0);
}

await testSession();
await testSim();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
