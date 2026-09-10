import { nt8Trading } from './nt8Trading';
import { SIM_ACCOUNT, type SimTrading } from './simTrading';

/**
 * 交易后端路由:默认直连 NT8 数据桥;回放模拟期间(setTradingBackend)
 * 所有交易调用改道本地模拟引擎。UI/hook 只认 `trading`,不关心后端是谁。
 * (SimTrading 方法省略了不用的 account/from/to 参数——参数更少的实现
 *  可结构性地赋给 nt8Trading 的签名,调用方按 nt8Trading 签名传参即可)
 */
let backend: typeof nt8Trading = nt8Trading;

/** 切换交易后端:null = 恢复 NT8 实盘 */
export function setTradingBackend(sim: SimTrading | null): void {
  backend = sim ?? nt8Trading;
}

function assertTradingAccount(account: string): void {
  if ((backend === nt8Trading) === (account === SIM_ACCOUNT)) {
    throw new Error('交易账户与当前会话不一致，请等待页面刷新后重试。');
  }
}

export const trading: typeof nt8Trading = {
  getAccounts: () => backend.getAccounts(),
  getPositions: (account) => backend.getPositions(account),
  getOrders: (account) => backend.getOrders(account),
  getBrackets: (account) => backend.getBrackets(account),
  getExecutions: (account, symbol, from, to) => backend.getExecutions(account, symbol, from, to),
  getExecutionPage: (account, symbol, from, to, offset, limit) => backend.getExecutionPage(account, symbol, from, to, offset, limit),
  placeOrder: async (payload) => { assertTradingAccount(payload.account); return backend.placeOrder(payload); },
  cancelOrder: async (account, orderId) => { assertTradingAccount(account); return backend.cancelOrder(account, orderId); },
  changeOrder: async (account, orderId, price) => { assertTradingAccount(account); return backend.changeOrder(account, orderId, price); },
  closePosition: async (account, symbol) => { assertTradingAccount(account); return backend.closePosition(account, symbol); },
};
