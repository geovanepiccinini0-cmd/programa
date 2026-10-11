-- Etapa D — Tarefas comerciais automáticas por etapa do funil.
-- PREPARADA, NÃO EXECUTADA nesta fase — aplicação manual e deliberada
-- pelo usuário no SQL Editor do Supabase, mesmo processo já usado em
-- todas as fases anteriores deste projeto.
--
-- Aditiva e segura: adiciona 1 coluna NULLABLE e 1 índice único
-- PARCIAL à tabela `tasks` já existente — reaproveita integralmente a
-- infraestrutura atual de tarefas (requisito "reutilize a
-- infraestrutura existente em vez de criar um segundo sistema de
-- tarefas"), nunca cria uma tabela nova. Nenhuma linha existente é
-- lida, migrada ou alterada; nenhuma policy de RLS é tocada (a tabela
-- `tasks` já é só-dono, ver docs/ARCHITECTURE_V1.md — "tasks: só o
-- dono acessa — nem o admin vê tarefas de outro usuário" — isso
-- continua valendo integralmente, sem nenhuma mudança). Nenhuma
-- tabela/migration do WhatsApp (pausado) ou das Etapas B/C
-- (follow_up_stage_policies, follow_up_snoozes) é tocada.
--
-- DISTINÇÃO EXPLÍCITA (requisitos da autorização da Etapa D):
-- - `etapa_gatilho` só é preenchida em tarefas com
--   `origem = 'auto_stage'` (src/lib/autoStageTasks.js) — nunca nas
--   tarefas 'manual'/'lead-agenda'/'auto'/'rotina' já existentes, que
--   continuam escrevendo exatamente as mesmas colunas de sempre (ver
--   taskToRow, src/lib/db.js: guard `!== undefined`, nunca envia esta
--   coluna para quem não a usa).
-- - `origem = 'auto_stage'` é uma string NOVA, deliberadamente
--   diferente de 'automation' (um blocker já existente e reservado em
--   src/lib/followUpEngine.js, nunca usado por nenhuma automação até
--   hoje) — os dois conceitos nunca se confundem.
--
-- Rollback: "drop index if exists public.tasks_auto_stage_pending_unique_idx; alter table public.tasks drop column if exists etapa_gatilho;"
-- (aditiva, nenhuma outra tabela/coluna depende desta).

-------------------------------------------------------------------
-- PRECONDIÇÃO — `tasks` é a tabela baseline do projeto (anterior a
-- qualquer migration deste histórico, ver docs/ARCHITECTURE_V1.md) —
-- a verificação abaixo só confirma que ela existe ANTES de tentar
-- alterá-la, para falhar com uma mensagem clara em vez de um erro
-- genérico do Postgres caso esta migration seja aplicada num banco
-- sem o schema baseline.
-------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'tasks') then
    raise exception 'Migration 028 depende da tabela baseline public.tasks — confirme o schema antes de aplicar.';
  end if;
end $$;

-------------------------------------------------------------------
-- A) coluna etapa_gatilho — registra QUAL etapa do funil disparou a
-- criação desta tarefa automática (só preenchida quando
-- `origem = 'auto_stage'`; sempre NULL para as demais origens, que
-- nunca escrevem esta coluna — ver taskToRow acima). É o que permite
-- o dedupe "mesmo lead + mesmo evento de entrada na etapa" (requisito
-- 6) sem precisar inferir a partir do título (texto livre, nunca
-- confiável para identidade).
-------------------------------------------------------------------
alter table public.tasks add column if not exists etapa_gatilho text;

comment on column public.tasks.etapa_gatilho is
  'Etapa D — etapa do funil (STAGES de constants.js) que disparou esta tarefa automática. Só preenchida quando origem = ''auto_stage''; NULL para toda tarefa manual/lead-agenda/auto/rotina já existente.';

-- Rollback deste bloco: "alter table public.tasks drop column if exists etapa_gatilho;" (também remove o índice do bloco B, que depende da coluna).

-------------------------------------------------------------------
-- B) índice único PARCIAL — requisito 7 ("garanta idempotência
-- inclusive com duas abas ou operações concorrentes... não dependa
-- apenas de uma verificação no React"). Este é o mecanismo REAL de
-- idempotência: hasPendingAutoStageTask (autoStageTasks.js) é só a
-- 1ª linha de defesa do lado do cliente — duas abas podem passar por
-- ela ao mesmo tempo, ANTES de qualquer uma escrever. O índice único
-- abaixo garante que, mesmo assim, só UMA linha com o mesmo
-- (lead_id, etapa_gatilho) PENDENTE (concluida = false) pode existir
-- para tarefas origem='auto_stage' — a segunda tentativa (de
-- qualquer aba) falha com 23505 (unique_violation), que
-- tasksApi.insertAutoStage (db.js) trata como sucesso idempotente
-- (devolve null), nunca como erro.
--
-- PARCIAL (where origem='auto_stage' and concluida=false), não um
-- índice único incondicional, por dois motivos:
-- 1) `etapa_gatilho` é NULL para toda tarefa que não é origem=
--    'auto_stage' — um índice único incondicional sobre
--    (lead_id, etapa_gatilho) trataria todas essas linhas (NULL,
--    NULL seria a única combinação repetida, mas múltiplos leads sem
--    etapa_gatilho em comum colidiriam de qualquer forma na
--    combinação (lead_id, NULL) de cada um) como parte do mesmo
--    espaço de unicidade das tarefas desta fase, o que é incorreto;
-- 2) `concluida=false` é o que implementa o requisito 8 (preservar
--    histórico, nunca apagar tarefas concluídas) MAIS o requisito 6
--    ("mesmo evento de entrada na etapa", não "a etapa alguma vez")
--    ao mesmo tempo: uma tarefa já concluída nunca conflita com uma
--    nova (ela saiu do escopo do índice no momento em que
--    concluida passou a true), permitindo um novo ciclo pela mesma
--    etapa gerar sua própria tarefa, exatamente como
--    hasPendingAutoStageTask (autoStageTasks.js) já decide do lado
--    puro.
-------------------------------------------------------------------
create unique index if not exists tasks_auto_stage_pending_unique_idx
  on public.tasks (lead_id, etapa_gatilho)
  where origem = 'auto_stage' and concluida = false;

comment on index public.tasks_auto_stage_pending_unique_idx is
  'Etapa D — garante, no nível do banco, no máximo 1 tarefa auto_stage PENDENTE por (lead_id, etapa_gatilho), mesmo sob duas abas/operações concorrentes. Tarefas concluídas saem do escopo do índice (permitem um novo ciclo pela mesma etapa).';

-- Rollback deste bloco: "drop index if exists public.tasks_auto_stage_pending_unique_idx;"

-------------------------------------------------------------------
-- VERIFICAÇÃO MANUAL recomendada após aplicar esta migration no
-- Supabase real (mesmo princípio das verificações documentadas na
-- migration 027) — nunca executada automaticamente por este arquivo:
--
--   1. Coluna presente:
--      select column_name from information_schema.columns
--        where table_schema = 'public' and table_name = 'tasks' and column_name = 'etapa_gatilho';
--   2. Índice único parcial presente e com a condição esperada:
--      select indexname, indexdef from pg_indexes
--        where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_auto_stage_pending_unique_idx';
--   3. RLS de `tasks` continua exatamente como antes (esta migration
--      não altera nenhuma policy):
--      select polname, polcmd from pg_policy where polrelid = 'public.tasks'::regclass;
