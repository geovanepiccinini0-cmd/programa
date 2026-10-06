-- Fase 1.14 da V2 — tabela de auditoria para alterações críticas.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em nenhuma existente.
-- Nesta fase o app só grava aqui mudança de etapa (incluindo Ganho/Perdido)
-- — não há trigger automática em cada update de cada tabela, para manter
-- o impacto mínimo (ver docs/CRM_V2_PHASE_01_REPORT.md).
-- Rollback: "drop table if exists public.audit_log;".

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

comment on table public.audit_log is
  'Fase 1 da V2: log de alterações críticas (nesta fase, só mudança de etapa do lead, incluindo Ganho/Perdido). Nunca deve conter secrets/tokens/credenciais — old_data/new_data carregam só os campos de negócio relevantes à mudança.';

alter table public.audit_log enable row level security;

create policy "audit_log: dono pode ler e criar"
  on public.audit_log
  for select using (user_id = auth.uid());

create policy "audit_log: dono pode inserir"
  on public.audit_log
  for insert with check (user_id = auth.uid());

create policy "audit_log: admin pode ler tudo"
  on public.audit_log
  for select using (public.is_admin());

create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_user_id_idx on public.audit_log (user_id);
