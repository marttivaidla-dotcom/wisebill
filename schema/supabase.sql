-- WiseBill andmebaas (Supabase). Käivita tühjas projektis üks kord; korduv käivitamine on ohutu.
-- Õigused: kasutaja näeb ainult nende firmade andmeid, mille liige ta on (company_members).
-- Kõik liikmed on võrdsed: muudavad firmat, saadavad arveid, jagavad firmat teistega.
-- Kasutajaid lisab ainult admin (avalik registreerimine on Supabase'i seadetes välja lülitatud).

-- ---------- Kasutajad ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Firmad ----------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  reg_number text not null default '',
  vat_number text,
  address text,
  iban text,
  accounts jsonb not null default '[]',                -- kontoplaan [{code, name, type}]
  default_expense_account text,
  default_income_account text,
  billberry jsonb,                                       -- {env, keyId, key, checkedAt}
  mappings jsonb not null default '{"parties":{},"articles":{},"accounts":{}}', -- õpitud koodid/kontod
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.company_members (
  company_id uuid not null references public.companies on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  added_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index if not exists company_members_user on public.company_members (user_id);

-- Juba imporditud / Booksis olevad arved – duplikaatide kontroll
create table if not exists public.register_entries (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies on delete cascade,
  direction text not null check (direction in ('sales', 'purchase')),
  party_reg_number text not null default '',
  party_name text not null default '',
  number text not null,
  date text not null,
  gross numeric(14, 2) not null,
  source text not null check (source in ('wisebill', 'books')),
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles on delete set null default auth.uid()
);
create index if not exists register_entries_company on public.register_entries (company_id);

-- ---------- Abifunktsioonid ----------
create or replace function public.is_member(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_members where company_id = c and user_id = auth.uid())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- Uus firma + looja liikmeks ühe päringuga (RLS lubab firmat näha alles liikmel)
create or replace function public.create_company(p_name text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Pole sisse logitud'; end if;
  insert into public.companies (name, created_by) values (coalesce(p_name, ''), auth.uid()) returning id into cid;
  insert into public.company_members (company_id, user_id) values (cid, auth.uid());
  return cid;
end $$;

-- Jaga firmat teise kasutajaga e-posti järgi (iga liige tohib)
create or replace function public.share_company(p_company uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if not public.is_member(p_company) then raise exception 'Sul pole selle firma õigusi'; end if;
  select id into uid from public.profiles where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'Kasutajat % ei leitud. Admin peab ta enne lisama.', p_email; end if;
  insert into public.company_members (company_id, user_id) values (p_company, uid) on conflict do nothing;
end $$;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists companies_touch on public.companies;
create trigger companies_touch before update on public.companies
  for each row execute function public.touch_updated_at();

-- ---------- Rea taseme turve ----------
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.register_entries enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);

drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies for select to authenticated using (public.is_member(id));
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update to authenticated using (public.is_member(id));
drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies for delete to authenticated using (public.is_member(id));
-- insert ainult create_company() kaudu

drop policy if exists members_read on public.company_members;
create policy members_read on public.company_members for select to authenticated using (public.is_member(company_id));
drop policy if exists members_delete on public.company_members;
create policy members_delete on public.company_members for delete to authenticated using (public.is_member(company_id));
-- insert ainult create_company() / share_company() kaudu

drop policy if exists register_all on public.register_entries;
create policy register_all on public.register_entries for all to authenticated
  using (public.is_member(company_id)) with check (public.is_member(company_id));

revoke all on function public.create_company(text) from public, anon;
revoke all on function public.share_company(uuid, text) from public, anon;
grant execute on function public.create_company(text) to authenticated;
grant execute on function public.share_company(uuid, text) to authenticated;
