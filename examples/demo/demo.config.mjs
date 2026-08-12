// Config for the bundled demo page. Use it to verify your setup works.
export default {
	url: 'http://127.0.0.1:3000/',
	iterations: 4,
	cpuThrottling: 4,
	probe: { webgl: true, loaf: true, markRequests: '/api/' },
	stubs: [{ pattern: '/api/action$', response: () => ({ ok: true }) }],
	async ready(page) {
		await page.waitFor(`document.querySelector('canvas')`);
		await page.sleep(1500);
	},
	async action(page) {
		await page.click('#go');
	},
	async waitDone(page) {
		await page.waitFor(`document.body.dataset.state === 'idle'`, { timeoutMs: 15000 });
	},
	out: 'demo-run.json',
	label: 'demo',
};
