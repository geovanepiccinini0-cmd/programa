-- Fase 3.5.2.1 — Fundação transacional do envio WhatsApp (outbound).
-- Rode este arquivo no SQL Editor do seu projeto Supabase, depois de
-- 018 (whatsapp_messages) e 019 (RPC de inbound) — NUNCA os substitui
-- ou altera: 018/019 permanecem exatamente como estão. A ÚNICA
-- exceção é um CREATE OR REPLACE FUNCTION sobre o trigger de
-- consistência criado na 018 (mesmo padrão já usado para a RPC de
-- inbound entre 016→017→019: o arquivo histórico nunca é editado, só
-- a função que ele criou é substituída por uma versão nova, numa
-- migration posterior).
--
-- ZERO envio real de mensagem acontece aqui — esta migration só cria
-- estrutura e as RPCs transacionais que uma futura Edge Function
-- (Fase 3.5.2.2, fora desta fase) vai consumir. Nenhum token da Meta,
-- nenhuma chamada HTTP, nenhum secret.
--
-- Rollback: ver comentário de cada bloco (cada objeto tem uma reversão
-- independente, nunca uma única operação destrutiva de tudo).

-------------------------------------------------------------------
-- PRECONDIÇÕES — falha fechada se 018/019 não existirem.
-------------------------------------------------------------------
do $$
begin
  if to_regclass('public.whatsapp_messages') is null then
    raise exception 'Precondicao falhou: public.whatsapp_messages (migration 018) nao existe';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'process_inbound_whatsapp_event'
  ) then
    raise exception 'Precondicao falhou: process_inbound_whatsapp_event (migration 016/017/019) nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- A) whatsapp_messages — colunas novas para o ciclo de vida outbound.
-------------------------------------------------------------------
-- client_token: chave de idempotência de REQUISIÇÃO (um clique/
-- tentativa do usuário), nunca confundida com external_message_id
-- (identidade da MENSAGEM segundo a Meta, só existe depois do aceite).
-- Nullable globalmente, mas o CHECK abaixo torna obrigatório para
-- outbound e proibido para inbound — nunca os dois sentidos ao mesmo
-- tempo.
--
-- attempt_count / attempt_claimed_at / last_attempted_at: suportam o
-- mecanismo de CLAIM concorrencialmente seguro (reserve_whatsapp_outbound_attempt,
-- seção D) — nunca usados pelo caminho inbound.
alter table public.whatsapp_messages
  add column if not exists client_token uuid,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists attempt_claimed_at timestamptz,
  add column if not exists last_attempted_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_messages_attempt_count_check'
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_attempt_count_check check (attempt_count >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_messages_client_token_direction_check'
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_client_token_direction_check
      check (
        (direction = 'outbound' and client_token is not null)
        or (direction = 'inbound' and client_token is null)
      );
  end if;
end $$;

create unique index if not exists whatsapp_messages_client_token_key
  on public.whatsapp_messages (client_token) where client_token is not null;

comment on column public.whatsapp_messages.client_token is
  'Fase 3.5.2.1 — chave de idempotência de REQUISIÇÃO de envio (um clique/tentativa do usuário), gerada pelo cliente antes da chamada à Edge Function. NUNCA confundir com external_message_id (identidade da mensagem segundo a Meta, só existe após o aceite). Obrigatório para outbound, proibido para inbound (ver whatsapp_messages_client_token_direction_check).';

-- Rollback deste bloco: "alter table public.whatsapp_messages drop column if exists client_token, drop column if exists attempt_count, drop column if exists attempt_claimed_at, drop column if exists last_attempted_at;" (aditivo, sem dado histórico dependente).

-------------------------------------------------------------------
-- B) whatsapp_outbound_attempts — auditoria APPEND-ONLY de cada
-- tentativa de chamada à Graph API (nunca o conteúdo da mensagem,
-- nunca o token de acesso da Meta — só metadados operacionais).
-------------------------------------------------------------------
create table if not exists public.whatsapp_outbound_attempts (
  id uuid primary key default gen_random_uuid(),
  whatsapp_message_id uuid not null references public.whatsapp_messages(id) on delete cascade,
  attempt_number integer not null,
  claimed_at timestamptz not null default now(),
  -- NULL enquanto a tentativa ainda está em andamento (entre o claim e
  -- a resolução) — preenchido exatamente uma vez, nunca mais alterado
  -- depois disso.
  outcome text,
  error_code text,
  http_status integer,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),

  constraint whatsapp_outbound_attempts_outcome_check
    check (outcome is null or outcome in ('sent', 'failed_transient', 'failed_terminal')),
  constraint whatsapp_outbound_attempts_attempt_number_check
    check (attempt_number > 0),
  constraint whatsapp_outbound_attempts_http_status_check
    check (http_status is null or (http_status >= 100 and http_status < 600))
);

