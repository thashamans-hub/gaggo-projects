-- Klistra in i Supabase → SQL Editor → New query → Run
-- Skapar bucket och tabell för GaGGos Projects.

insert into storage.buckets (id, name, public)
values ('vault', 'vault', true)
on conflict (id) do nothing;

drop policy if exists "vault_public_read"   on storage.objects;
drop policy if exists "vault_public_insert" on storage.objects;
drop policy if exists "vault_public_delete" on storage.objects;
drop policy if exists "vault_files_all"     on public.vault_files;

create policy "vault_public_read"
  on storage.objects for select to public
  using (bucket_id = 'vault');

create policy "vault_public_insert"
  on storage.objects for insert to public
  with check (bucket_id = 'vault');

create policy "vault_public_delete"
  on storage.objects for delete to public
  using (bucket_id = 'vault');

create table if not exists public.vault_files (
  id text primary key,
  name text not null,
  size bigint,
  type text,
  path text,
  url text,
  folder text,
  note text default '',
  "createdAt" timestamptz default now(),
  starred boolean default false,
  pinned boolean default false,
  tags text[] default '{}'
);

alter table public.vault_files enable row level security;

create policy "vault_files_all"
  on public.vault_files for all to anon
  using (true) with check (true);
