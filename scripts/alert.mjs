// 台股盤中訊號偵測：GitHub Actions 每 5 分鐘跑一次，觸發條件時透過 ntfy 推播到手機
// 環境變數：
//   NTFY_TOPIC    ntfy 主題（放 GitHub Secret，不要寫進公開 repo）；未設定時只印出不推播
//   ALERT_CONFIG  JSON，覆蓋下方 DEFAULTS，例如 {"ladder":[9.06,8.98,7.87]}（放 Secret）
//   STATE_FILE    已推播紀錄，避免同一訊號一天重複推（預設 alert-state.json）
//   FORCE=1       忽略交易時段檢查（測試用）
import { readFile, writeFile } from 'node:fs/promises';

const DEFAULTS = {
  ladder: [],          // 00406A 分批價位，觸及時提醒
  twDownPct: -1.5,     // 加權當日跌幅達到時提醒
  twUpPct: 1.5,        // 加權當日漲幅達到時提醒
  fastPct: 0.7,        // 加權 15 分鐘內急殺 / 急拉幅度
  etfDownPct: -2,      // 00406A 當日跌幅
};
const cfg = { ...DEFAULTS, ...JSON.parse(process.env.ALERT_CONFIG || '{}') };
const TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = process.env.STATE_FILE || 'alert-state.json';

async function chart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${symbol} HTTP ${r.status}`);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  const rows = (res.timestamp || []).map((t, i) => ({ t, d: new Date((t + off) * 1000).toISOString().slice(0, 10), c: q.close[i], h: q.high[i], l: q.low[i] }))
    .filter(r => r.c != null);
  return { meta: res.meta, rows };
}
const sma = (a, n) => a.slice(-n).reduce((s, v) => s + v, 0) / n;
const pct = x => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';

// 台北時間 09:00–13:35 之外不檢查
const tpe = new Date(Date.now() + 8 * 3600e3), hm = tpe.getUTCHours() * 100 + tpe.getUTCMinutes(), today = tpe.toISOString().slice(0, 10);
if (!process.env.FORCE && (hm < 900 || hm > 1335)) { console.log('非台股交易時段，略過'); process.exit(0); }

const [twI, etfI, twD, etfD] = await Promise.all([
  chart('^TWII', '5d', '5m'), chart('00406A.TW', '5d', '5m'), chart('^TWII', '1mo', '1d'), chart('00406A.TW', '6mo', '1d')]);
// 以最新一個交易日為「當日」；正式執行時必須是今天，FORCE 測試時用最近交易日
const session = twI.rows.at(-1)?.d;
if (!process.env.FORCE && session !== today) { console.log('今天沒有盤中資料（休市？），略過'); process.exit(0); }

// 昨收與日線指標只用「當日以前」的日 K，避免盤中價影響基準
const before = d => d.rows.filter(r => r.d < session);
const tw = twI.meta.regularMarketPrice, twPrev = before(twD).at(-1).c, twChg = (tw / twPrev - 1) * 100;
const etf = etfI.meta.regularMarketPrice, etfPrev = before(etfD).at(-1).c, etfChg = (etf / etfPrev - 1) * 100;
const past = before(etfD).map(r => r.c);
const ma5 = sma(past, 5), ma20 = sma(past, 20), sd = Math.sqrt(past.slice(-20).reduce((s, v) => s + (v - ma20) ** 2, 0) / 20), bbL = ma20 - 2 * sd;
const lo20 = Math.min(...before(etfD).slice(-20).map(r => r.l));
// 15 分鐘變化：當日最新一根 5 分 K 對比 3 根前
const tr = twI.rows.filter(r => r.d === session), fast = tr.length > 3 ? (tr.at(-1).c / tr.at(-4).c - 1) * 100 : 0;

const signals = [];
const add = (key, priority, title, msg) => signals.push({ key, priority, title, msg });
cfg.ladder.forEach((p, i) => { if (etf <= p) add(`ladder${i}`, 4, `00406A 觸及第 ${i + 1} 批 ${p}`, `現價 ${etf}（${pct(etfChg)}）`); });
if (etf < bbL) add('bbL', 4, '00406A 跌破布林下軌', `現價 ${etf}，布林下軌 ${bbL.toFixed(2)}（轉弱警示）`);
if (etf < lo20) add('lo20', 3, '00406A 跌破近 20 日低', `現價 ${etf}，近 20 日低 ${lo20.toFixed(2)}`);
if (etf > ma5) add('ma5', 3, '00406A 站上 MA5', `現價 ${etf}，MA5 ${ma5.toFixed(2)}（止跌訊號之一）`);
if (etfChg <= cfg.etfDownPct) add('etfDown', 4, `00406A 跌幅達 ${pct(etfChg)}`, `現價 ${etf}，昨收 ${etfPrev}`);
if (twChg <= cfg.twDownPct) add('twDown', 4, `加權大跌 ${pct(twChg)}`, `加權 ${tw.toFixed(0)}，昨收 ${twPrev.toFixed(0)}`);
if (twChg >= cfg.twUpPct) add('twUp', 4, `加權大漲 ${pct(twChg)}`, `加權 ${tw.toFixed(0)}，昨收 ${twPrev.toFixed(0)}`);
// 急殺 / 急拉每次新觸發都推（以 30 分鐘為單位去重）
const slot = Math.floor(hm / 100) * 2 + (hm % 100 >= 30 ? 1 : 0);
if (fast <= -cfg.fastPct) add(`fastDown${slot}`, 5, `加權 15 分鐘急殺 ${pct(fast)}`, `加權 ${tw.toFixed(0)}（當日 ${pct(twChg)}）`);
if (fast >= cfg.fastPct) add(`fastUp${slot}`, 4, `加權 15 分鐘急拉 ${pct(fast)}`, `加權 ${tw.toFixed(0)}（當日 ${pct(twChg)}）`);

console.log(`加權 ${tw.toFixed(0)} (${pct(twChg)}) 15分 ${pct(fast)} | 00406A ${etf} (${pct(etfChg)}) MA5 ${ma5.toFixed(2)} 布林下 ${bbL.toFixed(2)} 20日低 ${lo20.toFixed(2)}`);

let state = { date: today, sent: [] };
try { const s = JSON.parse(await readFile(STATE_FILE, 'utf8')); if (s.date === today) state = s; } catch {}
const fresh = signals.filter(s => !state.sent.includes(s.key));
for (const s of fresh) {
  console.log(`訊號：${s.title}｜${s.msg}`);
  if (!TOPIC) { state.sent.push(s.key); continue; }
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TOPIC, title: (process.env.ALERT_PREFIX || '') + s.title, message: `${s.msg}\n${tpe.toISOString().slice(11, 16)} 台北時間`, priority: s.priority, tags: ['chart_with_downwards_trend'], click: 'https://roychuang.github.io/Stock406/' }),
  });
  if (!r.ok) { console.error('推播失敗', r.status, await r.text()); continue; }
  state.sent.push(s.key);
}
if (!fresh.length) console.log('沒有新訊號');
await writeFile(STATE_FILE, JSON.stringify(state));
