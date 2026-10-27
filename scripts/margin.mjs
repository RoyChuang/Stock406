// 融資融券（證交所 MI_MARGN，每天晚上約 21:00 後公布），以大盤總額為主、00406A 為輔
// - fetchMargin(date)：抓某一天的資料，alert.mjs 晚間覆盤用
// - 直接執行：更新 data/margin.json（近 45 天歷史；pages.yml 先從 data 分支還原舊檔，只補抓缺的日期）
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const SYM = '00406A';
const num = s => +String(s).replace(/,/g, '');
const twse = async (date, type) => {
  const r = await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${date}&selectType=${type}&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`MI_MARGN ${type} HTTP ${r.status}`);
  return r.json();
};

// date：YYYYMMDD。當天還沒公布或休市回傳 null
// 每列都有「前日餘額」「今日餘額」；證交所說明以前日餘額為準、今日餘額為輔，這裡兩個都存
export async function fetchMargin(date) {
  const ms = await twse(date, 'MS'), T = ms.stat === 'OK' && ms.tables?.[0]?.data;
  const row = k => T && T.find(x => x[0].startsWith(k));
  const amt = row('融資金額'), fin = row('融資('), sht = row('融券(');
  if (!amt || !fin || !sht) return null;
  await new Promise(r => setTimeout(r, 800));   // 證交所短時間太多請求會擋
  const etf = await twse(date, '0099P');
  const e = etf.tables?.find(t => t.data?.length)?.data.find(x => x[0] === SYM);
  // ETF 表欄位：融資 買進、賣出、現金償還、前日餘額、今日餘額、限額；融券 買進、賣出、現券償還、前日餘額、今日餘額、限額
  return {
    date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
    amt: Math.round(num(amt[5]) / 1e5), amtPrev: Math.round(num(amt[4]) / 1e5),   // 大盤融資金額（億元）
    fin: num(fin[5]), finPrev: num(fin[4]),                                         // 大盤融資餘額（張）
    short: num(sht[5]), shortPrev: num(sht[4]),                                     // 大盤融券餘額（張）
    etfFin: e ? num(e[6]) : null, etfFinPrev: e ? num(e[5]) : null,                 // 00406A 融資餘額（張）
    etfShort: e ? num(e[12]) : null, etfShortPrev: e ? num(e[11]) : null,           // 00406A 融券餘額（張）
  };
}

const sg = x => (x >= 0 ? '+' : '') + x.toLocaleString('en');
// 推播一行：大盤融資金額增減、券資比；00406A 融資換算金額（price 是收盤價）
export function marginLine(m, price) {
  if (!m) return [];
  const da = m.amt - m.amtPrev, ratio = m.short / m.fin * 100;
  const etf = m.etfFin != null ? `｜00406A 融資 ${sg(m.etfFin - m.etfFinPrev)} 張（約 ${sg(+((m.etfFin - m.etfFinPrev) * price * 1000 / 1e8).toFixed(1))} 億）` : '';
  return [`融資：大盤 ${sg(da)} 億（共 ${m.amt.toLocaleString('en')} 億${da <= -50 ? '，借錢買股的人明顯減少' : da >= 50 ? '，借錢買股的人明顯增加' : ''}）｜券資比 ${ratio.toFixed(1)}%${etf}`];
}

// 直接執行：更新 data/margin.json
if (process.argv[1]?.endsWith('margin.mjs')) {
  let hist = [];
  try { hist = JSON.parse(await readFile('data/margin.json', 'utf8')).days || []; } catch {}
  const have = new Set(hist.map(h => h.date)), now = new Date(Date.now() + 8 * 3600e3), today = now.toISOString().slice(0, 10);
  let calls = 0;
  for (let k = 30; k >= 0 && calls < 25; k--) {
    const d = new Date(now - k * 864e5), iso = d.toISOString().slice(0, 10);
    if (have.has(iso) || [0, 6].includes(d.getUTCDay())) continue;
    calls++;
    try {
      const m = await fetchMargin(iso.replace(/-/g, ''));
      // 過去的日子沒資料＝休市，記下來不再重抓；今天沒資料可能只是還沒公布
      if (m) hist.push(m); else if (iso < today) hist.push({ date: iso, closed: true });
      console.log(iso, m ? `大盤融資 ${m.amt} 億、00406A 融資 ${m.etfFin} 張` : '沒有資料');
    } catch (e) { console.error(iso, e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
  const cut = new Date(now - 45 * 864e5).toISOString().slice(0, 10);
  hist = hist.filter(h => h.date >= cut).sort((a, b) => a.date.localeCompare(b.date));
  await mkdir('data', { recursive: true });
  await writeFile('data/margin.json', JSON.stringify({ t: new Date().toISOString(), days: hist }));
}
