import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

const STORAGE_KEY = 'tv-nt8-mobile-panel-ratio';
const DEFAULT_RATIO = 0.44;
const DIVIDER_HEIGHT = 12;

function bounds(containerHeight: number) {
  const available = Math.max(0, containerHeight - DIVIDER_HEIGHT);
  // 软键盘或极矮横屏下按空间收缩下限，避免任何一侧被挤出视口。
  return {
    available,
    min: Math.min(120, available / 2),
    // 图表区包含顶部合约栏（不超过 40px），额外保留 100px 给图表本身。
    max: available - Math.min(140, available / 2),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** 手机图表/下方面板分隔；独立保存比例，不修改桌面面板偏好。 */
export function useMobilePanelHeight(enabled: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved > 0 && saved < 1) return saved;
    } catch { /* 浏览器禁用存储时仍可拖动。 */ }
    return DEFAULT_RATIO;
  });
  const currentRatio = useRef(ratio);
  const drag = useRef<{
    handle: HTMLDivElement;
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const persist = useCallback(() => {
    try { localStorage.setItem(STORAGE_KEY, String(currentRatio.current)); } catch { /* ignore */ }
  }, []);

  const finishDrag = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    persist();
  }, [persist]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    const observer = new ResizeObserver(() => {
      finishDrag();
      setContainerHeight(container.clientHeight);
    });
    observer.observe(container);
    window.addEventListener('blur', finishDrag);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', finishDrag);
      finishDrag();
    };
  }, [enabled, finishDrag]);

  const limits = bounds(containerHeight);
  const height = clamp(limits.available * ratio, limits.min, limits.max);

  const resize = (requestedHeight: number) => {
    const current = bounds(containerRef.current?.clientHeight ?? 0);
    if (!current.available) return;
    const next = clamp(requestedHeight, current.min, current.max) / current.available;
    currentRatio.current = next;
    setRatio(next);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    finishDrag();
    const handle = event.currentTarget;
    const current = bounds(containerRef.current?.clientHeight ?? 0);
    handle.setPointerCapture(event.pointerId);
    drag.current = {
      handle,
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: clamp(current.available * currentRatio.current, current.min, current.max),
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    resize(active.startHeight + active.startY - event.clientY);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) finishDrag();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = bounds(containerRef.current?.clientHeight ?? 0);
    const currentHeight = clamp(current.available * currentRatio.current, current.min, current.max);
    const step = event.shiftKey ? 48 : 24;
    let next: number;
    switch (event.key) {
      case 'ArrowUp': next = currentHeight + step; break;
      case 'ArrowDown': next = currentHeight - step; break;
      case 'Home': next = current.min; break;
      case 'End': next = current.max; break;
      default: return;
    }
    event.preventDefault();
    resize(next);
    persist();
  };

  return {
    containerRef,
    panelStyle: { flexBasis: containerHeight > 0 ? `${height}px` : `${ratio * 100}%` },
    separatorProps: {
      onPointerDown, onPointerMove, onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd, onLostPointerCapture: onPointerEnd, onKeyDown,
      'aria-valuemin': Math.round(limits.min),
      'aria-valuemax': Math.round(limits.max),
      'aria-valuenow': Math.round(height),
      'aria-valuetext': `面板高度 ${Math.round(height)} 像素`,
    },
  };
}
