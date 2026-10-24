// 回測「到支撐＋止跌跡象」之後 1、5 個交易日的漲跌，結果存成 data/backtest.json 給儀表板讀
// 每一天只用「那天以前」的資料判斷（支撐用前一天以前的日 K 算，止跌跡象用當天收盤），以當天收盤價為進場價
// 同一組訊號 5 個交易日內只算第一次，避免連續幾天都碰到同一個支撐被重複計算
import { mkdir, writeFile } from 'node:fs/promises';
import { supRes } from './sr.mjs';

const SYMS = [
  ['00406A.TW', '00406A', 10],
  ['^TWII', '加權指數', 10],
  ['0056.TW', '0056 元大高股息（類似的高股息 ETF）', 10],
  ['00878.TW', '00878 國泰永續高股息（類似的高股息 ETF）', 10],
];
const GROUPS = [
  ['all', '所有交易日（對照組）'],
  ['sup', '碰到支撐'],
  ['sup2', '碰到支撐＋止跌跡象 ≥ 2'],
  ['sup0', '碰到支撐＋止跌跡象 0（還在跌）'],
  ['stop2', '止跌跡象 ≥ 2（不管支撐）'],
];

// 用起訖時間指定日 K；range=max 會被 Yahoo 自動改成週 K 或月 K
async function daily(symbol, years) {
  const now = Math.floor(Date.now() / 1000), url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${now - years * 365 * 86400}&period2=${now}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${symbol} HTTP ${r.status}`);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  return res.timestamp.map((t, i) => ({ d: new Date((t + off) * 1000).toISOString().slice(0, 10), c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume?.[i] || 0 }))
    // 休市日（例如颱風假）Yahoo 會補一根成交量 0、開高低收都一樣的假 K 棒，要拿掉
    .filter(r => r.c != null && r.h != null && r.l != null && !(r.v === 0 && r.h === r.l));
}

// 整段的指標序列（和儀表板、推播同參數：KD 9 日、MACD 12/26/9、5 日平均）
function series(rows) {
  const c = rows.map(r => r.c), n = c.length;
  const ema = k => { const a = 2 / (k + 1), e = []; c.forEach((v, i) => e.push(i ? v * a + e[i - 1] * (1 - a) : v)); return e; };
  const e12 = ema(12), e26 = ema(26), dif = c.map((_, i) => e12[i] - e26[i]), dea = [];
  dif.forEach((v, i) => dea.push(i ? v * 0.2 + dea[i - 1] * 0.8 : v));
  const hist = dif.map((v, i) => v - dea[i]), K = Array(n).fill(50), D = Array(n).fill(50), ma5 = Array(n).fill(null);
  for (let i = 8; i < n; i++) {
    const w = rows.slice(i - 8, i + 1), hh = Math.max(...w.map(r => r.h)), ll = Math.min(...w.map(r => r.l));
    K[i] = K[i - 1] * 2 / 3 + (hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100) / 3;
    D[i] = D[i - 1] * 2 / 3 + K[i] / 3;
  }
  for (let i = 4; i < n; i++) ma5[i] = c.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
  return { c, K, D, hist, ma5 };
}

function backtest(rows) {
  const x = series(rows), n = rows.length, ev = Object.fromEntries(GROUPS.map(([k]) => [k, []])), last = {};
  for (let t = 30; t < n - 1; t++) {
    const signs = [x.K[t] > x.D[t] && x.K[t] < 30, x.hist[t] < 0 && Math.abs(x.hist[t]) < Math.abs(x.hist[t - 1]), x.c[t] > x.ma5[t]].filter(Boolean).length;
    const { sup } = supRes(rows.slice(0, t), x.c[t - 1]);
    // 碰到支撐：當天最低價跌到支撐上方 1% 以內，而且收盤沒有跌破支撐 2% 以上（跌太深算跌破，不算碰到）
    const hit = sup.find(s => rows[t].l <= s.p * 1.01 && x.c[t] >= s.p * 0.98);
    const r1 = (x.c[t + 1] / x.c[t] - 1) * 100, r5 = t + 5 < n ? (x.c[t + 5] / x.c[t] - 1) * 100 : null;
    const e = { d: rows[t].d, c: +x.c[t].toFixed(2), signs, sup: hit ? +hit.p.toFixed(2) : null, r1: +r1.toFixed(2), r5: r5 == null ? null : +r5.toFixed(2) };
    const add = k => { if (k !== 'all' && last[k] != null && t - last[k] < 5) return; last[k] = t; ev[k].push(e); };
    add('all');
    if (hit) { add('sup'); if (signs >= 2) add('sup2'); if (signs === 0) add('sup0'); }
    if (signs >= 2) add('stop2');
  }
  const stat = es => {
    const a = es.filter(e => e.r5 != null), avg = (k, s = es) => s.length ? +(s.reduce((v, e) => v + e[k], 0) / s.length).toFixed(2) : null;
    return { n: es.length, r1: avg('r1'), r5: avg('r5', a), win1: es.length ? Math.round(es.filter(e => e.r1 > 0).length / es.length * 100) : null,
      win5: a.length ? Math.round(a.filter(e => e.r5 > 0).length / a.length * 100) : null, worst5: a.length ? Math.min(...a.map(e => e.r5)) : null };
  };
  return { groups: GROUPS.map(([k, label]) => ({ k, label, ...stat(ev[k]) })), recent: [...ev.sup].reverse().slice(0, 8) };
}

const out = { t: new Date().toISOString(), syms: [] };
for (const [s, name, years] of SYMS) {
  try {
    const rows = await daily(s, years);
    out.syms.push({ s, name, from: rows[0].d, to: rows.at(-1).d, days: rows.length, ...backtest(rows) });
    console.log('ok', s, rows.length);
  } catch (e) {
    console.error('fail', s, e.message);
  }
}
await mkdir('data', { recursive: true });
await writeFile('data/backtest.json', JSON.stringify(out));
if (process.argv.includes('--print')) for (const r of out.syms) {
  console.log(`\n${r.name} ${r.from}~${r.to}（${r.days} 天）`);
  for (const g of r.groups) console.log(`  ${g.label.padEnd(22)} n=${String(g.n).padStart(4)}  1天 ${g.r1}% 勝率 ${g.win1}%  5天 ${g.r5}% 勝率 ${g.win5}% 最差 ${g.worst5}%`);
}
