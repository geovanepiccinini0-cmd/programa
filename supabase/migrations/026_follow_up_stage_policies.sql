-- Etapa B — Follow-up configurável por etapa do funil comercial.
-- PREPARADA, NÃO EXECUTADA nesta fase — aplicação manual e deliberada
-- pelo usuário no SQL Editor do Supabase, mesmo processo já usado em
-- todas as fases anteriores deste projeto.
--
-- Aditiva e segura: cria uma tabela nova, não toca em `leads`/`tasks`/
-- `lead_interactions`/`audit_log`/nenhuma tabela do WhatsApp (que
-- permanece pausado e intocado por esta fase). Nenhum dado existente
-- é lido, migrado ou alterado.
--
-- O QUE ISTO CONFIGURA: só os PRAZOS (QUANDO o motor considera um
-- follow-up vencido) que já existiam como a constante global
-- FOLLOW_UP_POLICY em src/lib/followUpEngine.js — nunca o CANAL
-- recomendado (isso continua em nextBestActionPolicy.js, intocado) e
-- nunca decide se o lead está elegível (evaluateFollowUpEligibility,
-- também intocado). Ausência de linha para uma etapa = comportamento
-- IDÊNTICO ao anterior a esta fase (default global).
--
-- DISTINÇÃO EXPLÍCITA (requisito 6 da autorização da Etapa B):
-- `etapa` aqui é SEMPRE o funil comercial (STAGES de constants.js) —
-- nunca `leads.ultima_atualizacao`/`criado_em` (Etapa A, "lead
-- parado") nem `lead_interactions` (histórico de contato). Esta
-- tabela é só CONFIGURAÇÃO — nunca é escrita por nenhuma automação,
-- só por ação explícita do usuário na UI de configuração
-- (FollowUpPolicySettings.jsx); mudar um valor aqui nunca cria task
-- ou interação (requisito 7) — o motor só lê esta tabela na PRÓXIMA
-- avaliação de elegibilidade.
--
-- Rollback: "drop table if exists public.follow_up_stage_policies;"
-- (aditiva, nenhuma outra tabela referencia esta).

-------------------------------------------------------------------
-- PRECONDIÇÕES
-------------------------------------------------------------------
do $$
begin
  if to_regclass('public.leads') is null then
    raise exception 'Precondicao falhou: public.leads nao existe';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_admin'
  ) then
    raise exception 'Precondicao falhou: public.is_admin() nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- A) follow_up_stage_policies — 1 linha por (usuário, etapa). Cada
-- coluna de prazo é NULLABLE: null = "sem override para este campo,
-- usa o default global" (mesma semântica de override PARCIAL já
-- implementada em src/lib/followUpPolicyConfig.js). Nenhuma coluna
-- aqui tem relação com lead_id/lead_interactions — é pura
-- configuração do USUÁRIO, nunca de um lead específico.
-------------------------------------------------------------------
create table if not exists public.follow_up_stage_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  etapa text not null,

  -- Prazo (em horas) para cobrar retorno após uma tentativa de
  -- contato sem resposta (equivalente a FOLLOW_UP_POLICY.attempt.hoursUntilDue).
  attempt_hours_until_due integer,

  -- Prazo (em horas) para cobrar retorno após o envio de uma proposta
  -- (FOLLOW_UP_POLICY.proposal.hoursUntilDue).
  proposal_hours_until_due integer,

  -- Prazo (em horas) sem nova tentativa depois de um engajamento do
  -- lead (FOLLOW_UP_POLICY.noNewAttemptSinceEngagement.hoursUntilDue).
  no_new_attempt_hours_until_due integer,

  -- Quantas tentativas na mesma cadência antes de considerar a
  -- cadência esgotada (FOLLOW_UP_POLICY.maxAttempts).
  max_attempts integer,

  -- Prazo (em dias) para sugerir reativação após a cadência esgotada
  -- (FOLLOW_UP_POLICY.reactivationAfterMaxAttempts.daysUntilDue).
  reactivation_days_until_due integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint follow_up_stage_policies_unique_user_etapa unique (user_id, etapa),

  -- Mesmos limites conservadores já aplicados em
  -- src/lib/followUpPolicyConfig.js (sanitizeStagePolicyOverride) —
  -- defesa em profundidade: mesmo que um valor inválido escape da
  -- validação da UI/app, o banco nunca aceita um prazo absurdo
  -- (negativo, zero, ou maior que os limites de produto).
  constraint follow_up_stage_policies_attempt_range
    check (attempt_hours_until_due is null or (attempt_hours_until_due between 1 and 2160)),
  constraint follow_up_stage_policies_proposal_range
    check (proposal_hours_until_due is null or (proposal_hours_until_due between 1 and 2160)),
  constraint follow_up_stage_policies_no_new_attempt_range
    check (no_new_attempt_hours_until_due is null or (no_new_attempt_hours_until_due between 1 and 2160)),
  constraint follow_up_stage_policies_max_attempts_range
    check (max_attempts is null or (max_attempts between 1 and 20)),
  constraint follow_up_stage_policies_reactivation_range
    check (reactivation_days_until_due is null or (reactivation_days_until_due between 1 and 180))
);

