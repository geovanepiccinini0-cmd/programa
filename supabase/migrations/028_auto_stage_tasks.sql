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
--   taskToRow, src/lib/db.js: NUNCA emite esta coluna para nenhum
--   chamador — só tasksApi.insertAutoStage grava, e só no INSERT).
-- - `origem = 'auto_stage'` é uma string NOVA, deliberadamente
--   diferente de 'automation' (um blocker já existente e reservado em
--   src/lib/followUpEngine.js, nunca usado por nenhuma automação até
--   hoje) — os dois conceitos nunca se confundem.
--
-- Correção pós-revisão do PR #76 (achado 5) — `tasks.origem`/
-- `tasks.categoria` NÃO têm (e nunca tiveram) nenhum CHECK no schema
-- baseline deste projeto (docs/ARCHITECTURE_V1.md: "nenhuma tem CHECK
-- constraint... validados somente no frontend"), então
-- `origem = 'auto_stage'` é permitida sem nenhuma alteração adicional
-- — confirmado também empiricamente na validação local (ver relatório
-- do PR). Esta migration ACRESCENTA, de forma mínima e aditiva, só a
-- invariante NOVA que o requisito 5 pede para a coluna NOVA desta
-- fase (bloco B abaixo) — nunca uma CHECK retroativa sobre
-- origem/categoria em geral, que poderia falhar contra dados antigos
-- fora do controle desta fase e está fora do escopo mínimo necessário.
--
-- Rollback: "drop index if exists public.tasks_auto_stage_pending_unique_idx; alter table public.tasks drop constraint if exists tasks_auto_stage_etapa_gatilho_consistency; alter table public.tasks drop column if exists etapa_gatilho;"
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

-- Rollback deste bloco: "alter table public.tasks drop column if exists etapa_gatilho;" (também remove a CHECK do bloco B e o índice do bloco C, que dependem da coluna).

-------------------------------------------------------------------
-- B) CHECK de consistência — requisito 5 ("integridade dos campos").
-- Garante, no nível do banco, exatamente a relação que
-- src/lib/autoStageTasks.js já impõe do lado puro
-- (computeAutoStageTaskData sempre preenche `etapaGatilho` quando e
-- só quando `origem = 'auto_stage'`, e sempre com `leadId` presente —
-- uma tarefa auto_stage sem lead não tem sentido de domínio):
--   (origem <> 'auto_stage' e etapa_gatilho é null)
--   OU (origem = 'auto_stage' e etapa_gatilho NÃO é null e lead_id NÃO é null)
-- Nunca falha para nenhuma linha PRÉ-EXISTENTE: antes desta migration
-- nenhuma linha tem `origem = 'auto_stage'` (string nova desta fase) e
-- todas têm `etapa_gatilho` NULL (coluna recém-criada, default NULL,
-- bloco A) — o primeiro branch da condição vale para 100% das linhas
-- já existentes, então `add constraint` nunca encontra uma violação.
--
-- Isto também resolve, por construção, a preocupação levantada na
-- revisão sobre "UNIQUE(lead_id, etapa_gatilho) não cobrir múltiplos
-- NULL sem NULLS NOT DISTINCT" (achado 5): o índice do bloco C é
-- PARCIAL (`where origem='auto_stage' and concluida=false`), e dentro
-- desse subconjunto de linhas esta CHECK já GARANTE que
-- `etapa_gatilho` nunca é NULL — o problema clássico de "múltiplos
-- NULL não contam como duplicados" nunca chega a existir no espaço de
-- linhas que o índice de fato enxerga; `NULLS NOT DISTINCT` seria
-- necessário se o índice indexasse linhas com `etapa_gatilho` NULL,
-- o que, por esta CHECK, nunca acontece dentro do filtro
-- `origem = 'auto_stage'`.
-------------------------------------------------------------------
-- `alter table ... add constraint` não tem `if not exists` (diferente
-- de `create index`/`create table`) — o bloco DO abaixo torna a
-- adição idempotente manualmente, mesmo padrão já usado para a
-- publication Realtime na migration 027 (checar antes de agir, nunca
-- deixar uma re-execução falhar com "already exists").
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass and conname = 'tasks_auto_stage_etapa_gatilho_consistency'
  ) then
    alter table public.tasks
      add constraint tasks_auto_stage_etapa_gatilho_consistency
      check (
        (origem is distinct from 'auto_stage' and etapa_gatilho is null)
        or
        (origem = 'auto_stage' and etapa_gatilho is not null and lead_id is not null)
      ) not valid;
  end if;
