import { Component, lazy, Suspense, type ComponentProps } from 'react';

type Props = ComponentProps<typeof import('./TradeDetails').default>;

function createDetailsComponent() {
  return lazy(() => import('./TradeDetails'));
}

interface State {
  failed: boolean;
  Details: ReturnType<typeof createDetailsComponent>;
}

/** Keep a failed detail module or chart mount from unmounting the trading page. */
export default class TradeDetailsLoader extends Component<Props, State> {
  state: State = { failed: false, Details: createDetailsComponent() };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  private retry = () => {
    // React.lazy retains rejected imports, so each explicit retry needs a fresh instance.
    this.setState({ failed: false, Details: createDetailsComponent() });
  };

  render() {
    if (this.state.failed) {
      return <div role="alert" className="fixed right-6 bottom-6 left-6 z-[100] space-y-3 rounded-lg border border-amber-500/40 bg-[var(--tv-panel)] p-4 text-sm shadow-xl sm:left-auto sm:max-w-sm">
        <p className="text-amber-500">交易详情暂时无法显示，请重试。若仍无法打开，请刷新页面后再试。</p>
        <div className="flex gap-2">
          <button className="rounded-md border border-[var(--tv-border)] px-3 py-2 text-[var(--tv-text)]" onClick={this.retry}>重试详情</button>
          <button className="rounded-md border border-[var(--tv-border)] px-3 py-2 text-[var(--tv-text)]" onClick={this.props.onClose}>关闭详情</button>
        </div>
      </div>;
    }
    const Details = this.state.Details;
    return <Suspense fallback={<p role="status" className="text-sm text-[var(--tv-muted)]">正在载入交易详情…</p>}><Details {...this.props} /></Suspense>;
  }
}