comment on table public.whatsapp_outbound_attempts is
  'Fase 3.5.2.1 — log append-only de cada tentativa de chamada à Graph API por mensagem outbound. NUNCA contém conteúdo da mensagem, telefone, token de acesso ou payload bruto da Meta — só metadados operacionais (número da tentativa, outcome classificado, código de erro próprio, status HTTP). Exclusão nunca permitida (ver trigger abaixo) — resolução de uma tentativa é um UPDATE único, nunca repetido.';

create index if not exists whatsapp_outbound_attempts_message_id_idx
  on public.whatsapp_outbound_attempts (whatsapp_message_id);

-- Garantia real de "append-only": nenhuma linha pode ser excluída,
-- nem mesmo por service_role (que ignora RLS, mas NUNCA ignora
-- triggers). UPDATE continua permitido (necessário para resolver o
-- outcome exatamente uma vez).
create or replace function public.whatsapp_outbound_attempts_prevent_delete()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'whatsapp_outbound_attempts: exclusao nunca permitida (tabela append-only de auditoria)';
end;
$$;

drop trigger if exists whatsapp_outbound_attempts_prevent_delete_trigger on public.whatsapp_outbound_attempts;
create trigger whatsapp_outbound_attempts_prevent_delete_trigger
  before delete on public.whatsapp_outbound_attempts
  for each row execute function public.whatsapp_outbound_attempts_prevent_delete();

alter table public.whatsapp_outbound_attempts enable row level security;

-- RLS restritiva (seção "Segurança" do pedido): só leitura, só para o
-- dono da MENSAGEM associada (join, nunca uma coluna user_id própria
-- duplicada) ou admin. Zero policy de escrita para
-- anon/authenticated — toda escrita é exclusiva de service_role (via
-- as RPCs abaixo), mesmo padrão já estabelecido para whatsapp_messages
-- na migration 018.
create policy "whatsapp_outbound_attempts: dono pode ler"
  on public.whatsapp_outbound_attempts
  for select using (
    exists (
      select 1 from public.whatsapp_messages wm
      where wm.id = whatsapp_outbound_attempts.whatsapp_message_id
        and wm.user_id = auth.uid()
    )
  );

create policy "whatsapp_outbound_attempts: admin pode ler tudo"
  on public.whatsapp_outbound_attempts
  for select using (public.is_admin());

-- Rollback deste bloco: "drop table if exists public.whatsapp_outbound_attempts cascade; drop function if exists public.whatsapp_outbound_attempts_prevent_delete();"

-------------------------------------------------------------------
-- C) whatsapp_outbound_status_events — staging para eventos de status
-- (delivered/read/failed) do webhook que cheguem ANTES do
-- external_message_id estar persistido localmente (corrida genuína:
-- a Meta pode entregar o status quase imediatamente após aceitar o
-- envio, antes da nossa própria confirmação ter sido escrita).
-------------------------------------------------------------------
create table if not exists public.whatsapp_outbound_status_events (
  id uuid primary key default gen_random_uuid(),
  external_message_id text not null,
  new_status text not null,
  event_timestamp timestamptz not null,
  received_at timestamptz not null default now(),
  -- NULL enquanto pendente de reconciliação; preenchido quando
  -- aplicado (por apply_whatsapp_outbound_status_event ou pela
  -- reconciliação dentro de confirm_whatsapp_outbound_sent).
  processed_at timestamptz,
  whatsapp_message_id uuid references public.whatsapp_messages(id) on delete set null,

  constraint whatsapp_outbound_status_events_new_status_check
    check (new_status in ('delivered', 'read', 'failed')),
  constraint whatsapp_outbound_status_events_external_message_id_shape_check
    check (external_message_id ~ '^[^[:space:]](.*[^[:space:]])?$')
);

