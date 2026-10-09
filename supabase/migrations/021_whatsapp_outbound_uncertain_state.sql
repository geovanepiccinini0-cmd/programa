-- Fase 3.5.2.1 — Correção dos findings críticos da auditoria adversarial.
-- Depende de 018/019/020 (nunca os edita — mesmo precedente já usado
-- pela própria 020 sobre o trigger de 018: o arquivo histórico nunca
-- muda, só uma CREATE OR REPLACE/ALTER posterior substitui o que ele
-- criou). ZERO envio real, ZERO alteração em produção.
--
-- PROBLEMA CORRIGIDO (ver relatório da auditoria): a janela fixa de 2
-- minutos em reserve_whatsapp_outbound_attempt (020) liberava o claim
-- e autorizava uma SEGUNDA chamada HTTP real à Meta mesmo quando o
-- resultado da primeira tentativa era desconhecido (nenhum outcome
-- registrado) — provado empiricamente, inclusive com o cenário
-- agravante de confirmação dupla silenciosamente descartando o
-- segundo wamid real.
--
-- CORREÇÃO: introduz uma máquina de estados persistida com 5 estágios
-- (seção B) e um novo RPC "start_whatsapp_outbound_attempt_call"
-- (seção F) cuja transição queued->sending é a ÚNICA autorização real
-- para chamar a Graph API — persistida atomicamente ANTES de qualquer
-- chamada HTTP. A partir de "sending", NENHUM caminho deste arquivo
-- libera a mensagem por tempo — só por confirmação explícita
-- (confirm_whatsapp_outbound_sent) ou por declaração explícita de
-- resultado (mark_whatsapp_outbound_attempt_result com
-- outcome='uncertain'|'rejected_by_provider', nunca automática).
--
-- Rollback: ver comentário de cada bloco.

-------------------------------------------------------------------
-- PRECONDIÇÕES
-------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reserve_whatsapp_outbound_attempt'
  ) then
    raise exception 'Precondicao falhou: reserve_whatsapp_outbound_attempt (migration 020) nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- B) whatsapp_messages.status — amplia o vocabulário para incluir os
-- dois novos estágios da máquina de estados: "sending" (chamada
-- externa iniciada, persistida ANTES do HTTP) e "uncertain" (resultado
-- desconhecido após a chamada ter sido iniciada — bloqueio permanente,
-- nunca liberado por tempo).
-------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'whatsapp_messages_status_check') then
    alter table public.whatsapp_messages drop constraint whatsapp_messages_status_check;
  end if;
  alter table public.whatsapp_messages
    add constraint whatsapp_messages_status_check
    check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'uncertain'));
end $$;

comment on column public.whatsapp_messages.status is
  'Fase 3.4.1 (base) + 3.5.2.1 (estados outbound ampliados). Máquina de estados do envio: queued (reservado, chamada externa NAO iniciada) -> sending (chamada iniciada, persistido ANTES do HTTP — ver start_whatsapp_outbound_attempt_call) -> {sent (confirmado, pode progredir para delivered/read) | uncertain (resultado desconhecido, bloqueio PERMANENTE, nunca liberado por tempo — só por confirmação tardia ou decisão manual explícita) | failed (rejeição terminal comprovada pela Meta)}. "received" é exclusivo do caminho inbound.';

-- Rollback deste bloco: "alter table public.whatsapp_messages drop constraint whatsapp_messages_status_check; alter table public.whatsapp_messages add constraint whatsapp_messages_status_check check (status in ('received','queued','sent','delivered','read','failed'));" (reverte para o vocabulário da 018/020 — só seguro se nenhuma linha estiver em 'sending'/'uncertain' no momento do rollback).

-------------------------------------------------------------------
-- C) whatsapp_outbound_attempts — nova coluna calling_at (marca o
-- instante em que a transição para "sending" foi persistida para esta
-- tentativa) e vocabulário de outcome ampliado/renomeado para refletir
-- a nova máquina de estados (nunca mais "failed_transient"/
-- "failed_terminal" — substituídos por conceitos que distinguem
-- explicitamente "nunca chamou" de "chamou e o resultado é incerto"
-- de "a Meta rejeitou de fato").
-------------------------------------------------------------------
alter table public.whatsapp_outbound_attempts
  add column if not exists calling_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_attempts_calling_at_check') then
    alter table public.whatsapp_outbound_attempts drop constraint whatsapp_outbound_attempts_calling_at_check;
  end if;
  alter table public.whatsapp_outbound_attempts
    add constraint whatsapp_outbound_attempts_calling_at_check
    check (calling_at is null or calling_at >= claimed_at);

  if exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_attempts_outcome_check') then
    alter table public.whatsapp_outbound_attempts drop constraint whatsapp_outbound_attempts_outcome_check;
  end if;
  alter table public.whatsapp_outbound_attempts
    add constraint whatsapp_outbound_attempts_outcome_check
    check (outcome is null or outcome in ('sent', 'failed_before_call', 'uncertain', 'rejected_by_provider'));
