// 大盤成交金額（證交所 FMTQIK 每日市場成交資訊，收盤後約 14:00 公布，一個請求一個月）
// 使用者規則（2026-11-04 定）：大盤成交量不能一直量縮——成交金額連續 volDays 天「一天比一天少」（看 volDays+1 天）就不買（一定要符合）
const UA = { 'User-Agent': 'Mozilla/5.0' };
const num = s => +String(s).replace(/,/g, '');

// 回傳 [{ d: 'YYYY-MM-DD', amt: 成交金額（億元） }]，包含 upTo 當月與上個月（月初也夠算）
export async function fetchTurnover(upTo) {
  const [y, m] = upTo.split('-').map(Number), months = [[y, m], m === 1 ? [y - 1, 12] : [y, m - 1]];
  const out = [];
  for (const [yy, mm] of months) {
    const j = await (await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${yy}${String(mm).padStart(2, '0')}01&response=json`, { headers: UA })).json();
    if (j.stat !== 'OK') { if (yy === y && mm === m) continue; throw new Error(j.stat || 'FMTQIK 讀取失敗'); }
    for (const r of j.data) {
      const [ry, rm, rd] = r[0].trim().split('/').map(Number);
      out.push({ d: `${ry + 1911}-${String(rm).padStart(2, '0')}-${String(rd).padStart(2, '0')}`, amt: num(r[2]) / 1e8 });
    }
  }
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

// 只用 before（不含）以前的交易日判斷；回傳 { ok, days, text, why }，讀不到時 ok = null（不擋）
export function volRule(T, before, n = 3) {
  const a = (T || []).filter(x => x.d < before).slice(-(n + 1));
  if (a.length < n + 1) return { ok: null, text: '大盤成交金額：讀取失敗（這項先不檢查）', why: '' };
  const shrink = a.every((x, i) => !i || x.amt < a[i - 1].amt);
  const path = a.map(x => Math.round(x.amt).toLocaleString('en-US')).join(' → ');
  return { ok: !shrink, days: a,
    text: `大盤成交量沒有一直變少（一定要符合，連續 ${n} 天變少就不買）：近 ${n + 1} 天成交金額 ${path} 億${shrink ? `，已經連續 ${n} 天變少` : ''}`,
    why: `大盤成交量連續 ${n} 天變少` };
}

// 推播用一行（盤前、晚間）：rule 是 volRule 的結果，when 是「今天」或「明天」
export function volLine(rule, when) {
  if (rule.ok == null) return [];
  const last = rule.days.at(-1), prev = rule.days.at(-2), chg = (last.amt / prev.amt - 1) * 100;
  return [`大盤成交金額：${last.d.slice(5).replace('-', '/')} ${Math.round(last.amt).toLocaleString('en-US')} 億（${chg >= 0 ? '+' : ''}${chg.toFixed(0)}%）${rule.ok ? '' : `，已連續 ${rule.days.length - 1} 天變少，${when}依規則不買`}`];
}
