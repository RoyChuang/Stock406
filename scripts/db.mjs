// 在本機讀寫 Supabase 的部位資料（金鑰放 journal/.env，該資料夾不進 git）
// 用法：
//   node scripts/db.mjs show [代號]                         看部位、預算、分批、規則
//   node scripts/db.mjs trade buy|sell 日期 價格 張數 [備註] [代號]   記一筆成交
//   node scripts/db.mjs budget 金額 [代號]                   設定總預算（含已投入）
//   node scripts/db.mjs ladder 價位:張數 ... [代號]          重設分批，例如 prev:4 bbL:9 lo60:15 或 8.5:5
//   node scripts/db.mjs fill 批次 [代號]                     把某一批標成已買，推播就不再看這批
//   node scripts/db.mjs rules 分鐘 項數 [代號]               B 的分鐘數、C 至少幾項
// 代號預設 00406A
import { readFileSync } from 'node:fs';
try {
  for (const line of readFileSync(new URL('../journal/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const { db, rest } = await import('./supabase.mjs');

const [cmd, ...args] = process.argv.slice(2);
const isSym = s => /^[0-9A-Z]{4,6}[A-Z]?$/.test(s || '') && !/^\d+(\.\d+)?$/.test(s);
const symOf = a => (isSym(a.at(-1)) ? a.pop() : '00406A');

// secret key 沒有登入身分，寫入時要明確帶 user_id：取 Auth 裡唯一的使用者
async function userId() {
  const { users } = await db('auth/v1/admin/users');
  if (users.length !== 1) throw new Error(`Auth 裡有 ${users.length} 個使用者，預期 1 個`);
  return users[0].id;
}

async function show(sym) {
  const [pos, lad, rul, trades] = await Promise.all([
    rest(`positions?symbol=eq.${sym}`), rest(`ladder?symbol=eq.${sym}&order=seq`),
    rest(`rules?symbol=eq.${sym}`), rest(`trades?symbol=eq.${sym}&order=traded_on.desc,id.desc&limit=5`)]);
  const p = pos[0];
  console.log(p ? `${sym}：${p.lots} 張，均價 ${p.avg_price}，成本 ${Math.round(p.cost).toLocaleString()}，預算 ${p.budget ?? '未設'}，剩 ${p.budget_left != null ? Math.round(p.budget_left).toLocaleString() : '—'}` : `${sym}：沒有交易紀錄`);
  console.log('分批：' + (lad.map(l => `${l.status === 'active' ? '' : '✔'}第${l.seq}批 ${l.level}×${l.lots}`).join('、') || '未設定'));
  console.log('規則：' + (rul[0] ? `B ${rul[0].confirm_min} 分、C 至少 ${rul[0].c_min} 項` : '預設（15 分、3 項）'));
  for (const t of trades) console.log(`  ${t.traded_on} ${t.side === 'buy' ? '買' : '賣'} ${t.price} × ${t.lots}${t.note ? `（${t.note}）` : ''}`);
}

const sym = symOf(args);
if (cmd === 'show' || !cmd) await show(sym);
else if (cmd === 'trade') {
  const [side, date, price, lots, note] = args;
  if (!['buy', 'sell'].includes(side) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(+price > 0) || !(+lots > 0)) throw new Error('用法：trade buy|sell YYYY-MM-DD 價格 張數 [備註]');
  await rest('trades', { method: 'POST', body: { user_id: await userId(), symbol: sym, side, traded_on: date, price: +price, lots: +lots, note: note || null } });
  await show(sym);
} else if (cmd === 'budget') {
  await rest('budgets', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: await userId(), symbol: sym, total: +args[0] } });
  await show(sym);
} else if (cmd === 'ladder') {
  const uid = await userId(), rows = args.map((a, i) => { const [level, lots] = a.split(':'); return { user_id: uid, symbol: sym, seq: i + 1, level, lots: +lots || 0 }; });
  await rest(`ladder?symbol=eq.${sym}`, { method: 'DELETE' });
  await rest('ladder', { method: 'POST', body: rows });
  await show(sym);
} else if (cmd === 'fill') {
  await rest(`ladder?symbol=eq.${sym}&seq=eq.${+args[0]}`, { method: 'PATCH', body: { status: 'filled', updated_at: new Date().toISOString() } });
  await show(sym);
} else if (cmd === 'rules') {
  await rest('rules', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: await userId(), symbol: sym, confirm_min: +args[0], c_min: +args[1] } });
  await show(sym);
} else throw new Error(`不認得的指令：${cmd}`);