end $$;

comment on column public.whatsapp_outbound_attempts.calling_at is
  'Fase 3.5.2.1 — instante em que start_whatsapp_outbound_attempt_call persistiu a transição para "sending" NESTA tentativa especificamente. NULL enquanto a tentativa está só reservada (claimed) mas a chamada externa ainda não foi autorizada a iniciar.';

comment on column public.whatsapp_outbound_attempts.outcome is
  'Fase 3.5.2.1 — sent (confirmado), failed_before_call (certeza de que a chamada NUNCA saiu do nosso sistema — seguro liberar para nova tentativa imediatamente), uncertain (chamada iniciada, resultado desconhecido — NUNCA libera automaticamente), rejected_by_provider (rejeição terminal comprovada pela Meta, nunca mais retentável para este client_token).';

-- Rollback deste bloco: "alter table public.whatsapp_outbound_attempts drop column if exists calling_at; alter table public.whatsapp_outbound_attempts drop constraint if exists whatsapp_outbound_attempts_outcome_check; alter table public.whatsapp_outbound_attempts add constraint whatsapp_outbound_attempts_outcome_check check (outcome is null or outcome in ('sent','failed_transient','failed_terminal'));" (só seguro se nenhuma linha tiver outcome nos novos valores).

-------------------------------------------------------------------
-- D) whatsapp_outbound_confirmation_conflicts — auditoria append-only
-- e restrita de conflitos de confirmação: duas confirmações com wamids
-- DIFERENTES para a mesma whatsapp_message (ou uma confirmação
-- chegando para uma mensagem já em 'failed'). NUNCA substitui o
-- external_message_id já confirmado, NUNCA cria uma segunda
-- lead_interaction — só preserva os dois identificadores para
-- investigação/reconciliação manual (item 3 do pedido).
-------------------------------------------------------------------
create table if not exists public.whatsapp_outbound_confirmation_conflicts (
  id uuid primary key default gen_random_uuid(),
  whatsapp_message_id uuid not null references public.whatsapp_messages(id) on delete cascade,
  recorded_status text not null,
  recorded_external_message_id text,
  conflicting_external_message_id text not null,
  detected_at timestamptz not null default now()
);

comment on table public.whatsapp_outbound_confirmation_conflicts is
  'Fase 3.5.2.1 — append-only. Cada linha é um sinal de possível ENVIO DUPLICADO REAL detectado após o fato: uma segunda confirmação (wamid diferente do já registrado, ou chegando para uma mensagem já em failed) para a MESMA whatsapp_message. Nunca resolvido automaticamente — exige investigação/reconciliação manual, fora desta fase. Nunca contém conteúdo de mensagem.';

create index if not exists whatsapp_outbound_confirmation_conflicts_message_id_idx
  on public.whatsapp_outbound_confirmation_conflicts (whatsapp_message_id);

create or replace function public.whatsapp_outbound_confirmation_conflicts_prevent_delete()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'whatsapp_outbound_confirmation_conflicts: exclusao nunca permitida (tabela append-only de auditoria)';
end;
$$;

drop trigger if exists whatsapp_outbound_confirmation_conflicts_prevent_delete_trigger on public.whatsapp_outbound_confirmation_conflicts;
create trigger whatsapp_outbound_confirmation_conflicts_prevent_delete_trigger
  before delete on public.whatsapp_outbound_confirmation_conflicts
  for each row execute function public.whatsapp_outbound_confirmation_conflicts_prevent_delete();

alter table public.whatsapp_outbound_confirmation_conflicts enable row level security;
-- Zero policy — mesmo princípio de whatsapp_outbound_status_events
-- (020): plumbing interno de reconciliação, nunca exibido à UI nesta
-- fase. Acesso exclusivo a service_role.

-- Rollback deste bloco: "drop table if exists public.whatsapp_outbound_confirmation_conflicts cascade; drop function if exists public.whatsapp_outbound_confirmation_conflicts_prevent_delete();"

