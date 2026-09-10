import { useState } from 'react';
import { Pause, Play, StepForward, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ReplayBarProps {
  /** 历史行情源可用时才允许开始回放。 */
  enabled?: boolean;
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
  [60, '1 分钟'],
  [300, '5 分钟'],
  [900, '15 分钟'],
  [1800, '30 分钟'],
  [3600, '1 小时'],
  [86400, '1 天'],
];

/** datetime-local 默认值:3 天前 */
function defaultStartLocal(): string {
  const d = new Date(Date.now() - 3 * 86400 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 回放页内容；回放会话与播放状态由 ChartTerminal 控制。 */
export default function ReplayBar({
  enabled = true,
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
  const [startDraft, setStartDraft] = useState(defaultStartLocal);
  const startSec = Math.floor(new Date(startDraft).getTime() / 1000);
  const validStart = Number.isFinite(startSec) && startSec > 0;
  const inputCls =
    'h-8 w-full min-w-0 rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2 text-xs text-[var(--tv-text)]';

  return (
    <section className="space-y-4 p-3 text-xs text-[var(--tv-text)]" aria-label="历史回放控制">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">历史回放</h2>
        <span className={`rounded px-2 py-0.5 text-[11px] ${
          active ? 'bg-[#f0b90b]/15 text-[#b88900]' : 'bg-[var(--tv-bg)] text-[var(--tv-muted)]'
        }`}>
          {active ? (playing ? '播放中' : '已暂停') : '未开始'}
        </span>
      </div>

      {active ? (
        <div className="rounded-md border border-[#f0b90b]/30 bg-[var(--tv-bg)] p-3">
          <div className="mb-1 text-[11px] text-[var(--tv-muted)]">当前回放时间（本地时间）</div>
          <div className="font-mono text-sm tabular-nums">
            {cursor > 0 ? new Date(cursor * 1000).toLocaleString() : '—'}
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (enabled && validStart) onStart(startSec);
          }}
        >
          <label htmlFor="replay-start" className="block text-[11px] text-[var(--tv-muted)]">
            开始时间（本地时间）
          </label>
          <Input
            id="replay-start"
            type="datetime-local"
            required
            value={startDraft}
            onChange={(event) => setStartDraft(event.target.value)}
            className={inputCls}
          />
          <Button
            type="submit"
            size="sm"
            disabled={!enabled || !validStart}
            className="h-8 w-full gap-1.5 bg-[#2962ff] text-xs text-white hover:bg-[#2962ff]/90"
          >
            <Play className="h-3.5 w-3.5" />
            开始回放
          </Button>
          {!enabled && (
            <p className="text-[11px] leading-4 text-[var(--tv-muted)]">连接 NT8 数据桥后可开始回放。</p>
          )}
        </form>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="block text-[11px] text-[var(--tv-muted)]">推进步长</span>
          <select
            value={stepSec}
            onChange={(event) => onStepSecChange(parseInt(event.target.value, 10))}
            className={inputCls}
            title="每次推进的行情时间跨度"
          >
            {STEP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] text-[var(--tv-muted)]">播放速度</span>
          <select
            value={speed}
            onChange={(event) => onSpeedChange(parseFloat(event.target.value))}
            className={inputCls}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>{value}x</option>
            ))}
          </select>
        </label>
      </div>

      {active && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 border-[var(--tv-border)] bg-[var(--tv-bg)] text-xs hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]"
              title="按所选步长推进回放"
              onClick={onStep}
            >
              <StepForward className="h-3.5 w-3.5" />
              单步推进
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-[#2962ff] text-xs text-white hover:bg-[#2962ff]/90"
              onClick={onTogglePlay}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? '暂停' : '播放'}
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-full gap-1.5 text-xs text-[#ef5350] hover:bg-[#ef5350]/10 hover:text-[#ef5350]"
            onClick={onExit}
          >
            <X className="h-3.5 w-3.5" />
            保存并返回会话列表
          </Button>
        </div>
      )}

      <p className="text-[11px] leading-5 text-[var(--tv-muted)]">
        按所选步长推进历史行情，休市时自动跳到下一段行情。下方交易面板使用本会话的模拟账户。
      </p>
    </section>
  );
}
