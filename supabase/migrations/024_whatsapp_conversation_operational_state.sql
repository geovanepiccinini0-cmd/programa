-- Fase 3.6.2 — Estados operacionais de atendimento da conversa
-- WhatsApp (pendente_resposta / em_atendimento / aguardando_cliente /
-- concluido). Migration ADITIVA — nunca edita 018-023 (histórico
-- intocado). ZERO execução em produção nesta fase — só preparação
-- local, aplicação manual e deliberada pelo usuário no SQL Editor do
-- Supabase, mesmo processo já usado nas fases anteriores.
--
-- DISTINÇÃO EXPLÍCITA (nunca confundida, requisito explícito desta
-- fase): este é o estado OPERACIONAL/HUMANO da conversa (quem precisa
-- agir agora), nunca o status de ENTREGA da Meta
-- (whatsapp_messages.status/sent_at/delivered_at/read_at, Fase
-- 3.5.2.3). Tabela, trigger e RPC desta migration NUNCA leem nem
-- escrevem em whatsapp_messages. Nenhuma função aqui altera
-- leads.etapa/tags/qualquer coluna de funil comercial — isso
-- permanece exclusivamente manual pelo usuário.
--
-- Rollback: ver comentário de cada bloco.

-------------------------------------------------------------------
-- PRECONDIÇÕES
-------------------------------------------------------------------
do $$
begin
  if to_regclass('public.leads') is null then
    raise exception 'Precondicao falhou: public.leads nao existe';
  end if;
  if to_regclass('public.whatsapp_messages') is null then
    raise exception 'Precondicao falhou: public.whatsapp_messages (migration 018) nao existe';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_admin'
  ) then
    raise exception 'Precondicao falhou: public.is_admin() nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- A) whatsapp_conversation_state — 1 linha por lead (conversa = a
-- thread de whatsapp_messages daquele lead, mesmo agrupamento já
-- usado pela caixa de entrada desde a Fase 3.5.1/3.6.0). user_id
-- NUNCA é aceito do cliente — sempre derivado de leads.user_id por
-- trigger (seção B), mesmo princípio já usado em whatsapp_messages
-- (018).
-------------------------------------------------------------------
create table if not exists public.whatsapp_conversation_state (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pendente_resposta',
  -- Correção pós-revisão do PR #68 (achado CONFIRMED: sem nenhuma
  -- noção de ordem, a RPC automática podia aplicar um evento
  -- ATRASADO/fora de ordem por cima de um estado mais recente —
  -- ver seção D). last_event_at é o timestamp do evento (mensagem
  -- inbound real / confirmação outbound real) que determinou a
  -- ÚLTIMA transição AUTOMÁTICA aplicada — nunca escrito por uma
  -- alteração manual (ver seção C/db.js), que nunca inclui esta
  -- coluna no UPDATE.
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_conversation_state_status_check
    check (status in ('pendente_resposta', 'em_atendimento', 'aguardando_cliente', 'concluido'))
);

create index if not exists whatsapp_conversation_state_user_id_idx
  on public.whatsapp_conversation_state (user_id);

comment on table public.whatsapp_conversation_state is
  'Fase 3.6.2 — estado OPERACIONAL de atendimento humano de uma conversa WhatsApp (1 linha por lead). NUNCA confundir com status de entrega da Meta (whatsapp_messages.status/sent_at/delivered_at/read_at) — eixos independentes, nunca escritos pelo mesmo caminho. NUNCA altera leads.etapa/tags.';

comment on column public.whatsapp_conversation_state.status is
  'pendente_resposta (cliente enviou, aguardando o CRM) | em_atendimento (definido manualmente — nunca sobrescrito por evento automático, ver apply_whatsapp_conversation_operational_event) | aguardando_cliente (CRM enviou, aguardando o cliente) | concluido (definido manualmente). Alteração manual sempre permitida para qualquer um dos 4 valores, via UPDATE direto (RLS, seção C) — nunca via RPC.';

comment on column public.whatsapp_conversation_state.last_event_at is
  'Timestamp do evento (mensagem inbound real / confirmação outbound real) que determinou a última transição AUTOMÁTICA — usado pela RPC (seção D) para recusar um evento atrasado/fora de ordem (p_event_timestamp menor que este valor). NUNCA tocado por alteração manual.';

