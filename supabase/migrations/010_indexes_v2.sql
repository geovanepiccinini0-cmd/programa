-- Fase 1.11 da V2 — índices para suportar o crescimento da base de leads.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Só cria índices (CREATE INDEX IF NOT EXISTS) — não altera dado nenhum,
-- é seguro rodar a qualquer momento, inclusive com o app em produção.
-- Rollback: "drop index if exists <nome>;" para qualquer um deles.
--
-- lead_interactions já teve seus índices criados na migration 007
-- (lead_interactions_lead_id_idx, lead_interactions_user_id_idx,
-- lead_interactions_lead_id_occurred_at_idx) — não duplicados aqui.

create index if not exists leads_user_id_idx on public.leads (user_id);
create index if not exists leads_etapa_idx on public.leads (etapa);
create index if not exists leads_proximo_contato_idx on public.leads (proximo_contato);
create index if not exists leads_user_id_etapa_idx on public.leads (user_id, etapa);

create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_lead_id_idx on public.tasks (lead_id);
create index if not exists tasks_data_idx on public.tasks (data);
create index if not exists tasks_user_id_data_idx on public.tasks (user_id, data);
