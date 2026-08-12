# frame-probe

Find out **why** an animated web app drops frames — not just that it does.

Drives Chrome over the DevTools Protocol, replays the same interaction deterministically,
and records per-frame timings alongside renderer-internal call counts. Also reads traces
saved from the DevTools Performance panel, for problems you can't reproduce locally.

**Zero dependencies.** Node 22+ (uses the built-in `WebSocket`).

[한국어 README](./README.ko.md)

---

## Why not just open DevTools?

You can, and you should — once. The trouble starts when you try to compare two versions.

- The interaction isn't identical between runs, so the numbers move for reasons unrelated to your change.
- Opening the console changes the numbers. If the app logs objects, DevTools serializes them over the wire, and that cost lands in your measurement.
- Average FPS hides the problem. 60 → 58 fps usually isn't "every frame got slower", it's **one or two very long frames**. You need to know *which* frames and *what happened during them*.

frame-probe fixes the interaction, records every frame, and counts what the renderer actually did.

---

## Install

```bash
git clone <this repo> && cd frame-probe
node -v   # needs v22+
```

There is nothing to build and nothing to install.

Verify it works with the bundled demo — a page that deliberately stalls 400ms into each action:

```bash
node examples/demo/serve.mjs &
node bin/frame-probe.mjs run examples/demo/demo.config.mjs
node bin/frame-probe.mjs report demo-run.json
```

```
  iter |   fps | worst  | >25ms | lag over budget
     2 |  59.0 |   50.0ms |     1 |            59ms
     3 |  59.5 |   33.9ms |     1 |            43ms

=== long frames (>25ms) by offset from iteration start ===
  +   400ms  ## (2)      <- the injected stall, found
```

---

## Usage

### Just look at it first

No config, no setup. Opens the page, records while you interact, prints the report.

```bash
frame-probe watch --url=http://localhost:3000 --seconds=20 --throttle=4
```

Use this to find out *whether* you have a burst or a sustained problem before investing in
anything else.

### Then make it reproducible

Comparing two versions needs the interaction to be identical every time. Scaffold a config:

```bash
frame-probe init
```

and edit three things: **where is the app**, **how do I make it do the thing**, and **how do
I know it finished**.

```js
// my.config.mjs
export default {
  url: 'http://127.0.0.1:3000/',
  iterations: 6,
  cpuThrottling: 4,

  async ready(page)    { await page.waitFor(`document.querySelector('canvas')`); },
  async action(page)   { await page.click('#start'); },
  async waitDone(page) { await page.waitFor(`document.body.dataset.state === 'idle'`); },
};
```

```bash
frame-probe run my.config.mjs --out=before.json
# ... make your change ...
frame-probe run my.config.mjs --out=after.json
frame-probe report after.json
```

### Commands

| | |
|---|---|
| `frame-probe watch --url=…` | **Start here.** Zero config, record while you interact |
| `frame-probe init` | Scaffold a config file |
| `frame-probe run <config.mjs>` | Drive the app automatically, record, write JSON |
| `frame-probe report <run.json>` | Summary, long-frame histogram, object churn |
| `frame-probe trace <trace.json>` | Analyze a DevTools Performance export |

Flags: `--out=`, `--throttle=`, `--iterations=`, `--label=`, `--long=`, `--marks=`, `--url=`.

---

## What it records

**Per frame:** timestamp, delta, and running counters, so you can ask "what happened during
*that* frame" instead of guessing.

**CPU throttling** via `Emulation.setCPUThrottlingRate`. The DevTools UI stops at 6×; over
CDP any rate works.

