// 台股訊號推播（ntfy），由 GitHub Actions 執行：
//   MODE=intraday（預設）盤中每 5 分鐘：依使用者的分批規則（B 止跌確認 + C 環境過濾）判斷，只有符合時才推（會震動）
//   MODE=premarket        08:30（週一到週六）：用美股推估開盤，推風險等級與買點卡片（不震動）
//   MODE=evening          22:00 / 22:45：今天收盤、法人、明天推估，推風險等級與買點卡片（不震動）
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
  const DYN = { prev: [L.prev, '上次收盤價'], bbL: [L.bbL, '布林下緣'], lo20: [L.lo20, '近 1 個月最低'], lo60: [L.lo60, '近 3 個月最低'] };
  const out = [];
  for (const x of cfg.ladder) {
    let lv;
    if (typeof x === 'number') lv = { p: x, label: '' };
    else if (DYN[x]) lv = { p: +DYN[x][0].toFixed(2), label: DYN[x][1] };
    else {
      const m = /^pct(-?\d+(?:\.\d+)?)$/.exec(x);
      if (!m) throw new Error(`ALERT_CONFIG ladder 看不懂：${x}`);
      lv = { p: +(L.prev * (1 + m[1] / 100)).toFixed(2), label: `上次收盤 ${m[1]}%` };
    }
    if (!out.some(o => Math.abs(o.p - lv.p) / o.p < 0.005)) out.push(lv);
  }
  return out;
}
// EWT 法推估台股下一次開盤：dT 那天台股開盤前最後一個美股收盤起算，換成台幣計，扣掉台股 dT 當天已反映的部分
function ewtGap(twRows, ewt, fx, dT) {
  const F = byDate(fx), fxAt = d => F[d] ?? fx.rows.filter(r => r.d <= d).at(-1).c;
  const b = [...ewt.rows].reverse().find(r => r.d < dT);
  const ewtChg = ewt.px * fx.px / (b.c * fxAt(b.d)) - 1, twChg = twRows.at(-1).c / twRows.at(-2).c - 1;
  return ewt.rows.at(-1).d >= dT ? (1 + ewtChg) / (1 + twChg) - 1 : 0;
}
// 背景參考的美股與國際指標：不逐項列出，只用來判斷風險、挑出影響最大的原因
const WATCH = { '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq', '^SOX': '美國半導體', 'NVDA': 'NVIDIA', 'TSM': '台積電美股', 'EWT': '美股的台股 ETF',
  '^VIX': '恐慌指數 VIX', '^TNX': '美債利率', 'DX-Y.NYB': '美元', 'TWD=X': '美元兌台幣', '^KS11': '韓股', 'CL=F': '油價' };
