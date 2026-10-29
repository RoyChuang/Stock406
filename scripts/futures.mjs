// 外資台指期未平倉（期交所三大法人期貨，每天約 15:00 後公布），只看「臺股期貨」外資及陸資
// - fetchFutures(days)：一次抓近 days 天，alert.mjs 盤前、晚間覆盤、盤中風險用
// - 直接執行：更新 data/futures.json（近一年，給儀表板；一個請求就抓完，不用像融資一樣還原舊檔）
import { mkdir, writeFile } from 'node:fs/promises';

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '/');

// 回傳依日期排序的 [{ date, net 淨未平倉口數（負＝淨空單）, chg 當天多空交易淨額（負＝空單增加）, it 投信淨未平倉, dealer 自營商淨未平倉 }]
export async function fetchFutures(days = 370) {
  const now = new Date(Date.now() + 8 * 3600e3);
  const r = await fetch('https://www.taifex.com.tw/cht/3/futContractsDateDown', {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `queryStartDate=${ymd(new Date(now - days * 864e5))}&queryEndDate=${ymd(now)}&commodityId=TXF` });
  if (!r.ok) throw new Error(`期交所 HTTP ${r.status}`);
  // CSV 欄位：日期,商品名稱,身份別,多方交易口數,…,多空交易口數淨額(7),…,多空未平倉口數淨額(13),…
  const rows = new TextDecoder('big5').decode(await r.arrayBuffer()).trim().split(/\r?\n/).slice(1).map(l => l.split(','));
  const by = {};
  for (const x of rows) {
    if (x.length < 14) continue;
    const d = (by[x[0]] ??= { date: x[0].replace(/\//g, '-') });
    if (x[2].startsWith('外資')) { d.net = +x[13]; d.chg = +x[7]; }
    else if (x[2] === '投信') d.it = +x[13];
    else if (x[2] === '自營商') d.dealer = +x[13];
  }
  const out = Object.values(by).filter(d => d.net != null).sort((a, b) => a.date.localeCompare(b.date));
  if (!out.length) throw new Error('期交所沒有回傳資料');
  return out;
}

// 現在的淨空單比近一年幾 % 的日子還多（0–100）
const shortRank = F => {
  const past = F.slice(-250, -1), cur = F.at(-1).net;
  return past.length ? Math.round(past.filter(d => d.net > cur).length / past.length * 100) : null;
};

// 風險計分：空單一天大增 3000 口以上（近一年約最大的 10%），或淨空單在近一年最多的 10%，加 1 分（兩個都有也只算 1 分）
export function futuresRisk(F) {
  const d = F?.at(-1);
  if (!d) return null;
  if (d.chg <= -3000) return [1, `外資期貨空單一天增加 ${(-d.chg).toLocaleString('en')} 口（押台股會跌）`];
  const rk = shortRank(F);
  if (d.net < 0 && rk >= 90) return [1, `外資期貨空單 ${(-d.net / 1e4).toFixed(1)} 萬口，比近一年 ${rk}% 的日子還多`];
  return null;
}

// 推播一行
export function futuresLine(F) {
  const d = F?.at(-1);
  if (!d) return [];
  const side = d.net < 0 ? '空單' : '多單', rk = shortRank(F);
  const dir = d.chg < 0 ? `空單增加 ${(-d.chg).toLocaleString('en')} 口` : `空單減少 ${d.chg.toLocaleString('en')} 口`;
  return [`外資期貨：淨${side} ${(Math.abs(d.net) / 1e4).toFixed(1)} 萬口（${d.date.slice(5).replace('-', '/')} ${dir}${d.net < 0 && rk >= 90 ? `，比近一年 ${rk}% 的日子還多` : ''}）`];
}

if (process.argv[1]?.endsWith('futures.mjs')) {
  const F = await fetchFutures(370);
  await mkdir('data', { recursive: true });
  await writeFile('data/futures.json', JSON.stringify({ t: new Date().toISOString(), days: F }));
  const d = F.at(-1);
  console.log(`${d.date} 外資淨未平倉 ${d.net} 口（${d.chg >= 0 ? '+' : ''}${d.chg}），共 ${F.length} 天`);
}
