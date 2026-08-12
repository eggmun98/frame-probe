/**
 * Builds the instrumentation script that is injected into the page *before any
 * app code runs* (via Page.addScriptToEvaluateOnNewDocument).
 *
 * Everything here is read-only: original functions are always called. The probe
 * records, it never changes behaviour.
 */

/**
 * @param {object} options
 * @param {boolean} [options.webgl]      count WebGL draw calls / texture uploads
 * @param {boolean} [options.forceWebGL] hide navigator.gpu so WebGPU renderers fall back to WebGL
 * @param {boolean} [options.loaf]       collect Long Animation Frame entries
 * @param {string}  [options.markRequests] regex source; matching fetch() URLs get a timestamp mark
 */
export function buildProbe({ webgl = true, forceWebGL = false, loaf = true, markRequests = '' } = {}) {
	return `(() => {
  const P = {
    frames: [],
    marks: [],
    loaf: [],
    counters: { addChild: 0, destroy: 0, tickerAdd: 0, sortChildren: 0 },
    gl: { draw: 0, texImage: 0, texSub: 0, bufData: 0, bufSub: 0, bindTex: 0, useProg: 0 },
    objectLog: [],
    ticker: null,
    contextTypes: [],
  };
  window.__PROBE__ = P;

  ${
		forceWebGL
			? `// Make WebGPU-preferring renderers fall back to WebGL (useful when the target
  // device is WebGL-only, e.g. iOS Safari).
  try { Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }); } catch (e) {}`
			: ''
	}

  ${
		webgl
			? `// Wrap GL prototypes before the app grabs a context. Call *counts* are
  // hardware-independent, which makes them comparable across machines.
  const wrapGl = (proto) => {
    if (!proto || proto.__probeWrapped) return;
    proto.__probeWrapped = true;
    const bump = (name, key) => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = function (...a) { P.gl[key]++; return orig.apply(this, a); };
    };
    bump('drawElements', 'draw');
    bump('drawArrays', 'draw');
    bump('drawElementsInstanced', 'draw');
    bump('drawArraysInstanced', 'draw');
    bump('texImage2D', 'texImage');
    bump('compressedTexImage2D', 'texImage');
    bump('texSubImage2D', 'texSub');
    bump('bufferData', 'bufData');
    bump('bufferSubData', 'bufSub');
    bump('bindTexture', 'bindTex');
    bump('useProgram', 'useProg');
  };
  try { wrapGl(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype); } catch (e) {}
  try { wrapGl(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype); } catch (e) {}
  try {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (P.contextTypes.indexOf(type) < 0) P.contextTypes.push(type);
      return getContext.call(this, type, ...rest);
    };
  } catch (e) {}`
			: ''
	}

  // Frame recorder. One row per animation frame:
  // [now, delta, addChild, destroy, tickerAdd, sortChildren, draw, texImage, texSub, bufData, bufSub, bindTex, useProg, tickerCount]
  let last = performance.now();
  const loop = (now) => {
    const c = P.counters, g = P.gl;
    P.frames.push([
      +now.toFixed(2), +(now - last).toFixed(2),
      c.addChild, c.destroy, c.tickerAdd, c.sortChildren,
      g.draw, g.texImage, g.texSub, g.bufData, g.bufSub, g.bindTex, g.useProg,
      P.ticker ? P.ticker.count : -1,
    ]);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  ${
		loaf
			? `try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        P.loaf.push({
          startTime: +e.startTime.toFixed(2),
          duration: +e.duration.toFixed(2),
          blockingDuration: +((e.blockingDuration) || 0).toFixed(2),
          scripts: (e.scripts || []).map((s) => ({
            invoker: s.invoker,
            invokerType: s.invokerType,
            sourceURL: s.sourceURL,
            sourceFunctionName: s.sourceFunctionName,
            sourceCharPosition: s.sourceCharPosition,
            duration: +s.duration.toFixed(2),
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (err) { P.loafError = String(err); }`
			: ''
	}

  ${
		markRequests
			? `// Put network timings on the same clock as the frame recorder.
  const RE = new RegExp(${JSON.stringify(markRequests)});
  const origFetch = window.fetch;
  window.fetch = function (...a) {
    const url = String((a[0] && a[0].url) || a[0] || '');
    if (!RE.test(url)) return origFetch.apply(this, a);
    P.marks.push({ kind: 'requestStart', url, t: +performance.now().toFixed(2) });
    return origFetch.apply(this, a).then((r) => {
      P.marks.push({ kind: 'requestEnd', url, t: +performance.now().toFixed(2) });
      return r;
    });
  };`
			: ''
	}

  window.__probeMark = (kind, extra) => {
    P.marks.push(Object.assign({ kind, t: +performance.now().toFixed(2) }, extra || {}));
  };
})()`;
}
