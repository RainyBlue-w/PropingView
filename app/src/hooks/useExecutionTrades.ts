import { useEffect, useRef } from 'react';
import { type Nt8Execution } from '@/lib/nt8Trading';
import { trading } from '@/lib/tradingRouter';
import { pairRoundTrips } from '@/lib/executionPairs';
import { ensureExecutionToolPatched } from '@/lib/tvExecutionTool';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface UseExecutionTradesParams {
  widget: TradingViewWidget | null;
  symbol: string;
  /** 空串 = 未选账户/非 NT8,不画 */
  account: string;
  /** 每 1.00 点美元价值(连线盈亏金额用) */
  pointValue: number;
  /** 成交签名:变化时重新拉取(新成交即时上图) */
  refreshKey: string;
  /** false = 宿主已切到自绘覆盖层,本 hook 不动作(linetool 回退方案) */
  enabled: boolean;
}

/** 拉取的成交历史回溯窗口 */
const LOOKBACK_SEC = 7 * 86400;

/**
 * 私有路径:创建 LineToolExecution 成交小三角并配置属性。
 * 返回值是图表实体 id(与公开 createMultipointShape 同域,removeEntity 可删)。
 * 任何一步失败抛异常,由调用方回退到公开箭头。
 */
function createExecTriangle(chart: any, e: Nt8Execution, isBuy: boolean): any {
  const cw = chart._chartWidget;
  const model = cw?._model ?? cw?.model?.();
  if (!model) throw new Error('no chart model');
  const pane = model.paneForSource(model.mainSeries());
  const pts = chart._convertUserPointsToDataSource([{ time: e.time, price: e.price }]);
  const point = pts?.[0];
  if (!pane || !point) throw new Error('point convert failed');
  const src = model.createLineTool({ pane, point, linetool: 'LineToolExecution' });
  if (!src) throw new Error('createLineTool returned null');
  const color = isBuy ? '#26a69a' : '#ef5350';
  const p = typeof src.properties === 'function' ? src.properties() : null;
  if (p) {
    p.direction?.setValue?.(isBuy ? 'buy' : 'sell');
    p.text?.setValue?.(`${isBuy ? 'BUY' : 'SELL'} ${e.qty} @${e.price}`);
    p.tooltip?.setValue?.(
      `${isBuy ? 'Buy' : 'Sell'} ${e.qty} @ ${e.price}\n${new Date(e.time * 1000).toLocaleString()}\norderId: ${e.orderId}`,
    );
    p.arrowBuyColor?.setValue?.('#26a69a');
    p.arrowSellColor?.setValue?.('#ef5350');
    p.textColor?.setValue?.(color);
    p.frozen?.setValue?.(true); // 锁定,防误拖
  }
  src.setSavingInChartEnabled?.(false); // 与公开路径 disableSave 对齐:不参与布局保存
  return src.id();
}

/**
 * 图表交易历史(交易平台风格):
 * - 成交点:优先用 LineToolExecution 小三角(官网同款,y 经补丁精确锚定成交价,
 *   附带文字与 tooltip;引导见 lib/tvExecutionTool.ts),私有 API 不可用时回退
 *   arrow_up/down 公开箭头(买绿卖红,尖端同样精确对准成交时间/价);
 * - FIFO 配对进出场,画虚线连线并标注盈亏金额(盈绿亏红);
 * - 所有图形 zOrder 顶层、锁定不可拖、不参与保存。
 * 数据来自 /api/executions(NT8 本地库,默认永久保存)。
 */
export function useExecutionTrades({
  widget,
  symbol,
  account,
  pointValue,
  refreshKey,
  enabled,
}: UseExecutionTradesParams) {
  /** execKey/tripKey -> 图表绘图实体 id */
  const shapesRef = useRef(new Map<string, any>());
  const creatingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !widget || !symbol || !account) return;
    let chart: any = null;
    try {
      chart = (widget as any).activeChart();
    } catch {
      chart = null;
    }
    if (!chart) return;
    let cancelled = false;

    const removeShape = (id: any) => {
      try {
        chart.removeEntity(id);
      } catch {
        /* 图形已不存在 */
      }
    };

    /** 已存在/创建中则跳过,否则创建并把 id 登记进 shapesRef */
    const addShape = (key: string, create: () => Promise<any>) => {
      if (shapesRef.current.has(key) || creatingRef.current.has(key)) return;
      creatingRef.current.add(key);
      void (async () => {
        try {
          const id = await create();
          if (!cancelled) shapesRef.current.set(key, id);
          else removeShape(id);
        } catch {
          /* 图表未就绪,下次重试 */
        } finally {
          creatingRef.current.delete(key);
        }
      })();
    };

    void (async () => {
      let executions: Nt8Execution[];
      try {
        const to = Math.floor(Date.now() / 1000);
        ({ executions } = await trading.getExecutions(account, symbol, to - LOOKBACK_SEC, to));
      } catch {
        return;   // 拉取失败保留已有图形,下次签名变化重试
      }
      if (cancelled) return;

      const seen = new Set<string>();

      // ---- 成交点标记 ----
      // 首选(私有 API):LineToolExecution 小三角,精确价格锚定 + 文字/tooltip;
      // 回退(公开 API):arrow_up/down 粗箭头,尖端精确但尺寸固定约 20px
      // (库未暴露尺寸覆写;颜色键是 arrowColor,color 控制的是附带文本)
      const execToolReady = await ensureExecutionToolPatched(widget);
      if (cancelled) return;
      for (const e of executions) {
        const key = `exec-${e.orderId}-${e.time}-${e.side}-${e.qty}`;
        seen.add(key);
        const isBuy = e.side === 'Buy';
        addShape(key, async () => {
          if (execToolReady) {
            try {
              return createExecTriangle(chart, e, isBuy);
            } catch {
              /* 私有路径失败,落公开箭头 */
            }
          }
          return chart.createMultipointShape([{ time: e.time, price: e.price }], {
            shape: isBuy ? 'arrow_up' : 'arrow_down',
            lock: true,
            disableSelection: true,
            disableSave: true,
            zOrder: 'top',
            overrides: { arrowColor: isBuy ? '#26a69a' : '#ef5350' },
          });
        });
      }

      // ---- FIFO 配对:进出场盈亏连线 ----
      for (const t of pairRoundTrips(executions)) {
        const key = `rt-${t.entryTime}-${t.exitTime}-${t.entryPrice}-${t.qty}`;
        seen.add(key);
        const dir = t.long ? 1 : -1;
        const pnl = Math.round((t.exitPrice - t.entryPrice) * dir * t.qty * pointValue * 100) / 100;
        const win = pnl >= 0;
        const color = win ? '#26a69a' : '#ef5350';
        const text = `${win ? '+' : ''}${pnl}$`;
        addShape(key, () =>
          chart.createMultipointShape(
            [
              { time: t.entryTime, price: t.entryPrice },
              { time: t.exitTime, price: t.exitPrice },
            ],
            {
              shape: 'trend_line',
              lock: true,
              disableSelection: true,
              disableSave: true,
              zOrder: 'top',
              overrides: {
                linecolor: color,
                linestyle: 2,
                linewidth: 1,
                text,
                showLabel: true,
                textcolor: color,
                fontsize: 11,
              },
            },
          ),
        );
      }

      // 防御性清理:不在最新列表里的图形移除(正常不会发生)
      for (const [key, id] of Array.from(shapesRef.current)) {
        if (!seen.has(key)) {
          shapesRef.current.delete(key);
          removeShape(id);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const id of shapesRef.current.values()) removeShape(id);
      shapesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, symbol, account, pointValue, refreshKey, enabled]);
}
