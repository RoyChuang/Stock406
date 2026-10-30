// 00406A 全部成分股與各股漲跌
// - 來源：MoneyDJ「全部持股」頁（主動式 ETF 幾乎每個交易日更新，含持有股數）；抓不到或解析失敗時退回 Yahoo 奇摩股市持股頁（只有前 10 大、每月更新）
// - 直接執行：更新 data/holdings.json（pages.yml 先從 data 分支還原舊檔，保留歷次持股名單，用來比較新進／移出／張數與權重變化）
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const MONEYDJ = 'https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00406A.TW';

async function text(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const cs = /charset=([\w-]+)/i.exec(r.headers.get('content-type') || '')?.[1] || 'utf-8';
  let s = new TextDecoder(cs).decode(buf);
  // 沒在 header 宣告 big5、但頁面 meta 宣告的情況
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(s)?.[1];
  if (meta && meta.toLowerCase() !== cs.toLowerCase()) s = new TextDecoder(meta).decode(buf);
  return s;
}
const clean = h => h.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = s => +String(s).replace(/,/g, '');

// MoneyDJ：每列「個股名稱(代號.TW) | 投資比例(%) | 持有股數」；期貨等沒有股票代號的列另外記
async function fromMoneyDJ() {
  const html = await text(MONEYDJ);
  const date = /資料日期\s*[:：]\s*(\d{4})\/(\d{2})\/(\d{2})/.exec(clean(html));
  if (!date) throw new Error('找不到資料日期');
  const list = [], other = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(m[1]));
    if (cells.length < 3) continue;
    const w = num(cells[1]), s = num(cells[2]);
    if (!isFinite(w) || !isFinite(s)) continue;
    const m = /^(.+?)\((\d{4,6}[A-Z]?)\.TWO?\)$/.exec(cells[0]);
    if (m) list.push({ code: m[2], name: m[1], w, s });
    else other.push({ name: cells[0], w, s });
  }
  if (list.length < 10) throw new Error(`只解析到 ${list.length} 檔`);
  return { src: 'moneydj', date: `${date[1]}-${date[2]}-${date[3]}`, list, other };
}

// Yahoo 奇摩：只有前 10 大
async function fromYahooTW() {
  const m = (await text('https://tw.stock.yahoo.com/quote/00406A.TW/holding')).match(/"holdingDetail":(\[.*?\])/);
  if (!m) throw new Error('持股頁找不到 holdingDetail');
  const h = JSON.parse(m[1]);
  return { src: 'yahoo-tw', date: h[0].date.replace(/\//g, '-'), list: h.map(x => ({ code: x.ticker.replace(/\.TWO?$/, ''), ticker: x.ticker, name: x.name, w: +x.weighting })), other: [] };
}

export async function fetchHoldings() {
  try { return await fromMoneyDJ(); } catch (e) { console.error('MoneyDJ 失敗，改用 Yahoo 奇摩前 10 大：', e.message); }
  return fromYahooTW();
}

// 現價與今天、近 5 天、近 20 天的漲跌（%）；今天用 5 分 K 的 meta（chartPreviousClose 是官方的上次收盤）
async function quote(sym) {
  const get = async q => {
    const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?${q}`, { headers: UA })).json();
    if (!j.chart?.result?.[0]) throw new Error(j.chart?.error?.description || 'no data');
    return j.chart.result[0];
  };
  const [now, day] = await Promise.all([get('interval=5m&range=1d'), get('interval=1d&range=3mo')]);
  const m = now.meta, q = day.indicators.quote[0];
  // 濾掉休市日成交量 0 的假 K 棒；最後一根如果是今天就拿掉，改用即時價
  const today = new Date((m.regularMarketTime + m.gmtoffset) * 1000).toISOString().slice(0, 10);
  const c = day.timestamp.map((t, i) => ({ d: new Date((t + m.gmtoffset) * 1000).toISOString().slice(0, 10), c: q.close[i], v: q.volume[i], h: q.high[i], l: q.low[i] }))
    .filter(x => x.c != null && !(x.v === 0 && x.h === x.l) && x.d < today).map(x => x.c);
  const px = m.regularMarketPrice, pct = b => b ? +((px / b - 1) * 100).toFixed(2) : null;
  return { px, d1: pct(m.chartPreviousClose), d5: pct(c.at(-5)), d20: pct(c.at(-20)), t: new Date(m.regularMarketTime * 1000).toISOString() };
}
// MoneyDJ 上櫃股票也標 .TW，Yahoo 要用 .TWO：先試上次用過的，再試另一個
async function quoteCode(x, known) {
  const tries = x.ticker ? [x.ticker] : known.has(x.code) ? [known.get(x.code)] : [];
  for (const t of [`${x.code}.TW`, `${x.code}.TWO`]) if (!tries.includes(t)) tries.push(t);
  let err;
  for (const t of tries) { try { return { ticker: t, ...await quote(t) }; } catch (e) { err = e; } }
  throw err;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

if (process.argv[1]?.endsWith('holdings.mjs')) {
  let old = {};
  try { old = JSON.parse(await readFile('data/holdings.json', 'utf8')); } catch {}
  const h = await fetchHoldings();
  // 上次查到的 Yahoo 代號（.TW / .TWO），省掉試錯
  const known = new Map((old.list || []).filter(x => x.ticker).map(x => [x.ticker.replace(/\.TWO?$/, ''), x.ticker]));
  const list = await pool(h.list, 6, async x => {
    try { return { ...x, ...await quoteCode(x, known) }; } catch (e) { console.error(x.code, x.name, e.message); return { ...x, ticker: x.ticker || known.get(x.code) || `${x.code}.TW` }; }
  });
  let etf = null;
  try { etf = await quote('00406A.TW'); } catch (e) { console.error('00406A', e.message); }
  // 歷次持股名單（依持股日期、同一來源），只留最近 30 次；舊的 Yahoo 奇摩前 10 大名單沒有 src
  const snap = { date: h.date, src: h.src, list: list.map(({ ticker, name, w, s }) => ({ ticker, name, w, ...(s != null && { s }) })) };
  const hist = (old.hist || []).filter(x => !(x.date === h.date && (x.src || 'yahoo-tw') === h.src)).concat([snap])
    .sort((a, b) => a.date.localeCompare(b.date) || (a.src || '').localeCompare(b.src || '')).slice(-30);
  await mkdir('data', { recursive: true });
  await writeFile('data/holdings.json', JSON.stringify({ t: new Date().toISOString(), date: h.date, src: h.src, etf, list, other: h.other, hist }));
  const ok = list.filter(x => x.d1 != null), w = ok.reduce((s, x) => s + x.w, 0), c = ok.reduce((s, x) => s + x.w * x.d1 / 100, 0);
  console.log(`持股 ${h.date}（${h.src}）${list.length} 檔，有報價 ${ok.length} 檔合計 ${w.toFixed(1)}%，今天合計影響 ${c >= 0 ? '+' : ''}${c.toFixed(2)} 個百分點`);
}
