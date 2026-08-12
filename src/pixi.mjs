/**
 * Optional add-on: per-frame counters for PixiJS internals.
 *
 * The problem: bundlers don't put Pixi on `window`, so there is nothing to patch
 * from the outside.
 *
 * The trick: re-`import()` the *same module URL* the app already loaded. ES
 * modules are singletons per URL, so you get back the exact class objects the
 * app is using — not a second copy. Then wrap the prototypes read-only.
 *
 * This works with any bundler that serves real module URLs (Vite dev, native ESM,
 * import maps). For a fully bundled production build there is no separate module
 * URL to re-import, so use `moduleUrls` to point at whatever chunk exports Pixi,
 * or rely on the DevTools-trace workflow instead.
 */

/**
 * @param {object} options
 * @param {string[]} [options.moduleUrls]  explicit module URLs to try first
 * @param {string}   [options.urlPattern]  regex source used to find candidates among loaded resources
 * @param {number}   [options.objectLogLimit] how many addChild constructor names to record
 */
export function buildPixiPatch({
	moduleUrls = [],
	urlPattern = 'pixi',
	objectLogLimit = 30000,
} = {}) {
	return `(async () => {
  const P = window.__PROBE__;
  if (!P) return { ok: false, why: 'probe not installed' };

  const found = performance.getEntriesByType('resource')
    .map((r) => r.name)
    .filter((n) => new RegExp(${JSON.stringify(urlPattern)}, 'i').test(n));
  const candidates = [...new Set([...${JSON.stringify(moduleUrls)}, ...found])];

  // Careful: wrapper libraries (pixi-svelte, pixi-react, …) also export a name like
  // "Container", but it's a framework component, not the Pixi class. Only accept a module
  // whose Container actually has Pixi's prototype methods.
  const isRealPixi = (m) =>
    m && typeof m.Container === 'function' &&
    m.Container.prototype && typeof m.Container.prototype.addChild === 'function';

  let pixi = null;
  const rejected = [];
  for (const url of candidates) {
    try {
      const m = await import(url);
      if (isRealPixi(m)) { pixi = m; P.pixiUrl = url; break; }
      if (m && m.Container) rejected.push(url);
    } catch (e) { /* not a module, keep looking */ }
  }
  if (!pixi) return { ok: false, tried: candidates.slice(0, 10), lookedLikePixiButWasnt: rejected.slice(0, 5) };

  if (pixi.Ticker && pixi.Ticker.shared) {
    P.ticker = pixi.Ticker.shared;
    const add = pixi.Ticker.prototype.add;
    // Spine and AnimatedSprite register themselves here, so this doubles as a
    // "how many animated objects were created" counter.
    pixi.Ticker.prototype.add = function (...a) { P.counters.tickerAdd++; return add.apply(this, a); };
  }

  if (pixi.Container) {
    const proto = pixi.Container.prototype;

    if (proto.addChild) {
      const addChild = proto.addChild;
      proto.addChild = function (...a) {
        P.counters.addChild++;
        // Recording the constructor name is what turns "something is churning"
        // into "BitmapText is being recreated 200 times a second".
        if (P.objectLog.length < ${objectLogLimit}) {
          const child = a[0];
          P.objectLog.push([+performance.now().toFixed(1), child && child.constructor ? child.constructor.name : '?']);
        }
        return addChild.apply(this, a);
      };
    }

    if (proto.destroy) {
      const destroy = proto.destroy;
      proto.destroy = function (...a) { P.counters.destroy++; return destroy.apply(this, a); };
    }

    if (proto.sortChildren) {
      const sortChildren = proto.sortChildren;
      proto.sortChildren = function (...a) { P.counters.sortChildren++; return sortChildren.apply(this, a); };
    }
  }

  return { ok: true, url: P.pixiUrl, tickerCount: P.ticker ? P.ticker.count : -1 };
})()`;
}

/**
 * Optional add-on: disable an animation library's per-frame update to measure a
 * ceiling ("how much faster would we get if this cost nothing?").
 *
 * Answering that *before* optimising saves a lot of wasted work — if switching
 * something off entirely buys 2%, there is no point tuning it.
 *
 * @param {object} options
 * @param {string} options.urlPattern  regex source matching the library's module URL
 * @param {string} options.className   exported class name, e.g. 'Spine'
 * @param {string} options.method      prototype method to neutralise, e.g. 'internalUpdate'
 * @param {string[]} [options.moduleUrls] explicit URLs to try first
 */
export function buildDisablePatch({ urlPattern, className, method, moduleUrls = [] }) {
	return `(async () => {
  const P = window.__PROBE__;
  const found = performance.getEntriesByType('resource')
    .map((r) => r.name)
    .filter((n) => new RegExp(${JSON.stringify(urlPattern)}, 'i').test(n) && /\\.m?js/i.test(n));
  const candidates = [...new Set([...${JSON.stringify(moduleUrls)}, ...found])];
  for (const url of candidates) {
    try {
      const m = await import(url);
      const Cls = m[${JSON.stringify(className)}];
      if (Cls && Cls.prototype && Cls.prototype[${JSON.stringify(method)}]) {
        Cls.prototype[${JSON.stringify(method)}] = function () {};
        if (P) P.disabled = url;
        return { ok: true, url };
      }
    } catch (e) { /* keep looking */ }
  }
  return { ok: false, tried: candidates.slice(0, 10) };
})()`;
}