-------------------------------------------------------------------
-- E) reserve_whatsapp_outbound_attempt — reescrito. A reclamação por
-- expiração (2 min) agora SÓ se aplica enquanto status='queued' — o
-- que o próprio banco PROVA que significa "a chamada externa nunca
-- começou" (a única porta para "sending" é a seção F, e ela é uma
-- transição atômica condicionada a status='queued'). Para 'sending'
-- (ALREADY_CALLING) e 'uncertain' (UNCERTAIN_BLOCKED), NÃO HÁ
-- verificação de tempo alguma — bloqueio permanente para este
-- client_token, qualquer que seja o tempo decorrido.
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
  v_has_prior_uncertain boolean;
begin
  if p_client_token is null then
    raise exception 'reserve_whatsapp_outbound_attempt: p_client_token nao pode ser nulo';
  end if;
  if p_content is null or p_content !~ '\S' then
    raise exception 'reserve_whatsapp_outbound_attempt: p_content ausente ou vazio';
  end if;

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

      -- "sending": chamada externa já foi iniciada (comprovado pelo
      -- banco) — bloqueio PERMANENTE, nunca verificado por tempo.
      if v_status = 'sending' then
        return query select 'ALREADY_CALLING'::text, v_id, null::integer, v_status;
        return;
      end if;

      -- "uncertain": resultado desconhecido depois de uma chamada já
      -- iniciada — bloqueio PERMANENTE para este client_token. Uma
      -- nova tentativa real exige uma nova intenção explícita (novo
      -- client_token), nunca a reutilização silenciosa deste.
      if v_status = 'uncertain' then
        return query select 'UNCERTAIN_BLOCKED'::text, v_id, null::integer, v_status;
        return;
      end if;

      if v_status in ('sent', 'delivered', 'read', 'failed') then
        return query select 'ALREADY_RESOLVED'::text, v_id, null::integer, v_status;
        return;
      end if;

      -- Aqui v_status = 'queued': o próprio banco prova que a chamada
      -- externa NUNCA foi iniciada para esta linha (única porta para
      -- "sending" é start_whatsapp_outbound_attempt_call, seção F, uma
      -- transição atômica condicionada a status='queued'). Só aqui a
      -- janela de carência de 2 minutos é uma heurística OTIMISTA, sem
      -- nenhuma responsabilidade de segurança — a autorização real
      -- para chamar a Meta é o CAS da seção F, nunca este reserve.
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

    -- Aviso de possível duplicidade (item 2 do pedido): uma nova
    -- intenção (client_token novo) para um lead que já tem uma
    -- mensagem em 'uncertain' é permitida (nunca bloqueada
    -- silenciosamente — é uma decisão legítima do usuário), mas
    -- sinalizada explicitamente para quem chamou poder avisar sobre o
    -- risco de duplicidade.
    select exists (
      select 1 from public.whatsapp_messages
      where lead_id = p_lead_id and direction = 'outbound' and status = 'uncertain'
    ) into v_has_prior_uncertain;

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

      if v_has_prior_uncertain then
        return query select 'CLAIMED_WITH_PRIOR_UNCERTAIN'::text, v_id, 1, 'queued'::text;
      else
        return query select 'CLAIMED'::text, v_id, 1, 'queued'::text;
      end if;
      return;
    exception
      when unique_violation then
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
-- F) start_whatsapp_outbound_attempt_call — NOVO. A ÚNICA autorização
-- real para chamar a Graph API: transição atômica queued->sending,
-- persistida ANTES de qualquer chamada HTTP. Implementado como um CAS
-- (compare-and-swap) condicionado a status='queued' + lock de linha —
-- no máximo UM chamador recebe outcome='STARTED' por mensagem; todos
-- os demais recebem 'ALREADY_STARTED_OR_RESOLVED' e NÃO DEVEM chamar a
-- Meta. Isso vale mesmo que reserve_whatsapp_outbound_attempt tenha
-- devolvido CLAIMED para mais de um chamador (ex. reclamação de uma
-- linha 'queued' abandonada, seção E) — este CAS é o árbitro final.
-------------------------------------------------------------------
create or replace function public.start_whatsapp_outbound_attempt_call(
  p_message_id uuid
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
begin
  select status into v_status
  from public.whatsapp_messages
  where id = p_message_id
  for update;

  if not found then
    raise exception 'start_whatsapp_outbound_attempt_call: whatsapp_message % nao encontrado', p_message_id;
  end if;

  if v_status <> 'queued' then
    return query select 'ALREADY_STARTED_OR_RESOLVED'::text, v_status;
    return;
  end if;

  update public.whatsapp_messages
  set status = 'sending',
      last_attempted_at = now()
  where id = p_message_id;

  update public.whatsapp_outbound_attempts
  set calling_at = now()
  where id = (
    select woa.id from public.whatsapp_outbound_attempts woa
    where woa.whatsapp_message_id = p_message_id and woa.outcome is null
    order by woa.attempt_number desc
    limit 1
  );

  return query select 'STARTED'::text, 'sending'::text;
  return;
end;
$$;

comment on function public.start_whatsapp_outbound_attempt_call(uuid) is
  'Fase 3.5.2.1 — CAS queued->sending. Deve ser chamado pela Edge Function e seu outcome verificado ANTES de qualquer chamada HTTP à Meta: só outcome=STARTED autoriza a chamada; ALREADY_STARTED_OR_RESOLVED significa que outro chamador (ou outro caminho) já decidiu o destino desta mensagem — a chamada HTTP NUNCA deve ser feita neste caso.';

revoke all on function public.start_whatsapp_outbound_attempt_call(uuid) from public;
revoke all on function public.start_whatsapp_outbound_attempt_call(uuid) from anon;
revoke all on function public.start_whatsapp_outbound_attempt_call(uuid) from authenticated;
grant execute on function public.start_whatsapp_outbound_attempt_call(uuid) to service_role;

-------------------------------------------------------------------
-- G) confirm_whatsapp_outbound_sent — reescrito. Só resolve a partir
-- de 'sending' ou 'uncertain' (nunca mais 'queued' — confirmar sem
-- jamais ter passado por start_whatsapp_outbound_attempt_call é uma
-- violação de contrato, falha fechada). Conflito de wamid diferente
-- (item 3): NUNCA substitui o já confirmado, NUNCA cria uma segunda
-- lead_interaction — registra em whatsapp_outbound_confirmation_conflicts
-- e devolve um outcome distinto para quem chamou investigar.
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
  v_existing_wamid text;
  v_content text;
  v_occurred_at timestamptz;
  v_interaction_id uuid;
  v_pending record;