-- Rollback deste bloco: "drop table if exists public.whatsapp_conversation_state cascade;"

-------------------------------------------------------------------
-- B) Trigger de consistência — deriva/força user_id a partir de
-- leads.user_id (nunca confia no client, nem em service_role) e
-- bloqueia troca de lead_id após a criação. Mesmo padrão de
-- imutabilidade reforçada já usado em whatsapp_messages (022) —
-- trigger nunca é ignorado por role, diferente de RLS.
-------------------------------------------------------------------
create or replace function public.whatsapp_conversation_state_consistency_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead_user_id uuid;
begin
  if tg_op = 'UPDATE' and new.lead_id is distinct from old.lead_id then
    raise exception 'whatsapp_conversation_state: lead_id e imutavel (tentativa de trocar % para %)', old.lead_id, new.lead_id;
  end if;

  select l.user_id into v_lead_user_id from public.leads l where l.id = new.lead_id;
  if v_lead_user_id is null then
    raise exception 'whatsapp_conversation_state: lead % nao encontrado', new.lead_id;
  end if;

  new.user_id := v_lead_user_id;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists whatsapp_conversation_state_consistency_check_trigger on public.whatsapp_conversation_state;
create trigger whatsapp_conversation_state_consistency_check_trigger
  before insert or update on public.whatsapp_conversation_state
  for each row execute function public.whatsapp_conversation_state_consistency_check();

comment on function public.whatsapp_conversation_state_consistency_check() is
  'Fase 3.6.2 — forca user_id = leads.user_id (nunca aceita do cliente, nunca do service_role) e bloqueia troca de lead_id apos a criacao. security definer so para poder ler leads.user_id mesmo quando o chamador so teria acesso de LEITURA via RLS a sua propria linha — nunca expande o que o chamador pode LER de leads (so este uso interno pontual), nunca expande o que pode ESCREVER.';

-- Rollback deste bloco: "drop trigger if exists whatsapp_conversation_state_consistency_check_trigger on public.whatsapp_conversation_state; drop function if exists public.whatsapp_conversation_state_consistency_check();"

-------------------------------------------------------------------
-- C) RLS — dono do lead pode ler/criar/alterar manualmente (mesmo
-- padrão de leads/templates); admin lê e edita tudo (mesmo padrão de
-- leads, 005_admin_edit_leads.sql), nunca exclui. Sem policy de
-- DELETE para authenticated/admin — só cascade via FK quando o lead é
-- removido.
-------------------------------------------------------------------
alter table public.whatsapp_conversation_state enable row level security;

drop policy if exists "whatsapp_conversation_state: dono pode ler" on public.whatsapp_conversation_state;
create policy "whatsapp_conversation_state: dono pode ler"
  on public.whatsapp_conversation_state for select
  using (user_id = auth.uid());

drop policy if exists "whatsapp_conversation_state: admin pode ler tudo" on public.whatsapp_conversation_state;
create policy "whatsapp_conversation_state: admin pode ler tudo"
  on public.whatsapp_conversation_state for select
  using (public.is_admin());

drop policy if exists "whatsapp_conversation_state: dono pode inserir" on public.whatsapp_conversation_state;
create policy "whatsapp_conversation_state: dono pode inserir"
  on public.whatsapp_conversation_state for insert
  with check (user_id = auth.uid());

drop policy if exists "whatsapp_conversation_state: admin pode inserir" on public.whatsapp_conversation_state;
create policy "whatsapp_conversation_state: admin pode inserir"
  on public.whatsapp_conversation_state for insert
  with check (public.is_admin());

drop policy if exists "whatsapp_conversation_state: dono pode atualizar" on public.whatsapp_conversation_state;
create policy "whatsapp_conversation_state: dono pode atualizar"
  on public.whatsapp_conversation_state for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "whatsapp_conversation_state: admin pode atualizar" on public.whatsapp_conversation_state;
create policy "whatsapp_conversation_state: admin pode atualizar"
  on public.whatsapp_conversation_state for update
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.whatsapp_conversation_state from anon;
grant select, insert, update on public.whatsapp_conversation_state to authenticated;
grant all on public.whatsapp_conversation_state to service_role;