async function watch() {
  const syms = Object.keys(WATCH), res = await Promise.allSettled(syms.map(s => chart(s, '1y', '1d'))), out = {};
  syms.forEach((s, i) => { if (res[i].status === 'fulfilled') { const d = res[i].value; out[s] = { px: d.px, chg: (d.px / d.rows.at(-2).c - 1) * 100, above: d.px > levels(d.rows).ma20, date: d.rows.at(-1).d }; } });
  return out;
}
// 風險等級（固定規則）：每項給分，0–1 低、2–3 中、4 以上偏高；原因只列分數最高的兩項
// L：00406A 日線指標、price：00406A 價格、tw：{ px, L } 大盤、w：watch() 結果、nav：折溢價
function risk({ L, price, tw, w, nav, pre = '' }) {
  const f = [];
  if (price < L.bbL) f.push([2, `${pre}00406A 跌破布林下緣 ${L.bbL.toFixed(2)}（跌勢比平常強）`]);
  else if (price < L.ma20) f.push([1, `${pre}00406A 在月平均價 ${L.ma20.toFixed(2)} 之下`]);
  if (tw && tw.L.ma60 && tw.px < tw.L.ma60) f.push([1, `${pre}大盤跌破季平均`]);
  const tech = ['^GSPC', '^IXIC', '^SOX', 'NVDA', 'TSM', 'EWT'].filter(s => w[s]), weak = tech.filter(s => !w[s].above).length;
  if (weak >= 4) f.push([1, `美股科技股 ${tech.length} 項${weak === tech.length ? '全部' : `有 ${weak} 項`}在月平均價之下`]);
  for (const s of ['^SOX', 'NVDA', 'TSM', 'EWT']) if (w[s]?.chg <= -2) f.push([1, `${WATCH[s]}大跌 ${pct(w[s].chg)}`]);
  const vix = w['^VIX']?.px;
  if (vix > 25) f.push([2, `VIX ${vix.toFixed(1)}，市場很恐慌`]); else if (vix > 20) f.push([1, `VIX ${vix.toFixed(1)}，市場偏緊張`]);
  if (w['CL=F']?.chg >= 3) f.push([1, `油價大漲 ${pct(w['CL=F'].chg)}（通膨、利率壓力）`]);
  if (w['TWD=X']?.chg >= 0.5) f.push([1, `台幣急貶 ${pct(w['TWD=X'].chg)}（外資可能在賣）`]);
  if (w['^TNX']?.chg >= 3) f.push([1, `美債利率大漲 ${pct(w['^TNX'].chg)}（對高股息不利）`]);
  if (nav && nav.prem > 0.5) f.push([1, `市價比淨值貴 ${nav.prem}%（買貴風險）`]);
  const score = f.reduce((a, x) => a + x[0], 0);
  const level = score >= 4 ? '🔴 偏高' : score >= 2 ? '🟡 中' : '🟢 低';
  return { level, score, reasons: f.sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => x[1]) };
}
const riskLines = r => [`風險：${r.level}`, ...(r.reasons.length ? r.reasons.map(t => `　└ ${t}`) : ['　└ 目前沒有明顯風險訊號'])];
// 買點：est 是預估價或今天最低價；🎯 會到、⚪ 還差幾 %
const buyLines = (ladder, est, hitTxt) => ['買點：', ...ladder.map((l, i) => est != null && est <= l.p
  ? `🎯 第${i + 1}批 ${l.p}（${l.label}）　${hitTxt}`
  : `⚪ 第${i + 1}批 ${l.p}（${l.label}）${est != null ? `　還差 ${pct((l.p / est - 1) * 100)}` : ''}`)];
const premTxt = p => p > 0 ? `貴 ${p}%` : p < 0 ? `便宜 ${-p}%` : '一樣';
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
else if (MODE === 'evening') await evening();
else await intraday();

async function premarket() {
  // 台股休市（週六、國定假日）時，只要昨晚美股有開，一樣推，改成推估台股下次開盤
  const twClosed = [0, 6].includes(tpe.getUTCDay()) || await isHoliday();
  const [tw, etf, ewt, fx, w, nav] = await Promise.all([chart('^TWII', '1y', '1d'), chart('00406A.TW', '1y', '1d'), chart('EWT', '1y', '1d'), chart('TWD=X', '1y', '1d'), watch(), inav('00406A')]);
  const yesterday = new Date(tpe - 864e5).toISOString().slice(0, 10);
  if (!FORCE && twClosed && w['^GSPC']?.date !== yesterday) { console.log('台股休市，昨晚美股也沒開，略過'); return; }
  // 台股最後一個收盤日 dT；只看 dT 以前（含）的日 K
  const twRows = tw.rows.filter(r => r.d < today), dT = twRows.at(-1).d;
  const L = levels(etf.rows.filter(r => r.d <= dT)), ladder = ladderOf(L);
  const gap = ewtGap(twRows, ewt, fx, dT), estEtf = +(L.prev * (1 + gap)).toFixed(2), estTw = twRows.at(-1).c * (1 + gap);
  const r = risk({ L, price: estEtf, tw: { px: estTw, L: levels(twRows) }, w, nav, pre: '預估 ' });
  const when = twClosed ? '下次' : '';
  const title = `00406A 預估${when}開盤 ${estEtf}（${pct(gap * 100)}）｜風險 ${r.level}`;
  const msg = [
    ...riskLines(r),
    ...buyLines(ladder, estEtf, '開盤可能就到'),
    `⏸ 結論：開盤前還不能判斷你的規則，盤中符合會震動通知你${nav && nav.prem > 0 ? `（目前比淨值貴 ${nav.prem}%，這項不符合）` : ''}`,
    `上次收盤 ${L.prev}（${dT.slice(5).replace('-', '/')}）｜依美股推估，僅供參考｜${clock}`,
  ].join('\n');
  await push(title, msg, 2, ['sunrise']);
}

