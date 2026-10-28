// 本機儀表板伺服器：提供 index.html，並代理 Yahoo Finance 日線資料（避開瀏覽器 CORS）
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4060;
const CACHE_MS = 30 * 1000;
const cache = new Map();

async function fetchChart(symbol, range, interval) {
  const key = `${symbol}|${range}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.body;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  let body = await r.text();
  if (interval === '1d') {
    const { fillGaps, needsFill } = await import('./scripts/fill-gaps.mjs');
    if (needsFill(symbol)) body = JSON.stringify(await fillGaps(JSON.parse(body), symbol));
  }
  cache.set(key, { t: Date.now(), body });
  return body;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === '/api/chart') {
    const symbol = u.searchParams.get('symbol');
    if (!symbol || !/^[\w.^=-]{1,20}$/.test(symbol)) {
      res.writeHead(400).end('bad symbol');
      return;
    }
    try {
      const body = await fetchChart(symbol, u.searchParams.get('range') || '1y', u.searchParams.get('interval') || '1d');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  const full = path.join(__dirname, path.normalize(file));
  if (!full.startsWith(__dirname) || !fs.existsSync(full)) {
    res.writeHead(404).end('not found');
    return;
  }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(full)] || 'text/plain';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => console.log(`Stock406 dashboard: http://localhost:${PORT}`));
