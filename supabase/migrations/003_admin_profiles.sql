-- Rode este arquivo no SQL Editor do seu projeto Supabase (o projeto que já
-- existia antes desta atualização — instalações novas já recebem tudo isso
-- direto pelo supabase/schema.sql).
--
-- Cria o conceito de "administrador": qualquer usuário marcado como admin
-- passa a poder LER (mas não editar) os leads de todos os outros usuários,
-- para acompanhar métricas gerais. Tarefas continuam 100% privadas de cada
-- vendedor, sem acesso do admin.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: usuário vê o próprio perfil" on public.profiles;
create policy "profiles: usuário vê o próprio perfil" on public.profiles
  for select using (id = auth.uid());

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "profiles: admin pode ler tudo" on public.profiles;
create policy "profiles: admin pode ler tudo" on public.profiles
  for select using (public.is_admin());

drop policy if exists "leads: admin pode ler tudo" on public.leads;
create policy "leads: admin pode ler tudo" on public.leads
  for select using (public.is_admin());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, is_admin)
  values (new.id, new.email, false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: cria o perfil do(s) usuário(s) que já existiam antes desta
-- migração (o trigger acima só roda para usuários criados a partir de agora).
insert into public.profiles (id, email, is_admin)
select id, email, false from auth.users
on conflict (id) do nothing;

-- Marque o SEU usuário como administrador (substitua pelo seu e-mail de
-- login no CRM):
update public.profiles set is_admin = true
where email = 'SEU_EMAIL_AQUI@exemplo.com';
