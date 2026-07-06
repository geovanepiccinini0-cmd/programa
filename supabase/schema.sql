-- CRM Piccinini · schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase
-- (Project > SQL Editor > New query > colar e Run).

create extension if not exists "pgcrypto";

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null,
  telefone text,
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
  criado_em date not null default current_date,
  ultima_atualizacao date not null default current_date,
  created_at timestamptz not null default now()
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

alter table public.leads enable row level security;
alter table public.templates enable row level security;
alter table public.tasks enable row level security;

create policy "leads: dono pode tudo" on public.leads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "templates: dono pode tudo" on public.templates
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "tasks: dono pode tudo" on public.tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Realtime: permite que a UI sincronize entre abas/dispositivos automaticamente
alter publication supabase_realtime add table public.leads;
alter publication supabase_realtime add table public.templates;
alter publication supabase_realtime add table public.tasks;
