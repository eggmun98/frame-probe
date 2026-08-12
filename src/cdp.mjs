// 최소 CDP 클라이언트 (Node 22 내장 WebSocket 사용, 의존성 없음)
export function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();
	const listeners = new Map();

	const ready = new Promise((res, rej) => {
		ws.addEventListener('open', () => res());
		ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
	});

	ws.addEventListener('message', (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(JSON.stringify(msg.error)));
			else resolve(msg.result);
			return;
		}
		if (msg.method) {
			const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
			for (const k of [key, msg.method]) {
				const ls = listeners.get(k);
				if (ls) ls.forEach((fn) => fn(msg.params, msg.sessionId));
			}
		}
	});

	const send = (method, params = {}, sessionId) =>
		ready.then(
			() =>
				new Promise((resolve, reject) => {
					const id = nextId++;
					pending.set(id, { resolve, reject });
					ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
				}),
		);

	const on = (method, fn) => {
		if (!listeners.has(method)) listeners.set(method, []);
		listeners.get(method).push(fn);
	};

	return { send, on, ready, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
