import { useCallback, useRef, useState } from 'react';

/**
 * 浮窗拖拽 hook(把手的 onMouseDown 启动拖动)。
 * - 未拖动过:返回 pos=null,调用方用 className 里的默认锚定(right/top 等);
 * - 拖动过:返回显式 {x,y}(相对定位父容器;fixed 浮窗则相对视口),
 *   调用方据此覆盖 style,并持久化到 localStorage(键由调用方给)。
 *
 * 用法:面板根元素加 data-draggable-panel,把手元素挂 onHandleMouseDown。
 */
export function useDraggable(storageKey: string) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number') return p;
      }
    } catch {
      /* ignore */
    }
    return null;
  });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0) return; // 只响应左键
      e.preventDefault();
      const panel = (e.currentTarget as HTMLElement).closest('[data-draggable-panel]') as HTMLElement | null;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      // 相对定位父容器换算(absolute 浮窗);无定位父级(fixed)则按视口
      const parentRect =
        panel.offsetParent instanceof HTMLElement
          ? panel.offsetParent.getBoundingClientRect()
          : { left: 0, top: 0 };
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: rect.left - parentRect.left,
        baseY: rect.top - parentRect.top,
      };
      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const x = Math.min(window.innerWidth - 80, Math.max(0, d.baseX + ev.clientX - d.startX));
        const y = Math.min(window.innerHeight - 40, Math.max(0, d.baseY + ev.clientY - d.startY));
        setPos({ x, y });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (dragRef.current) {
          dragRef.current = null;
          setPos((p) => {
            if (p) {
              try {
                localStorage.setItem(storageKey, JSON.stringify(p));
              } catch {
                /* ignore */
              }
            }
            return p;
          });
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [storageKey],
  );

  return { pos, onHandleMouseDown };
}
