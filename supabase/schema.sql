-- CRM Piccinini · schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase
-- (Project > SQL Editor > New query > colar e Run).

create extension if not exists "pgcrypto";

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null,
  telefone text,
  cidade text,
  canal text,
  produto text not null,
  etapa text not null,
  tipo text,
  credito numeric,
  entrada numeric,
  parcela numeric,
  lance numeric,
  valor numeric,
  valor_imovel numeric,
  proximo_contato date,
  proximo_contato_horario text,
  notas text,
  tags text[] not null default '{}',
  criado_em date not null default current_date,
  ultima_atualizacao date not null default current_date,
  created_at timestamptz not null default now(),
  -- Campos V2 (Fase 1 — fundação técnica, ver docs/ARCHITECTURE_V1.md e docs/CRM_V2_PHASE_01_REPORT.md)
  next_action_type text,
  next_action_note text,
  lead_temperature text,
  priority text not null default 'normal',
  lost_reason text,
  lost_reason_note text,
  won_at timestamptz,
  lost_at timestamptz,
  deleted_at timestamptz
);

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  titulo text not null,
  categoria text not null,
  horario text,
  dias text[] not null default '{}',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  titulo text not null,
  categoria text not null,
  data date,
  horario text,
  concluida boolean not null default false,
  lead_id uuid references public.leads(id) on delete set null,
  origem text not null default 'manual',
  template_id uuid references public.templates(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.lead_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  type text not null,
  direction text,
  channel text,
  content text,
  metadata jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;
alter table public.templates enable row level security;
alter table public.tasks enable row level security;
alter table public.profiles enable row level security;
alter table public.lead_interactions enable row level security;
alter table public.audit_log enable row level security;

create policy "leads: dono pode tudo" on public.leads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "templates: dono pode tudo" on public.templates
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "tasks: dono pode tudo" on public.tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "profiles: usuário vê o próprio perfil" on public.profiles
  for select using (id = auth.uid());

-- Função auxiliar (security definer = ignora RLS internamente ao consultar
-- profiles, evitando recursão) usada para dar ao admin visão de leitura
-- sobre os leads de todos os vendedores, sem dar acesso de escrita.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create policy "profiles: admin pode ler tudo" on public.profiles
  for select using (public.is_admin());

create policy "leads: admin pode ler tudo" on public.leads
  for select using (public.is_admin());

-- Admin também pode editar e mudar de etapa os leads de qualquer vendedor
-- (mas não excluir — a exclusão continua restrita ao dono do lead).
create policy "leads: admin pode editar tudo" on public.leads
  for update using (public.is_admin()) with check (public.is_admin());

-- Cria automaticamente um perfil (não-admin) para cada novo usuário cadastrado
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

-- lead_interactions (timeline do lead — Fase 1 V2): dono lê/cria só as
-- próprias, admin só lê tudo (mesma regra de leitura de leads).
create policy "lead_interactions: dono pode ler e criar" on public.lead_interactions
  for select using (user_id = auth.uid());
create policy "lead_interactions: dono pode inserir" on public.lead_interactions
  for insert with check (user_id = auth.uid());
create policy "lead_interactions: admin pode ler tudo" on public.lead_interactions
  for select using (public.is_admin());

-- audit_log (Fase 1 V2): mesma regra de lead_interactions.
create policy "audit_log: dono pode ler e criar" on public.audit_log
  for select using (user_id = auth.uid());
create policy "audit_log: dono pode inserir" on public.audit_log
  for insert with check (user_id = auth.uid());
create policy "audit_log: admin pode ler tudo" on public.audit_log
  for select using (public.is_admin());

-- Índices (Fase 1 V2 — suportar o crescimento da base de leads)
create index if not exists leads_user_id_idx on public.leads (user_id);
create index if not exists leads_etapa_idx on public.leads (etapa);
create index if not exists leads_proximo_contato_idx on public.leads (proximo_contato);
create index if not exists leads_user_id_etapa_idx on public.leads (user_id, etapa);
create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_lead_id_idx on public.tasks (lead_id);
create index if not exists tasks_data_idx on public.tasks (data);
create index if not exists tasks_user_id_data_idx on public.tasks (user_id, data);
create index if not exists lead_interactions_lead_id_idx on public.lead_interactions (lead_id);
create index if not exists lead_interactions_user_id_idx on public.lead_interactions (user_id);
create index if not exists lead_interactions_lead_id_occurred_at_idx on public.lead_interactions (lead_id, occurred_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_user_id_idx on public.audit_log (user_id);

-- Realtime: permite que a UI sincronize entre abas/dispositivos automaticamente
alter publication supabase_realtime add table public.leads;
alter publication supabase_realtime add table public.templates;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.lead_interactions;
