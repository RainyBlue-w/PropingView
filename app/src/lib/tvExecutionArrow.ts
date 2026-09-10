interface ScreenPoint {
  x: number;
  y: number;
  add(offset: { x: number; y: number }): ScreenPoint;
}

interface IconRenderData {
  center: ScreenPoint;
  height: number;
  corners: {
    topLeft: ScreenPoint;
    topRight: ScreenPoint;
    bottomLeft: ScreenPoint;
    bottomRight: ScreenPoint;
  };
}

interface IconRenderer {
  setData(data: IconRenderData | null): void;
}

interface IconPaneView {
  _iconRenderer?: IconRenderer;
  update(): void;
}

interface IconSource {
  paneViews(...args: unknown[]): IconPaneView[] | null;
}

const alignedSources = new WeakSet<IconSource>();

// v32.1 f062/f063 use a 24×24 viewBox. Their rounded tips are at
// y=2.0025 and y=21.9975, respectively (the extrema of the SVG Bézier curves).
const TIP_DISTANCE_FROM_CENTER = (12 - 2.0025) / 24;

/**
 * Keep the execution's real time/price as the drawing point, but anchor the
 * small arrow by its tip. Public icon overrides only expose size/color/angle.
 * This v32.1 adapter affects this one locked execution icon, never prototypes
 * or user drawings. Missing internals safely retain the native centered icon.
 */
export function alignExecutionArrowTip(shape: unknown, isBuy: boolean): void {
  const source = (shape as { _source?: IconSource } | null)?._source;
  if (!source || typeof source.paneViews !== 'function' || alignedSources.has(source)) return;
  alignedSources.add(source);
  const paneViews = source.paneViews;
  const alignedRenderers = new WeakSet<IconRenderer>();

  // Views load asynchronously and can be replaced; intercept each current view
  // when the library requests it, without polling or holding a widget alive.
  source.paneViews = function (...args) {
    const views = paneViews.apply(this, args);
    for (const view of views ?? []) {
      const renderer = view._iconRenderer;
      if (!renderer || typeof renderer.setData !== 'function'
        || typeof view.update !== 'function' || alignedRenderers.has(renderer)) continue;
      alignedRenderers.add(renderer);
      const setData = renderer.setData;
      renderer.setData = function (data) {
        const corners = data?.corners;
        if (!data || !Number.isFinite(data.height) || typeof data.center?.add !== 'function'
          || !corners || ![corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight]
            .every(point => typeof point?.add === 'function')) {
          return setData.call(this, data);
        }
        // height/center already include the library's DPR and pixel rounding.
        // Shift render data only: price scales, source points and FIFO lines
        // continue to use the untouched execution coordinates.
        const offset = { x: 0, y: (isBuy ? 1 : -1) * data.height * TIP_DISTANCE_FROM_CENTER };
        setData.call(this, {
          ...data,
          center: data.center.add(offset),
          corners: {
            ...corners,
            topLeft: corners.topLeft.add(offset),
            topRight: corners.topRight.add(offset),
            bottomLeft: corners.bottomLeft.add(offset),
            bottomRight: corners.bottomRight.add(offset),
          },
        });
      };
      view.update(); // Refresh data that may have been cached before binding.
    }
    return views;
  };
}
