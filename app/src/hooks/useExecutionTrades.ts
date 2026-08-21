import { useEffect, useRef } from 'react';
import { nt8Trading, type Nt8Execution } from '@/lib/nt8Trading';
import { pairRoundTrips } from '@/lib/executionPairs';

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
 * 图表交易历史(交易平台风格):
 * - 成交点:arrow_up/down 箭头(买绿卖红),尖端精确对准成交时间/价;
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
        ({ executions } = await nt8Trading.getExecutions(account, symbol, to - LOOKBACK_SEC, to));
      } catch {
        return;   // 拉取失败保留已有图形,下次签名变化重试
      }
      if (cancelled) return;

      const seen = new Set<string>();

      // ---- 成交点箭头(arrow_up/down:箭头尖端精确对准成交时间/价) ----
      // 注:该线型尺寸固定(约 20px,库未暴露尺寸覆写),但锚点精确;
      // 颜色键是 arrowColor(color 控制的是附带文本)
      for (const e of executions) {
        const key = `exec-${e.orderId}-${e.time}-${e.side}-${e.qty}`;
        seen.add(key);
        const isBuy = e.side === 'Buy';
        addShape(key, () =>
          chart.createMultipointShape([{ time: e.time, price: e.price }], {
            shape: isBuy ? 'arrow_up' : 'arrow_down',
            lock: true,
            disableSelection: true,
            disableSave: true,
            zOrder: 'top',
            overrides: { arrowColor: isBuy ? '#26a69a' : '#ef5350' },
          }),
        );
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
