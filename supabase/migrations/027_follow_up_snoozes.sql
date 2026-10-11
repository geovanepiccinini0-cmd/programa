-- Etapa C — Adiamento de follow-ups ("Adiar"/"Cancelar adiamento").
-- PREPARADA, NÃO EXECUTADA nesta fase — aplicação manual e deliberada
-- pelo usuário no SQL Editor do Supabase, mesmo processo já usado em
-- todas as fases anteriores deste projeto.
--
-- Aditiva e segura: cria uma tabela nova, não toca em `leads`/`tasks`/
-- `lead_interactions`/`audit_log`/`follow_up_stage_policies`/nenhuma
-- tabela do WhatsApp (que permanece pausado e intocado por esta
-- fase). Nenhum dado existente é lido, migrado ou alterado.
--
-- DISTINÇÃO EXPLÍCITA (requisitos da autorização da Etapa C):
-- - `follow_up_snoozes` é uma tabela NOVA e SEPARADA — nunca uma
--   coluna em `leads`, nunca reaproveita `tasks` (origem
--   'lead-agenda'/'auto', tarefas de agenda já existentes). Adiar um
--   follow-up nunca cria/altera/remove uma task.
-- - Nunca escreve em `lead_interactions` — o histórico de mensagens/
--   ligações/tentativas comerciais nunca é apagado nem modificado por
--   um adiamento ou pelo seu cancelamento.
-- - Nunca altera `leads.etapa`/`leads.deleted_at` — adiar não arquiva
--   nem muda a etapa do funil.
-- - 1 linha por LEAD (lead_id é a própria PK — diferente de
--   follow_up_stage_policies, que é 1 linha por ETAPA+usuário): os
--   dois eixos de configuração (Etapa B: QUANDO o motor considera
--   vencido, por etapa; Etapa C: adiar um vencimento específico, por
--   lead) são independentes e se compõem em src/lib/followUpQueue.js,
--   nunca se sobrepõem no banco.
--
-- Rollback: "drop table if exists public.follow_up_snoozes;"
-- (aditiva, nenhuma outra tabela referencia esta).

-------------------------------------------------------------------
-- PRECONDIÇÃO — esta tabela tem FK para `leads` (diferente de
-- follow_up_stage_policies, que não tem): a própria FK
-- `references public.leads(id)` já garante a integridade referencial
-- no nível do banco; a verificação abaixo só confirma que a tabela
-- `leads` existe ANTES de tentar criar essa FK, para falhar com uma
-- mensagem clara em vez de um erro genérico do Postgres caso esta
-- migration seja aplicada fora de ordem.
-------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'leads') then
    raise exception 'Migration 027 depende da tabela public.leads (migrations anteriores) — aplique-as antes.';
  end if;
end $$;

