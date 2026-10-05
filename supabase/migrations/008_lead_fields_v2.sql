-- Fase 1.6 a 1.10 da V2 — novos campos de qualificação/acompanhamento do lead.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- 100% aditivo: só adiciona colunas nullable (ou com default inofensivo)
-- em public.leads. Nenhum dado existente é alterado ou lido para isso.
-- Rollback (nessa ordem, se precisar remover tudo desta migration):
--   alter table public.leads
--     drop column if exists next_action_type,
--     drop column if exists next_action_note,
--     drop column if exists lead_temperature,
--     drop column if exists priority,
--     drop column if exists lost_reason,
--     drop column if exists lost_reason_note,
--     drop column if exists won_at,
--     drop column if exists lost_at;

alter table public.leads
  -- 1.6 — próxima ação: não só QUANDO falar com o cliente, mas O QUE fazer.
  -- Valores usados pelo frontend: call | whatsapp | meeting | proposal | follow_up | other
  add column if not exists next_action_type text,
  add column if not exists next_action_note text,

  -- 1.7 — temperatura do lead (classificação manual nesta fase).
  -- Valores usados pelo frontend: cold | warm | hot
  add column if not exists lead_temperature text,

  -- 1.8 — prioridade.
  -- Valores usados pelo frontend: low | normal | high | urgent
  add column if not exists priority text not null default 'normal',

  -- 1.9 — motivo de perda (preenchido quando etapa = 'Perdido').
  -- Valores usados pelo frontend: sem_condicao | sem_interesse | nao_responde |
  --   fechou_concorrente | credito_reprovado | adiou_decisao | outro
  add column if not exists lost_reason text,
  add column if not exists lost_reason_note text,

  -- 1.10 — data/hora em que o lead entrou em Ganho/Perdido (ver regra de
  -- consistência em docs/CRM_V2_PHASE_01_REPORT.md).
  add column if not exists won_at timestamptz,
  add column if not exists lost_at timestamptz;

comment on column public.leads.next_action_type is 'Fase 1 V2: tipo da próxima ação planejada (call, whatsapp, meeting, proposal, follow_up, other). Sem CHECK constraint ainda.';
comment on column public.leads.lead_temperature is 'Fase 1 V2: classificação manual (cold, warm, hot). Sem CHECK constraint ainda, sem scoring automático nesta fase.';
comment on column public.leads.priority is 'Fase 1 V2: prioridade manual (low, normal, high, urgent). Default normal.';
comment on column public.leads.lost_reason is 'Fase 1 V2: motivo de perda, preenchido quando etapa = Perdido. Não obrigatório.';
comment on column public.leads.won_at is 'Fase 1 V2: timestamp em que o lead entrou na etapa Ganho, mantido automaticamente pela aplicação.';
comment on column public.leads.lost_at is 'Fase 1 V2: timestamp em que o lead entrou na etapa Perdido, mantido automaticamente pela aplicação.';
