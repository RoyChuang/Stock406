// GitHub Actions 定時執行：抓 Yahoo Finance 日線存成 data/*.json，供 GitHub Pages 靜態版讀取
import { mkdir, writeFile } from 'node:fs/promises';

const SYMBOLS = ['00406A.TW', '^TWII', '2330.TW', '^GSPC', '^IXIC', '^SOX', '^VIX'];
export const fileName = s => s.replace(/\^/g, '_') + '.json';

await mkdir('data', { recursive: true });
let failed = 0;
for (const s of SYMBOLS) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1y&interval=1d&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.chart?.result?.[0]) throw new Error('empty result');
    await writeFile(`data/${fileName(s)}`, JSON.stringify(j));
    console.log('ok', s);
  } catch (e) {
    failed++;
    console.error('fail', s, e.message);
  }
}
await writeFile('data/updated.json', JSON.stringify({ t: new Date().toISOString() }));
if (failed === SYMBOLS.length) process.exit(1);
