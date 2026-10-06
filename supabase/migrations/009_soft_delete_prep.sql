-- Fase 1.13 da V2 — preparação para soft delete (NÃO ativado nesta fase).
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Esta migration só cria a coluna. O comportamento de exclusão continua
-- sendo o mesmo de hoje (delete físico) — nada no app foi alterado para
-- usar esta coluna ainda. Rollback: "alter table public.leads drop column
-- if exists deleted_at;".

alter table public.leads add column if not exists deleted_at timestamptz;

comment on column public.leads.deleted_at is
  'Fase 1 V2 (preparação, não ativado): quando preenchido, marcaria o lead como excluído sem apagar a linha. Hoje a exclusão de lead continua sendo física (delete real) — ver estratégia em docs/CRM_V2_PHASE_01_REPORT.md antes de ativar o uso desta coluna.';
