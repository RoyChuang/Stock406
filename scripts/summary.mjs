// 把 data/*.json 濃縮成幾十行文字摘要，給雲端排程的 Claude 讀（避免直接讀原始 JSON 浪費 token）
// 用法：node scripts/summary.mjs [資料夾，預設 data]
import { readFile } from 'node:fs/promises';

const dir = process.argv[2] || 'data';
const SYMBOLS = ['00406A.TW', '^TWII', '2330.TW', 'TSM', 'EWT', 'TWD=X', '^SOX', 'NVDA', '^GSPC', '^IXIC', '^VIX', '^TNX', 'NQ=F', 'ES=F'];
const file = s => `${dir}/${s.replace(/\^/g, '_')}.json`;

const ema = (a, n) => { const k = 2 / (n + 1), e = []; a.forEach((v, i) => e.push(i ? v * k + e[i - 1] * (1 - k) : v)); return e; };
const smaAt = (a, n, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
const f = (x, dp = 2) => x == null || isNaN(x) ? '-' : x.toFixed(dp);
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';

async function load(s) {
  const j = JSON.parse(await readFile(file(s), 'utf8')), r = j.chart.result[0], q = r.indicators.quote[0], off = r.meta.gmtoffset || 0;
  const rows = r.timestamp.map((t, i) => ({ d: new Date((t + off) * 1000).toISOString().slice(0, 10), h: q.high[i], l: q.low[i], c: q.close[i] }))
    .filter(x => x.c != null);
  return { meta: r.meta, rows, px: r.meta.regularMarketPrice ?? rows.at(-1).c };
}
function ind(rows) {
  const c = rows.map(r => r.c), h = rows.map(r => r.h), l = rows.map(r => r.l), N = c.length - 1;
  const dif = c.map((_, i) => ema(c, 12)[i] - ema(c, 26)[i]), dea = ema(dif, 9), hist = dif.map((v, i) => v - dea[i]);
  let ag = 0, al = 0, rsi = null;
  for (let i = 1; i <= N; i++) {
    const ch = c[i] - c[i - 1], g = Math.max(ch, 0), lo = Math.max(-ch, 0);
    if (i <= 14) { ag += g / 14; al += lo / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + lo) / 14; }
    if (i >= 14) rsi = 100 - 100 / (1 + ag / (al || 1e-9));
  }
  let K = 50, D = 50;
  for (let i = 8; i <= N; i++) {
    const hh = Math.max(...h.slice(i - 8, i + 1)), ll = Math.min(...l.slice(i - 8, i + 1));
    K = K * 2 / 3 + (hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100) / 3; D = D * 2 / 3 + K / 3;
  }
  const m20 = smaAt(c, 20, N), sd = Math.sqrt(c.slice(-20).reduce((s, v) => s + (v - m20) ** 2, 0) / 20);
  return { ma5: smaAt(c, 5, N), ma20: m20, ma60: smaAt(c, 60, N), ma120: smaAt(c, 120, N), hist: hist[N], histPrev: hist[N - 1], rsi, K, D,
    bbU: m20 + 2 * sd, bbL: m20 - 2 * sd, lo20: Math.min(...l.slice(-20)), lo60: Math.min(...l.slice(-60)) };
}

const D = {};
for (const s of SYMBOLS) { try { D[s] = await load(s); } catch (e) { console.log(`${s}: 讀取失敗 ${e.message}`); } }
try { console.log('資料抓取時間(UTC):', JSON.parse(await readFile(`${dir}/updated.json`, 'utf8')).t); } catch {}

console.log('\n標的 | 報價時間(UTC) | 現價 | 最近收盤 | MA5/MA20/MA60 | MACD柱(今/昨) | RSI | K/D | 布林上/下');
for (const s of SYMBOLS) {
  const d = D[s]; if (!d) continue;
  const x = ind(d.rows), dp = d.px > 1000 ? 0 : 2;
  console.log([s, new Date(d.meta.regularMarketTime * 1000).toISOString().slice(0, 16), f(d.px, dp),
    d.rows.slice(-5).map(r => `${r.d.slice(5)}:${f(r.c, dp)}`).join(' '),
    `${f(x.ma5, dp)}/${f(x.ma20, dp)}/${f(x.ma60, dp)}`, `${f(x.hist, 3)}/${f(x.histPrev, 3)}`, f(x.rsi, 1), `${f(x.K, 1)}/${f(x.D, 1)}`,
    `${f(x.bbU, dp)}/${f(x.bbL, dp)}`].join(' | '));
}

// 跳空估算：與 index.html 的 ewtGap / adrPremium 相同算法
const byDate = d => Object.fromEntries(d.rows.map(r => [r.d, r.c]));
const tw = D['^TWII'], e = D['EWT'], fx = D['TWD=X'], adr = D['TSM'], t2330 = D['2330.TW'], etf = D['00406A.TW'];
if (tw && e && fx) {
  const dT = tw.rows.at(-1).d, b = [...e.rows].reverse().find(r => r.d < dT), F = byDate(fx);
  const fxB = F[b.d] ?? fx.rows.filter(r => r.d <= b.d).at(-1).c;
  const ewtChg = e.px * fx.px / (b.c * fxB) - 1, twChg = tw.rows.at(-1).c / tw.rows.at(-2).c - 1, gap = (1 + ewtChg) / (1 + twChg) - 1;
  console.log(`\n[EWT 法] 台股最後交易日 ${dT}；EWT(台幣計) 自 ${b.d} 起 ${pct(ewtChg)}，加權 ${dT} 已反映 ${pct(twChg)} → 推估跳空 ${pct(gap)}，加權約 ${f(tw.rows.at(-1).c * (1 + gap), 0)}` +
    (etf ? `，00406A 約 ${f(etf.rows.at(-1).c * (1 + gap))}` : ''));
}
if (adr && fx && t2330) {
  const A = byDate(adr), F = byDate(fx);
  const hist = t2330.rows.filter(r => A[r.d] && F[r.d]).map(r => A[r.d] * F[r.d] / 5 / r.c - 1).slice(-20);
  const base = hist.reduce((a, v) => a + v, 0) / hist.length, adrTwd = adr.px * fx.px / 5, last = t2330.rows.at(-1).c;
  console.log(`[ADR 法] TSM 換算 ${f(adrTwd, 0)} 元，對 2330 收盤 ${last} 溢價 ${pct(adrTwd / last - 1)}；20 日均溢價 ${pct(base)} → 推算 2330 約 ${f(adrTwd / (1 + base), 0)}（${pct(adrTwd / (1 + base) / last - 1)}）`);
}
if (etf) {
  const x = ind(etf.rows);
  console.log(`[00406A 支撐] 近20日低 ${f(x.lo20)}、布林下軌 ${f(x.bbL)}、近60日低 ${f(x.lo60)}；壓力 MA5 ${f(x.ma5)}、MA60 ${f(x.ma60)}、MA20 ${f(x.ma20)}`);
}
