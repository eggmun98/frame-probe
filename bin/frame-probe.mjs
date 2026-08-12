#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/run.mjs';
import { summarize, buckets, objects } from '../src/analyze.mjs';
import { analyzeTrace } from '../src/trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const usage = `frame-probe — find out why an animated web app drops frames

  frame-probe watch --url=<url> [--seconds=20] [--throttle=4]
      Zero config. Opens the page, records while you interact, then reports.
      Start here if you just want to see where the long frames are.

  frame-probe init [--out=frame-probe.config.mjs]
      Write a starter config you can edit.

  frame-probe run <config.mjs> [--out=run.json] [--throttle=N] [--iterations=N]
      Drive the app automatically and record. Reproducible; use this to compare versions.

  frame-probe report <run.json> [--long=25]
      Summary, long-frame histogram, object churn.

  frame-probe trace <devtools-trace.json> [--marks=1200,4500] [--url=/api/action]
      Analyze a trace exported from the DevTools Performance panel.

Environment:
  CHROME_BIN    path to Chrome/Chromium
  CDP_PORT      remote debugging port (default 9333)
`;

if (!command || has('help')) {
	console.log(usage);
	process.exit(0);
}

// ---------------------------------------------------------------- watch
if (command === 'watch') {
	const url = flag('url');
	if (!url) {
		console.error('watch needs --url=<url>\n');
		console.log(usage);
		process.exit(1);
	}
	const seconds = Number(flag('seconds', 20));
	const out = flag('out', 'watch.json');

	console.log(`\nRecording ${url} for ${seconds}s.`);
	console.log('Interact with the page now — clicks, scrolls, whatever reproduces the jank.\n');

	await run(
		{
			url,
			iterations: 1,
			cpuThrottling: Number(flag('throttle', 1)),
			probe: { webgl: true, loaf: true, forceWebGL: has('webgl') },
			pixi: has('no-pixi') ? null : { urlPattern: 'pixi' },
			async ready(page) {
				await page.sleep(Number(flag('wait', 4000)));
			},
			async action() {},
			async waitDone(page) {
				await page.sleep(seconds * 1000);
			},
			out,
			label: 'watch',
		},
		{},
	);

	console.log('');
	summarize(out);
	buckets(out);
	objects(out);
	process.exit(0);
}

// ---------------------------------------------------------------- init
if (command === 'init') {
	const out = path.resolve(flag('out', 'frame-probe.config.mjs'));
	if (fs.existsSync(out)) {
		console.error(`${out} already exists — refusing to overwrite.`);
		process.exit(1);
	}
	fs.copyFileSync(path.join(HERE, '..', 'examples', 'basic.config.mjs'), out);
	console.log(`Wrote ${out}`);
	console.log('\nEdit three things:');
	console.log('  url        where the app is');
	console.log('  action()   how to make it do the thing you want to measure');
	console.log('  waitDone() how to know that thing finished');
	console.log(`\nThen: frame-probe run ${path.relative(process.cwd(), out)}`);
	process.exit(0);
}

// ---------------------------------------------------------------- run
if (command === 'run') {
	const target = positional[0];
	if (!target) {
		console.error('run needs a config file. Create one with: frame-probe init\n');
		console.log(usage);
		process.exit(1);
	}
	const overrides = {};
	if (flag('out')) overrides.out = flag('out');
	if (flag('throttle')) overrides.cpuThrottling = Number(flag('throttle'));
	if (flag('iterations')) overrides.iterations = Number(flag('iterations'));
	if (flag('label')) overrides.label = flag('label');
	await run(target, overrides);
	process.exit(0);
}

// ---------------------------------------------------------------- report
if (command === 'report') {
	const target = positional[0];
	if (!target) { console.log(usage); process.exit(1); }
	const longFrameMs = Number(flag('long', 25));
	summarize(target, { longFrameMs });
	buckets(target, { longFrameMs });
	objects(target);
	process.exit(0);
}

// ---------------------------------------------------------------- trace
if (command === 'trace') {
	const target = positional[0];
	if (!target) { console.log(usage); process.exit(1); }
	const marks = (flag('marks', '') || '')
		.split(',')
		.map((x) => Number(x.trim()))
		.filter((x) => Number.isFinite(x) && x > 0);
	analyzeTrace(target, { markers: marks, markerUrlPattern: flag('url', '') });
	process.exit(0);
}

console.log(usage);
process.exit(1);
