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
// 策略指標一行摘要（只當資訊）：price 為現價，volRatio 為量比（盤中是當日累計量對前 5 日均量）
function strategyLine(L, price, volRatio, volNote = '') {
  const bias = (price / L.ma5 - 1) * 100;
  const heat = L.heat < 0.5 ? '冷清' : L.heat < 1.5 ? '正常' : L.heat < 3 ? '偏熱' : '過熱';
  const cross = L.cross === 'golden' ? '近 3 天短期均價往上穿過，轉強跡象' : L.cross === 'dead' ? '近 3 天短期均價往下穿過，轉弱跡象'
    : L.ma5 > L.ma10 ? '短期均價在上面，偏強' : '短期均價在下面，偏弱';
  return [
    `參考指標（不影響規則）：`,
    `離 5 日平均價 ${pct(bias)}（${Math.abs(bias) < 5 ? '差距 <5%，不算追高' : '差距 ≥5%，離平均價太遠'}）`,
    `成交量是前 5 天平均的 ${volRatio.toFixed(2)} 倍${volNote}`,
    `交易熱度：近 5 天成交量是近 3 個月平均的 ${L.heat.toFixed(1)} 倍（${heat}）`,
    `5 日均價 ${L.ma5.toFixed(2)}、10 日均價 ${L.ma10.toFixed(2)}：${cross}`,
  ].join('\n');
}
// 止跌跡象清單（盤前與晚間覆盤共用）：L.prev 是最近一個收盤價
function stopSigns(L, vixNow, sox) {
  const soxL = levels(sox.rows);
  return [
    [L.K > L.D && L.Kp <= L.Dp && L.K < 30, '短線指標 KD 在低檔翻頭向上'], [L.hist < 0 && Math.abs(L.hist) < Math.abs(L.histPrev), 'MACD 顯示下跌力道變小'],
    [L.prev > L.ma5, `價格回到 5 日平均價 ${L.ma5.toFixed(2)} 之上`], [L.prev > L.ma20, `價格回到月平均價 ${L.ma20.toFixed(2)} 之上`],
    [vixNow < 18, `美股恐慌指數 VIX 降到 18 以下（目前 ${vixNow.toFixed(1)}）`], [sox.px > soxL.ma5, '美國半導體股回到 5 日平均之上'],
  ];
}
const fmtSigns = ok => [`止跌跡象 ${ok.filter(o => o[0]).length}/${ok.length}（✅ 越多越像跌勢要停）：`, ...ok.map(o => `${o[0] ? '✅' : '❌'} ${o[1]}`)];
// EWT 法推估台股下一次開盤：dT 那天台股開盤前最後一個美股收盤起算，換成台幣計，扣掉台股 dT 當天已反映的部分
function ewtGap(twRows, ewt, fx, dT) {
  const F = byDate(fx), fxAt = d => F[d] ?? fx.rows.filter(r => r.d <= d).at(-1).c;
  const b = [...ewt.rows].reverse().find(r => r.d < dT);
  const ewtChg = ewt.px * fx.px / (b.c * fxAt(b.d)) - 1, twChg = twRows.at(-1).c / twRows.at(-2).c - 1;
  return ewt.rows.at(-1).d >= dT ? (1 + ewtChg) / (1 + twChg) - 1 : 0;
}
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
  // 台股休市（週六、國定假日）時，只要昨晚美股有開，一樣推「美股收盤總結」，推估台股下次開盤
  const twClosed = [0, 6].includes(tpe.getUTCDay()) || await isHoliday();
  const [tw, etf, t2330, adr, ewt, fx, vix, sox, gspc, ixic] = await Promise.all(
    ['^TWII', '00406A.TW', '2330.TW', 'TSM', 'EWT', 'TWD=X', '^VIX', '^SOX', '^GSPC', '^IXIC'].map(s => chart(s, '1y', '1d')));
  const yesterday = new Date(tpe - 864e5).toISOString().slice(0, 10), usDate = gspc.rows.at(-1).d;
  if (!FORCE && twClosed && usDate !== yesterday) { console.log('台股休市，昨晚美股也沒開，略過'); return; }
  const nav = await inav('00406A');
  // 台股最後一個收盤日 dT；盤前只看 dT 以前（含）的日 K
  const twRows = tw.rows.filter(r => r.d < today), dT = twRows.at(-1).d;
  const upTo = d => d.rows.filter(r => r.d <= dT);
  const L = levels(upTo(etf)), twL = levels(twRows), ladder = ladderOf(L);

  const gap = ewtGap(twRows, ewt, fx, dT), F = byDate(fx);
  // ADR 法：20 日平均溢價推算台積電
  const A = byDate(adr), hist = upTo(t2330).filter(r => A[r.d] && F[r.d]).map(r => A[r.d] * F[r.d] / 5 / r.c - 1).slice(-20);
  const base = hist.reduce((a, v) => a + v, 0) / hist.length, adrGap = adr.px * fx.px / 5 / (1 + base) / upTo(t2330).at(-1).c - 1;
  // 台積電美股從台股 dT 開盤前最後一個美股收盤算起的漲跌（和 EWT 法同一段時間）
  const tsmTw = upTo(t2330).at(-1).c, adrTwd = adr.px * fx.px / 5, adrB = [...adr.rows].reverse().find(r => r.d < dT);

  const estTw = twRows.at(-1).c * (1 + gap), estEtf = +(L.prev * (1 + gap)).toFixed(2);
  const hits = ladder.map((l, i) => `${estEtf <= l.p ? '🎯' : '⚪'} 第${i + 1}批 ${l.p}${l.label ? `(${l.label})` : ''}`);
  const vixNow = vix.px, ok = stopSigns(L, vixNow, sox);
  const warn = [
    [estEtf < L.bbL, `預估開盤會跌破布林下緣 ${L.bbL.toFixed(2)}（近期正常波動的底部）`],
    [twL.ma120 && estTw < twL.ma120, `預估大盤會跌破半年平均 ${twL.ma120?.toFixed(0)}`],
    [vixNow > 25, `VIX 超過 25，市場很恐慌（${vixNow.toFixed(1)}）`],
  ].filter(w => w[0]);

  const md = dT.slice(5).replace('-', '/');
  const usChg = d => pct((d.px / d.rows.at(-2).c - 1) * 100);
  const title = twClosed ? `美股收盤總結（台股今天休市）：預估台股下次開盤 ${pct(gap * 100)}，00406A 約 ${estEtf}`
    : `盤前：預估大盤 ${pct(gap * 100)}，00406A 約 ${estEtf}`;
  const msg = [
    `美股收盤（${usDate.slice(5).replace('-', '/')}）：S&P 500 ${usChg(gspc)}｜Nasdaq ${usChg(ixic)}｜美國半導體 ${usChg(sox)}`,
    `美股的台股 ETF ${usChg(ewt)}｜台積電美股 ${usChg(adr)}（詳見下方）`,
    ``,
    `用美股推估台股${twClosed ? '下次' : ''}開盤（從上次台股收盤到現在的美股變化）：`,
    `大盤（加權指數）約 ${estTw.toFixed(0)}（${pct(gap * 100)}）`,
    `00406A 上次收盤 ${L.prev}（${md}）→ 預估${twClosed ? '下次' : ''}開盤約 ${estEtf}`,
    nav ? `上次收盤時，市價比基金實際價值（淨值 ${nav.nav}）${premTxt(nav.prem)}` : '市價與淨值比較：讀取失敗',
    ``,
    `【台積電】`,
    `台積電美股收 ${adr.px.toFixed(2)} 美元（昨晚 ${usChg(adr)}，從台股 ${md} 收盤後算起 ${pct((adr.px / adrB.c - 1) * 100)}）`,
    `換算成台股每股約 ${adrTwd.toFixed(0)} 元，比台股上次收盤 ${tsmTw.toFixed(0)} 貴 ${((adrTwd / tsmTw - 1) * 100).toFixed(1)}%（平常貴 ${(base * 100).toFixed(1)}%）`,
    `照平常差距推算，台積電${twClosed ? '下次' : ''}開盤約 ${(tsmTw * (1 + adrGap)).toFixed(0)}（${pct(adrGap * 100)}）`,
    ``,
    `你的分批價位（🎯 預估開盤會跌到、⚪ 不會）：`, ...hits,
    `🎯 的價位如果掛了買單，開盤就可能直接用開盤價買到。`,
    ``,
    ...fmtSigns(ok),
    warn.length ? `⚠️ 要小心：\n${warn.map(w => `　└ ${w[1]}`).join('\n')}` : '⚠️ 要小心：無',
    ``,
    strategyLine(L, L.prev, L.vLast / L.v5, `（${md}）`),
    ``,
    `美股恐慌指數 VIX ${vixNow.toFixed(1)}（<18 平靜、>25 恐慌）`,
    `1 美元 = ${fx.px.toFixed(3)} 台幣`,
    `以上是用美股推算的粗估，僅供參考。${clock}`,
  ].join('\n');
  await push(title, msg, twClosed ? 2 : 3, ['sunrise']);
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
  const [etfD, twD, tsmD, ewt, fx, vix, sox, gspc, ixic, nq, es] = await Promise.all([
    chart('00406A.TW', '6mo', '1d'), chart('^TWII', '1y', '1d'), chart('2330.TW', '1mo', '1d'), chart('EWT', '1y', '1d'), chart('TWD=X', '1y', '1d'),
    chart('^VIX', '5d', '1d'), chart('^SOX', '1y', '1d'), chart('^GSPC', '1d', '5m'), chart('^IXIC', '1d', '5m'), chart('NQ=F', '1d', '5m'), chart('ES=F', '1d', '5m')]);
  // 台股最後一個交易日；正式執行時必須是今天，否則代表今天休市
  const dT = twD.rows.at(-1).d;
  if (!FORCE && dT !== today) { console.log('今天台股沒開盤，略過'); return; }
  const upTo = d => d.rows.filter(r => r.d <= dT), before = d => d.rows.filter(r => r.d < dT);
  const etfRows = upTo(etfD), bar = etfRows.at(-1), Lb = levels(before(etfD)), L = levels(etfRows), ladder = ladderOf(Lb);
  const twRows = upTo(twD), twL = levels(twRows), tw = twRows.at(-1).c, twChg = (tw / twRows.at(-2).c - 1) * 100;
  const tsmRows = upTo(tsmD), tsmChg = (tsmRows.at(-1).c / tsmRows.at(-2).c - 1) * 100;
  const etfChg = (bar.c / Lb.prev - 1) * 100, md = dT.slice(5).replace('-', '/');
  const [nav, inst] = await Promise.all([inav('00406A'), institutions(dT)]);
  const sg = x => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');

  const warn = [
    [bar.c < L.bbL, `00406A 收盤跌破布林下緣 ${L.bbL.toFixed(2)}（近期正常波動的底部）`],
    [twL.ma120 && tw < twL.ma120, `大盤收盤跌破半年平均 ${twL.ma120?.toFixed(0)}`],
    [vix.px > 25, `VIX 超過 25，市場很恐慌（${vix.px.toFixed(1)}）`],
  ].filter(w => w[0]);

  // 美股是否已開盤：用 S&P 500 當天的正常交易時段判斷
  const reg = gspc.meta.currentTradingPeriod?.regular, now = Date.now() / 1000;
  const usOpen = reg && now >= reg.start && now <= reg.end;
  const hhmm = t => new Date((t + 8 * 3600) * 1000).toISOString().slice(11, 16);
  const dayChg = d => (d.px / d.meta.chartPreviousClose - 1) * 100;
  const gap = ewt.rows.at(-1).d >= dT ? ewtGap(twRows, ewt, fx, dT) : null;

  const title = `🌙 今日覆盤：00406A 收 ${bar.c.toFixed(2)}（${pct(etfChg)}），大盤 ${pct(twChg)}`;
  const msg = [
    `【今天台股 ${md}】`,
    `00406A 收盤 ${bar.c.toFixed(2)}（${pct(etfChg)}）｜最高 ${bar.h.toFixed(2)}｜最低 ${bar.l.toFixed(2)}`,
    nav && nav.date === dT.replace(/-/g, '') ? `收盤時市價比基金實際價值（淨值 ${nav.nav}）${premTxt(nav.prem)}` : '收盤時市價與淨值比較：讀取失敗',
    `大盤（加權指數）${tw.toFixed(0)}（${pct(twChg)}）｜台積電 ${tsmRows.at(-1).c.toFixed(0)}（${pct(tsmChg)}）`,
    inst ? [
      `法人買賣（正數＝買進比賣出多）：`,
      `　└ 整個台股：外資 ${sg(inst.mkt.f)} 億、投信 ${sg(inst.mkt.i)} 億、自營商 ${sg(inst.mkt.d)} 億`,
      inst.etf ? `　└ 00406A：外資 ${sg(inst.etf.f)} 張、投信 ${sg(inst.etf.i)} 張、自營商 ${sg(inst.etf.d)} 張（自營商多半是 ETF 造市商在調節，參考就好）` : '　└ 00406A：沒有資料',
    ].join('\n') : '法人買賣：還沒公布或讀取失敗',
    ``,
    `你的分批價位今天（🎯 有跌到、⚪ 沒有）：`,
    ...ladder.map((l, i) => `${bar.l <= l.p ? '🎯' : '⚪'} 第${i + 1}批 ${l.p}${l.label ? `(${l.label})` : ''}`),
    ``,
    ...fmtSigns(stopSigns(L, vix.px, sox)),
    warn.length ? `⚠️ 要小心：\n${warn.map(w => `　└ ${w[1]}`).join('\n')}` : '⚠️ 要小心：無',
    ``,
    strategyLine(L, bar.c, L.vLast / L.v5, `（${md}）`),
    ``,
    `【美股現在】`,
    usOpen ? `S&P 500 ${pct(dayChg(gspc))}｜Nasdaq ${pct(dayChg(ixic))}｜美國半導體 ${pct((sox.px / sox.rows.at(-2).c - 1) * 100)}`
      : `${reg && now < reg.start ? `美股還沒開盤（台北時間 ${hhmm(reg.start)} 開盤）` : '美股目前沒有交易'}，先看期貨：`,
    `美股期貨：Nasdaq ${pct(dayChg(nq))}｜S&P ${pct(dayChg(es))}`,
    `美股恐慌指數 VIX ${vix.px.toFixed(1)}（<18 平靜、>25 恐慌）｜1 美元 = ${fx.px.toFixed(3)} 台幣`,
    gap != null ? `照目前美股推估，台股下次開盤約 ${pct(gap * 100)}（00406A 約 ${(bar.c * (1 + gap)).toFixed(2)}）${usOpen ? '\n　└ 美股還沒收盤，數字還會變，明早 8:30 會再推估一次' : ''}`
      : '明早 8:30 會用美股收盤推估台股開盤。',
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
    [nav ? nav.prem <= 0 : null, nav ? `沒有買貴：市價比基金實際價值（淨值 ${nav.nav}）${nav.prem > 0 ? `貴 ${nav.prem}%` : nav.prem < 0 ? `便宜 ${-nav.prem}%` : '一樣'}` : '市價與淨值比較：讀取失敗'],
    [fx15 < 0.15, `台幣沒有急貶（15 分鐘 ${pct(-fx15)}）`],
    [nq15 > -0.3 && nq60 > -0.6, `美股期貨沒有急跌（15 分鐘 ${pct(nq15)}、1 小時 ${pct(nq60)}）`],
    [lowAge(day(tsmI)) >= cfg.confirmMin, `台積電今天最低價${held(day(tsmI))}`],
    [lowAge(day(twI)) >= cfg.confirmMin, `大盤今天最低點${held(day(twI))}`],
  ];
  const cCount = C.filter(c => c[0] === true).length, cOk = cCount >= cfg.cMin;
  const mark = arr => arr.map(([ok, t]) => `　└ ${ok === true ? '✅' : ok === false ? '❌' : '❔'} ${t}`).join('\n');
  const detail = `${bOk ? '✅' : '❌'} B 跌勢暫停（下面任一項就算）\n${mark(B)}\n${cOk ? '✅' : '❌'} C 大環境 ${cCount}/${C.length} 項 OK（要 ${cfg.cMin} 項）\n${mark(C)}`;

  const signals = [];
  const add = (key, priority, title, msg) => signals.push({ key, priority, title, msg });
  // 分批：當日曾到價、現價仍在該價位 +1% 以內才算「到價」；B 與 C 都符合才震動提醒
  ladder.forEach(({ p, label }, i) => {
    if (dayLow > p || etf > p * 1.01) return;
    const name = `第 ${i + 1} 批 ${p}${label ? `（${label}）` : ''}`;
    if (bOk && cOk) add(`met${i}`, 4, `🔴 符合你的${name}買進規則`, `00406A 現價 ${etf}（今天 ${pct(etfChg)}）\n${detail}`);
    else add(`touch${i}`, 2, `🟡 ${name}到價，但規則還沒符合`, `00406A 現價 ${etf}（今天 ${pct(etfChg)}）\n${detail}`);
  });
  if (etf < L.bbL) add('bbL', 4, '⚠️ 00406A 跌破布林下緣', `現價 ${etf}，布林下緣 ${L.bbL.toFixed(2)}\n布林下緣是近期正常波動的底部，跌破代表跌勢比平常強`);
  if (etf < L.lo20) add('lo20', 2, '00406A 跌破近 1 個月最低價', `現價 ${etf}，近 1 個月最低 ${L.lo20.toFixed(2)}`);
  if (etf > L.ma5) add('ma5', 2, '00406A 回到 5 日平均價之上', `現價 ${etf}，5 日平均價 ${L.ma5.toFixed(2)}（止跌跡象之一）`);
  if (etfChg <= cfg.etfDownPct) add('etfDown', 2, `00406A 今天跌 ${pct(etfChg)}`, `現價 ${etf}，上次收盤 ${L.prev}`);
  if (twChg <= cfg.twDownPct) add('twDown', 2, `大盤大跌 ${pct(twChg)}`, `加權指數 ${tw.toFixed(0)}，上次收盤 ${twPrev.toFixed(0)}`);
  if (twChg >= cfg.twUpPct) add('twUp', 2, `大盤大漲 ${pct(twChg)}`, `加權指數 ${tw.toFixed(0)}，上次收盤 ${twPrev.toFixed(0)}`);
  // 急殺 / 急拉以 30 分鐘為單位去重
  const slot = Math.floor(hm / 100) * 2 + (hm % 100 >= 30 ? 1 : 0);
  if (fast <= -cfg.fastPct) add(`fastDown${slot}`, 5, `⚠️ 大盤 15 分鐘內急跌 ${pct(fast)}`, `加權指數 ${tw.toFixed(0)}（今天 ${pct(twChg)}）`);
  if (fast >= cfg.fastPct) add(`fastUp${slot}`, 2, `大盤 15 分鐘內急漲 ${pct(fast)}`, `加權指數 ${tw.toFixed(0)}（今天 ${pct(twChg)}）`);
  // 每小時摘要（10、11、12、13 點各一則，不震動）
  const hour = Math.floor(hm / 100);
  if (hm >= 1000 || FORCE) add(`sum${hour}`, 2, `⚪ ${String(hour).padStart(2, '0')}:00 盤中摘要`, [
    `00406A 現價 ${etf}（今天 ${pct(etfChg)}）`,
    `今天最低 ${dayLow}｜今天平均成交價 ${vwap.toFixed(2)}`,
    `大盤（加權指數）${tw.toFixed(0)}（今天 ${pct(twChg)}）`,
    `分批（🎯 今天已跌到、⚪ 還沒）：${ladder.map((l, i) => `${dayLow <= l.p ? '🎯' : '⚪'}${i + 1} ${l.p}`).join(' ')}`,
    ``,
    detail,
    ``,
    strategyLine(L, etf, etfDay.reduce((s, r) => s + r.v, 0) / L.v5, '（今天累計，盤中會一直增加）'),
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
