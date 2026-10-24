-- Stock406 第一階段：交易紀錄、預算、分批規則、規則參數
-- 用法：Supabase 後台 → SQL Editor → New query → 貼上整份 → Run。可以重複執行。
-- 隱私：每張表都開 RLS，只有登入的本人看得到自己的資料；GitHub Actions 用 secret key 讀寫（會略過 RLS）。
-- 這份檔案在公開 repo，不要在這裡寫任何個人數字。

-- 每筆買賣。期初部位也記成一筆 buy（備註寫「期初」）
create table if not exists public.trades (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  symbol      text not null,
  traded_on   date not null,
  side        text not null check (side in ('buy', 'sell')),
  price       numeric(10, 3) not null check (price > 0),
  lots        integer not null check (lots > 0),
  fee         numeric(12, 0) not null default 0,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists trades_user_symbol on public.trades (user_id, symbol, traded_on);

-- 每檔的總預算（含已投入）
create table if not exists public.budgets (
  user_id  uuid not null default auth.uid() references auth.users on delete cascade,
  symbol   text not null,
  total    numeric(14, 0) not null check (total >= 0),
  primary key (user_id, symbol)
);

-- 分批規則：level 可以是固定價格（'9.06'）或動態值（'prev'、'bbL'、'lo20'、'lo60'、'pct-3'）
-- 買完一批就把 status 改成 filled，推播自動不再看那一批
create table if not exists public.ladder (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  symbol      text not null,
  seq         integer not null,
  level       text not null,
  lots        integer not null default 0 check (lots >= 0),
  status      text not null default 'active' check (status in ('active', 'filled', 'off')),
  trade_id    bigint references public.trades on delete set null,
  updated_at  timestamptz not null default now(),
  unique (user_id, symbol, seq)
);

-- 進場規則參數（B：當日低點幾分鐘沒破；C：5 項環境至少幾項）
create table if not exists public.rules (
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  symbol       text not null,
  confirm_min  integer not null default 15,
  c_min        integer not null default 3,
  primary key (user_id, symbol)
);

-- 目前部位：由交易紀錄算出（均價只算買進的加權平均，賣出不影響均價）
create or replace view public.positions with (security_invoker = true) as
select
  t.user_id,
  t.symbol,
  sum(case when t.side = 'buy' then t.lots else -t.lots end)                         as lots,
  round(sum(case when t.side = 'buy' then t.price * t.lots end)
        / nullif(sum(case when t.side = 'buy' then t.lots end), 0), 3)               as avg_price,
  sum(case when t.side = 'buy' then t.price * t.lots * 1000 + t.fee
           else -(t.price * t.lots * 1000) + t.fee end)                              as cost,
  b.total                                                                             as budget,
  b.total - sum(case when t.side = 'buy' then t.price * t.lots * 1000 + t.fee
                     else -(t.price * t.lots * 1000) + t.fee end)                    as budget_left
from public.trades t
left join public.budgets b on b.user_id = t.user_id and b.symbol = t.symbol
group by t.user_id, t.symbol, b.total;

-- 建專案時關掉了「Automatically expose new tables」，所以要自己開權限：只給登入的人（authenticated）和 Actions（service_role），不給匿名（anon）
grant select, insert, update, delete on public.trades, public.budgets, public.ladder, public.rules to authenticated, service_role;
grant select on public.positions to authenticated, service_role;
revoke all on public.trades, public.budgets, public.ladder, public.rules, public.positions from anon;

-- RLS：只能看、改自己的資料
alter table public.trades  enable row level security;
alter table public.budgets enable row level security;
alter table public.ladder  enable row level security;
alter table public.rules   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['trades', 'budgets', 'ladder', 'rules'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;
