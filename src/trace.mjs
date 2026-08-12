/**
 * Analyzes a trace saved from the Chrome DevTools Performance panel.
 *
 * This is the tool for problems you cannot reproduce locally: you ask whoever
 * *can* reproduce it to record 10 seconds and send you the .json.
 *
 * Recording instructions to pass along:
 *   Performance panel -> record -> "Save profile" (download icon) -> .json
 *   Keep it under ~10 seconds; traces get large fast.
 */
import fs from 'node:fs';

const LONG_TASK_MS = Number(process.env.LONG_TASK_MS ?? 20);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2600);

export function analyzeTrace(file, { markers = [], markerUrlPattern = '' } = {}) {
	const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
	const events = trace.traceEvents ?? trace;
	const metadata = trace.metadata ?? {};

	let t0 = Infinity;
	for (const e of events) if (e.ts > 0 && e.ts < t0) t0 = e.ts;
	const ms = (ts) => (ts - t0) / 1000;

	console.log('=== metadata ===');
	console.log('  CPU throttling:', metadata.cpuThrottling ?? '(none)');
	console.log('  recorded at   :', metadata.startTime ?? '?');
	console.log('  events        :', events.length);
	if (metadata.cpuThrottling > 1) {
		console.log('  NOTE: this trace was throttled. Confirm the real device is actually');
		console.log('        that slow before optimising for these numbers.');
	}

	// ---------------------------------------------------------------- frames
	const states = {};
	for (const e of events) {
		const state = e.name === 'PipelineReporter' ? e.args?.frame_reporter?.state : null;
		if (state) states[state] = (states[state] ?? 0) + 1;
	}
	if (Object.keys(states).length) {
		console.log('\n=== frame outcomes ===');
		for (const [state, count] of Object.entries(states)) console.log('  ' + String(count).padStart(6), state);
	}

	// ---------------------------------------------------------------- markers
	let marks = markers.slice();
	if (!marks.length && markerUrlPattern) {
		const re = new RegExp(markerUrlPattern);
		for (const e of events) {
			if (e.name !== 'ResourceSendRequest') continue;
			const url = e.args?.data?.url;
			if (url && re.test(url)) marks.push(ms(e.ts));
		}
		if (marks.length) console.log('\nmarkers from requests:', marks.map((x) => '+' + x.toFixed(0) + 'ms').join(' '));
	}

	// ---------------------------------------------------------------- long tasks
	const longTasks = events
		.filter((e) => e.name === 'RunTask' && e.dur > LONG_TASK_MS * 1000)
		.map((e) => ({ t: ms(e.ts), d: e.dur / 1000 }));

	console.log(`\n=== tasks over ${LONG_TASK_MS}ms: ${longTasks.length} ===`);
	console.log('  over 33ms:', longTasks.filter((x) => x.d > 33).length, '· over 50ms:', longTasks.filter((x) => x.d > 50).length);

	if (marks.length) {
		const hist = {};
		for (const task of longTasks) {
			let base = null;
			for (const m of marks) if (task.t >= m - 200 && (base === null || m > base)) base = m;
			if (base === null) continue;
			const bucket = Math.floor((task.t - base) / 200) * 200;
			hist[bucket] = (hist[bucket] ?? 0) + 1;
		}
		console.log('\n  offset from marker, 200ms buckets:');
		console.log('  (clustered = a burst to chase · spread = sustained over-budget)\n');
		Object.entries(hist)
			.map(([k, v]) => [Number(k), v])
			.sort((a, b) => a[0] - b[0])
			.forEach(([k, v]) => console.log('    +' + String(k).padStart(5) + 'ms  ' + '#'.repeat(Math.min(v, 60)) + ' (' + v + ')'));
	}

	// ---------------------------------------------------------------- embedded CPU profile
	const nodes = new Map();
	let samples = [];
	let deltas = [];
	let profileStart = null;
	for (const e of events) {
		if (e.name === 'Profile' && e.args?.data) profileStart = e.args.data.startTime ?? e.ts;
		if (e.name !== 'ProfileChunk') continue;
		const cp = e.args?.data?.cpuProfile;
		if (!cp) continue;
		for (const n of cp.nodes ?? []) nodes.set(n.id, n);
		if (cp.samples) samples = samples.concat(cp.samples);
		if (e.args.data.timeDeltas) deltas = deltas.concat(e.args.data.timeDeltas);
	}

	if (!samples.length) {
		console.log('\nNo CPU profile in this trace (JS sampling was off while recording).');
		return;
	}

	let cursor = profileStart ?? t0;
	const times = samples.map((_, i) => {
		cursor += deltas[i] ?? 0;
		return (cursor - t0) / 1000;
	});

	const inWindow = (x) => !marks.length || marks.some((m) => x >= m && x < m + WINDOW_MS);
	const fnName = (n) => n.callFrame.functionName || '(anonymous)';
	const lineNo = (n) => (n.callFrame.lineNumber >= 0 ? n.callFrame.lineNumber + 1 : 0);
	const isNoise = (f) => /^\(idle\)|^\(program\)|^\(root\)|^\(garbage/.test(f);

	const selfUs = new Map();
	for (let i = 0; i < samples.length; i++) {
		if (!inWindow(times[i])) continue;
		selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + Math.max(0, deltas[i] ?? 0));
	}

	const byFn = new Map();
	const byChunk = new Map();
	let total = 0;
	for (const [id, us] of selfUs) {
		const n = nodes.get(id);
		if (!n || isNoise(fnName(n))) continue;
		total += us;
		const key = `${fnName(n)}  @${lineNo(n)}`;
		byFn.set(key, (byFn.get(key) ?? 0) + us);
		const chunk = `chunk:${lineNo(n)}`;
		byChunk.set(chunk, (byChunk.get(chunk) ?? 0) + us);
	}

	const scope = marks.length ? `${marks.length} windows × ${WINDOW_MS}ms` : 'whole trace';
	console.log(`\n=== CPU self time — ${scope}, ${(total / 1000).toFixed(0)}ms of real work ===`);

	console.log('\n  by chunk line (minified bundles still separate by line number):');
	[...byChunk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
		.forEach(([k, v]) => console.log(`    ${(v / 1000).toFixed(0).padStart(6)}ms ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`));

	console.log('\n  top functions:');
	[...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
		.forEach(([k, v]) => console.log(`    ${(v / 1000).toFixed(0).padStart(6)}ms ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`));
}
