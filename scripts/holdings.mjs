// 00406A 前 10 大成分股（Yahoo 奇摩股市持股頁，投信每月更新一次）與各股漲跌
// - 直接執行：更新 data/holdings.json（pages.yml 先從 data 分支還原舊檔，保留歷次持股名單，用來比較新增／移除／權重變化）
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const UA = { 'User-Agent': 'Mozilla/5.0' };

// 回傳 { date: 'YYYY-MM-DD', list: [{ ticker, name, w }] }
export async function fetchHoldings() {
  const r = await fetch('https://tw.stock.yahoo.com/quote/00406A.TW/holding', { headers: UA });
  if (!r.ok) throw new Error(`Yahoo 奇摩 HTTP ${r.status}`);
  const m = (await r.text()).match(/"holdingDetail":(\[.*?\])/);
  if (!m) throw new Error('持股頁找不到 holdingDetail');
  const h = JSON.parse(m[1]);
  return { date: h[0].date.replace(/\//g, '-'), list: h.map(x => ({ ticker: x.ticker, name: x.name, w: +x.weighting })) };
}

// 現價與今天、近 5 天、近 20 天的漲跌（%）；今天用 5 分 K 的 meta（chartPreviousClose 是官方的上次收盤）
async function quote(sym) {
  const get = async q => (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?${q}`, { headers: UA })).json()).chart.result[0];
  const [now, day] = await Promise.all([get('interval=5m&range=1d'), get('interval=1d&range=3mo')]);
  const m = now.meta, q = day.indicators.quote[0];
  // 濾掉休市日成交量 0 的假 K 棒；最後一根如果是今天就拿掉，改用即時價
  const today = new Date((m.regularMarketTime + m.gmtoffset) * 1000).toISOString().slice(0, 10);
  const c = day.timestamp.map((t, i) => ({ d: new Date((t + m.gmtoffset) * 1000).toISOString().slice(0, 10), c: q.close[i], v: q.volume[i], h: q.high[i], l: q.low[i] }))
    .filter(x => x.c != null && !(x.v === 0 && x.h === x.l) && x.d < today).map(x => x.c);
  const px = m.regularMarketPrice, pct = b => b ? +((px / b - 1) * 100).toFixed(2) : null;
  return { px, d1: pct(m.chartPreviousClose), d5: pct(c.at(-5)), d20: pct(c.at(-20)), t: new Date(m.regularMarketTime * 1000).toISOString() };
}

if (process.argv[1]?.endsWith('holdings.mjs')) {
  let old = {};
  try { old = JSON.parse(await readFile('data/holdings.json', 'utf8')); } catch {}
  const h = await fetchHoldings();
  // 歷次持股名單（依持股日期），只留最近 12 次
  const hist = (old.hist || []).filter(x => x.date !== h.date).concat([{ date: h.date, list: h.list }]).sort((a, b) => a.date.localeCompare(b.date)).slice(-12);
  const list = [];
  for (const x of h.list) {
    try { list.push({ ...x, ...await quote(x.ticker) }); } catch (e) { list.push(x); console.error(x.ticker, e.message); }
  }
  let etf = null;
  try { etf = await quote('00406A.TW'); } catch (e) { console.error('00406A', e.message); }
  await mkdir('data', { recursive: true });
  await writeFile('data/holdings.json', JSON.stringify({ t: new Date().toISOString(), date: h.date, etf, list, hist }));
  const ok = list.filter(x => x.d1 != null), w = ok.reduce((s, x) => s + x.w, 0), c = ok.reduce((s, x) => s + x.w * x.d1 / 100, 0);
  console.log(`持股 ${h.date}，前 10 大 ${w.toFixed(1)}%，今天合計影響 ${c >= 0 ? '+' : ''}${c.toFixed(2)} 個百分點`);
}
