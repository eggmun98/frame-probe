// Tiny static server for the demo page. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.PORT ?? 3000);

http
	.createServer((req, res) => {
		if (req.url.startsWith('/api/')) {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end('{"ok":true}');
		}
		const file = path.join(HERE, 'index.html');
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(fs.readFileSync(file));
	})
	.listen(port, () => console.log(`demo on http://127.0.0.1:${port}/`));
