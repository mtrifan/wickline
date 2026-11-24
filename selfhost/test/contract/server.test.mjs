// Contract: upstream server.mjs as the self-hosted entrypoint uses it (wrap, don't modify).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { importUpstream, readUpstream, point } from './helpers.mjs';

const { startServer } = await importUpstream('server.mjs');
const started = [];
after(() => { for (const s of started) { s.closeAllConnections?.(); s.close(); } });

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  started.push(server);
  return server.address().port;
}

test('startServer resolves {server, port} with exactly one request listener', async () => {
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  started.push(server);
  assert.ok(server instanceof http.Server, point('server-start'));
  assert.equal(typeof port, 'number', point('server-start'));
  assert.equal(server.listeners('request').length, 1, `${point('server-start')} the selfhost wrapper captures the single request listener`);
});

test('the captured listener can serve requests from another http.Server (delegation)', async () => {
  const { server } = await startServer({ port: 0, host: '127.0.0.1' });
  started.push(server);
  const [upstreamHandler] = server.listeners('request');
  const front = http.createServer((req, res) => upstreamHandler(req, res));
  const port = await listen(front);

  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(r.status, 200, point('server-health'));
  const body = await r.json();
  assert.equal(body.app, 'wickline', point('server-health'));
  assert.ok('version' in body, point('server-health'));

  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(html.status, 200, point('server-start'));
});

test('non-GET requests are refused with 405 before routing', async () => {
  const { port } = await startServer({ port: 0, host: '127.0.0.1' }).then((s) => { started.push(s.server); return s; });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { method });
    assert.equal(r.status, 405, `${point('server-methods')} ${method}`);
  }
});

test('CORS * is set through writeHead, not setHeader', async () => {
  const { server } = await startServer({ port: 0, host: '127.0.0.1' });
  started.push(server);
  const [upstreamHandler] = server.listeners('request');
  const seen = { setHeader: [], writeHead: [] };
  const front = http.createServer((req, res) => {
    const setHeader = res.setHeader.bind(res);
    const writeHead = res.writeHead.bind(res);
    res.setHeader = (name, value) => { seen.setHeader.push(String(name).toLowerCase()); return setHeader(name, value); };
    res.writeHead = (...args) => {
      const headers = args.find((a) => a && typeof a === 'object') || {};
      const names = Array.isArray(headers) ? headers.filter((_, i) => i % 2 === 0) : Object.keys(headers);
      seen.writeHead.push(...names.map((n) => String(n).toLowerCase()));
      return writeHead(...args);
    };
    upstreamHandler(req, res);
  });
  const port = await listen(front);
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  await r.arrayBuffer();
  assert.equal(r.headers.get('access-control-allow-origin'), '*', point('server-cors'));
  assert.ok(seen.writeHead.includes('access-control-allow-origin'), `${point('server-cors')} ACAO must arrive via writeHead`);
  assert.ok(!seen.setHeader.includes('access-control-allow-origin'), `${point('server-cors')} ACAO via setHeader would need a different strip`);
});

test('Yahoo stream: SSE, at most 100 symbols, ticks carry the session flag m', () => {
  const src = readUpstream('server.mjs');
  const handler = src.slice(src.indexOf('function handleStream'), src.indexOf('function handleStream') + 1200);
  assert.match(handler, /text\/event-stream/, point('yahoo-stream'));
  assert.match(handler, /\.slice\(0,\s*100\)/, `${point('yahoo-stream')} the server adapter shards Yahoo symbols by this cap`);
  assert.match(handler, /data: \$\{JSON\.stringify\(tick\)\}/, point('yahoo-stream'));
  assert.match(src, /\bm:\s*f\[7\] != null \? Number\(f\[7\]\) : 0/, `${point('yahoo-stream')} tick.m (session flag)`);
});

test('lib/proxy.mjs exports envProxy and setServerProxy', async () => {
  const proxy = await importUpstream('lib/proxy.mjs');
  assert.equal(typeof proxy.envProxy, 'function', point('proxy-api'));
  assert.equal(typeof proxy.setServerProxy, 'function', point('proxy-api'));
});
