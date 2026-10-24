-- Stock406 第二階段：推播紀錄（公開可讀）
-- 用法：Supabase 後台 → SQL Editor → New query → 貼上整份 → Run。可以重複執行。
-- 這張表不放任何個人資料（沒有張數、均價、預算），所以開放匿名讀取；只有 GitHub Actions（secret key）能寫入。

create table if not exists public.signals (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  trade_date   date not null,               -- 對應的台股交易日（盤前是預估的那一天，晚間是當天）
  symbol       text not null,
  kind         text not null,               -- premarket / evening / met / touch / bbL / fastDown / summary
  title        text not null,
  price        numeric(10, 3),              -- 推播當下的價格（盤前是預估開盤價）
  risk_level   text,                        -- 🟢 低 / 🟡 中 / 🔴 偏高
  risk_score   integer,
  reasons      text[],
  verdict      text,                        -- 依使用者規則的一行結論
  batches      integer[],                   -- 相關的批次編號
  ret_1d       numeric(8, 3),               -- 推播後第 1、5 個交易日收盤相對 price 的漲跌 %，晚間覆盤回補
  ret_5d       numeric(8, 3)
);
create index if not exists signals_symbol_ts on public.signals (symbol, ts desc);

alter table public.signals enable row level security;
drop policy if exists public_read on public.signals;
create policy public_read on public.signals for select to anon, authenticated using (true);

grant select on public.signals to anon, authenticated;
grant select, insert, update, delete on public.signals to service_role;