end $$;

-- `not valid` + `validate constraint` em dois passos (em vez de um
-- `add constraint` único): evita um ACCESS EXCLUSIVE lock de validação
-- de todas as linhas já existentes bloquear escritas concorrentes em
-- `tasks` por mais tempo que o necessário — mesmo cuidado operacional
-- recomendado pela documentação do Postgres para tabelas em uso. A
-- validação em si é rápida (0 linhas podem violar, ver acima), mas o
-- padrão em dois passos é mantido aqui como prática consistente.
-- `validate constraint` é naturalmente idempotente: reaplicá-la a uma
-- constraint já validada é um no-op rápido, nunca um erro.
alter table public.tasks validate constraint tasks_auto_stage_etapa_gatilho_consistency;

comment on constraint tasks_auto_stage_etapa_gatilho_consistency on public.tasks is
  'Etapa D — etapa_gatilho preenchida se e somente se origem=''auto_stage'', e nesse caso lead_id também é obrigatório. Nunca violada por linhas anteriores a esta migration (todas tinham origem <> ''auto_stage'' e etapa_gatilho NULL).';

-- Rollback deste bloco: "alter table public.tasks drop constraint if exists tasks_auto_stage_etapa_gatilho_consistency;"

-------------------------------------------------------------------
-- C) índice único PARCIAL — requisito 7 ("garanta idempotência
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
--
-- LIMITAÇÃO EXPLÍCITA (achado 6 da revisão do PR #76, documentada
-- igualmente em autoStageTasks.js) — este índice impede duplicação
-- enquanto existir uma linha PENDENTE para (lead_id, etapa_gatilho),
-- NÃO impede duas tarefas para "o mesmo lead voltou a entrar nesta
-- etapa" em geral: se o lead reentra na mesma etapa enquanto a tarefa
-- da entrada anterior AINDA está pendente, nenhuma segunda é criada
-- (a pendente já cobre as duas entradas, por desenho); só depois que
-- ela é concluída OU excluída (onDeleteTask, controle genérico já
-- existente) é que uma nova entrada na mesma etapa volta a gerar
-- tarefa. "Tarefa cancelada" neste domínio é sinônimo de "excluída"
-- — não existe um terceiro estado "cancelada" distinto de "concluída"
-- na tabela `tasks` hoje; ambos retiram a linha do conjunto PENDENTE
-- que este índice (e hasPendingAutoStageTask) enxergam.
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
--   2. CHECK de consistência presente e VALIDADA (não apenas
--      declarada — confirme convalidated = true, nunca 'not valid'
--      pendurado):
--      select conname, convalidated, pg_get_constraintdef(oid) from pg_constraint
--        where conrelid = 'public.tasks'::regclass and conname = 'tasks_auto_stage_etapa_gatilho_consistency';
--   3. Índice único parcial presente e com a condição esperada:
--      select indexname, indexdef from pg_indexes
--        where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_auto_stage_pending_unique_idx';
--   4. RLS de `tasks` continua exatamente como antes (esta migration
--      não altera nenhuma policy):
--      select polname, polcmd from pg_policy where polrelid = 'public.tasks'::regclass;
--   5. Teste funcional de integridade (deve FALHAR, confirmando a
--      CHECK): tentar inserir uma linha com origem='auto_stage' e
--      etapa_gatilho NULL deve ser rejeitado pelo Postgres.
