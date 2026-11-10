-- Run once in Supabase > SQL Editor. Stores paid orders sent by the Stripe webhook.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text unique not null,
  stripe_payment_intent text,
  customer_email text,
  customer_name text,
  shipping_address jsonb,
  items jsonb not null,
  amount_total numeric not null,
  currency text default 'usd',
  status text default 'paid',
  created_at timestamptz default now()
);
alter table orders enable row level security;
drop policy if exists "Owner can read orders" on orders;
drop policy if exists "Owner can update orders" on orders;
create policy "Owner can read orders" on orders for select to authenticated using (true);
create policy "Owner can update orders" on orders for update to authenticated using (true) with check (true);
-- No public access. The webhook writes using the server-side secret key.