comment on table public.whatsapp_outbound_status_events is
  'Fase 3.5.2.1 — staging de eventos de status (delivered/read/failed) recebidos do webhook ANTES do external_message_id correspondente existir em whatsapp_messages. Reconciliado automaticamente por confirm_whatsapp_outbound_sent (quando o wamid é finalmente gravado) ou numa nova tentativa de apply_whatsapp_outbound_status_event. Nunca contém conteúdo de mensagem.';

create index if not exists whatsapp_outbound_status_events_pending_idx
  on public.whatsapp_outbound_status_events (external_message_id) where processed_at is null;

alter table public.whatsapp_outbound_status_events enable row level security;
-- Zero policy — tabela de plumbing interno, nunca exibida à UI; RLS
-- habilitada sem nenhuma policy nega acesso a todos os papéis exceto
-- service_role (mesmo princípio já usado em integration_accounts/
-- integration_events desde a Fase 3.1).

-- Rollback deste bloco: "drop table if exists public.whatsapp_outbound_status_events cascade;"

-------------------------------------------------------------------
-- D) Relaxamento PONTUAL do trigger de consistência (018) — permite
-- que uma atualização de PROGRESSÃO DE STATUS (delivered/read/failed,
-- nunca uma INSERT nem uma reassociação de lead/conta/owner) seja
-- aplicada mesmo que o lead tenha sido soft-deletado DEPOIS do envio.
-- Isso completa um registro histórico legítimo (a mensagem já existia
-- e já estava associada a este lead) — nunca cria, nunca reativa,
-- nunca reassocia nada. Toda INSERT, e toda UPDATE que de fato mude
-- lead_id/user_id/integration_account_id, continua EXATAMENTE tão
-- estrita quanto a versão original da 018 — nenhuma validação de
-- owner/conta é relaxada, só a checagem de "lead ativo" para este
-- caso específico e estreito.
-------------------------------------------------------------------
create or replace function public.whatsapp_messages_consistency_check()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_lead_user_id uuid;
  v_lead_deleted_at timestamptz;
  v_account_user_id uuid;
  v_is_pure_status_update boolean;
begin
  v_is_pure_status_update :=
    tg_op = 'UPDATE'
    and new.lead_id = old.lead_id
    and new.user_id = old.user_id
    and new.integration_account_id = old.integration_account_id;

  select l.user_id, l.deleted_at into v_lead_user_id, v_lead_deleted_at
  from public.leads l
  where l.id = new.lead_id;

  if v_lead_user_id is null then
    raise exception 'whatsapp_messages: lead % nao encontrado', new.lead_id;
  end if;

  -- Fase 3.5.2.1 — ÚNICA mudança de comportamento desta migration: a
  -- checagem de lead excluído NUNCA se aplica a uma progressão pura de
  -- status (associação owner/lead/account inalterada) — ver comentário
  -- de topo desta seção. Qualquer outro caso (INSERT, ou UPDATE que
  -- mude a associação) continua recusado exatamente como na 018.
  if v_lead_deleted_at is not null and not v_is_pure_status_update then
    raise exception 'whatsapp_messages: lead % esta excluido (deleted_at=%), nao pode receber nova mensagem', new.lead_id, v_lead_deleted_at;
  end if;

  if v_lead_user_id is distinct from new.user_id then
    raise exception 'whatsapp_messages: user_id (%) nao corresponde ao owner do lead % (%)', new.user_id, new.lead_id, v_lead_user_id;
  end if;

  select ia.user_id into v_account_user_id
  from public.integration_accounts ia
  where ia.id = new.integration_account_id;

  if v_account_user_id is null then
    raise exception 'whatsapp_messages: integration_account % nao encontrada', new.integration_account_id;
  end if;

  if v_account_user_id is distinct from new.user_id then
    raise exception 'whatsapp_messages: user_id (%) nao corresponde ao owner da integration_account % (%)', new.user_id, new.integration_account_id, v_account_user_id;
  end if;

  return new;
end;
$$;

