// Yahoo 的台股日 K 偶爾會整天漏掉（例如 2026-10-27 的 00406A、加權指數），但 5 分 K 還在。
// 用 5 分 K 把漏掉的日子補成一根日 K（收盤用最後一根 5 分 K，跟官方收盤可能差 0.1% 左右；
// 該日剛好是 meta 的最新交易日時改用 meta 的收盤、最高、最低）。直接改 Yahoo 原始 JSON，
// 讓 fetch-data、alert、server 讀到的格式不變。
export const needsFill = symbol => /\.TW$|^\^TWII$/.test(symbol);

export async function fillGaps(json, symbol) {
  const res = json?.chart?.result?.[0];
  if (!res?.timestamp || !needsFill(symbol)) return json;
  const off = res.meta.gmtoffset || 0, day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const q = res.indicators.quote[0];
  const have = new Set(res.timestamp.filter((_, i) => q.close[i] != null).map(day));

  let intra;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    intra = (await r.json()).chart.result[0];
  } catch { return json; }
  const iq = intra?.indicators?.quote?.[0];
  if (!iq || !intra.timestamp) return json;

  const days = {};
  intra.timestamp.forEach((t, i) => { if (iq.close[i] != null) (days[day(t)] ??= []).push(i); });
  const metaDay = res.meta.regularMarketTime ? day(res.meta.regularMarketTime) : null;
  const order = Object.keys(days).sort(), adj = res.indicators.adjclose?.[0]?.adjclose;
  for (const [d, ix] of Object.entries(days)) {
    if (have.has(d)) continue;
    const m = d === metaDay ? res.meta : {};
    // 漏掉的是最新交易日的前一天：range=1d 的 chartPreviousClose 就是那天的官方收盤（含收盤集合競價）
    let close = m.regularMarketPrice;
    if (close == null && order[order.indexOf(d) + 1] === metaDay) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        close = (await r.json()).chart.result[0].meta.chartPreviousClose;
      } catch {}
    }
    const bar = {
      open: iq.open[ix[0]],
      high: m.regularMarketDayHigh ?? Math.max(...ix.map(i => iq.high[i])),
      low: m.regularMarketDayLow ?? Math.min(...ix.map(i => iq.low[i])),
      close: close ?? iq.close[ix.at(-1)],
      volume: ix.reduce((s, i) => s + (iq.volume[i] || 0), 0),
    };
    // 日 K 若已有當天的空位（全部 null）就填進去，沒有就依時間插入
    let k = res.timestamp.findIndex(t => day(t) === d);
    if (k < 0) {
      const t = intra.timestamp[ix[0]];
      k = res.timestamp.findIndex(x => x > t);
      if (k < 0) k = res.timestamp.length;
      res.timestamp.splice(k, 0, t);
      for (const f of ['open', 'high', 'low', 'close', 'volume']) q[f].splice(k, 0, null);
      adj?.splice(k, 0, null);
    }
    for (const f of Object.keys(bar)) q[f][k] = bar[f];
    if (adj) adj[k] = bar.close;
    console.error(`fillGaps: ${symbol} 補上 ${d} 日 K（Yahoo 漏掉）`);
  }
  return json;
}
