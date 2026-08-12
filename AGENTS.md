# Notes for agents

Rules for using frame-probe. Background and rationale are in `README.md`.

## Hard rules

1. **Discard the first run** after changing source. Dev-server transform cost lands in it.
2. **Compare against the same server process.** Restarting the app server shifts the whole
   baseline — the same code has measured 44.7ms and 253.4ms across two processes.
3. **Never claim an improvement from a single timing comparison.** Use A/B/A, or verify
   with a counter.
4. **Clean up processes you started.** Check whether the app server is already running
   before starting your own, and don't kill one you didn't start.

## Standard loop

```bash
frame-probe run my.config.mjs --out=warmup.json   # discard
frame-probe run my.config.mjs --out=after.json
frame-probe report after.json
```

## Reading the result

**Look at the long-frame histogram first.**

- Clustered at one offset → a burst. Find what happens at that moment; check the object
  churn section for what gets created.
- Spread evenly → sustained over-budget. **Fixing individual functions will not help.**
  Use a ceiling experiment to narrow the direction.

**Counters beat timings.** They don't drift with machine or server state:
`addChild` per iteration, `Ticker.add` (objects created), `texSubImage2D` (GPU uploads).
A type appearing hundreds of times per iteration is a recreation bug.

**A/B/A when you must compare timings.** Run *after*, then *before*, then *after* again.
If the two `after` runs straddle `before`, the change is below the noise floor — **do not
report it as an improvement.**

**Measure the ceiling before optimizing.**

```js
disable: { urlPattern: 'some-lib', className: 'Thing', method: 'update' },
```

Whatever you gain with the subsystem fully switched off is the ceiling for optimizing it.
If that's small, drop the direction.

## Config hooks

Prefer, in order: a test-only DOM overlay → reading app state via module re-import →
network marks → quiescence → fixed waits. Never click canvas coordinates.

When re-importing a state module, resolve the real URL from
`performance.getEntriesByType('resource')` — dev servers add cache-busting query strings,
and importing the bare path gives you a different module instance whose values never change.

## Reporting

- Separate what was measured from what is inferred. Label them.
- If there was no improvement, say so. Many plausible optimizations measure as zero.
- If you reverted a change, say that you reverted it.
- Record failed attempts with their evidence, so the next person doesn't repeat them.

## Don't

- Don't pick a throttle rate without knowing the target device. A recent flagship phone is
  roughly desktop-class; presets named "low-tier mobile" model hardware from years ago.
- Don't expect CPU throttling to reproduce GPU, texture-bandwidth, or **refresh-rate**
  problems. It cannot.
- Don't leave stack capture enabled inside instrumentation. Its cost lands on whatever
  function you wrapped and will look like the hotspot.