comment on function public.whatsapp_messages_consistency_check() is
  'Fase 3.4.1 (base) + 3.5.2.1 (progressão pura de status nunca bloqueada por lead soft-deletado, desde que a associação owner/lead/account permaneça inalterada) — guard de consistência owner/lead/account para whatsapp_messages.';

-- Rollback deste bloco: reaplicar o CREATE OR REPLACE FUNCTION da migration 018 (texto completo naquele arquivo) — nunca "drop function" (a trigger depende dela).

-------------------------------------------------------------------
-- E) reserve_whatsapp_outbound_attempt — RPC transacional que
-- combina idempotência por client_token (item 9) com o CLAIM
-- concorrencialmente seguro da autorização para chamar a Graph API
-- (itens 7/8). Chamável só por service_role.
--
-- GARANTIA REAL (provada empiricamente, ver relatório): dentro do
-- nosso banco, no máximo UMA chamada concorrente para o MESMO
-- client_token (ou para a mesma linha já existente) recebe
-- outcome='CLAIMED' por vez — qualquer outra concorrente recebe
-- 'ALREADY_IN_FLIGHT' ou 'ALREADY_RESOLVED', nunca duas autorizações
-- simultâneas.
--
-- LIMITE ESTRUTURAL HONESTO (nunca escondido): a Cloud API da Meta não
-- aceita nenhuma chave de idempotência no endpoint de envio. Esta RPC
-- garante que SOMENTE UMA requisição do NOSSO sistema recebe
-- autorização para fazer a chamada HTTP — ela NUNCA pode garantir que
-- essa chamada, uma vez feita, chegue exatamente uma vez à Meta (ex.
-- nossa própria resposta HTTP pode se perder depois de a Meta já ter
-- processado). Esse é um limite do sistema externo, não desta RPC.
-------------------------------------------------------------------
create or replace function public.reserve_whatsapp_outbound_attempt(
  p_client_token uuid,
  p_user_id uuid,
  p_lead_id uuid,
  p_integration_account_id uuid,
  p_content text
)
returns table (
  outcome text,
  message_id uuid,
  attempt_number integer,
  current_status text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_lead_id uuid;
  v_integration_account_id uuid;
  v_content text;
  v_status text;
  v_attempt_claimed_at timestamptz;
  v_attempt_count integer;
  v_lead_owner uuid;
  v_account_owner uuid;
begin
  if p_client_token is null then
    raise exception 'reserve_whatsapp_outbound_attempt: p_client_token nao pode ser nulo';
  end if;
  if p_content is null or p_content !~ '\S' then
    raise exception 'reserve_whatsapp_outbound_attempt: p_content ausente ou vazio';
  end if;

  -- Validação explícita de propriedade ANTES de qualquer escrita —
  -- nunca confia apenas no chamador (Edge Function) nem apenas no
  -- trigger da 018 (defesa em profundidade, mesmo princípio já usado
  -- em process_inbound_whatsapp_event). Falha rápida e clara, sem
  -- nunca inserir uma linha ou uma tentativa condenada a ser rejeitada
  -- pelo trigger de qualquer forma.
  select user_id into v_lead_owner from public.leads where id = p_lead_id;
  if v_lead_owner is null then
    raise exception 'reserve_whatsapp_outbound_attempt: lead % nao encontrado', p_lead_id;
  end if;
  if v_lead_owner is distinct from p_user_id then
    raise exception 'reserve_whatsapp_outbound_attempt: lead % nao pertence ao usuario %', p_lead_id, p_user_id;
  end if;

  select user_id into v_account_owner from public.integration_accounts where id = p_integration_account_id and active = true;
  if v_account_owner is null then
    raise exception 'reserve_whatsapp_outbound_attempt: integration_account % nao encontrada ou inativa', p_integration_account_id;
  end if;
  if v_account_owner is distinct from p_user_id then
    raise exception 'reserve_whatsapp_outbound_attempt: integration_account % nao pertence ao usuario %', p_integration_account_id, p_user_id;
  end if;

  loop
    select id, lead_id, integration_account_id, content, status, attempt_claimed_at
      into v_id, v_lead_id, v_integration_account_id, v_content, v_status, v_attempt_claimed_at
    from public.whatsapp_messages
    where client_token = p_client_token
    for update;

    if found then
      if v_lead_id is distinct from p_lead_id
         or v_integration_account_id is distinct from p_integration_account_id
         or v_content is distinct from p_content
      then
        return query select 'IDENTITY_CONFLICT'::text, v_id, null::integer, v_status;
        return;
      end if;

      if v_status is distinct from 'queued' then
        return query select 'ALREADY_RESOLVED'::text, v_id, null::integer, v_status;
        return;
      end if;

      if v_attempt_claimed_at is not null and v_attempt_claimed_at > now() - interval '2 minutes' then
        return query select 'ALREADY_IN_FLIGHT'::text, v_id, null::integer, v_status;
        return;
      end if;

      update public.whatsapp_messages
      set attempt_count = attempt_count + 1,
          attempt_claimed_at = now(),
          last_attempted_at = now()
      where id = v_id
      returning attempt_count into v_attempt_count;

      insert into public.whatsapp_outbound_attempts (whatsapp_message_id, attempt_number)
      values (v_id, v_attempt_count);

      return query select 'CLAIMED'::text, v_id, v_attempt_count, 'queued'::text;
      return;
    end if;

    begin
      insert into public.whatsapp_messages (
        user_id, lead_id, integration_account_id, provider, direction, status,
        content, client_token, occurred_at, attempt_count, attempt_claimed_at, last_attempted_at
      ) values (
        p_user_id, p_lead_id, p_integration_account_id, 'whatsapp', 'outbound', 'queued',
        p_content, p_client_token, now(), 1, now(), now()
      )
      returning id into v_id;

      insert into public.whatsapp_outbound_attempts (whatsapp_message_id, attempt_number)
      values (v_id, 1);

      return query select 'CLAIMED'::text, v_id, 1, 'queued'::text;
      return;
    exception
      when unique_violation then
        -- Corrida genuína: outra transação inseriu com o MESMO
        -- client_token entre nosso SELECT (não encontrou) e nosso
        -- INSERT. Volta ao topo do loop — a releitura agora ENCONTRA
        -- a linha e passa pela MESMA lógica de identidade/claim acima,
        -- nunca um caminho duplicado.
        continue;
    end;
  end loop;
end;
$$;

revoke all on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text) from public;
revoke all on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text) from anon;
revoke all on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text) from authenticated;
grant execute on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text) to service_role;