// 證交所三大法人買賣超（約 15:00–16:00 公布）：大盤金額（億元）與 00406A 張數
async function institutions(d) {
  const ymd = d.replace(/-/g, ''), num = s => +String(s).replace(/,/g, '');
  try {
    const [b, t] = await Promise.all([
      fetch(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate=${ymd}&type=day&response=json`).then(r => r.json()),
      fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=0099P&response=json`).then(r => r.json())]);
    if (b.stat !== 'OK') return null;
    const v = name => b.data.filter(r => r[0].startsWith(name)).reduce((s, r) => s + num(r[3]), 0) / 1e8;
    const e = t.stat === 'OK' && t.data.find(r => r[0].trim() === '00406A');
    return { mkt: { f: v('外資'), i: v('投信'), d: v('自營商') },
      etf: e && { f: (num(e[4]) + num(e[7])) / 1000, i: num(e[10]) / 1000, d: num(e[11]) / 1000 } };
  } catch (e) { console.log('法人資料讀取失敗', e.message); return null; }
}

// 晚間覆盤（台北 22:00）：今天台股收盤總結 + 法人 + 分批是否跌到 + 美股開盤後的走勢與明天推估
async function evening() {
  // 排程有 22:00（EVENING_SLOT=dst）與 22:45（std）兩個；美國夏令時間 21:30 開盤用 22:00，冬令 22:30 開盤用 22:45
  const usDst = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date()).includes('EDT');
  const slot = process.env.EVENING_SLOT;
  if (!FORCE && slot && (slot === 'dst') !== usDst) { console.log(`美國${usDst ? '夏令' : '冬令'}時間，這個時段略過`); return; }
  const [etfD, twD, ewt, fx, w] = await Promise.all([chart('00406A.TW', '1y', '1d'), chart('^TWII', '1y', '1d'), chart('EWT', '1y', '1d'), chart('TWD=X', '1y', '1d'), watch()]);
  // 台股最後一個交易日；正式執行時必須是今天，否則代表今天休市
  const dT = twD.rows.at(-1).d;
  if (!FORCE && dT !== today) { console.log('今天台股沒開盤，略過'); return; }
  const upTo = d => d.rows.filter(r => r.d <= dT), before = d => d.rows.filter(r => r.d < dT);
  const bar = upTo(etfD).at(-1), Lb = levels(before(etfD)), L = levels(upTo(etfD)), twRows = upTo(twD);
  const etfChg = (bar.c / Lb.prev - 1) * 100;
  const [nav, inst] = await Promise.all([inav('00406A'), institutions(dT)]);
  const sg = x => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
  // 今天跌到哪幾批（用今天以前的價位）；明天的買點用含今天的價位
  const hitToday = ladderOf(Lb).map((l, i) => bar.l <= l.p ? i + 1 : 0).filter(Boolean);
  const gap = ewt.rows.at(-1).d >= dT ? ewtGap(twRows, ewt, fx, dT) : null, est = gap == null ? null : +(bar.c * (1 + gap)).toFixed(2);
  const navOk = nav && nav.date === dT.replace(/-/g, '');
  const r = risk({ L, price: bar.c, tw: { px: twRows.at(-1).c, L: levels(twRows) }, w, nav: navOk && nav });
  const title = `🌙 00406A 收 ${bar.c.toFixed(2)}（${pct(etfChg)}）｜風險 ${r.level}`;
  const msg = [
    `今天：最低 ${bar.l.toFixed(2)}｜${hitToday.length ? `第 ${hitToday.join('、')} 批有跌到` : '分批價位都沒跌到'}${navOk ? `｜收盤比淨值${premTxt(nav.prem)}` : ''}`,
    inst ? `法人：00406A 外資 ${inst.etf ? sg(inst.etf.f) + ' 張' : '—'}｜整個台股外資 ${sg(inst.mkt.f)} 億` : '法人：還沒公布',
    est != null ? `明天：依目前美股推估 00406A 約 ${est}（${pct(gap * 100)}），美股還沒收盤，明早 8:30 再更新` : '明天：美股還沒開盤，明早 8:30 推估',
    ...riskLines(r),
    ...buyLines(ladderOf(L), est, '明天開盤可能就到'),
    '⏸ 結論：明天盤中照你的規則判斷，符合會震動通知你',
    clock,
  ].join('\n');
  await push(title, msg, 2, ['crescent_moon']);
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

  const held = rows => { const m = lowAge(rows); return m < 5 ? '剛剛還在創新低' : `已經 ${m.toFixed(0)} 分鐘沒再跌破`; };
  // B 止跌確認
  const B = [
    [lowAge(etfDay) >= cfg.confirmMin, `今天最低價 ${dayLow} ${held(etfDay)}（要 ${cfg.confirmMin} 分）`],
    [etf > vwap, `現價${etf > vwap ? '高於' : '低於'}今天平均成交價 ${vwap.toFixed(2)}`],
  ];
  const bOk = B.some(b => b[0]);
  // C 環境過濾（台幣、美期用最近 15 分鐘；台積電、大盤看是否剛創當日新低）
  // 美期近乎 24 小時交易，用最近 15 分鐘與 60 分鐘的變化
  const fx15 = chg15(fxI.rows), nq15 = chg15(nqI.rows), nqR = nqI.rows, nq60 = nqR.length > 12 ? (nqR.at(-1).c / nqR.at(-13).c - 1) * 100 : 0;
  const C = [
    // 每項第三欄是不符合時的短原因
    [nav ? nav.prem <= 0 : null, nav ? `沒有買貴：市價比基金實際價值（淨值 ${nav.nav}）${nav.prem > 0 ? `貴 ${nav.prem}%` : nav.prem < 0 ? `便宜 ${-nav.prem}%` : '一樣'}` : '市價與淨值比較：讀取失敗', '比淨值貴'],
    [fx15 < 0.15, `台幣沒有急貶（15 分鐘 ${pct(-fx15)}）`, '台幣急貶'],
    [nq15 > -0.3 && nq60 > -0.6, `美股期貨沒有急跌（15 分鐘 ${pct(nq15)}、1 小時 ${pct(nq60)}）`, '美股期貨急跌'],
    [lowAge(day(tsmI)) >= cfg.confirmMin, `台積電今天最低價${held(day(tsmI))}`, '台積電還在跌'],
    [lowAge(day(twI)) >= cfg.confirmMin, `大盤今天最低點${held(day(twI))}`, '大盤還在跌'],
  ];
  const cCount = C.filter(c => c[0] === true).length, cOk = cCount >= cfg.cMin;
  const mark = arr => arr.map(([ok, t]) => `　└ ${ok === true ? '✅' : ok === false ? '❌' : '❔'} ${t}`).join('\n');
  // 依使用者規則的一行結論（不是我的買賣建議）：到價且 B、C 都符合才是「可以照計畫買」
  const missAll = [...(bOk ? [] : ['00406A 還在跌']), ...C.filter(c => c[0] !== true).map(c => c[2])];
  const touched = ladder.map((l, i) => dayLow <= l.p && etf <= l.p * 1.01 ? i + 1 : 0).filter(Boolean);
  const verdict = bOk && cOk ? (touched.length ? `✅ 結論：符合你的規則，第 ${touched.join('、')} 批可以照計畫買` : '⏸ 結論：規則符合，但還沒到你的價位')
    : `⏸ 結論：依你的規則現在先不買（原因：${missAll.join('、')}）`;
  const detail = `${bOk ? '✅' : '❌'} B 跌勢暫停（下面任一項就算）\n${mark(B)}\n${cOk ? '✅' : '❌'} C 大環境 ${cCount}/${C.length} 項 OK（要 ${cfg.cMin} 項）\n${mark(C)}`;

  console.log(`加權 ${tw.toFixed(0)} (${pct(twChg)}) 15分 ${pct(fast)} | 00406A ${etf} (${pct(etfChg)}) 當日低 ${dayLow} VWAP ${vwap.toFixed(2)}`);
  console.log('分批價位：' + fmtLadder(ladder));
  console.log(detail);
  // 使用者要求盤中只在「符合規則」時推（震動）；到價未符合、跌破、急跌等「還在跌」的提醒都不推
  // 同時符合多批時合併成一則；每批一天只推一次
  let state = { date: today, sent: [] };
  try { const st = JSON.parse(await readFile(STATE_FILE, 'utf8')); if (st.date === today) state = st; } catch {}
  const fresh = bOk && cOk ? touched.filter(n => !state.sent.includes(`met${n - 1}`)) : [];
  if (fresh.length) {
    const names = fresh.map(n => `${ladder[n - 1].p}（${ladder[n - 1].label}）`).join('、');
    const title = `✅ 符合你的第 ${fresh.join('、')} 批規則：${names}`;
    if (await push(title, `00406A 現價 ${etf}（今天 ${pct(etfChg)}）\n${verdict}\n${detail}\n${clock}`, 4, ['white_check_mark']))
      state.sent.push(...fresh.map(n => `met${n - 1}`));
  } else console.log('沒有新訊號');
  await writeFile(STATE_FILE, JSON.stringify(state));
}
