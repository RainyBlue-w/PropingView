type MenuProvider = Parameters<TradingViewWidget['onContextMenu']>[0];
type Binding = { provider: MenuProvider };
type Registration = { current?: Binding };

const registrations = new WeakMap<TradingViewWidget, Registration>();

/** onContextMenu adds a callback; it does not replace or unsubscribe the previous one. */
export function bindContextMenu(widget: TradingViewWidget, provider: MenuProvider): () => void {
  let registration = registrations.get(widget);
  if (!registration) {
    const slot: Registration = {};
    widget.onContextMenu((time, price) => slot.current?.provider(time, price) ?? []);
    registrations.set(widget, slot);
    registration = slot;
  }

  // Only the latest state supplies items, including after effect cleanup/rebinding.
  const binding = { provider };
  registration.current = binding;
  return () => {
    if (registration.current === binding) registration.current = undefined;
  };
}