**WebGL call counts** — draw calls, `texSubImage2D` (texture uploads), `bufferSubData`.
These are wrapped on the prototypes before the app gets a context. Counts are
hardware-independent, which makes them comparable across machines — see
[Trust counters, not timings](#trust-counters-not-timings).

**Long Animation Frames** with script attribution, when the browser supports it.

**Deterministic replay** — stub network calls so every iteration is byte-for-byte identical:

```js
stubs: [
  { pattern: '/api/action$', response: () => ({ ok: true, value: 42 }) },
  { pattern: '/api/slow$',   response: {}, delayMs: 3000 },  // probe loading paths
],
```

This is not a nicety, it's what makes comparison possible. If the server returns something
different each run, you can't tell whether a number moved because of your change or because
the response was different.

### Reuse the fixtures you already have

You probably already have canned server responses somewhere — Storybook stories, MSW
handlers, test fixtures, VCR cassettes. Read them in Node and serve them from the stub:

```js
import fs from 'node:fs';
const fixtures = JSON.parse(fs.readFileSync('./src/stories/data/scenarios.json', 'utf8'));
const scenario = fixtures.find((f) => f.id === Number(process.env.SCENARIO ?? 1));

export default {
  stubs: [{ pattern: '/api/action$', response: () => ({ result: scenario.events }) }],
};
```

Now you can aim the measurement at a specific situation by changing one id, and the app
runs fully offline.

**Exercise the expensive fixtures, not just the convenient one.** In the investigation this
came from, months of measurements used the "nothing happens" fixture. The worst churn —
hundreds of objects recreated per second — only appeared in the fixture with a result
animation, which nobody had measured.

### PixiJS add-on

Bundlers don't put Pixi on `window`, so there's nothing to patch from outside. The trick:
re-`import()` the *same module URL* the app already loaded. ES modules are singletons per
URL, so you get back the exact classes the app is using.

```js
pixi: { urlPattern: 'pixi' },
```

You then get `addChild` / `destroy` / `sortChildren` counts — **and the constructor name of
every object added to the scene graph**. That last one is what turns "something is churning"
into "`BitmapText` is being recreated 200 times a second because its list key includes the
text itself".

Works with Vite dev, native ESM, and import maps. A fully bundled production build has no
separate module URL to re-import — use the trace workflow for those.

---

## Triggering the action, and knowing when it ended

This is the only part that's specific to your app, and the whole reason configs have hooks.
Ranked by how well they hold up:

**1. A test-only DOM overlay.** If your app renders to canvas or WebGL, a small DOM overlay
behind a flag (`?e2e=true`) that exposes buttons and state attributes is by far the best
option:

```js
async action(page)   { await page.click('[data-testid=start]'); },
async waitDone(page) { await page.waitFor(`document.body.dataset.state === 'idle'`); },
```

It survives layout and resolution changes, and you probably want it for end-to-end tests
anyway. **If the app doesn't have one, adding it is usually worth more than working around
its absence.**

**2. Read the app's own state.** Same singleton trick as the Pixi add-on — re-import the
state module and read it:

```js
async waitDone(page) {
  await page.waitFor(`(async () => {
    const url = performance.getEntriesByType('resource').map(r => r.name).find(n => /appState/.test(n));
    const m = await import(url);
    return m.state.phase === 'idle';
  })()`);
}
```

Watch out: dev servers add cache-busting query strings. Importing `/src/state.js` when the
app loaded `/src/state.js?t=1699…` gives you a **different module instance** whose values
never change. Always resolve the real URL from `performance.getEntriesByType('resource')`.

**3. Network marks.** With `probe.markRequests` set, request timings are already on the
frame clock, so the request that starts the action is a reliable *start* boundary with no
extra work. You still need something else for the end.

**4. Quiescence.** Treat "no scene-graph mutations for N frames" as done. Rough, but it
needs nothing from the app.

**5. Keyboard trigger plus a fixed wait.** Works, but idle time leaks into your averages.
If you must use it, draw conclusions only from metrics that idle time can't distort — long
frame counts rather than average FPS.

**Don't click canvas coordinates.** They break silently when layout or resolution changes.

---

## Reading the output

### The histogram is the first thing to look at

```
=== long frames (>25ms) by offset from iteration start ===
  +   400ms  ############ (12)
```
**Clustered** — a burst. Something specific happens at that moment. Go find it.

```
  +   400ms  ############ (12)
  +   600ms  ################ (16)
  +   800ms  ############ (12)
  +  1000ms  ############### (15)
```
**Spread** — sustained over-budget. There is no single hotspot to fix; the app needs to do
less work overall. Knowing which of these you have saves days.

### Trust counters, not timings

Timings drift for reasons that have nothing to do with your code. Real examples from the
investigation this tool came out of:

- The same code measured **44.7ms** on one dev-server process and **253.4ms** on another.
- The same build, run twice: **554ms** and **608ms**.

Counters don't drift. "Did that change reduce GPU texture uploads?" was answered in one
line — `texSubImage2D` went from **26.2** to **26.3** per iteration, i.e. it didn't — after
timing comparisons had suggested a 20% win that turned out to be noise.

### A/B/A when you must compare timings

Run *after*, then *before*, then *after* again. If the two `after` runs straddle the
`before`, your change is below the noise floor.

### Measure the ceiling before optimizing

Before tuning a subsystem, ask what you'd gain by removing it entirely:

```js
disable: { urlPattern: 'my-anim-lib', className: 'Skeleton', method: 'update' },
```

In that investigation, switching off *all* skeletal animation updates moved 46.7 → 47.8 fps.
That single run closed off a whole line of work that looked promising.

---

## Traces from other people's machines

Sometimes you can't reproduce it. Have whoever can record 10 seconds in the DevTools
Performance panel (**Save profile** → `.json`) and send it over.

```bash
frame-probe trace their-trace.json --url='/api/action'
```

You get dropped-frame counts, the long-task histogram, and self-time attribution from the
CPU profile embedded in the trace. Minified production bundles still separate by chunk line
number, which is usually enough to tell which library is spending the time.

**Check `cpuThrottling` in the output first.** A trace recorded at 15× tells you about a
device 15× slower than that laptop — which may be nothing like the device people are
actually complaining about.

---

## Things that will bite you

**Console-related CDP traffic pollutes measurements.** If the page logs objects and the
runtime domain is enabled, serialization cost lands in your numbers. frame-probe doesn't
enable it.

**Your instrumentation is not free.** An early version captured `new Error().stack` inside a
wrapper to find callers; that made the wrapped function look like the top cost in the
profile. It wasn't. Keep stack capture off by default.

**Throw away the first run** after changing source. Dev-server transform cost lands in it.

**Exercise the paths that matter.** Measuring only the cheap path hides real problems — in
the original investigation, weeks of measurements used a code path with no result
presentation, which is exactly where the worst churn turned out to be.

**Match the kind of load, not just the amount.** CPU throttling slows main-thread JS. It
does not emulate GPU limits, texture bandwidth, or **display refresh rate**. A 120Hz device
has an 8.3ms frame budget, not 16.7ms — an app that comfortably holds 60fps can look worse
there than one locked to 60. No amount of CPU throttling will show you that.

**Ask what device before you optimize.** A recent flagship phone is roughly desktop-class.
Emulator presets named "low-tier mobile" model hardware from years ago.

---

## License

MIT
