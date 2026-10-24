// Supabase REST 小工具：用 secret key（會略過 RLS），只在 GitHub Actions 或本機 journal/.env 裡有金鑰
// 環境變數：SUPABASE_URL（可帶或不帶 /rest/v1/）、SUPABASE_SECRET_KEY
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY;
export const dbReady = !!(URL_ && KEY);

export async function db(path, { method = 'GET', body, prefer } = {}) {
  if (!dbReady) throw new Error('沒有設定 SUPABASE_URL / SUPABASE_SECRET_KEY');
  const r = await fetch(`${URL_}/${path}`, {
    method,
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body && JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
export const rest = (path, opt) => db(`rest/v1/${path}`, opt);
