import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { connect, sleep } from './cdp.mjs';
import { buildProbe } from './probe.mjs';
import { buildPixiPatch, buildDisablePatch } from './pixi.mjs';

const CHROME_CANDIDATES = [
	process.env.CHROME_BIN,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const findChrome = () => {
	for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
	throw new Error('Chrome not found. Set CHROME_BIN to the executable path.');
};

const base64 = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64');

/**
 * Runs one measurement session against a config module.
 * @param {string} configPath
 * @param {object} [overrides]
 */
export async function run(configOrPath, overrides = {}) {
	// Accepts a path to a config module, or a plain object (used by the
	// zero-config `--url` mode).
	const loaded =
		typeof configOrPath === 'string'
			? await import(pathToFileURL(path.resolve(configOrPath)).href).then((m) => m.default ?? m)
			: configOrPath;
	const config = { ...loaded, ...overrides };

	const {
		url,
		iterations = 5,
		cpuThrottling = 1,
		windowSize = '1280,800',
		headless = false,
		warmupMs = 3000,
		settleMs = 1500,
		probe: probeOptions = {},
		pixi: pixiOptions = null,
		disable = null,
		stubs = [],
		out = 'probe-run.json',
		label = 'run',
	} = config;

	if (!url) throw new Error('config.url is required');

	const chromePath = findChrome();
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-probe-'));
	const port = Number(process.env.CDP_PORT ?? 9333);

	const chrome = spawn(
		chromePath,
		[
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${userDataDir}`,
			'--no-first-run',
			'--no-default-browser-check',
			// Keep the tab scheduled like a foreground tab even when it loses focus,
			// otherwise measurements silently drift.
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			`--window-size=${windowSize}`,
			...(headless ? ['--headless=new'] : []),
			'about:blank',
		],
		{ stdio: 'ignore' },
	);
	const cleanup = () => { try { chrome.kill(); } catch {} };
	process.on('exit', cleanup);

	let wsUrl = null;
	for (let i = 0; i < 60 && !wsUrl; i++) {
		await sleep(250);
		try {
			wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
		} catch {}
	}
	if (!wsUrl) throw new Error('Could not reach Chrome DevTools endpoint');

	const { send, on } = connect(wsUrl);
	const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
	const cdp = (method, params) => send(method, params, sessionId);

	await cdp('Page.enable');

	// ---------------------------------------------------------------- request stubbing
	if (stubs.length) {
		const headers = [
			{ name: 'Access-Control-Allow-Origin', value: '*' },
			{ name: 'Access-Control-Allow-Headers', value: '*' },
			{ name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' },
			{ name: 'Content-Type', value: 'application/json' },
		];
		on(`${sessionId}:Fetch.requestPaused`, async ({ requestId, request }) => {
			const fulfill = (body, status = 200) =>
				cdp('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: base64(body) });

			if (request.method === 'OPTIONS') {
				return void cdp('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: headers, body: '' });
			}
			for (const stub of stubs) {
				if (!new RegExp(stub.pattern).test(request.url)) continue;
				if (stub.delayMs) await sleep(stub.delayMs);
				const body = typeof stub.response === 'function' ? await stub.response(request) : stub.response;
				return void fulfill(body ?? {}, stub.status ?? 200);
			}
			return void cdp('Fetch.continueRequest', { requestId });
		});
		await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
	}

	// ---------------------------------------------------------------- instrumentation
	await cdp('Page.addScriptToEvaluateOnNewDocument', { source: buildProbe(probeOptions) });

	const evaluate = async (expression, awaitPromise = false) => {
		const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
		return r.result.value;
	};

	/** Minimal page helper handed to config hooks. */
	const page = {
		evaluate,
		sleep,
		cdp,
		click: (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`),
		clickAt: async (x, y) => {
			for (const type of ['mousePressed', 'mouseReleased']) {
				await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
			}
			return true;
		},
		press: async (key, code, keyCode) => {
			for (const type of ['keyDown', 'keyUp']) {
				await cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
			}
		},
		mark: (kind, extra) => evaluate(`window.__probeMark(${JSON.stringify(kind)}, ${JSON.stringify(extra ?? null)})`),
		waitFor: async (expression, { timeoutMs = 30000, intervalMs = 250 } = {}) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (await evaluate(`!!(${expression})`)) return true;
				await sleep(intervalMs);
			}
			throw new Error(`waitFor timed out: ${expression}`);
		},
	};

	console.log(`[${label}] navigating to ${url}`);
	await cdp('Page.navigate', { url });

	if (config.ready) await config.ready(page);
	else await sleep(warmupMs);

	// Pixi counters need the app's module to be loaded already, so patch after ready.
	if (pixiOptions) {
		const result = await evaluate(buildPixiPatch(pixiOptions), true);
		if (result?.ok) console.log(`[${label}] pixi counters on (${result.url})`);
		else console.log(`[${label}] no PixiJS module found — scene-graph counters off (fine for non-Pixi pages)`);
	}
	if (disable) {
		const result = await evaluate(buildDisablePatch(disable), true);
		console.log(`[${label}] disable patch:`, JSON.stringify(result));
	}

	await sleep(settleMs);
	if (cpuThrottling > 1) await cdp('Emulation.setCPUThrottlingRate', { rate: cpuThrottling });
	await sleep(500);

	// Drop everything recorded during load so the numbers describe steady state.
	await evaluate(`(() => { const P = window.__PROBE__; P.frames.length = 0; P.marks.length = 0; P.objectLog.length = 0; return 1; })()`);

	for (let i = 0; i < iterations; i++) {
		await page.mark('iterationStart', { i });
		if (config.action) await config.action(page, i);
		if (config.waitDone) await config.waitDone(page, i);
		else await sleep(config.iterationMs ?? 3000);
		await page.mark('iterationEnd', { i });
		console.log(`[${label}] iteration ${i + 1}/${iterations}`);
	}

	if (cpuThrottling > 1) await cdp('Emulation.setCPUThrottlingRate', { rate: 1 });

	const payload = await evaluate(
		`JSON.stringify((() => { const P = window.__PROBE__; return {
			frames: P.frames, marks: P.marks, loaf: P.loaf, counters: P.counters,
			gl: P.gl, objectLog: P.objectLog, contextTypes: P.contextTypes,
			pixiUrl: P.pixiUrl, disabled: P.disabled, loafError: P.loafError,
		}; })())`,
	);
	const data = JSON.parse(payload);
	const outPath = path.resolve(out);
	fs.writeFileSync(outPath, JSON.stringify({ label, config: { url, iterations, cpuThrottling }, ...data }));
	console.log(`[${label}] wrote ${outPath}  frames=${data.frames.length} marks=${data.marks.length}`);

	cleanup();
	return outPath;
}
