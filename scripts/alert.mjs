// 台股訊號推播（ntfy），由 GitHub Actions 執行：
//   MODE=intraday（預設）盤中每 5 分鐘：依使用者的分批規則（B 止跌確認 + C 環境過濾）判斷是否符合，
//                         另有跌破支撐、大漲大跌、急殺急拉，以及每小時摘要
//   MODE=premarket        每個交易日 08:30：用美股收盤推估開盤跳空，對照分批價位與訊號清單
// 推播分級（ntfy priority）：4–5 會震動，只用在「符合規則」「急殺」「轉弱警示」；2 不震動，用於資訊與摘要
// 環境變數：
//   NTFY_TOPIC    ntfy 主題（放 GitHub Secret，不要寫進公開 repo）；未設定時只印出不推播
//   ALERT_CONFIG  JSON，覆蓋下方 DEFAULTS，例如 {"ladder":["prev","bbL","lo60"]}（放 Secret）
//   STATE_FILE    盤中已推播紀錄，避免同一訊號一天重複推（預設 alert-state.json）
//   FORCE=1       忽略交易時段與休市檢查（測試用）；ALERT_PREFIX 會加在標題前
import { readFile, writeFile } from 'node:fs/promises';

const DEFAULTS = {
  // 00406A 分批價位。每一項可以是固定價格，或每次用最新日 K 計算的動態價位：
  //   "prev" 昨收、"bbL" 布林下軌、"lo20" 近 20 日低、"lo60" 近 60 日低、"pct-3" 昨收 -3%
  // 相差不到 0.5% 的價位視為同一批
  ladder: ['prev', 'bbL', 'lo60'],
  twDownPct: -1.5,     // 加權當日跌幅達到時提醒
  twUpPct: 1.5,        // 加權當日漲幅達到時提醒
  fastPct: 0.7,        // 加權 15 分鐘內急殺 / 急拉幅度
  etfDownPct: -2,      // 00406A 當日跌幅
  // 使用者的分批規則（2026-10-23 定）：每一批都要 B 且 C
  //   B 止跌確認：00406A 當日低點已經 confirmMin 分鐘沒有被跌破，或現價站上 VWAP
  //   C 環境過濾：5 項環境條件中至少 cMin 項符合
  confirmMin: 15,
  cMin: 3,
};
const cfg = { ...DEFAULTS, ...JSON.parse(process.env.ALERT_CONFIG || '{}') };
const MODE = process.env.MODE || 'intraday', FORCE = !!process.env.FORCE;
const TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = process.env.STATE_FILE || 'alert-state.json';

