import { useEffect, useRef } from 'react';
import { type Nt8Execution } from '@/lib/nt8Trading';
import { trading } from '@/lib/tradingRouter';
import { pairRoundTrips } from '@/lib/executionPairs';
import { compareExecutions, executionTime } from '@/lib/tradeAnalytics';
import { alignExecutionArrowTip } from '@/lib/tvExecutionArrow';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface UseExecutionTradesParams {
  widget: TradingViewWidget | null;
  symbol: string;
  /** 空串 = 未选账户/非 NT8,不画 */
  account: string;
  /** 每 1.00 点美元价值(连线盈亏颜色用) */
  pointValue: number;
  /** 成交签名:变化时重新拉取(新成交即时上图) */
  refreshKey: string;
  /** 图表交易历史开关；关闭时清理全部成交标记及连线 */
  enabled: boolean;
  /** 周期变化后丢弃旧周期吸附过的绘图，使用原始成交时间重建。 */
  epoch: number;
}

/** 拉取的成交历史回溯窗口 */
const LOOKBACK_SEC = 7 * 86400;

/**
 * 图表交易历史(交易平台风格):
 * - 成交点:约 12px 的小箭头,买绿卖红,尖端对准成交时间/价,不显示文字;
 * - FIFO 配对进出场,只画虚线连线(盈绿亏红),不显示盈亏金额或统计标签;
 * - 所有图形 zOrder 顶层、锁定不可拖、不参与保存。
 * 数据来自 /api/executions(NT8 本机成交归档,或回放模拟后端)。
 */
export function useExecutionTrades({
  widget,
  symbol,
  account,
  pointValue,
  refreshKey,
  enabled,
  epoch,
}: UseExecutionTradesParams) {
  /** execKey/tripKey -> 图表绘图实体 id */
  const shapesRef = useRef(new Map<string, any>());

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
    const shapes = shapesRef.current;
    // 每轮独立，快速关闭再打开时不被上一轮尚未完成的创建任务挡住。
    const creating = new Set<string>();

    const removeShape = (id: any) => {
      try {
        chart.removeEntity(id);
      } catch {
        /* 图形已不存在 */
      }
    };

    /** 已存在/创建中则跳过,否则创建并把 id 登记进 shapesRef */
    const addShape = (key: string, create: () => Promise<any>) => {
      if (shapes.has(key) || creating.has(key)) return;
      creating.add(key);
      void (async () => {
        try {
          const id = await create();
          if (!cancelled) shapes.set(key, id);
          else removeShape(id);
        } catch {
          /* 图表未就绪,下次重试 */
        } finally {
          creating.delete(key);
        }
      })();
    };

    void (async () => {
      let executions: Nt8Execution[];
      try {
        const to = Math.floor(Date.now() / 1000);
        ({ executions } = await trading.getExecutions(account, symbol, to - LOOKBACK_SEC, to));
      } catch {
        return;   // 拉取失败,下次签名或周期变化重试
      }
      if (cancelled) return;
      // 原订单和方向信息均不可用时，归档保留记录，但不伪造买卖箭头或参与配对。
      executions = executions.filter(e => e.side === 'Buy' || e.side === 'Sell');

      const seen = new Set<string>();

      // 绘图会把 time 固定吸附到创建时的 K 线；必须等新周期数据就绪再创建。
      // 不读取旧图形的 getPoints()，它已经丢失原成交时间的精度。
      try {
        await new Promise<void>(resolve => {
          if (chart.dataReady(resolve)) resolve();
        });
      } catch {
        return; // widget 已销毁时，等待数据可能抛错。
      }
      if (cancelled) return;
      executions = executions.map(e => ({ ...e, time: executionTime(e) })).sort(compareExecutions);

      // ---- 成交点标记 ----
      // arrow_up/down 的约 20×22px 大小固定；公开 icon 支持 size 缩放。
      // SVG 外框 14px，箭头实际约 12px；渲染时把尖端对准原始成交点。
      for (const e of executions) {
        const key = e.executionId
          ? `exec-id-${e.executionId}`
          : `exec-${e.orderId}-${e.time}-${e.side}-${e.qty}-${e.price}`;
        seen.add(key);
        const isBuy = e.side === 'Buy';
        addShape(key, async () => {
          const id = await chart.createMultipointShape([{ time: e.time, price: e.price }], {
            shape: 'icon',
            icon: isBuy ? 0xf062 : 0xf063,
            text: '',
            lock: true,
            disableSelection: true,
            disableSave: true,
            disableUndo: true,
            showInObjectsTree: false,
            zOrder: 'top',
            overrides: {
              size: 14,
              color: isBuy ? '#26a69a' : '#ef5350',
              angle: Math.PI / 2,
              text: '',
              showLabel: false,
            },
          });
          if (id != null && !cancelled) {
            try {
              alignExecutionArrowTip(chart.getShapeById(id), isBuy);
            } catch {
              // 库接口变化时保留原生图标，仍返回 id 纳入关闭/切周期的清理。
            }
          }
          return id;
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
        addShape(key, () =>
          chart.createMultipointShape(
            [
              { time: t.entryTime, price: t.entryPrice },
              { time: t.exitTime, price: t.exitPrice },
            ],
            {
              shape: 'trend_line',
              text: '',
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              zOrder: 'top',
              overrides: {
                linecolor: color,
                linestyle: 2,
                linewidth: 1,
                text: '',
                showLabel: false,
                alwaysShowStats: false,
                showPriceLabels: false,
                showPriceRange: false,
                showPercentPriceRange: false,
                showPipsPriceRange: false,
                showBarsRange: false,
                showDateTimeRange: false,
                showDistance: false,
                showAngle: false,
              },
            },
          ),
        );
      }

      // 防御性清理:不在最新列表里的图形移除(正常不会发生)
      for (const [key, id] of Array.from(shapes)) {
        if (!seen.has(key)) {
          shapes.delete(key);
          removeShape(id);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const id of shapes.values()) removeShape(id);
      shapes.clear();
    };
  }, [widget, symbol, account, pointValue, refreshKey, enabled, epoch]);
}