-------------------------------------------------------------------
-- F) confirm_whatsapp_outbound_sent — transição atômica
-- queued->sent + gravação do wamid + criação da lead_interaction
-- outbound (exatamente uma vez) + reconciliação de eventos de status
-- pendentes (item 11). Chamável só por service_role.
-------------------------------------------------------------------
create or replace function public.confirm_whatsapp_outbound_sent(
  p_message_id uuid,
  p_external_message_id text
)
returns table (
  outcome text,
  lead_interaction_id uuid
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_user_id uuid;
  v_lead_id uuid;
  v_existing_interaction_id uuid;
  v_content text;
  v_occurred_at timestamptz;
  v_interaction_id uuid;
  v_pending record;
begin
  if p_external_message_id is null or p_external_message_id !~ '\S' then
    raise exception 'confirm_whatsapp_outbound_sent: p_external_message_id invalido (nulo ou vazio)';
  end if;

  -- Fase 3.5.2.1 — qualificado com o alias "wm.": o parâmetro de saída
  -- desta função também se chama lead_interaction_id (RETURNS TABLE
  -- acima), e o PL/pgSQL trata nomes de parâmetro de saída como
  -- variáveis locais — sem qualificação, "lead_interaction_id" dentro
  -- de uma query é ambíguo entre essa variável e a coluna real da
  -- tabela. Mesma classe de cuidado em toda referência a colunas
  -- chamadas "outcome"/"lead_interaction_id" neste arquivo.
  select wm.status, wm.user_id, wm.lead_id, wm.lead_interaction_id, wm.content, wm.occurred_at
    into v_status, v_user_id, v_lead_id, v_existing_interaction_id, v_content, v_occurred_at
  from public.whatsapp_messages wm
  where wm.id = p_message_id
  for update;

  if not found then
    raise exception 'confirm_whatsapp_outbound_sent: whatsapp_message % nao encontrado', p_message_id;
  end if;

  if v_status in ('sent', 'delivered', 'read') then
    -- Idempotente: já confirmado antes (ex. a resposta HTTP original
    -- da Edge Function para o browser se perdeu, e uma segunda
    -- chamada de confirmação foi tentada) — NUNCA cria uma segunda
    -- lead_interaction.
    return query select 'ALREADY_CONFIRMED'::text, v_existing_interaction_id;
    return;
  end if;

  if v_status <> 'queued' then
    raise exception 'confirm_whatsapp_outbound_sent: whatsapp_message % esta em status inesperado (%) para confirmacao', p_message_id, v_status;
  end if;

  insert into public.lead_interactions (
    user_id, lead_id, type, direction, channel, content, metadata, occurred_at, created_by
  ) values (
    v_user_id, v_lead_id, 'whatsapp', 'outbound', 'whatsapp', v_content,
    jsonb_build_object(
      'activity_class', 'attempt',
      'source', 'integration',
      'provider', 'whatsapp',
      'external_message_id', p_external_message_id
    ),
    v_occurred_at, null
  )
  returning id into v_interaction_id;

  update public.whatsapp_messages
  set status = 'sent',
      external_message_id = p_external_message_id,
      sent_at = now(),
      lead_interaction_id = v_interaction_id,
      attempt_claimed_at = null,
      error_code = null
  where id = p_message_id;

  update public.whatsapp_outbound_attempts
  set outcome = 'sent', resolved_at = now()
  where id = (
    select woa.id from public.whatsapp_outbound_attempts woa
    where woa.whatsapp_message_id = p_message_id and woa.outcome is null
    order by woa.attempt_number desc
    limit 1
  );

  -- Reconciliação (item 11): aplica agora, na MESMA transação,
  -- qualquer evento de status que já tenha chegado para este wamid
  -- ANTES dele existir localmente (ver whatsapp_outbound_status_events,
  -- seção C, e apply_whatsapp_outbound_status_event, seção G).
  for v_pending in
    select id, new_status, event_timestamp
    from public.whatsapp_outbound_status_events
    where external_message_id = p_external_message_id and processed_at is null
    order by event_timestamp asc
  loop
    update public.whatsapp_messages
    set status = v_pending.new_status,
        delivered_at = case when v_pending.new_status = 'delivered' then coalesce(delivered_at, v_pending.event_timestamp) else delivered_at end,
        read_at = case when v_pending.new_status = 'read' then coalesce(read_at, v_pending.event_timestamp) else read_at end
    where id = p_message_id
      and status = any(
        case v_pending.new_status
          when 'delivered' then array['sent']
          when 'read' then array['sent', 'delivered']
          when 'failed' then array['sent', 'delivered']
          else array[]::text[]
        end
      );

    update public.whatsapp_outbound_status_events
    set processed_at = now(), whatsapp_message_id = p_message_id
    where id = v_pending.id;
  end loop;

  return query select 'CONFIRMED'::text, v_interaction_id;
  return;
end;
$$;

revoke all on function public.confirm_whatsapp_outbound_sent(uuid, text) from public;
revoke all on function public.confirm_whatsapp_outbound_sent(uuid, text) from anon;
revoke all on function public.confirm_whatsapp_outbound_sent(uuid, text) from authenticated;
grant execute on function public.confirm_whatsapp_outbound_sent(uuid, text) to service_role;

-------------------------------------------------------------------
-- G) mark_whatsapp_outbound_attempt_result — libera o claim e grava
-- o resultado (falha transitória -> volta para queued, nunca reenvio
-- automático; falha terminal -> failed). Chamável só por service_role.
-------------------------------------------------------------------
create or replace function public.mark_whatsapp_outbound_attempt_result(
  p_message_id uuid,
  p_outcome text,
  p_error_code text,
  p_http_status integer
)
returns table (
  outcome text,
  current_status text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_new_status text;
begin
  if p_outcome not in ('failed_transient', 'failed_terminal') then
    raise exception 'mark_whatsapp_outbound_attempt_result: p_outcome invalido (%)', p_outcome;
  end if;

  select status into v_status
  from public.whatsapp_messages
  where id = p_message_id
  for update;

  if not found then
    raise exception 'mark_whatsapp_outbound_attempt_result: whatsapp_message % nao encontrado', p_message_id;
  end if;

  if v_status <> 'queued' then
    -- Resultado chegando tarde para uma mensagem já resolvida por
    -- outro caminho (ex. confirm_whatsapp_outbound_sent já rodou
    -- primeiro) — nunca sobrescreve um estado mais avançado.
    return query select 'IGNORED_ALREADY_RESOLVED'::text, v_status;
    return;
  end if;

  v_new_status := case when p_outcome = 'failed_terminal' then 'failed' else 'queued' end;

  update public.whatsapp_messages
  set status = v_new_status,
      error_code = p_error_code,
      attempt_claimed_at = null
  where id = p_message_id;

  update public.whatsapp_outbound_attempts
  set outcome = p_outcome, error_code = p_error_code, http_status = p_http_status, resolved_at = now()
  where id = (
    select woa.id from public.whatsapp_outbound_attempts woa
    where woa.whatsapp_message_id = p_message_id and woa.outcome is null
    order by woa.attempt_number desc
    limit 1
  );

  return query select p_outcome, v_new_status;
  return;
end;
$$;

revoke all on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) from public;
revoke all on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) from anon;
revoke all on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) from authenticated;
grant execute on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) to service_role;

