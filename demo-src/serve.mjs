// Local preview server that behaves like Cloudflare Pages for this site: applies site/_headers (splats, comma-joined
// repeats, "! Name" removals), serves directory index.html, redirects /dir to /dir/, and falls back to 404.html.
// usage: node demo-src/serve.mjs [port]   (binds to 127.0.0.1 only)
import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = new URL('../site/', import.meta.url).pathname;
const port = Number(process.argv[2] || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

const rules = [];
for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) { rules.push({ pattern: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), ops: [] }); continue; }
  const t = line.trim();
  if (t.startsWith('!')) rules.at(-1).ops.push({ remove: t.slice(1).trim().toLowerCase() });
  else { const i = t.indexOf(':'); rules.at(-1).ops.push({ name: t.slice(0, i).trim(), value: t.slice(i + 1).trim() }); }
}
function headersFor(path) {
  const out = new Map();
  for (const rule of rules.filter((r) => r.pattern.test(path))) {
    for (const op of rule.ops) {
      if (op.remove) { out.delete(op.remove); continue; }
      const key = op.name.toLowerCase(), prev = out.get(key);
      out.set(key, { name: op.name, value: prev ? `${prev.value}, ${op.value}` : op.value });
    }
  }
  return [...out.values()];
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(400).end(); return; }
  let status = 200, stat = null;
  try { stat = statSync(file); } catch { /* missing */ }
  if (stat?.isDirectory()) {
    if (!path.endsWith('/')) { res.writeHead(308, { Location: path + '/' }).end(); return; }
    file = join(file, 'index.html');
    try { stat = statSync(file); } catch { stat = null; }
  }
  if (!stat || path.split('/').some((p) => p.startsWith('_'))) { status = 404; file = join(root, '404.html'); }
  const headers = { 'Content-Type': types[extname(file)] || 'application/octet-stream' };
  for (const h of headersFor(path)) headers[h.name] = h.value;
  res.writeHead(status, headers);
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
