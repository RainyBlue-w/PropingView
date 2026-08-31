/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * TradingView 私有 API 引导:LineToolExecution(官网同款成交小三角)加载 + 精准价格锚定补丁。
 *
 * 背景(逆向实测,CL v29.4):
 * - 公开 API createExecutionShape 自 v29 起仅限 Trading Platform,本项目的纯 charting_library
 *   包拿不到;但 LineToolExecution 工具类仍在库内,只是懒加载未注册;
 * - 经 iframe 域的 webpack 运行时拿到 require 后,可调内部 ensureLineToolLoaded 完成注册,
 *   再用 model.createLineTool({ linetool: 'LineToolExecution' }) 直接创建成交标记;
 * - 原生渲染把箭头钉在 bar 高/低点外 10px(成交价只进文字标签,不进 y 坐标)。这里对
 *   ExecutionsPositionController.prototype.getXYCoordinate 包一层:y 改用精确成交价,
 *   x(bar 吸附、同 bar 多笔成交错开)保持原生逻辑。
 *
 * 全部为私有 API:不硬编码 webpack 模块 id(按导出名探测),任何一步失败返回 false,
 * 调用方回退到公开 createMultipointShape(arrow_up/down)方案,互不污染。
 */

/** iframe contentWindow -> 引导结果(每个图表 realm 只需引导一次) */
const bootstrapped = new WeakMap<object, Promise<boolean>>();

/**
 * 确保 LineToolExecution 已加载且 y 已 patch 为精确成交价。
 * 返回 false = 私有 API 不可用(库升级结构变动等),调用方走公开回退。
 */
export function ensureExecutionToolPatched(widget: any): Promise<boolean> {
  try {
    const iw = widget?._iFrame?.contentWindow;
    if (!iw) return Promise.resolve(false);
    let p = bootstrapped.get(iw);
    if (!p) {
      p = doBootstrap(iw).catch(() => false);
      bootstrapped.set(iw, p);
    }
    return p;
  } catch {
    return Promise.resolve(false);
  }
}

async function doBootstrap(iw: any): Promise<boolean> {
  const req = stealRequire(iw);
  if (!req) return false;
  const loader = getModuleExports(req, 'ensureLineToolLoaded');
  if (!loader) return false;
  await loader.ensureLineToolLoaded('LineToolExecution');
  const ctrl = getModuleExports(req, 'ExecutionsPositionController')?.ExecutionsPositionController;
  if (typeof ctrl !== 'function') return false;
  patchGetXYCoordinate(ctrl);
  return true;
}

/** 从 iframe 域的 webpack chunk 数组偷出 __webpack_require。 */
function stealRequire(iw: any): any {
  try {
    const chunkKey = Object.keys(iw).find((k) => k.startsWith('webpackChunk'));
    if (!chunkKey) return null;
    let req: any = null;
    iw[chunkKey].push([[{ toString: () => 'tv-exec-tool' }], {}, (r: any) => { req = r; }]);
    return req;
  } catch {
    return null;
  }
}

/**
 * 按导出名取模块 exports。先查已执行模块缓存;未命中再扫模块工厂源码
 * (export 声明 `name:()=>` 在压缩后仍保留),找到后按需 require。
 */
function getModuleExports(req: any, exportName: string): any {
  const cache = req.c || {};
  for (const id of Object.keys(cache)) {
    try {
      const e = cache[id]?.exports;
      if (e && typeof e[exportName] === 'function') return e;
    } catch {
      /* 忽略异常模块 */
    }
  }
  const factories = req.m || {};
  const marker = `${exportName}:()=>`;
  for (const id of Object.keys(factories)) {
    try {
      if (String(factories[id]).includes(marker)) {
        const e = req(id);
        if (e && typeof e[exportName] === 'function') return e;
      }
    } catch {
      /* 忽略异常模块 */
    }
  }
  return null;
}

/**
 * 包一层 getXYCoordinate:x 用原生结果(bar 吸附 + 同 bar 错开),y 换成精确成交价。
 * 幂等;任何异常都回落到原生结果,绝不影响渲染。
 */
function patchGetXYCoordinate(ctrl: any) {
  const proto = ctrl?.prototype;
  if (!proto || proto.__tvExactPricePatched || typeof proto.getXYCoordinate !== 'function') return;
  const orig = proto.getXYCoordinate;
  proto.getXYCoordinate = function (this: any, exec: any, timeScale: any, timePointIndex: any) {
    const r = orig.call(this, exec, timeScale, timePointIndex);
    try {
      if (!r || r.x === -1) return r;
      const price = typeof exec?.getPrice === 'function' ? exec.getPrice() : NaN;
      if (!Number.isFinite(price)) return r;
      const series = this._pane.model().mainSeries();
      return { x: r.x, y: series.priceScale().priceToCoordinate(price, series.firstValue()) };
    } catch {
      return r;
    }
  };
  proto.__tvExactPricePatched = true;
}
