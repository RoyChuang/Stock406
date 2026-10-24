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
  const now = Math.floor(Date.now() / 1000), url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${now - years * 365 * 86400}&period2=${now}&interval=1d&events=div`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${symbol} HTTP ${r.status}`);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  // a：還原配息後的收盤價（算報酬用，除息不算下跌）
  const adj = res.indicators.adjclose?.[0]?.adjclose || [];
  const rows = res.timestamp.map((t, i) => ({ d: new Date((t + off) * 1000).toISOString().slice(0, 10), o: q.open[i], c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume?.[i] || 0, a: adj[i] ?? q.close[i] }))
    // 休市日（例如颱風假）Yahoo 會補一根成交量 0、開高低收都一樣的假 K 棒，要拿掉
    .filter(r => r.c != null && r.h != null && r.l != null && !(r.v === 0 && r.h === r.l));
  // 配息紀錄（除息日、每單位金額），殖利率用
  rows.divs = Object.values(res.events?.dividends || {}).sort((a, b) => a.date - b.date)
    .map(x => ({ d: new Date((x.date + off) * 1000).toISOString().slice(0, 10), a: x.amount }));
  return rows;
}

// 殖利率位置：年化配息 ÷ 股價。滿一年用近 12 個月配息加總；不滿一年（例如 00406A）用最近一次配息 × 一年配幾次
// 歷史區間：每天用「當天以前近 12 個月配息 ÷ 當天收盤」算殖利率，統計現在排在過去的第幾 %
function yieldInfo(rows, divs) {
  if (!divs.length) return null;
  const day = d => Date.parse(d) / 864e5, gaps = divs.slice(1).map((x, i) => day(x.d) - day(divs[i].d)).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[gaps.length >> 1] : 365, freq = gap < 45 ? 12 : gap < 120 ? 4 : gap < 240 ? 2 : 1;
  const last = rows.at(-1), full = day(last.d) - day(divs[0].d) >= 365 - gap / 2;
  // 近一年配息：除息日往前 350 天內的配息加總。用 365 天的話，今年和去年的除息日只差一兩天就會重複算一次；
  // 不能用「最近 freq 次」，因為 0056 這類 ETF 中途從年配改季配
  const ttm = t => divs.filter(x => x.d <= rows[t].d && day(rows[t].d) - day(x.d) < 350).reduce((v, x) => v + x.a, 0);
  const annual = full ? ttm(rows.length - 1) : divs.at(-1).a * freq;
  const out = { freq, full, annual: +annual.toFixed(3), cur: +(annual / last.c * 100).toFixed(2), divs: divs.slice(-8) };
  // 至少要 2 年配息紀錄，歷史區間才有意義
  if (day(last.d) - day(divs[0].d) >= 730) {
    const start = rows.findIndex(r => day(r.d) - day(divs[0].d) >= 365), ys = [];
    // 年配時期除息日晚幾天，窗口內會暫時沒有配息，那幾天跳過
    for (let t = start; t < rows.length; t++) { const v = ttm(t); if (v > 0) ys.push(v / rows[t].c * 100); }
    const sorted = [...ys].sort((a, b) => a - b), q = p => +sorted[Math.floor(p * (sorted.length - 1))].toFixed(2);
    Object.assign(out, { from: rows[start].d, p20: q(0.2), p50: q(0.5), p80: q(0.8), rank: Math.round(sorted.filter(v => v < ys.at(-1)).length / sorted.length * 100) });
  }
  return out;
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

// ---------- 分批方式比較 ----------
// 從每個月初開始一輪：同一筆錢（當作 1），6 個月（126 個交易日）內投入，看到 1 年（252 個交易日）後的結果
// 價位和止跌跡象用原始股價判斷（和看盤時一樣）；張數和報酬用還原配息的股價算（除息不算下跌）
// 依支撐的價位每天用「當天以前」的日 K 重算：上次收盤價、布林下緣、近 3 個月最低，張數 1:2:3
const PLANS = [
  ['dca', '定期定額（每月一次，6 個月）'],
  ['lad-all', '依支撐 1:2:3（6 個月沒買到的補買）'],
  ['lad-cash', '依支撐 1:2:3（沒買到的留現金）'],
  ['ladS-all', '依支撐 1:2:3＋等止跌跡象（沒買到的補買）'],
  ['ladS-cash', '依支撐 1:2:3＋等止跌跡象（沒買到的留現金）'],
];
function plans(rows) {
  const x = series(rows), n = rows.length, W = [1 / 6, 2 / 6, 3 / 6], DEP = 126, HOLD = 252;
  if (n < 60 + HOLD + 1) return null;
  const f = rows.map(r => r.a / r.c);
  const levels = t => {
    const c = x.c.slice(t - 20, t), m = c.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(c.reduce((s, v) => s + (v - m) ** 2, 0) / 20);
    return [x.c[t - 1], m - 2 * sd, Math.min(...rows.slice(t - 60, t).map(r => r.l))];
  };
  const signs = t => [x.K[t] > x.D[t] && x.K[t] < 30, x.hist[t] < 0 && Math.abs(x.hist[t]) < Math.abs(x.hist[t - 1]), x.c[t] > x.ma5[t]].filter(Boolean).length;
  const runs = Object.fromEntries(PLANS.map(([k]) => [k, []]));
  let starts = 0;
  for (let s = 60; s + HOLD < n; s += 21, starts++) {
    for (const [k] of PLANS) {
      const [plan, rest] = k.split('-');
      let cash = 1, units = 0, worst = 0, dep = 0;
      const done = [false, false, false], armed = [null, null, null];
      const buy = (t, p, amt) => { units += amt / (p * f[t]); cash -= amt; };
      for (let t = s; t <= s + HOLD; t++) {
        if (t < s + DEP) {
          if (plan === 'dca') { if ((t - s) % 21 === 0) buy(t, x.c[t], 1 / 6); }
          else {
            const L = levels(t), sg = plan === 'ladS' ? signs(t) : 0;
            L.forEach((lv, i) => {
              if (done[i]) return;
              // 掛單：當天最低價跌到價位就成交；開盤就跳空低於價位的話用開盤價成交
              if (plan === 'lad' && rows[t].l <= lv) { buy(t, Math.min(lv, rows[t].o), W[i]); done[i] = true; }
              // 等止跌：先碰到價位，之後哪天止跌跡象 ≥ 2、收盤還在價位 3% 以內，用收盤價買
              if (plan === 'ladS') {
                if (armed[i] == null && rows[t].l <= lv) armed[i] = lv;
                if (armed[i] != null && sg >= 2 && x.c[t] <= armed[i] * 1.03) { buy(t, x.c[t], W[i]); done[i] = true; }
              }
            });
          }
        } else if (t === s + DEP) {
          dep = 1 - cash;
          if (rest === 'all' && cash > 1e-9) buy(t, x.c[t], cash);
        }
        worst = Math.min(worst, cash + units * rows[t].a - 1);
      }
      runs[k].push({ cost: units ? ((1 - cash) / units / rows[s].a - 1) * 100 : null, dep: plan === 'dca' ? 1 : dep, worst: worst * 100, ret: (cash + units * rows[s + HOLD].a - 1) * 100 });
    }
  }
  const avg = a => +(a.reduce((v, b) => v + b, 0) / a.length).toFixed(2);
  return {
    starts, from: rows[60].d, to: rows[n - HOLD - 1].d,
    rows: PLANS.map(([k, label]) => {
      const r = runs[k], c = r.filter(e => e.cost != null);
      return { k, label, cost: c.length ? avg(c.map(e => e.cost)) : null, dep: Math.round(avg(r.map(e => e.dep)) * 100), worst: avg(r.map(e => e.worst)), worstMin: +Math.min(...r.map(e => e.worst)).toFixed(2),
        ret: avg(r.map(e => e.ret)), win: k === 'dca' ? null : Math.round(r.filter((e, i) => e.ret > runs.dca[i].ret).length / r.length * 100) };
    }),
  };
}

const out = { t: new Date().toISOString(), syms: [] };
for (const [s, name, years] of SYMS) {
  try {
    const rows = await daily(s, years);
    out.syms.push({ s, name, from: rows[0].d, to: rows.at(-1).d, days: rows.length, yld: yieldInfo(rows, rows.divs), plans: plans(rows), ...backtest(rows) });
    console.log('ok', s, rows.length);
  } catch (e) {
    console.error('fail', s, e.message);
  }
}
await mkdir('data', { recursive: true });
await writeFile('data/backtest.json', JSON.stringify(out));
if (process.argv.includes('--print')) for (const r of out.syms) {
  console.log(`\n${r.name} ${r.from}~${r.to}（${r.days} 天）`, JSON.stringify({ ...r.yld, divs: undefined }));
  for (const g of r.groups) console.log(`  ${g.label.padEnd(22)} n=${String(g.n).padStart(4)}  1天 ${g.r1}% 勝率 ${g.win1}%  5天 ${g.r5}% 勝率 ${g.win5}% 最差 ${g.worst5}%`);
}
