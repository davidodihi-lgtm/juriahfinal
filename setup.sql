-- ============ JURIAH MONIQUE ADORNMENTS — SUPABASE SETUP ============
-- Paste this whole file into Supabase > SQL Editor > Run.
-- Safe to run on top of the earlier products table.

-- 1) Products table (creates it if you haven't yet)
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric not null,
  description text,
  image_url text,
  category text,
  in_stock boolean default true,
  created_at timestamp default now()
);
alter table products add column if not exists badge text;
alter table products add column if not exists sort_order int default 0;

-- 2) Security: public can read, only logged-in owner can change
alter table products enable row level security;
drop policy if exists "Public can read products" on products;
drop policy if exists "Authenticated users can manage products" on products;
create policy "Public can read products" on products for select using (true);
create policy "Authenticated users can manage products" on products for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- 3) Photo storage bucket (public read, owner-only upload/edit/delete)
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "Public read product images" on storage.objects;
drop policy if exists "Owner upload product images" on storage.objects;
drop policy if exists "Owner update product images" on storage.objects;
drop policy if exists "Owner delete product images" on storage.objects;
create policy "Public read product images" on storage.objects for select using (bucket_id = 'product-images');
create policy "Owner upload product images" on storage.objects for insert to authenticated with check (bucket_id = 'product-images');
create policy "Owner update product images" on storage.objects for update to authenticated using (bucket_id = 'product-images');
create policy "Owner delete product images" on storage.objects for delete to authenticated using (bucket_id = 'product-images');

-- 4) Starting products (only if the table is empty). Photos come from the site's /images folder.
insert into products (name, price, description, image_url, category, badge, sort_order)
select * from (values
 ('Ivory & Silver Necklace', 26, 'Warm white glass beads set between brushed silver rondelles.', 'images/necklace-ivory-silver.jpeg', 'necklace', 'Bestseller', 1),
 ('Onyx & Silver Necklace', 26, 'Deep matte black beads paired with the same silver rondelles.', 'images/necklace-onyx-silver.jpeg', 'necklace', null, 2),
 ('Blush & Peacock Necklace', 29, 'Soft lilac-pink beads alternating with peacock iridescent glass.', 'images/necklace-blush-peacock.jpeg', 'necklace', 'New', 3),
 ('Aurora Iridescent Necklace', 24, 'Single-strand glass beads that shift from teal to violet in the light.', 'images/necklace-aurora-iridescent.jpeg', 'necklace', null, 4),
 ('Ruby & Crystal Necklace', 22, 'Bright red and clear glass beads for an everyday pop of color.', 'images/necklace-ruby-crystal.jpeg', 'necklace', null, 5),
 ('Amber Glass Necklace', 25, 'Warm honey-toned glass beads with a soft golden glow.', 'images/necklace-amber-glass.jpeg', 'necklace', null, 6),
 ('Coral & Moonstone Bracelet', 19, 'Chunky coral-red beads spaced with milky moonstone-tone rounds.', 'images/bracelet-coral-moonstone.jpeg', 'bracelet', 'New', 7),
 ('Turquoise & Gold Necklace', 27, 'Turquoise and gold beads accented with tiny red spacers.', 'images/necklace-turquoise-gold.jpeg', 'necklace', null, 8),
 ('Crystal & Silver Necklace', 23, 'Clear glass beads knotted between antiqued silver rondelles.', 'images/necklace-crystal-silver.jpeg', 'necklace', null, 9),
 ('Ivory & Bronze Necklace', 26, 'Cream beads set against warm antiqued bronze rondelles.', 'images/necklace-ivory-bronze.jpeg', 'necklace', null, 10)
) as v(name, price, description, image_url, category, badge, sort_order)
where not exists (select 1 from products);