-- Rollback deste bloco: "alter table public.whatsapp_conversation_state disable row level security;" seguido de "drop policy ..." para cada policy acima (ou simplesmente dropar a tabela inteira, ver bloco A).

-------------------------------------------------------------------
-- D) apply_whatsapp_conversation_operational_event — chamada
-- EXCLUSIVAMENTE pelos dois composition roots já aprovados
-- (whatsapp-webhook e whatsapp-send) via client service_role, SEMPRE
-- APÓS o evento real já ter sido confirmado (mensagem inbound
-- persistida / envio confirmado) — nunca antes, nunca especulativo.
-- user_id NUNCA é parâmetro (nunca aceito de fora) — sempre derivado
-- de leads.user_id, mesmo princípio do trigger da seção B.
--
-- CORREÇÃO (revisão do PR #68 antes da implantação, achado
-- CONFIRMED): a assinatura original só recebia lead_id/event_type,
-- sem NENHUMA noção de quando o evento realmente ocorreu. Isso
-- permitia que um evento ATRASADO ou entregue FORA DE ORDEM (ex.: a
-- confirmação de um envio outbound demora alguns segundos — timeout/
-- retry de rede — e só é persistida DEPOIS de uma mensagem inbound
-- mais recente já ter marcado a conversa como pendente_resposta; a
-- confirmação atrasada então sobrescreveria isso de volta para
-- aguardando_cliente, escondendo que o cliente já respondeu) ou uma
-- REENTREGA genuína da Meta chegando fora de ordem sobrescrevesse
-- indevidamente um estado mais recente. Novo parâmetro obrigatório
-- p_event_timestamp (o timestamp REAL do evento — occurredAt da
-- mensagem inbound, ou o instante da confirmação outbound) +
-- last_event_at (seção A) resolvem isso: um evento cujo timestamp é
-- ANTERIOR ao último já aplicado é IGNORADO (nunca aplicado, nunca
-- um erro — redelivery legítima da Meta sempre recebe ACK).
--
-- CORREÇÃO 2 (revisão adicional, achado CONFIRMED: concorrência real
-- na PRIMEIRA inserção): um `SELECT ... FOR UPDATE` isolado só trava
-- uma linha que já existe — contra DUAS chamadas simultâneas criando
-- a linha pela PRIMEIRA vez para o MESMO lead, não há nada para
-- travar antes de qualquer uma delas commitar, e a antiga versão
-- desta função não tinha NENHUMA guarda de ordenação dentro do
-- próprio INSERT ... ON CONFLICT DO UPDATE (sempre sobrescrevia,
-- incondicionalmente). Corrigido: a guarda de ordenação agora vive
-- DENTRO da cláusula WHERE do próprio ON CONFLICT DO UPDATE —
-- avaliada pelo Postgres atomicamente contra a linha JÁ COMMITADA no
-- exato momento do conflito (nunca contra uma leitura separada e
-- potencialmente obsoleta). Duas transações concorrentes tentando
-- criar a linha pela primeira vez para o mesmo lead_id são
-- serializadas pelo próprio índice único da chave primária — a
-- segunda delas SEMPRE enxerga o conflito com a primeira já
-- committada (nunca um "ambas inserem", nunca uma leitura suja) e
-- decide com a WHERE abaixo, nunca com um valor obsoleto. O
-- `SELECT ... FOR UPDATE` isolado foi removido (não é mais necessário
-- nem suficiente — a correção real é só a cláusula WHERE).
--
-- REGRA DE PRECEDÊNCIA (simples, documentada, verificada SOMENTE
-- quando a guarda de ordenação acima permite a atualização):
-- 'em_atendimento' é PEGAJOSO — uma vez definido (sempre
-- manualmente, nunca por esta função), nenhum evento automático
-- (inbound_received OU outbound_sent) o sobrescreve. Qualquer OUTRO
-- estado atual (pendente_resposta/aguardando_cliente/concluido) É
-- sobrescrito pelo evento automático correspondente — inclusive
-- reabrindo uma conversa 'concluido' quando chega uma nova mensagem
-- do cliente (comportamento esperado: uma conversa não permanece
-- "concluída" para sempre só porque foi marcada assim antes de uma
-- nova mensagem).
-------------------------------------------------------------------
create or replace function public.apply_whatsapp_conversation_operational_event(
  p_lead_id uuid,
  p_event_type text,
  p_event_timestamp timestamptz
)
returns table (status text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_new_status text;
  v_applied_status text;
begin
  if p_lead_id is null then
    raise exception 'apply_whatsapp_conversation_operational_event: p_lead_id nao pode ser nulo';
  end if;
  if p_event_type not in ('inbound_received', 'outbound_sent') then
    raise exception 'apply_whatsapp_conversation_operational_event: p_event_type invalido (%)', p_event_type;
  end if;
  if p_event_timestamp is null then
    raise exception 'apply_whatsapp_conversation_operational_event: p_event_timestamp nao pode ser nulo';
  end if;

  select l.user_id into v_user_id from public.leads l where l.id = p_lead_id;
  if v_user_id is null then
    raise exception 'apply_whatsapp_conversation_operational_event: lead % nao encontrado', p_lead_id;
  end if;

  v_new_status := case p_event_type
    when 'inbound_received' then 'pendente_resposta'
    when 'outbound_sent' then 'aguardando_cliente'
  end;

  -- Upsert atômico único — tanto a criação da linha (primeira
  -- inserção, nunca em conflito) quanto a atualização concorrente
  -- (conflito, decidido pela WHERE abaixo) acontecem na MESMA
  -- instrução SQL, sem nenhuma janela entre "ler" e "decidir". Quando
  -- a WHERE é falsa (evento atrasado/fora de ordem), a linha
  -- simplesmente NÃO é tocada — nem o trigger de consistência
  -- (seção B) chega a rodar para essa tentativa, e o RETURNING abaixo
  -- não devolve nenhuma linha (nunca um erro).
  insert into public.whatsapp_conversation_state as wcs (lead_id, user_id, status, last_event_at)
  values (p_lead_id, v_user_id, v_new_status, p_event_timestamp)
  on conflict (lead_id) do update
    set status = case
      when wcs.status = 'em_atendimento' then wcs.status
      else excluded.status
    end,
    last_event_at = excluded.last_event_at
  where wcs.last_event_at is null or excluded.last_event_at >= wcs.last_event_at
  returning wcs.status into v_applied_status;

  if v_applied_status is null then
    -- A WHERE recusou a atualização (evento atrasado/fora de ordem)
    -- — devolve o estado ATUAL (inalterado) para o chamador. A linha
    -- com certeza já existe neste ponto (só chegamos aqui quando o
    -- INSERT colidiu e a WHERE foi falsa — nunca na primeira
    -- inserção de um lead, que nunca colide).
    select c.status into v_applied_status from public.whatsapp_conversation_state c where c.lead_id = p_lead_id;
  end if;

  return query select v_applied_status;
  return;
end;
$$;

comment on function public.apply_whatsapp_conversation_operational_event(uuid, text, timestamptz) is
  'Fase 3.6.2 (+ correção de ordenação, revisão do PR #68) — aplica uma transicao AUTOMATICA de estado operacional (inbound_received->pendente_resposta, outbound_sent->aguardando_cliente). Um evento cujo p_event_timestamp seja ANTERIOR ao last_event_at ja registrado e IGNORADO (nunca sobrescreve um estado mais recente). NUNCA sobrescreve em_atendimento (regra de precedencia documentada acima). Chamavel so por service_role, sempre APOS o evento real (mensagem persistida/envio confirmado). NUNCA toca leads.etapa/tags nem whatsapp_messages.';

revoke all on function public.apply_whatsapp_conversation_operational_event(uuid, text, timestamptz) from public;
revoke all on function public.apply_whatsapp_conversation_operational_event(uuid, text, timestamptz) from anon;
revoke all on function public.apply_whatsapp_conversation_operational_event(uuid, text, timestamptz) from authenticated;
grant execute on function public.apply_whatsapp_conversation_operational_event(uuid, text, timestamptz) to service_role;

-- Rollback deste bloco: "drop function if exists public.apply_whatsapp_conversation_operational_event(uuid, text, timestamptz);"
