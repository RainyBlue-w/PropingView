import { Component, lazy, Suspense } from 'react';

function createMonitorComponent() {
  return lazy(() => import('@/sections/MonitorPage'));
}

interface State {
  failed: boolean;
  Page: ReturnType<typeof createMonitorComponent>;
}

/** Keep a failed monitor module from unmounting the trading terminal. */
export default class MonitorPageLoader extends Component<object, State> {
  state: State = { failed: false, Page: createMonitorComponent() };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  private retry = () => {
    // React.lazy retains rejected imports, so each explicit retry needs a fresh instance.
    this.setState({ failed: false, Page: createMonitorComponent() });
  };

  render() {
    if (this.state.failed) {
      return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--tv-bg)] p-6 text-sm">
        <p className="text-amber-500">监控面板暂时无法载入，请重试。若仍无法打开，请刷新页面后再试。</p>
        <button className="rounded-md border border-[var(--tv-border)] px-3 py-2 text-[var(--tv-text)]" onClick={this.retry}>重试监控面板</button>
      </div>;
    }
    const Page = this.state.Page;
    return <Suspense fallback={<p role="status" className="flex h-full items-center justify-center bg-[var(--tv-bg)] text-sm text-[var(--tv-muted)]">正在载入监控面板…</p>}><Page /></Suspense>;
  }
}