create index if not exists follow_up_stage_policies_user_id_idx
  on public.follow_up_stage_policies (user_id);

comment on table public.follow_up_stage_policies is
  'Etapa B — override OPCIONAL e PARCIAL dos prazos de follow-up (src/lib/followUpEngine.js FOLLOW_UP_POLICY), por etapa do funil comercial E por usuário. Ausência de linha = comportamento padrão global, idêntico ao anterior a esta fase. Nunca relacionada a leads.ultima_atualizacao (Etapa A) nem a lead_interactions (histórico comercial) — eixo de configuração independente. Nunca escrita por automação — só por ação explícita do usuário.';

-- Rollback deste bloco: "drop table if exists public.follow_up_stage_policies;"

-------------------------------------------------------------------
-- B) Trigger de consistência — mesmo princípio já usado em
-- whatsapp_conversation_state (migration 024): força user_id a
-- partir de auth.uid() (nunca aceita do cliente) e mantém
-- updated_at. Como esta tabela não referencia leads, não há
-- user_id "derivado de outra tabela" para validar — é só o próprio
-- usuário autenticado, sempre.
-------------------------------------------------------------------
create or replace function public.follow_up_stage_policies_consistency_check()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.user_id := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists follow_up_stage_policies_consistency_check_trigger on public.follow_up_stage_policies;
create trigger follow_up_stage_policies_consistency_check_trigger
  before insert or update on public.follow_up_stage_policies
  for each row execute function public.follow_up_stage_policies_consistency_check();

comment on function public.follow_up_stage_policies_consistency_check() is
  'Etapa B — forca user_id = auth.uid() (nunca aceita do cliente) e mantem updated_at. security invoker (nunca definer) — não precisa ler nenhuma outra tabela, diferente do equivalente em whatsapp_conversation_state (024).';

-- Rollback deste bloco: "drop trigger if exists follow_up_stage_policies_consistency_check_trigger on public.follow_up_stage_policies; drop function if exists public.follow_up_stage_policies_consistency_check();"

-------------------------------------------------------------------
-- C) RLS — dono pode ler/criar/atualizar/excluir SÓ a própria
-- configuração. Sem policy de admin: diferente de leads/métricas,
-- configuração de follow-up é pessoal de cada vendedor, nunca
-- compartilhada nem visível por outro usuário (nem admin) — decisão
-- de produto desta fase, documentada aqui para nunca ficar implícita.
-------------------------------------------------------------------
alter table public.follow_up_stage_policies enable row level security;

drop policy if exists "follow_up_stage_policies: dono pode ler" on public.follow_up_stage_policies;
create policy "follow_up_stage_policies: dono pode ler"
  on public.follow_up_stage_policies
  for select using (user_id = auth.uid());

drop policy if exists "follow_up_stage_policies: dono pode inserir" on public.follow_up_stage_policies;
create policy "follow_up_stage_policies: dono pode inserir"
  on public.follow_up_stage_policies
  for insert with check (user_id = auth.uid());

drop policy if exists "follow_up_stage_policies: dono pode atualizar" on public.follow_up_stage_policies;
create policy "follow_up_stage_policies: dono pode atualizar"
  on public.follow_up_stage_policies
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "follow_up_stage_policies: dono pode excluir" on public.follow_up_stage_policies;
create policy "follow_up_stage_policies: dono pode excluir"
  on public.follow_up_stage_policies
  for delete using (user_id = auth.uid());

-- Nenhuma coluna sensível/derivada de servidor nesta tabela (ao
-- contrário de whatsapp_conversation_state.last_read_at) — por isso
-- o GRANT é de TABELA INTEIRA para authenticated, sem restrição de
-- coluna: todas as colunas de configuração são deliberadamente
-- editáveis pelo próprio dono. RLS acima é a fronteira real.
grant select, insert, update, delete on public.follow_up_stage_policies to authenticated;
grant all on public.follow_up_stage_policies to service_role;

-- Rollback deste bloco: nenhum necessário isoladamente — já cobrto pelo "drop table" do bloco A.