begin
  if p_external_message_id is null or p_external_message_id !~ '\S' then
    raise exception 'confirm_whatsapp_outbound_sent: p_external_message_id invalido (nulo ou vazio)';
  end if;

  select wm.status, wm.user_id, wm.lead_id, wm.lead_interaction_id, wm.content, wm.occurred_at, wm.external_message_id
    into v_status, v_user_id, v_lead_id, v_existing_interaction_id, v_content, v_occurred_at, v_existing_wamid
  from public.whatsapp_messages wm
  where wm.id = p_message_id
  for update;

  if not found then
    raise exception 'confirm_whatsapp_outbound_sent: whatsapp_message % nao encontrado', p_message_id;
  end if;

  if v_status in ('sent', 'delivered', 'read') then
    if v_existing_wamid = p_external_message_id then
      -- Idempotente: replay exato de uma confirmação já aplicada.
      return query select 'ALREADY_CONFIRMED'::text, v_existing_interaction_id;
      return;
    end if;

    -- Conflito real (item 3): um SEGUNDO wamid chegando para uma
    -- intenção já confirmada com outro wamid — sinal de possível
    -- envio duplicado de fato. NUNCA sobrescreve, NUNCA cria uma
    -- segunda lead_interaction — só preserva para investigação.
    insert into public.whatsapp_outbound_confirmation_conflicts (
      whatsapp_message_id, recorded_status, recorded_external_message_id, conflicting_external_message_id
    ) values (
      p_message_id, v_status, v_existing_wamid, p_external_message_id
    );
    return query select 'CONFLICT_DIFFERENT_WAMID'::text, v_existing_interaction_id;
    return;
  end if;

  if v_status = 'failed' then
    -- Conflito real (item 3): confirmação chegando para uma mensagem
    -- que já havíamos declarado como rejeição terminal comprovada —
    -- anomalia que exige investigação manual, nunca resolução
    -- automática/silenciosa.
    insert into public.whatsapp_outbound_confirmation_conflicts (
      whatsapp_message_id, recorded_status, recorded_external_message_id, conflicting_external_message_id
    ) values (
      p_message_id, v_status, v_existing_wamid, p_external_message_id
    );
    return query select 'CONFLICT_UNEXPECTED_STATE'::text, null::uuid;
    return;
  end if;

  if v_status not in ('sending', 'uncertain') then
    -- 'queued': contrato violado — confirm chamado sem jamais ter
    -- passado por start_whatsapp_outbound_attempt_call. Falha fechada.
    raise exception 'confirm_whatsapp_outbound_sent: whatsapp_message % esta em status % (esperado sending ou uncertain) — confirm chamado sem start_whatsapp_outbound_attempt_call?', p_message_id, v_status;
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
-- H) mark_whatsapp_outbound_attempt_result — reescrito para a nova
-- máquina de estados. "failed_before_call" só é aceito a partir de
-- 'queued' (certeza de que a chamada nunca saiu do nosso sistema —
-- seguro liberar para nova tentativa imediatamente). "uncertain" e
-- "rejected_by_provider" só são aceitos a partir de 'sending' (a
-- chamada foi de fato iniciada): "uncertain" bloqueia
-- PERMANENTEMENTE (nunca mais liberado automaticamente);
-- "rejected_by_provider" é a única forma de declarar uma rejeição
-- terminal comprovada pela Meta a partir de uma chamada já iniciada.
-- Nunca presume que timeout/5xx/ausência de resposta significa
-- rejeição — quem chama esta função é responsável por essa
-- classificação; o banco só IMPEDE a transição incorreta.
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
begin
  if p_outcome not in ('failed_before_call', 'uncertain', 'rejected_by_provider') then
    raise exception 'mark_whatsapp_outbound_attempt_result: p_outcome invalido (%)', p_outcome;
  end if;

  select status into v_status
  from public.whatsapp_messages
  where id = p_message_id
  for update;

  if not found then
    raise exception 'mark_whatsapp_outbound_attempt_result: whatsapp_message % nao encontrado', p_message_id;
  end if;

  if p_outcome = 'failed_before_call' then
    if v_status <> 'queued' then
      -- Não é possível alegar "nunca chamou" para uma mensagem que já
      -- está em 'sending' (ou além) — o banco já provou o contrário.
      return query select 'IGNORED_INVALID_TRANSITION'::text, v_status;
      return;
    end if;

    update public.whatsapp_messages
    set attempt_claimed_at = null, error_code = p_error_code
    where id = p_message_id;

    update public.whatsapp_outbound_attempts
    set outcome = 'failed_before_call', error_code = p_error_code, http_status = p_http_status, resolved_at = now()
    where id = (
      select woa.id from public.whatsapp_outbound_attempts woa
      where woa.whatsapp_message_id = p_message_id and woa.outcome is null
      order by woa.attempt_number desc
      limit 1
    );

    return query select 'failed_before_call'::text, 'queued'::text;
    return;
  end if;

  -- 'uncertain' e 'rejected_by_provider' só a partir de 'sending'.
  if v_status <> 'sending' then
    return query select 'IGNORED_ALREADY_RESOLVED'::text, v_status;
    return;
  end if;

  if p_outcome = 'uncertain' then
    update public.whatsapp_messages
    set status = 'uncertain', error_code = p_error_code
    where id = p_message_id;

    update public.whatsapp_outbound_attempts
    set outcome = 'uncertain', error_code = p_error_code, http_status = p_http_status, resolved_at = now()
    where id = (
      select woa.id from public.whatsapp_outbound_attempts woa
      where woa.whatsapp_message_id = p_message_id and woa.outcome is null
      order by woa.attempt_number desc
      limit 1
    );

    return query select 'uncertain'::text, 'uncertain'::text;
    return;
  end if;

  -- rejected_by_provider
  update public.whatsapp_messages
  set status = 'failed', error_code = p_error_code
  where id = p_message_id;

  update public.whatsapp_outbound_attempts
  set outcome = 'rejected_by_provider', error_code = p_error_code, http_status = p_http_status, resolved_at = now()
  where id = (
    select woa.id from public.whatsapp_outbound_attempts woa
    where woa.whatsapp_message_id = p_message_id and woa.outcome is null
    order by woa.attempt_number desc
    limit 1
  );

  return query select 'rejected_by_provider'::text, 'failed'::text;
  return;
end;
$$;

revoke all on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) from public;
revoke all on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) from anon;
revoke all on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) from authenticated;
grant execute on function public.mark_whatsapp_outbound_attempt_result(uuid, text, text, integer) to service_role;
