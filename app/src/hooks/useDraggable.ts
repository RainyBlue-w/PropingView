import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 拖拽 hook(把手的 onPointerDown 启动拖动)。
 * - 未拖动过:返回 pos=null,调用方用 className 里的默认锚定(right/top 等);
 * - 拖动过:返回显式 {x,y}(相对定位父容器;fixed 浮窗则相对视口),
 *   调用方据此覆盖 style,并持久化到 localStorage(键由调用方给)。
 *
 * 根元素绑定 panelRef + data-draggable-panel，把手绑定 onHandlePointerDown + touch-none。
 * Pointer Capture 保证拖过图表 iframe 后仍继续接收移动；ResizeObserver 防止移出容器。
 */
export function useDraggable(storageKey: string) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw);
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return p;
      }
    } catch {
      /* ignore */
    }
    return null;
  });
  const currentPos = useRef(pos);
  const observer = useRef<ResizeObserver | null>(null);
  const finishDrag = useRef<(() => void) | null>(null);

  const persist = useCallback((p: { x: number; y: number }) => {
    try { localStorage.setItem(storageKey, JSON.stringify(p)); } catch { /* 存储不可用 */ }
  }, [storageKey]);

  const clamp = useCallback((panel: HTMLElement, p: { x: number; y: number }) => {
    const parent = panel.offsetParent instanceof HTMLElement ? panel.offsetParent : null;
    return {
      x: Math.max(0, Math.min(p.x, (parent?.clientWidth || window.innerWidth) - panel.offsetWidth)),
      y: Math.max(0, Math.min(p.y, (parent?.clientHeight || window.innerHeight) - panel.offsetHeight)),
    };
  }, []);

  const panelRef = useCallback((panel: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!panel) return;
    observer.current = new ResizeObserver(() => {
      const previous = currentPos.current;
      if (!previous) return;
      const next = clamp(panel, previous);
      if (next.x === previous.x && next.y === previous.y) return;
      currentPos.current = next;
      setPos(next);
      persist(next);
    });
    observer.current.observe(panel);
    if (panel.offsetParent instanceof HTMLElement) observer.current.observe(panel.offsetParent);
  }, [clamp, persist]);

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return; // 只响应左键
      e.preventDefault();
      const panel = (e.currentTarget as HTMLElement).closest('[data-draggable-panel]') as HTMLElement | null;
      if (!panel) return;
      finishDrag.current?.();
      const rect = panel.getBoundingClientRect();
      // 相对定位父容器换算(absolute 浮窗);无定位父级(fixed)则按视口
      const parentRect =
        panel.offsetParent instanceof HTMLElement
          ? panel.offsetParent.getBoundingClientRect()
          : { left: 0, top: 0 };
      const drag = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: rect.left - parentRect.left,
        baseY: rect.top - parentRect.top,
      };
      const handle = e.currentTarget;
      const pointerId = 'pointerId' in e ? e.pointerId : null;
      if (pointerId != null) handle.setPointerCapture(pointerId);
      const moveEvent = pointerId != null ? 'pointermove' : 'mousemove';
      const upEvent = pointerId != null ? 'pointerup' : 'mouseup';
      const onMove = (event: Event) => {
        const ev = event as PointerEvent;
        if (pointerId != null && ev.pointerId !== pointerId) return;
        const next = clamp(panel, { x: drag.baseX + ev.clientX - drag.startX, y: drag.baseY + ev.clientY - drag.startY });
        currentPos.current = next;
        setPos(next);
      };
      const onUp = () => {
        window.removeEventListener(moveEvent, onMove);
        window.removeEventListener(upEvent, onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('blur', onUp);
        handle.removeEventListener('lostpointercapture', onUp);
        if (pointerId != null && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        if (currentPos.current) persist(currentPos.current);
        finishDrag.current = null;
      };
      finishDrag.current = onUp;
      window.addEventListener(moveEvent, onMove);
      window.addEventListener(upEvent, onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('blur', onUp);
      handle.addEventListener('lostpointercapture', onUp);
    },
    [clamp, persist],
  );

  const reset = useCallback(() => {
    finishDrag.current?.();
    currentPos.current = null;
    setPos(null);
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [storageKey]);

  useEffect(() => () => {
    finishDrag.current?.();
    observer.current?.disconnect();
  }, []);

  return { pos, panelRef, onHandleMouseDown, onHandlePointerDown: onHandleMouseDown, reset };
}