async function chart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${symbol} HTTP ${r.status}`);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  const rows = (res.timestamp || []).map((t, i) => ({ t, d: new Date((t + off) * 1000).toISOString().slice(0, 10), c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume?.[i] || 0 }))
    .filter(r => r.c != null);
  return { meta: res.meta, rows, px: res.meta.regularMarketPrice ?? rows.at(-1)?.c };
}
const sma = (a, n) => a.slice(-n).reduce((s, v) => s + v, 0) / n;
const ema = (a, n) => { const k = 2 / (n + 1), e = []; a.forEach((v, i) => e.push(i ? v * k + e[i - 1] * (1 - k) : v)); return e; };
const pct = x => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
const byDate = d => Object.fromEntries(d.rows.map(r => [r.d, r.c]));

// 用一段日 K（只含已收盤的日子）算出分批與訊號需要的指標
function levels(rows) {
  const c = rows.map(r => r.c), prev = +c.at(-1).toFixed(2), ma20 = sma(c, 20);
  const sd = Math.sqrt(c.slice(-20).reduce((s, v) => s + (v - ma20) ** 2, 0) / 20);
  const dif = c.map((_, i) => ema(c, 12)[i] - ema(c, 26)[i]), dea = ema(dif, 9), hist = dif.map((v, i) => v - dea[i]);
  let K = 50, D = 50, Kp = 50, Dp = 50;
  for (let i = 8; i < rows.length; i++) {
    const w = rows.slice(i - 8, i + 1), hh = Math.max(...w.map(r => r.h)), ll = Math.min(...w.map(r => r.l));
    Kp = K; Dp = D; K = K * 2 / 3 + (hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100) / 3; D = D * 2 / 3 + K / 3;
  }
  // 借自 daily_stock_analysis 策略的價量指標：MA5/MA10 交叉、量比、量能冷熱
  const v = rows.map(r => r.v), ma5At = k => sma(c.slice(0, c.length - k), 5), ma10At = k => sma(c.slice(0, c.length - k), 10);
  const above = [3, 2, 1, 0].map(k => ma5At(k) > ma10At(k));
  const cross = above.slice(1).some((a, i) => a && !above[i]) && above[3] ? 'golden' : above.slice(1).some((a, i) => !a && above[i]) && !above[3] ? 'dead' : null;
  return { prev, ma5: sma(c, 5), ma10: sma(c, 10), ma20, ma120: c.length >= 120 ? sma(c, 120) : null, bbL: ma20 - 2 * sd,
    cross, vLast: v.at(-1), v5: sma(v.slice(0, -1), 5), heat: sma(v, 5) / sma(v, 60),
    lo20: Math.min(...rows.slice(-20).map(r => r.l)), lo60: Math.min(...rows.slice(-60).map(r => r.l)),
    hist: hist.at(-1), histPrev: hist.at(-2), K, D, Kp, Dp };
}
function ladderOf(L) {
  const DYN = { prev: [L.prev, '昨收'], bbL: [L.bbL, '布林下軌'], lo20: [L.lo20, '近 20 日低'], lo60: [L.lo60, '近 60 日低'] };
  const out = [];
  for (const x of cfg.ladder) {
    let lv;
    if (typeof x === 'number') lv = { p: x, label: '' };
    else if (DYN[x]) lv = { p: +DYN[x][0].toFixed(2), label: DYN[x][1] };
    else {
      const m = /^pct(-?\d+(?:\.\d+)?)$/.exec(x);
      if (!m) throw new Error(`ALERT_CONFIG ladder 看不懂：${x}`);
      lv = { p: +(L.prev * (1 + m[1] / 100)).toFixed(2), label: `昨收 ${m[1]}%` };
    }
    if (!out.some(o => Math.abs(o.p - lv.p) / o.p < 0.005)) out.push(lv);
  }
  return out;
}
// 策略指標一行摘要（只當資訊）：price 為現價，volRatio 為量比（盤中是當日累計量對前 5 日均量）
function strategyLine(L, price, volRatio, volNote = '') {
  const bias = (price / L.ma5 - 1) * 100;
  const heat = L.heat < 0.5 ? '冷清' : L.heat < 1.5 ? '正常' : L.heat < 3 ? '偏熱' : '過熱';
  const cross = L.cross === 'golden' ? '近 3 日黃金交叉' : L.cross === 'dead' ? '近 3 日死亡交叉' : L.ma5 > L.ma10 ? '在上' : '在下，未交叉';
  return [
    `策略指標：MA5 乖離 ${pct(bias)}（${Math.abs(bias) < 5 ? '<5% 未追高' : '≥5% 偏離大'}）`,
    `量比 ${volRatio.toFixed(2)}${volNote}｜量能冷熱：近 5 日均量為 60 日的 ${L.heat.toFixed(1)} 倍（${heat}）`,
    `MA5 ${L.ma5.toFixed(2)} / MA10 ${L.ma10.toFixed(2)}：MA5 ${cross}`,
  ].join('\n');
}
const fmtLadder = ladder => ladder.map((l, i) => `第${i + 1}批 ${l.p}${l.label ? `(${l.label})` : ''}`).join('、');

// 證交所 MIS 的 ETF 盤中預估淨值（約 15 秒更新）：e 市價、f 預估淨值、g 折溢價 %、j 時間
async function inav(code) {
  try {
    const j = await (await fetch('https://mis.twse.com.tw/stock/data/all_etf.txt', { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
    const m = j.a1.flatMap(g => g.msgArray || []).find(x => x.a === code);
    return m && { px: +m.e, nav: +m.f, prem: +m.g, time: m.j, date: m.i };
  } catch (e) { console.log('預估淨值讀取失敗', e.message); return null; }
}

async function push(title, message, priority, tags) {
  console.log(`推播：${title}\n${message}\n`);
  if (!TOPIC) return true;
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TOPIC, title: (process.env.ALERT_PREFIX || '') + title, message, priority, tags,
      // 不設 click：點通知會在 ntfy App 內展開全文；儀表板改成按鈕
      actions: [{ action: 'view', label: '儀表板', url: 'https://roychuang.github.io/Stock406/', clear: false }] }),
  });
  if (!r.ok) console.error('推播失敗', r.status, await r.text());
  return r.ok;
}

const tpe = new Date(Date.now() + 8 * 3600e3), hm = tpe.getUTCHours() * 100 + tpe.getUTCMinutes(), today = tpe.toISOString().slice(0, 10);
const clock = tpe.toISOString().slice(11, 16) + ' 台北時間';

// 證交所休市日（颱風等臨時休市不在表上，盤中模式另外用「今天有沒有盤中資料」判斷）
async function isHoliday() {
  try {
    const j = await (await fetch('https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json')).json();
    return j.data.some(([d, name]) => d === today && !/交易/.test(name));
  } catch { return false; }
}

if (MODE === 'premarket') await premarket();
else await intraday();

async function premarket() {
  if (!FORCE && await isHoliday()) { console.log('今天休市，略過'); return; }
  const [tw, etf, t2330, adr, ewt, fx, vix, sox] = await Promise.all(
    ['^TWII', '00406A.TW', '2330.TW', 'TSM', 'EWT', 'TWD=X', '^VIX', '^SOX'].map(s => chart(s, '1y', '1d')));
  const nav = await inav('00406A');
  // 台股最後一個收盤日 dT；盤前只看 dT 以前（含）的日 K
  const twRows = tw.rows.filter(r => r.d < today), dT = twRows.at(-1).d;
  const upTo = d => d.rows.filter(r => r.d <= dT);
  const L = levels(upTo(etf)), twL = levels(twRows), ladder = ladderOf(L);

  // EWT 法：dT 那天台股開盤前最後一個美股收盤起算，換成台幣計，扣掉台股 dT 當天已反映的部分
  const F = byDate(fx), fxAt = d => F[d] ?? fx.rows.filter(r => r.d <= d).at(-1).c;
  const b = [...ewt.rows].reverse().find(r => r.d < dT);
  const ewtChg = ewt.px * fx.px / (b.c * fxAt(b.d)) - 1, twChg = twRows.at(-1).c / twRows.at(-2).c - 1;
  const gap = ewt.rows.at(-1).d >= dT ? (1 + ewtChg) / (1 + twChg) - 1 : 0;
  // ADR 法：20 日平均溢價推算台積電
  const A = byDate(adr), hist = upTo(t2330).filter(r => A[r.d] && F[r.d]).map(r => A[r.d] * F[r.d] / 5 / r.c - 1).slice(-20);
  const base = hist.reduce((a, v) => a + v, 0) / hist.length, adrGap = adr.px * fx.px / 5 / (1 + base) / upTo(t2330).at(-1).c - 1;

  const estTw = twRows.at(-1).c * (1 + gap), estEtf = +(L.prev * (1 + gap)).toFixed(2);
  const hits = ladder.map((l, i) => `${estEtf <= l.p ? '🎯' : '⚪'} 第${i + 1}批 ${l.p}${l.label ? `(${l.label})` : ''}`);
  const vixNow = vix.px, soxL = levels(sox.rows);
  const ok = [
    [L.K > L.D && L.Kp <= L.Dp && L.K < 30, 'KD 低檔黃金交叉'], [L.hist < 0 && Math.abs(L.hist) < Math.abs(L.histPrev), 'MACD 綠柱縮短'],
    [L.prev > L.ma5, `站上 MA5 ${L.ma5.toFixed(2)}`], [L.prev > L.ma20, `站上月線 ${L.ma20.toFixed(2)}`],
    [vixNow < 18, `VIX < 18（${vixNow.toFixed(1)}）`], [sox.px > soxL.ma5, '費半站回 MA5'],
  ];
  const warn = [
    [estEtf < L.bbL, `推估開盤低於布林下軌 ${L.bbL.toFixed(2)}`],
    [twL.ma120 && estTw < twL.ma120, `推估加權低於半年線 ${twL.ma120?.toFixed(0)}`],
    [vixNow > 25, `VIX > 25（${vixNow.toFixed(1)}）`],
  ].filter(w => w[0]);

  const md = dT.slice(5).replace('-', '/');
  const title = `盤前：推估加權 ${pct(gap * 100)}，00406A ≈ ${estEtf}`;
  const msg = [
    `EWT 法加權 ≈ ${estTw.toFixed(0)}（${pct(gap * 100)}）｜ADR 法台積電 ${pct(adrGap * 100)}`,
    `00406A 昨收 ${L.prev}（${md}）→ 推估開盤 ≈ ${estEtf}`,
    nav ? `昨收折溢價 ${nav.prem > 0 ? '+' : ''}${nav.prem}%（預估淨值 ${nav.nav}${nav.prem > 0 ? '，市價比淨值貴' : ''}）` : '折溢價：讀取失敗',
    `分批（🎯 推估開盤會觸及、⚪ 不會）：`, ...hits,
    `觸及的批次若掛限價單，會以開盤價成交。`,
    `止跌訊號 ${ok.filter(o => o[0]).length}/${ok.length}：`, ...ok.map(o => `${o[0] ? '✅' : '❌'} ${o[1]}`),
    warn.length ? `轉弱警示：${warn.map(w => w[1]).join('、')}` : '轉弱警示：無',
    strategyLine(L, L.prev, L.vLast / L.v5, `（${md}）`),
    `VIX ${vixNow.toFixed(1)}｜費半 ${pct((sox.px / sox.rows.at(-2).c - 1) * 100)}｜USD/TWD ${fx.px.toFixed(3)}`,
    `推估為粗估（ADR 溢價、時差、權重差異），僅供參考。${clock}`,
  ].join('\n');
  await push(title, msg, 3, ['sunrise']);
}

async function intraday() {
  if (!FORCE && (hm < 900 || hm > 1335)) { console.log('非台股交易時段，略過'); return; }
  const [twI, etfI, tsmI, fxI, nqI, twD, etfD, nav] = await Promise.all([
    chart('^TWII', '5d', '5m'), chart('00406A.TW', '5d', '5m'), chart('2330.TW', '5d', '5m'), chart('TWD=X', '5d', '5m'), chart('NQ=F', '5d', '5m'),
    chart('^TWII', '1mo', '1d'), chart('00406A.TW', '6mo', '1d'), inav('00406A')]);
  // 以最新一個交易日為「當日」；正式執行時必須是今天，FORCE 測試時用最近交易日
  const session = twI.rows.at(-1)?.d;
  if (!FORCE && session !== today) { console.log('今天沒有盤中資料（休市？），略過'); return; }

  // 昨收與日線指標只用「當日以前」的日 K，避免盤中價影響基準
  const before = d => d.rows.filter(r => r.d < session);
  const L = levels(before(etfD)), ladder = ladderOf(L);
  const tw = twI.px, twPrev = before(twD).at(-1).c, twChg = (tw / twPrev - 1) * 100;
  const etf = etfI.px, etfChg = (etf / L.prev - 1) * 100;
  const day = d => d.rows.filter(r => r.d === session);
  const chg15 = rows => rows.length > 3 ? (rows.at(-1).c / rows.at(-4).c - 1) * 100 : 0;   // 最新 5 分 K 對比 15 分鐘前
  const fast = chg15(day(twI));
  // 「當日低點已經 N 分鐘沒被跌破」：以最後一根 5 分 K 的時間當現在，避免報價延遲造成誤判
  const lowAge = rows => {
    if (!rows.length) return 0;
    const low = Math.min(...rows.map(r => r.l)), at = rows.findLastIndex(r => r.l === low);
    return (rows.at(-1).t - rows[at].t) / 60;
  };
  const etfDay = day(etfI), dayLow = +(etfDay.length ? Math.min(...etfDay.map(r => r.l)) : etf).toFixed(2);
  const vwap = etfDay.reduce((s, r) => s + (r.h + r.l + r.c) / 3 * r.v, 0) / (etfDay.reduce((s, r) => s + r.v, 0) || 1);

  // B 止跌確認
  const B = [
    [lowAge(etfDay) >= cfg.confirmMin, `當日低 ${dayLow} 已 ${lowAge(etfDay).toFixed(0)} 分未破（需 ${cfg.confirmMin}）`],
    [etf > vwap, `${etf > vwap ? '站上' : '低於'} VWAP ${vwap.toFixed(2)}`],
  ];
  const bOk = B.some(b => b[0]);
  // C 環境過濾（台幣、美期用最近 15 分鐘；台積電、大盤看是否剛創當日新低）
  // 美期近乎 24 小時交易，用最近 15 分鐘與 60 分鐘的變化
  const fx15 = chg15(fxI.rows), nq15 = chg15(nqI.rows), nqR = nqI.rows, nq60 = nqR.length > 12 ? (nqR.at(-1).c / nqR.at(-13).c - 1) * 100 : 0;
  const C = [
    [nav ? nav.prem <= 0 : null, nav ? `折溢價 ${nav.prem > 0 ? '+' : ''}${nav.prem}%（淨值 ${nav.nav}）` : '折溢價 讀取失敗'],
    [fx15 < 0.15, `台幣 15 分 ${pct(-fx15)}${fx15 >= 0.15 ? ' 急貶' : ''}`],
    [nq15 > -0.3 && nq60 > -0.6, `美期 15 分 ${pct(nq15)}、60 分 ${pct(nq60)}`],
    [lowAge(day(tsmI)) >= cfg.confirmMin, `台積電當日低 ${lowAge(day(tsmI)).toFixed(0)} 分未破`],
    [lowAge(day(twI)) >= cfg.confirmMin, `大盤當日低 ${lowAge(day(twI)).toFixed(0)} 分未破`],
  ];
  const cCount = C.filter(c => c[0] === true).length, cOk = cCount >= cfg.cMin;
  const mark = arr => arr.map(([ok, t]) => `　└ ${ok === true ? '✅' : ok === false ? '❌' : '❔'} ${t}`).join('\n');
  const detail = `${bOk ? '✅' : '❌'} B 止跌確認（任一）\n${mark(B)}\n${cOk ? '✅' : '❌'} C 環境 ${cCount}/${C.length}（需 ${cfg.cMin}）\n${mark(C)}`;

  const signals = [];
  const add = (key, priority, title, msg) => signals.push({ key, priority, title, msg });
  // 分批：當日曾到價、現價仍在該價位 +1% 以內才算「到價」；B 與 C 都符合才震動提醒
  ladder.forEach(({ p, label }, i) => {
    if (dayLow > p || etf > p * 1.01) return;
    const name = `第 ${i + 1} 批 ${p}${label ? `（${label}）` : ''}`;
    if (bOk && cOk) add(`met${i}`, 4, `🔴 符合你的${name}規則`, `00406A ${etf}（${pct(etfChg)}）\n${detail}`);
    else add(`touch${i}`, 2, `🟡 ${name}到價，規則未符合`, `00406A ${etf}（${pct(etfChg)}）\n${detail}`);
  });
  if (etf < L.bbL) add('bbL', 4, '00406A 跌破布林下軌', `現價 ${etf}，布林下軌 ${L.bbL.toFixed(2)}（轉弱警示）`);
  if (etf < L.lo20) add('lo20', 2, '00406A 跌破近 20 日低', `現價 ${etf}，近 20 日低 ${L.lo20.toFixed(2)}`);
  if (etf > L.ma5) add('ma5', 2, '00406A 站上 MA5', `現價 ${etf}，MA5 ${L.ma5.toFixed(2)}（止跌訊號之一）`);
  if (etfChg <= cfg.etfDownPct) add('etfDown', 2, `00406A 跌幅達 ${pct(etfChg)}`, `現價 ${etf}，昨收 ${L.prev}`);
  if (twChg <= cfg.twDownPct) add('twDown', 2, `加權大跌 ${pct(twChg)}`, `加權 ${tw.toFixed(0)}，昨收 ${twPrev.toFixed(0)}`);
  if (twChg >= cfg.twUpPct) add('twUp', 2, `加權大漲 ${pct(twChg)}`, `加權 ${tw.toFixed(0)}，昨收 ${twPrev.toFixed(0)}`);
  // 急殺 / 急拉以 30 分鐘為單位去重
  const slot = Math.floor(hm / 100) * 2 + (hm % 100 >= 30 ? 1 : 0);
  if (fast <= -cfg.fastPct) add(`fastDown${slot}`, 5, `加權 15 分鐘急殺 ${pct(fast)}`, `加權 ${tw.toFixed(0)}（當日 ${pct(twChg)}）`);
  if (fast >= cfg.fastPct) add(`fastUp${slot}`, 2, `加權 15 分鐘急拉 ${pct(fast)}`, `加權 ${tw.toFixed(0)}（當日 ${pct(twChg)}）`);
  // 每小時摘要（10、11、12、13 點各一則，不震動）
  const hour = Math.floor(hm / 100);
  if (hm >= 1000 || FORCE) add(`sum${hour}`, 2, `⚪ ${String(hour).padStart(2, '0')}:00 盤中摘要`, [
    `00406A ${etf}（${pct(etfChg)}）｜當日低 ${dayLow}｜VWAP ${vwap.toFixed(2)}`,
    `加權 ${tw.toFixed(0)}（${pct(twChg)}）`,
    `分批：${ladder.map((l, i) => `${dayLow <= l.p ? '🎯' : '⚪'}${i + 1} ${l.p}`).join(' ')}`,
    detail,
    strategyLine(L, etf, etfDay.reduce((s, r) => s + r.v, 0) / L.v5, '（當日累計，盤中會持續增加）'),
  ].join('\n'));

  console.log(`加權 ${tw.toFixed(0)} (${pct(twChg)}) 15分 ${pct(fast)} | 00406A ${etf} (${pct(etfChg)}) 當日低 ${dayLow} VWAP ${vwap.toFixed(2)}`);
  console.log('分批價位：' + fmtLadder(ladder));
  console.log(detail);

  let state = { date: today, sent: [] };
  try { const s = JSON.parse(await readFile(STATE_FILE, 'utf8')); if (s.date === today) state = s; } catch {}
  const fresh = signals.filter(s => !state.sent.includes(s.key));
  for (const s of fresh) if (await push(s.title, `${s.msg}\n${clock}`, s.priority, ['chart_with_downwards_trend'])) state.sent.push(s.key);
  if (!fresh.length) console.log('沒有新訊號');
  await writeFile(STATE_FILE, JSON.stringify(state));
}
