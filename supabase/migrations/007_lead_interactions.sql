-- Fase 1.2/1.3 da V2 — Timeline de interações do lead.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em leads/tasks/templates
-- existentes. Rollback: "drop table if exists public.lead_interactions;"
-- (não há dado de outra tabela que dependa dela).

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

comment on table public.lead_interactions is
  'Timeline estruturada de interações com o lead (Fase 1 da V2). Tipos previstos: note, call, follow_up, meeting, proposal, stage_change, system. Canais previstos: manual, phone, crm, whatsapp, instagram, email. Direction: inbound, outbound, internal. Nenhum desses valores tem CHECK constraint ainda (ver docs/CRM_V2_PHASE_01_REPORT.md).';

alter table public.lead_interactions enable row level security;

-- Dono do lead: lê e cria as próprias interações (mesmo padrão de leads/tasks/templates).
create policy "lead_interactions: dono pode ler e criar"
  on public.lead_interactions
  for select using (user_id = auth.uid());

create policy "lead_interactions: dono pode inserir"
  on public.lead_interactions
  for insert with check (user_id = auth.uid());

-- Admin: só leitura de tudo, mesma regra já aplicada a leads (sem poder
-- editar ou excluir interação de outro vendedor).
create policy "lead_interactions: admin pode ler tudo"
  on public.lead_interactions
  for select using (public.is_admin());

create index if not exists lead_interactions_lead_id_idx on public.lead_interactions (lead_id);
create index if not exists lead_interactions_user_id_idx on public.lead_interactions (user_id);
create index if not exists lead_interactions_lead_id_occurred_at_idx on public.lead_interactions (lead_id, occurred_at desc);

alter publication supabase_realtime add table public.lead_interactions;
