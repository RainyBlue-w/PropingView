import { useState } from 'react';
import { GripVertical, Pause, Play, StepForward, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDraggable } from '@/hooks/useDraggable';

const REPLAY_POS_KEY = 'nt8-terminal-replay-pos';

export interface ReplayBarProps {
  active: boolean;
  /** 回放游标时间(unix 秒) */
  cursor: number;
  playing: boolean;
  speed: number;
  /** 步长(行情时间秒):单步/播放每次推进的市场时间跨度 */
  stepSec: number;
  onStart: (startSec: number) => void;
  onStep: () => void;
  onTogglePlay: () => void;
  onSpeedChange: (v: number) => void;
  onStepSecChange: (v: number) => void;
  onExit: () => void;
}

const SPEEDS = [0.5, 1, 2, 5];
/** 步长选项:[秒, 显示名] */
const STEP_OPTIONS: [number, string][] = [
  [60, '1min'],
  [300, '5min'],
  [900, '15min'],
  [1800, '30min'],
  [3600, '1h'],
  [86400, '1D'],
];

/** datetime-local 默认值:3 天前 */
function defaultStartLocal(): string {
  const d = new Date(Date.now() - 3 * 86400 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 回放控制条(图表左上浮条):
 * 未激活 = [回放] 按钮 → 起点选择;激活 = 游标时间/单步/播放/速度/退出。
 * 纯受控组件,全部状态在 ChartTerminal。
 */
export default function ReplayBar({
  active,
  cursor,
  playing,
  speed,
  stepSec,
  onStart,
  onStep,
  onTogglePlay,
  onSpeedChange,
  onStepSecChange,
  onExit,
}: ReplayBarProps) {
  const [open, setOpen] = useState(false);
  const [startDraft, setStartDraft] = useState(defaultStartLocal);
  const drag = useDraggable(REPLAY_POS_KEY);
  const dragStyle = drag.pos ? { left: drag.pos.x, top: drag.pos.y, right: 'auto' as const } : undefined;
  const grip = (
    <span
      className="cursor-move text-[var(--tv-muted)] hover:text-[var(--tv-text)]"
      title="按住拖动"
      onMouseDown={drag.onHandleMouseDown}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
  );

  if (!active) {
    return (
      <div
        data-draggable-panel
        style={dragStyle}
        className="absolute left-2 top-2 z-50 flex items-center gap-2 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)]/95 px-2 py-1.5 shadow-lg backdrop-blur"
      >
        {grip}
        {open ? (
          <>
            <Input
              type="datetime-local"
              value={startDraft}
              onChange={(e) => setStartDraft(e.target.value)}
              className="h-7 w-52 border-[var(--tv-border)] bg-[var(--tv-bg)] text-xs text-[var(--tv-text)]"
            />
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                const t = Math.floor(new Date(startDraft).getTime() / 1000);
                if (t > 0) onStart(t);
              }}
            >
              开始
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-[var(--tv-text)]"
            title="在历史数据上回放并模拟开单"
            onClick={() => setOpen(true)}
          >
            回放
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      data-draggable-panel
      style={dragStyle}
      className="absolute left-2 top-2 z-50 flex items-center gap-1.5 rounded-md border border-[#f0b90b]/40 bg-[var(--tv-panel)]/95 px-2 py-1.5 text-xs text-[var(--tv-text)] shadow-lg backdrop-blur"
    >
      {grip}
      <span className="mr-1 rounded bg-[#f0b90b]/15 px-1.5 py-0.5 font-semibold text-[#f0b90b]">
        回放中
      </span>
      <span className="font-mono text-[var(--tv-muted)]">
        {cursor > 0 ? new Date(cursor * 1000).toLocaleString() : '—'}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        title="前进一根 K 线"
        onClick={onStep}
      >
        <StepForward className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        title={playing ? '暂停' : '播放'}
        onClick={onTogglePlay}
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </Button>
      <select
        value={stepSec}
        onChange={(e) => onStepSecChange(parseInt(e.target.value, 10))}
        className="h-7 rounded border border-[var(--tv-border)] bg-[var(--tv-bg)] px-1 text-xs text-[var(--tv-text)]"
        title="步长:每次推进的行情时间跨度"
      >
        {STEP_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <select
        value={speed}
        onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
        className="h-7 rounded border border-[var(--tv-border)] bg-[var(--tv-bg)] px-1 text-xs text-[var(--tv-text)]"
        title="播放速度"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}x
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-[#ef5350]"
        title="退出回放,恢复实盘"
        onClick={onExit}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