-------------------------------------------------------------------
-- H) apply_whatsapp_outbound_status_event — aplica um evento de
-- status (delivered/read/failed) vindo do webhook (Fase 3.5.2.3,
-- fora desta fase — aqui só o contrato/RPC é preparado). Nunca
-- regride (transições permitidas fechadas); se o wamid ainda não
-- existir localmente, persiste em staging para reconciliação futura
-- (item 11).
-------------------------------------------------------------------
create or replace function public.apply_whatsapp_outbound_status_event(
  p_external_message_id text,
  p_new_status text,
  p_event_timestamp timestamptz
)
returns table (
  outcome text,
  message_id uuid
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_allowed_from text[];
begin
  if p_external_message_id is null or p_external_message_id !~ '\S' then
    raise exception 'apply_whatsapp_outbound_status_event: p_external_message_id invalido (nulo ou vazio)';
  end if;
  if p_new_status not in ('delivered', 'read', 'failed') then
    raise exception 'apply_whatsapp_outbound_status_event: p_new_status invalido (%)', p_new_status;
  end if;
  if p_event_timestamp is null then
    raise exception 'apply_whatsapp_outbound_status_event: p_event_timestamp nao pode ser nulo';
  end if;

  v_allowed_from := case p_new_status
    when 'delivered' then array['sent']
    when 'read' then array['sent', 'delivered']
    when 'failed' then array['sent', 'delivered']
  end;

  update public.whatsapp_messages
  set status = p_new_status,
      delivered_at = case when p_new_status = 'delivered' then coalesce(delivered_at, p_event_timestamp) else delivered_at end,
      read_at = case when p_new_status = 'read' then coalesce(read_at, p_event_timestamp) else read_at end
  where external_message_id = p_external_message_id
    and status = any(v_allowed_from)
  returning id into v_id;

  if found then
    return query select 'APPLIED'::text, v_id;
    return;
  end if;

  select id into v_id from public.whatsapp_messages where external_message_id = p_external_message_id;

  if v_id is not null then
    -- A linha existe mas não está num status de origem permitido:
    -- evento fora de ordem (ex. 'delivered' chegando depois de 'read'
    -- já aplicado) ou reentrega de um evento já aplicado antes — em
    -- ambos os casos, ignorar é o comportamento correto (nunca
    -- regride, nunca duplica efeito).
    return query select 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE'::text, v_id;
    return;
  end if;

  -- Nenhuma linha com este external_message_id existe ainda — o
  -- status chegou ANTES da confirmação do envio (item 11). Persiste
  -- para reconciliação futura, nunca descarta.
  insert into public.whatsapp_outbound_status_events (external_message_id, new_status, event_timestamp)
  values (p_external_message_id, p_new_status, p_event_timestamp);

  return query select 'PENDING_WAMID'::text, null::uuid;
  return;
end;
$$;

revoke all on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz) from public;
revoke all on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz) from anon;
revoke all on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz) from authenticated;
grant execute on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz) to service_role;