-------------------------------------------------------------------
-- A) follow_up_snoozes — 1 linha por LEAD. `lead_id` é a própria PK
-- (nunca um id próprio) porque não há sentido em mais de um
-- adiamento simultâneo para o mesmo lead — salvar um novo adiamento
-- SUBSTITUI o anterior (ver followUpSnoozesApi.save, src/lib/db.js:
-- UPDATE -> INSERT -> retry, nunca .upsert()/ON CONFLICT, mesmo
-- hotfix do PR #72 aplicado aqui). `user_id` é redundante com o
-- user_id de `leads` (que já determina a posse), mas replicado aqui
-- (mesmo padrão de whatsapp_conversation_state, migration 024) para
-- permitir RLS simples e direta (`user_id = auth.uid()`) sem subquery
-- em cada policy, e para o índice de user_id ficar eficiente mesmo
-- sem join. O trigger abaixo (seção B) é quem GARANTE que este
-- `user_id` é sempre o dono real do lead, nunca confiando no cliente.
-------------------------------------------------------------------
create table if not exists public.follow_up_snoozes (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snoozed_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists follow_up_snoozes_user_id_idx
  on public.follow_up_snoozes (user_id);

comment on table public.follow_up_snoozes is
  'Etapa C — adiamento OPCIONAL de um follow-up, por lead. 1 linha por lead (lead_id é a PK) — salvar um novo adiamento substitui o anterior. Nunca relacionado a tasks (origem lead-agenda) nem a lead_interactions (histórico comercial, nunca alterado por esta tabela). Ausência de linha, ou snoozed_until no passado, = comportamento padrão (elegibilidade sempre recalculada ao vivo por evaluateFollowUpEligibility + applySnoozeToEvaluation, nunca um status persistido).';

-- Rollback deste bloco: "drop table if exists public.follow_up_snoozes;"

-------------------------------------------------------------------
-- B) Trigger de consistência — diferente de follow_up_stage_policies
-- (024/026, user_id = auth.uid() direto), esta tabela tem uma FK para
-- `lead_id`: o dono real é quem o PRÓPRIO LEAD pertence
-- (leads.user_id), nunca um valor enviado pelo cliente. Mesmo
-- princípio e mesma justificativa de SECURITY DEFINER já usado em
-- whatsapp_conversation_state_consistency_check (migration 024): a
-- função precisa LER leads.user_id para validar a posse, e RLS de
-- leads poderia bloquear essa leitura para o chamador em cenários
-- futuros — SECURITY DEFINER garante que a verificação sempre
-- funciona, SEM nunca confiar em nenhum valor vindo do client.
--
-- Por que isto é seguro mesmo "forçando" user_id em todo UPDATE
-- (mesmo raciocínio já documentado/testado em migration 026): a
-- policy de UPDATE (seção C) já exige `using (user_id = auth.uid())`
-- — ninguém nunca consegue nem comerçar a atualizar uma linha de
-- outro usuário, com ou sem este trigger. O trigger é a segunda
-- camada: mesmo que o client tentasse enviar um lead_id de um lead de
-- OUTRO usuário (tentativa de "roubar" o adiamento para um lead que
-- não é seu), o INSERT falharia na policy de INSERT (with check
-- user_id = auth.uid(), e o trigger forçaria user_id = owner do
-- lead_id informado — se o lead não for do chamador, o user_id
-- forçado nunca vai ser igual a auth.uid(), e a policy rejeita).
-------------------------------------------------------------------
create or replace function public.follow_up_snoozes_consistency_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lead_owner uuid;
begin
  select user_id into lead_owner from public.leads where id = new.lead_id;
  if lead_owner is null then
    raise exception 'Lead % não encontrado — adiamento requer um lead existente.', new.lead_id;
  end if;
  new.user_id := lead_owner;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists follow_up_snoozes_consistency_check_trigger on public.follow_up_snoozes;
create trigger follow_up_snoozes_consistency_check_trigger
  before insert or update on public.follow_up_snoozes
  for each row execute function public.follow_up_snoozes_consistency_check();

comment on function public.follow_up_snoozes_consistency_check() is
  'Etapa C — forca user_id = dono real do lead (leads.user_id via lookup SECURITY DEFINER, nunca aceita do cliente) e mantem updated_at. Mesmo padrão de whatsapp_conversation_state_consistency_check (024).';

-- Rollback deste bloco: "drop trigger if exists follow_up_snoozes_consistency_check_trigger on public.follow_up_snoozes; drop function if exists public.follow_up_snoozes_consistency_check();"

-------------------------------------------------------------------
-- C) RLS — dono do LEAD pode ler/criar/atualizar/excluir SÓ o
-- adiamento dos próprios leads. Sem policy de admin — adiamento é
-- uma conveniência operacional pessoal do vendedor responsável pelo
-- lead, mesma decisão de produto já aplicada a follow_up_stage_policies.
-------------------------------------------------------------------
alter table public.follow_up_snoozes enable row level security;

drop policy if exists "follow_up_snoozes: dono pode ler" on public.follow_up_snoozes;
create policy "follow_up_snoozes: dono pode ler"
  on public.follow_up_snoozes
  for select using (user_id = auth.uid());

drop policy if exists "follow_up_snoozes: dono pode inserir" on public.follow_up_snoozes;
create policy "follow_up_snoozes: dono pode inserir"
  on public.follow_up_snoozes
  for insert with check (user_id = auth.uid());

drop policy if exists "follow_up_snoozes: dono pode atualizar" on public.follow_up_snoozes;
create policy "follow_up_snoozes: dono pode atualizar"
  on public.follow_up_snoozes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "follow_up_snoozes: dono pode excluir" on public.follow_up_snoozes;
create policy "follow_up_snoozes: dono pode excluir"
  on public.follow_up_snoozes
  for delete using (user_id = auth.uid());

-- Nenhuma coluna sensível/derivada de servidor além de user_id (já
-- protegido pelo trigger acima) — GRANT de tabela inteira para
-- authenticated, RLS acima é a fronteira real. Mesmo padrão de
-- follow_up_stage_policies (026).
grant select, insert, update, delete on public.follow_up_snoozes to authenticated;
grant all on public.follow_up_snoozes to service_role;

-- Rollback deste bloco: nenhum necessário isoladamente — já cobrto pelo "drop table" do bloco A.
