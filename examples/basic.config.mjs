/**
 * A config file describes three things:
 *   1. where the app is
 *   2. how to make it do the thing you want to measure
 *   3. how to know that thing has finished
 *
 * Everything else — frame recording, counters, throttling — is handled for you.
 */
export default {
	url: 'http://127.0.0.1:3000/',

	iterations: 6,
	// DevTools presets top out at 6×. Higher values are only reachable over CDP,
	// which is one reason to drive Chrome directly.
	cpuThrottling: 4,

	probe: {
		webgl: true,
		// Set true if the target device has no WebGPU (e.g. iOS Safari) and you
		// want the same renderer path locally.
		forceWebGL: false,
		loaf: true,
		// fetch() URLs matching this get timestamped on the frame clock.
		markRequests: '/api/',
	},

	// Optional: count PixiJS scene-graph churn. Remove this block for non-Pixi apps.
	pixi: {
		urlPattern: 'pixi',
		// If auto-discovery fails, name the module URL explicitly:
		// moduleUrls: ['/node_modules/.vite/deps/pixi__js.js'],
	},

	// Optional: stub network calls so every iteration is byte-for-byte identical.
	// Without this, run-to-run differences drown out the change you are measuring.
	stubs: [
		{
			pattern: '/api/action$',
			response: () => ({ ok: true, result: 'fixed-deterministic-payload' }),
			// delayMs: 3000,  // useful for probing loading/pending code paths
		},
	],

	/** Wait until the app is interactive. */
	async ready(page) {
		await page.waitFor(`document.querySelector('canvas')`);
		await page.sleep(3000);
	},

	/** Do the thing once. */
	async action(page) {
		await page.click('#start-button');
	},

	/** Wait for it to finish, so iterations don't overlap. */
	async waitDone(page) {
		await page.waitFor(`document.body.dataset.state === 'idle'`, { timeoutMs: 15000 });
	},

	out: 'run.json',
	label: 'baseline',
};
