import fs from 'node:fs';

// Frame row layout, mirrored from probe.mjs.
const T = 0, DT = 1, ADD = 2, DESTROY = 3, TICKER_ADD = 4, SORT = 5;
const DRAW = 6, TEX_IMAGE = 7, TEX_SUB = 8, BUF_DATA = 9, BUF_SUB = 10, BIND_TEX = 11, USE_PROG = 12, TICKER_COUNT = 13;

const FRAME_BUDGET_MS = 1000 / 60;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

/** Splits the recording into iterations using the marks the runner emitted. */
function iterations(data) {
	const starts = data.marks.filter((m) => m.kind === 'iterationStart');
	return starts.map((start) => {
		const end = data.marks.find((m) => m.kind === 'iterationEnd' && m.i === start.i);
		return { i: start.i, from: start.t, to: end ? end.t : Infinity };
	});
}

const frameAt = (frames, t) => {
	let best = frames[0];
	for (const f of frames) {
		if (f[T] <= t) best = f;
		else break;
	}
	return best;
};

export function summarize(file, { longFrameMs = 25 } = {}) {
	const data = JSON.parse(fs.readFileSync(file, 'utf8'));
	const frames = data.frames ?? [];
	if (!frames.length) {
		console.log('no frames recorded');
		return;
	}

	console.log(`=== ${data.label ?? file} ===`);
	if (data.config) console.log(`  url ${data.config.url} · CPU throttle ${data.config.cpuThrottling}×`);
	if (data.contextTypes?.length) console.log(`  canvas contexts: ${data.contextTypes.join(', ')}`);
	if (data.pixiUrl) console.log('  pixi counters: on');
	if (data.disabled) console.log(`  DISABLED for ceiling test: ${data.disabled}`);

	const rows = iterations(data);
	const totals = { lag: 0, long: 0, fps: 0, add: 0, spine: 0, n: 0 };
	let all = [];

	console.log('\n  iter |   fps | worst  | >' + longFrameMs + 'ms | lag over budget | addChild');
	for (const it of rows) {
		const slice = frames.filter((f) => f[T] >= it.from && f[T] <= it.to);
		const deltas = slice.map((f) => f[DT]).slice(1);
		if (!deltas.length) continue;
		const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
		const lag = deltas.reduce((s, d) => s + Math.max(0, d - FRAME_BUDGET_MS), 0);
		const long = deltas.filter((d) => d > longFrameMs).length;
		const a = frameAt(frames, it.from), b = frameAt(frames, it.to);
		const added = b[ADD] - a[ADD];

		console.log(
			`  ${String(it.i).padStart(4)} | ${(1000 / avg).toFixed(1).padStart(5)} | ${Math.max(...deltas).toFixed(1).padStart(6)}ms | ${String(long).padStart(5)} | ${lag.toFixed(0).padStart(13)}ms | ${String(added).padStart(8)}`,
		);

		totals.lag += lag; totals.long += long; totals.fps += 1000 / avg;
		totals.add += added; totals.spine += b[TICKER_ADD] - a[TICKER_ADD]; totals.n++;
		all = all.concat(deltas);
	}

	if (!totals.n) { console.log('  (no complete iterations)'); return; }

	all.sort((x, y) => x - y);
	console.log(`\n  average ${(totals.fps / totals.n).toFixed(1)} fps`);
	console.log(`  lag over budget ${(totals.lag / totals.n).toFixed(0)}ms per iteration · ${totals.long} long frames total`);
	console.log(`  frame time  median ${pct(all, 0.5).toFixed(1)}ms · p90 ${pct(all, 0.9).toFixed(1)}ms · p99 ${pct(all, 0.99).toFixed(1)}ms`);
	console.log(`  addChild ${(totals.add / totals.n).toFixed(0)}/iter · Ticker.add ${(totals.spine / totals.n).toFixed(0)}/iter`);

	const gl = data.gl ?? {};
	if (gl.draw) {
		const frameCount = frames.length;
		console.log(
			`  GL per frame  draw ${(gl.draw / frameCount).toFixed(1)} · texSubImage2D ${(gl.texSub / frameCount).toFixed(2)} · bufferSubData ${(gl.bufSub / frameCount).toFixed(2)}`,
		);
	}

	const last = frames[frames.length - 1];
	if (last[TICKER_COUNT] >= 0) console.log(`  Ticker.shared listeners at end: ${last[TICKER_COUNT]} (growing across iterations = leak)`);
}

/** Buckets long frames by offset from each iteration start. */
export function buckets(file, { bucketMs = 200, longFrameMs = 25 } = {}) {
	const data = JSON.parse(fs.readFileSync(file, 'utf8'));
	const frames = data.frames ?? [];
	const hist = new Map();

	for (const it of iterations(data)) {
		const slice = frames.filter((f) => f[T] >= it.from && f[T] <= it.to);
		for (let i = 1; i < slice.length; i++) {
			if (slice[i][DT] <= longFrameMs) continue;
			const bucket = Math.floor((slice[i][T] - it.from) / bucketMs) * bucketMs;
			hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
		}
	}

	console.log(`\n=== long frames (>${longFrameMs}ms) by offset from iteration start ===`);
	console.log('  clustered at one offset = a burst you can chase');
	console.log('  spread evenly = sustained over-budget, no single hotspot\n');
	[...hist.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, v]) => {
		console.log(`  +${String(k).padStart(6)}ms  ${'#'.repeat(Math.min(v, 60))} (${v})`);
	});
}

/** What kinds of objects were created, and when. */
export function objects(file, { topN = 15 } = {}) {
	const data = JSON.parse(fs.readFileSync(file, 'utf8'));
	const log = data.objectLog ?? [];
	if (!log.length) { console.log('\nno object log (enable the pixi add-on)'); return; }

	const byName = {};
	for (const [, name] of log) byName[name] = (byName[name] ?? 0) + 1;
	const iters = iterations(data).length || 1;

	console.log(`\n=== objects added to the scene graph (${log.length} total, ${iters} iterations) ===`);
	Object.entries(byName)
		.sort((a, b) => b[1] - a[1])
		.slice(0, topN)
		.forEach(([name, count]) => console.log(`  ${String(count).padStart(7)}  ${(count / iters).toFixed(1).padStart(7)}/iter  ${name}`));
	console.log('\n  A type appearing hundreds of times per iteration is usually a component');
	console.log('  being recreated when it should be updated in place.');
}
