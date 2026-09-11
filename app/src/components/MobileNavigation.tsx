import { useEffect, useState } from 'react';
import { History, Menu, Moon, PanelBottom, Play, RefreshCw, Settings, Sun, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BridgeConnectionStatus, { type BridgeStatuses } from '@/components/BridgeConnectionStatus';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

type Page = 'chart' | 'overview' | 'records' | 'replay' | 'copy';
const pages: { id: Page; label: string }[] = [
  { id: 'chart', label: '交易图表' }, { id: 'overview', label: '账户总览' },
  { id: 'records', label: '交易记录' }, { id: 'replay', label: '回放模拟' },
  { id: 'copy', label: '复制交易' },
];
const menuItem = 'min-h-8 text-xs focus:bg-[var(--tv-border)] focus:text-[var(--tv-text)]';

interface Props {
  page: Page;
  onNavigate: (page: Page) => void;
  chartVisible: boolean;
  tradingPanelVisible: boolean;
  accountPanelVisible: boolean;
  replayActive: boolean;
  replayPanelVisible: boolean;
  onToggleTradingPanel: () => void;
  onToggleAccountPanel: () => void;
  onToggleReplayPanel: () => void;
  bridgeStatuses: BridgeStatuses;
  showTradeHistory: boolean;
  onToggleTradeHistory: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onReconnect: () => void;
  onSettings: () => void;
}

/** A single phone header row; secondary pages and tools stay in the menu. */
export default function MobileNavigation(props: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Pointer events inside the chart iframe do not reach the parent document.
    const close = () => setOpen(false);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [open]);
  return <nav aria-label="主导航" className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--tv-border)] bg-[var(--tv-panel)] px-2 text-[var(--tv-text)]">
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="页面菜单" className="h-8 gap-1.5 px-1.5 text-xs hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]">
          <Menu className="h-4 w-4" />{pages.find(item => item.id === props.page)?.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[100] max-h-[var(--radix-dropdown-menu-content-available-height)] w-52 border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)]">
        <DropdownMenuLabel className="text-[10px] text-[var(--tv-muted)]">页面</DropdownMenuLabel>
        {pages.map(item => <DropdownMenuItem key={item.id} aria-label={item.label} aria-current={props.page === item.id ? 'page' : undefined}
          onSelect={() => props.onNavigate(item.id)} className={`${menuItem} ${props.page === item.id ? 'text-[#5b8cff]' : ''}`}>
          {item.label}
        </DropdownMenuItem>)}
        <DropdownMenuSeparator className="bg-[var(--tv-border)]" />
        <DropdownMenuItem aria-label="账户信息" disabled={!props.chartVisible} onSelect={props.onToggleAccountPanel} className={menuItem}>
          <Wallet />{props.accountPanelVisible ? '收起账户信息' : '账户信息'}
        </DropdownMenuItem>
        {props.replayActive && <DropdownMenuItem aria-label="回放控制" onSelect={props.onToggleReplayPanel} className={menuItem}>
          <Play />{props.replayPanelVisible ? '收起回放控制' : '回放控制'}
        </DropdownMenuItem>}
        <DropdownMenuItem aria-label={props.showTradeHistory ? '隐藏交易历史' : '显示交易历史'} onSelect={props.onToggleTradeHistory} className={menuItem}>
          <History />{props.showTradeHistory ? '隐藏交易历史' : '显示交易历史'}
        </DropdownMenuItem>
        <DropdownMenuItem aria-label={props.theme === 'dark' ? '切换为白天模式' : '切换为黑夜模式'} onSelect={props.onToggleTheme} className={menuItem}>
          {props.theme === 'dark' ? <Sun /> : <Moon />}{props.theme === 'dark' ? '白天模式' : '黑夜模式'}
        </DropdownMenuItem>
        <DropdownMenuItem aria-label="重新连接数据桥" onSelect={props.onReconnect} className={menuItem}><RefreshCw />重新连接数据桥</DropdownMenuItem>
        <DropdownMenuItem aria-label="数据桥设置" onSelect={props.onSettings} className={menuItem}><Settings />数据桥设置</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <BridgeConnectionStatus statuses={props.bridgeStatuses} compact />
    <Button variant="ghost" aria-label="交易面板" aria-pressed={props.chartVisible && props.tradingPanelVisible} aria-controls="trading-page-trade"
      disabled={!props.chartVisible} onClick={props.onToggleTradingPanel}
      className={`ml-auto h-8 shrink-0 gap-1 px-2 text-xs hover:bg-[var(--tv-border)] ${props.tradingPanelVisible && props.chartVisible ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)]'}`}>
      <PanelBottom className="h-3.5 w-3.5" />交易面板
    </Button>
  </nav>;
}
