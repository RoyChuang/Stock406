// 支撐與壓力：和 index.html 的 supRes 同一套算法（前低/前高、平均價、布林、成交最多的價位、整數關卡，相差 1% 合併）
// alert.mjs（推播）與 backtest.mjs（回測）共用
const sma = (a, n) => a.slice(-n).reduce((s, v) => s + v, 0) / n;
export function supRes(rows, p) {
  const c = rows.map(r => r.c), n = c.length, md = d => d.slice(5).replace('-', '/');
  const ma = k => n >= k ? sma(c, k) : null, m20 = ma(20);
  const sd = Math.sqrt(c.slice(-20).reduce((s, v) => s + (v - m20) ** 2, 0) / 20);
  const cand = [['月平均價', m20], ['季平均價', ma(60)], ['半年平均價', ma(120)], ['年平均價', ma(240)], ['布林下緣', m20 - 2 * sd], ['布林上緣', m20 + 2 * sd],
    ['近 1 個月最低', Math.min(...rows.slice(-20).map(r => r.l))], ['近 1 個月最高', Math.max(...rows.slice(-20).map(r => r.h))]];
  for (let i = Math.max(5, n - 250); i < n - 5; i++) {
    const w = rows.slice(i - 5, i + 6);
    if (rows[i].l <= Math.min(...w.map(r => r.l))) cand.push([`前低 ${md(rows[i].d)}`, rows[i].l]);
    if (rows[i].h >= Math.max(...w.map(r => r.h))) cand.push([`前高 ${md(rows[i].d)}`, rows[i].h]);
  }
  const vr = rows.slice(-60), lo = Math.min(...vr.map(r => r.l)), hi = Math.max(...vr.map(r => r.h)), bin = Array(20).fill(0);
  if (hi > lo) {
    vr.forEach(r => bin[Math.min(19, Math.floor(((r.h + r.l + r.c) / 3 - lo) / (hi - lo) * 20))] += r.v || 0);
    const k = bin.indexOf(Math.max(...bin));
    if (bin[k] > 0) cand.push(['近 3 個月成交最多', lo + (k + 0.5) * (hi - lo) / 20]);
  }
  const step = [[10, 0.5], [50, 1], [100, 5], [500, 10], [1000, 50], [5000, 100], [Infinity, 1000]].find(([m]) => p < m)[1];
  cand.push(['整數關卡', Math.floor(p / step) * step], ['整數關卡', Math.ceil(p / step) * step]);
  const G = [];
  for (const [k, v] of cand.filter(([, v]) => v != null && Math.abs(v / p - 1) < 0.15).sort((a, b) => b[1] - a[1])) {
    const g = G.at(-1);
    if (g && (g.ref - v) / g.ref < 0.01) { g.vs.push(v); g.ks.push(k); } else G.push({ ref: v, vs: [v], ks: [k] });
  }
  const out = G.map(g => {
    const lows = g.ks.filter(k => k.startsWith('前低')), highs = g.ks.filter(k => k.startsWith('前高'));
    const ks = [...new Set(g.ks.filter(k => !/^前[低高]/.test(k)))];
    if (lows.length) ks.unshift(`${g.ref > p ? '跌破的前低' : '前低'} ${lows.slice(-2).map(k => k.slice(3)).join('、')}${lows.length > 2 ? ` 等 ${lows.length} 次` : ''}`);
    if (highs.length) ks.unshift(`${g.ref < p ? '突破的前高' : '前高'} ${highs.slice(-2).map(k => k.slice(3)).join('、')}${highs.length > 2 ? ` 等 ${highs.length} 次` : ''}`);
    return { p: g.vs.reduce((a, b) => a + b, 0) / g.vs.length, ks, n: g.ks.length };
  });
  return { sup: out.filter(g => g.p < p * 0.998).slice(0, 3), res: out.filter(g => g.p > p * 1.002).reverse().slice(0, 2) };
}
