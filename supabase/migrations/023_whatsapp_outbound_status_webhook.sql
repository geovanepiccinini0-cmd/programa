-- Fase 3.5.2.3 — Processamento de status outbound (sent/delivered/
-- read/failed) vindos do webhook Meta já existente. Depende de
-- 018-022 (nunca os edita — mesmo precedente já usado em todas as
-- fases anteriores: arquivo histórico nunca muda, só um CREATE OR
-- REPLACE/ALTER posterior substitui o que ele criou). ZERO execução
-- em produção, ZERO migration real aplicada, ZERO secret real, ZERO
-- chamada real à Meta.
--
-- AUDITORIA INICIAL (resumo — ver relatório da fase para o detalhe):
-- o webhook inbound (supabase/functions/whatsapp-webhook/) já valida
-- assinatura HMAC (whatsappWebhook.ts) e já resolve a conta pelo
-- phone_number_id do payload (findIntegrationAccountCandidates +
-- resolveIntegrationAccount) — esta fase REUTILIZA esse mesmo webhook
-- e esse mesmo mecanismo de resolução de conta, nunca cria um segundo
-- endpoint público. apply_whatsapp_outbound_status_event (020) já
-- existe e já cobre delivered/read/failed com staging — faltava: (a)
-- suporte ao evento "sent" da Meta, (b) nenhuma validação de que o
-- status pertence à CONTA correta (gap real: um wamid poderia, em
-- tese, ser "atualizado" por um payload que resolva para outra conta
-- do mesmo projeto), (c) nenhum registro do código de erro de uma
-- falha de entrega. Nenhuma incompatibilidade estrutural foi
-- encontrada — só extensões aditivas.
--
-- Rollback: ver comentário de cada bloco.

-------------------------------------------------------------------
-- PRECONDIÇÕES
-------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_whatsapp_outbound_status_event'
  ) then
    raise exception 'Precondicao falhou: apply_whatsapp_outbound_status_event (migration 020) nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- A) whatsapp_outbound_status_events — novas colunas: integration_account_id
-- (conta que REPORTOU o evento, segundo o webhook — permite detectar
-- "conta incorreta" mesmo no caminho de staging, antes do wamid
-- existir localmente) e error_code (preservado para eventos 'failed'
-- pendentes de reconciliação, nunca perdido). new_status passa a
-- aceitar também 'sent' (item 2 do pedido).
-------------------------------------------------------------------
alter table public.whatsapp_outbound_status_events
  add column if not exists integration_account_id uuid references public.integration_accounts(id) on delete set null,
  add column if not exists error_code text;

create index if not exists whatsapp_outbound_status_events_account_idx
  on public.whatsapp_outbound_status_events (integration_account_id);

-- CORREÇÃO (Finding #3 da auditoria adversarial) — deduplicação
-- idempotente de eventos antecipados/desconhecidos: um evento
-- EXATAMENTE igual (mesma conta, mesmo wamid, mesmo status, mesmo
-- timestamp original do evento e mesmo error_code) nunca gera uma
-- segunda linha de staging — reentregas idênticas da Meta (comuns no
-- protocolo de webhooks, que usa "at-least-once") não crescem a
-- tabela sem limite. Eventos tecnicamente DIFERENTES (timestamp
-- diferente, status diferente ou error_code diferente) continuam
-- gerando linhas distintas — nunca descartados.
create unique index if not exists whatsapp_outbound_status_events_dedup_idx
  on public.whatsapp_outbound_status_events (
    integration_account_id, external_message_id, new_status, event_timestamp, (coalesce(error_code, ''))
  );

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_status_events_new_status_check') then
    alter table public.whatsapp_outbound_status_events drop constraint whatsapp_outbound_status_events_new_status_check;
  end if;
  alter table public.whatsapp_outbound_status_events
    add constraint whatsapp_outbound_status_events_new_status_check
    check (new_status in ('sent', 'delivered', 'read', 'failed'));
end $$;

comment on column public.whatsapp_outbound_status_events.integration_account_id is
  'Fase 3.5.2.3 — conta WhatsApp que reportou este evento, segundo o webhook (resolvida pelo phone_number_id do payload, nunca informada pelo cliente). Usada para detectar "conta incorreta" e para nunca reconciliar um evento contra uma mensagem de OUTRA conta.';

comment on column public.whatsapp_outbound_status_events.error_code is
  'Fase 3.5.2.3 — código de erro da Meta para um evento new_status=failed pendente de reconciliação. NUNCA conteúdo de mensagem, NUNCA token.';

-- Rollback deste bloco: "alter table public.whatsapp_outbound_status_events drop constraint if exists whatsapp_outbound_status_events_new_status_check; alter table public.whatsapp_outbound_status_events add constraint whatsapp_outbound_status_events_new_status_check check (new_status in ('delivered','read','failed')); alter table public.whatsapp_outbound_status_events drop column if exists integration_account_id; alter table public.whatsapp_outbound_status_events drop column if exists error_code;" (só seguro se nenhuma linha tiver new_status='sent' no momento do rollback).

-------------------------------------------------------------------
-- A2) CORREÇÃO (Finding #2 da auditoria adversarial) —
-- whatsapp_outbound_status_anomalies: antes desta correção,
-- ACCOUNT_MISMATCH era recusado mas não deixava rastro algum —
-- impossível investigar depois do fato. Esta tabela append-only
-- registra ACCOUNT_MISMATCH e também LATE_FAILURE_AFTER_DELIVERY
-- (Finding #1 — um 'failed' tardio bloqueado por entrega/leitura já
-- comprovada). Nunca token, nunca conteúdo de mensagem, nunca
-- telefone — só identificadores técnicos (ids de conta, wamid,
-- status). RLS habilitado SEM nenhuma policy: anon/authenticated
-- nunca leem nem escrevem; só service_role (que ignora RLS por
-- padrão do Postgres) tem acesso, via GRANT explícito.
-------------------------------------------------------------------
create table if not exists public.whatsapp_outbound_status_anomalies (
  id uuid primary key default gen_random_uuid(),
  anomaly_type text not null check (anomaly_type in ('ACCOUNT_MISMATCH', 'LATE_FAILURE_AFTER_DELIVERY')),
  reporting_integration_account_id uuid references public.integration_accounts(id) on delete set null,
  message_integration_account_id uuid references public.integration_accounts(id) on delete set null,
  external_message_id text not null,
  attempted_status text not null,
  current_status text,
  error_code text,
  event_timestamp timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_outbound_status_anomalies_wamid_idx
  on public.whatsapp_outbound_status_anomalies (external_message_id);

comment on table public.whatsapp_outbound_status_anomalies is
  'Fase 3.5.2.3 (correção pós-auditoria) — auditoria append-only de anomalias de status outbound (conta incorreta reportando evento, ou falha tardia bloqueada por entrega/leitura já comprovada). Nunca token, nunca conteúdo de mensagem, nunca telefone. Só service_role lê/escreve. Nunca altera a mensagem legítima, nunca cria associação especulativa.';

alter table public.whatsapp_outbound_status_anomalies enable row level security;

revoke all on public.whatsapp_outbound_status_anomalies from public;
revoke all on public.whatsapp_outbound_status_anomalies from anon;
revoke all on public.whatsapp_outbound_status_anomalies from authenticated;
grant select, insert on public.whatsapp_outbound_status_anomalies to service_role;

create or replace function public.log_whatsapp_outbound_status_anomaly(
  p_anomaly_type text,
  p_reporting_account_id uuid,
  p_message_account_id uuid,
  p_external_message_id text,
  p_attempted_status text,
  p_current_status text,
  p_error_code text,
  p_event_timestamp timestamptz
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.whatsapp_outbound_status_anomalies (
    anomaly_type, reporting_integration_account_id, message_integration_account_id,
    external_message_id, attempted_status, current_status, error_code, event_timestamp
  ) values (
    p_anomaly_type, p_reporting_account_id, p_message_account_id,
    p_external_message_id, p_attempted_status, p_current_status, p_error_code, p_event_timestamp
  );
end;
$$;

revoke all on function public.log_whatsapp_outbound_status_anomaly(text, uuid, uuid, text, text, text, text, timestamptz) from public;
revoke all on function public.log_whatsapp_outbound_status_anomaly(text, uuid, uuid, text, text, text, text, timestamptz) from anon;
revoke all on function public.log_whatsapp_outbound_status_anomaly(text, uuid, uuid, text, text, text, text, timestamptz) from authenticated;
grant execute on function public.log_whatsapp_outbound_status_anomaly(text, uuid, uuid, text, text, text, text, timestamptz) to service_role;

-- Rollback deste bloco: "drop function if exists public.log_whatsapp_outbound_status_anomaly(text, uuid, uuid, text, text, text, text, timestamptz); drop table if exists public.whatsapp_outbound_status_anomalies;"

-------------------------------------------------------------------
-- B) apply_whatsapp_outbound_status_event — CREATE OR REPLACE. Novo
-- parâmetro obrigatório p_integration_account_id (resolvido pelo
-- webhook a partir do phone_number_id do payload, NUNCA informado
-- pelo cliente do CRM) e novo parâmetro opcional p_error_code (só
-- relevante para new_status='failed'). Suporta agora também
-- new_status='sent'. Nova validação: se o wamid já existir numa
-- mensagem de OUTRA conta, o evento é recusado (ACCOUNT_MISMATCH) —
-- NUNCA aplicado, NUNCA associado por adivinhação.
-------------------------------------------------------------------
create or replace function public.apply_whatsapp_outbound_status_event(
  p_external_message_id text,
  p_new_status text,
  p_event_timestamp timestamptz,
  p_integration_account_id uuid,
  p_error_code text default null
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
  v_message_account_id uuid;
  v_message_status text;
  v_reporting_account_user_id uuid;
  v_reporting_account_provider text;
  v_allowed_from text[];
begin
  if p_external_message_id is null or p_external_message_id !~ '\S' then
    raise exception 'apply_whatsapp_outbound_status_event: p_external_message_id invalido (nulo ou vazio)';
  end if;
  if p_new_status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'apply_whatsapp_outbound_status_event: p_new_status invalido (%)', p_new_status;
  end if;
  if p_event_timestamp is null then
    raise exception 'apply_whatsapp_outbound_status_event: p_event_timestamp nao pode ser nulo';
  end if;
  if p_integration_account_id is null then
    raise exception 'apply_whatsapp_outbound_status_event: p_integration_account_id nao pode ser nulo';
  end if;

  -- Identificação da conta pelo identificador CONFIÁVEL já resolvido
  -- pelo webhook (item 2 do pedido) — exige que ela exista, esteja
  -- ativa e seja provider='whatsapp', mesmo padrão já usado em
  -- reserve_whatsapp_outbound_attempt (022).
  select ia.user_id, ia.provider into v_reporting_account_user_id, v_reporting_account_provider
  from public.integration_accounts ia
  where ia.id = p_integration_account_id and ia.active = true;

  if v_reporting_account_user_id is null then
    raise exception 'apply_whatsapp_outbound_status_event: integration_account % nao encontrada ou inativa', p_integration_account_id;
  end if;
  if v_reporting_account_provider is distinct from 'whatsapp' then
    raise exception 'apply_whatsapp_outbound_status_event: integration_account % nao e provider=whatsapp (provider=%)', p_integration_account_id, v_reporting_account_provider;
  end if;

  select wm.id, wm.integration_account_id, wm.status into v_id, v_message_account_id, v_message_status
  from public.whatsapp_messages wm
  where wm.external_message_id = p_external_message_id
  for update;

  if found then
    -- Item 2 do pedido: "não permitir que status de outra conta
    -- altere mensagens". A mensagem com este wamid já existe, mas
    -- pertence a uma conta DIFERENTE da que reportou o evento —
    -- recusado, nunca aplicado, nunca uma segunda tentativa de
    -- adivinhar a conta certa.
    if v_message_account_id is distinct from p_integration_account_id then
      -- CORREÇÃO (Finding #2) — antes recusado em silêncio; agora
      -- auditado (sem dados sensíveis), sem alterar a mensagem
      -- legítima e sem associação especulativa.
      perform public.log_whatsapp_outbound_status_anomaly(
        'ACCOUNT_MISMATCH', p_integration_account_id, v_message_account_id,
        p_external_message_id, p_new_status, v_message_status, p_error_code, p_event_timestamp
      );
      return query select 'ACCOUNT_MISMATCH'::text, null::uuid;
      return;
    end if;

    -- CORREÇÃO (Finding #1 — regressão de status) — política de
    -- transição documentada:
    --   sent -> delivered -> read: progressão normal, sempre válida.
    --   failed só é aceito partindo de 'sent' (nenhuma evidência de
    --     entrega ainda existe). Uma vez 'delivered' ou 'read'
    --     comprovados, um 'failed' tardio/fora de ordem (reordenação
    --     de webhooks da Meta é um comportamento real e documentado)
    --     NUNCA os sobrescreve — evidência positiva de entrega/leitura
    --     é tratada como mais confiável que um evento de falha
    --     posterior, e nunca é descartada silenciosamente (ver
    --     log_whatsapp_outbound_status_anomaly abaixo).
    --   delivered/read SÃO aceitos partindo de 'failed' — um 'failed'
    --     marcado anteriormente pode ser corrigido por uma entrega/
    --     leitura comprovada depois (ex.: falha reportada antes de uma
    --     reentrega bem-sucedida, ou reordenação do próprio webhook).
    --     Esta é a política conservadora: nunca descarta a evidência
    --     POSITIVA mais forte disponível. error_code é limpo nesse
    --     caso (deixaria de refletir o estado atual da mensagem).
    v_allowed_from := case p_new_status
      -- 'sent': por construção, toda linha com external_message_id já
      -- preenchido está, no mínimo, em 'sent' (confirm_whatsapp_outbound_sent
      -- é o ÚNICO caminho que grava external_message_id, sempre junto
      -- com status='sent') — logo um evento 'sent' encontrando a
      -- linha é SEMPRE um duplicado/fora de ordem, nunca uma transição
      -- nova.
      when 'sent' then array[]::text[]
      when 'delivered' then array['sent', 'failed']
      when 'read' then array['sent', 'delivered', 'failed']
      when 'failed' then array['sent']
      else array[]::text[]
    end;

    if v_message_status = any(v_allowed_from) then
      update public.whatsapp_messages
      set status = p_new_status,
          delivered_at = case when p_new_status = 'delivered' then coalesce(delivered_at, p_event_timestamp) else delivered_at end,
          read_at = case when p_new_status = 'read' then coalesce(read_at, p_event_timestamp) else read_at end,
          error_code = case
            when p_new_status = 'failed' then p_error_code
            when p_new_status in ('delivered', 'read') then null
            else error_code
          end
      where id = v_id;

      return query select 'APPLIED'::text, v_id;
      return;
    end if;

    if p_new_status = 'failed' and v_message_status in ('delivered', 'read') then
      -- CORREÇÃO (Finding #1) — bloqueado propositalmente (ver
      -- política acima). Nunca descartado em silêncio: auditado.
      perform public.log_whatsapp_outbound_status_anomaly(
        'LATE_FAILURE_AFTER_DELIVERY', p_integration_account_id, v_message_account_id,
        p_external_message_id, p_new_status, v_message_status, p_error_code, p_event_timestamp
      );
      return query select 'IGNORED_LATE_FAILURE_PROTECTED_DELIVERY'::text, v_id;
      return;
    end if;

    -- Evento fora de ordem (ex. 'delivered' chegando depois de 'read'
    -- já aplicado) ou reentrega de um evento já aplicado antes — em
    -- ambos os casos, ignorar é o comportamento correto (nunca
    -- regride, nunca duplica efeito, timestamps originais
    -- preservados).
    return query select 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE'::text, v_id;
    return;
  end if;

  -- Nenhuma linha com este external_message_id existe ainda — o
  -- status chegou ANTES da confirmação do envio (item 3 do pedido:
  -- "eventos antecipados"). Persiste em staging, JUNTO com a conta que
  -- reportou e o error_code (se houver) — nunca descarta, nunca
  -- associa especulativamente a nenhuma mensagem existente.
  -- CORREÇÃO (Finding #3) — deduplicação idempotente: um evento
  -- EXATAMENTE igual a um já estagiado (mesma conta, wamid, status,
  -- timestamp e error_code) não gera uma segunda linha. Eventos
  -- tecnicamente distintos continuam sendo preservados normalmente.
  insert into public.whatsapp_outbound_status_events (
    external_message_id, new_status, event_timestamp, integration_account_id, error_code
  )
  values (
    p_external_message_id, p_new_status, p_event_timestamp, p_integration_account_id, p_error_code
  )
  on conflict (integration_account_id, external_message_id, new_status, event_timestamp, (coalesce(error_code, '')))
  do nothing;

  return query select 'PENDING_WAMID'::text, null::uuid;
  return;
end;
$$;

comment on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz, uuid, text) is
  'Fase 3.5.2.1 (base) + 3.5.2.3 (suporte a sent, validação de conta via ACCOUNT_MISMATCH auditado, error_code preservado para failed, dedup idempotente de staging) + correção pós-auditoria (failed nunca regride delivered/read; delivered/read podem corrigir um failed anterior) — aplica um evento de status outbound vindo do webhook Meta já autenticado. Chamável só por service_role.';

revoke all on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz, uuid, text) from public;
revoke all on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz, uuid, text) from anon;
revoke all on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz, uuid, text) from authenticated;
grant execute on function public.apply_whatsapp_outbound_status_event(text, text, timestamptz, uuid, text) to service_role;

-- A assinatura ANTERIOR (3 parâmetros, sem conta/error_code) deixa de
-- ser chamável pelo nome simples — removida explicitamente para nunca
-- deixar uma versão insegura (sem a checagem de conta) ainda
-- invocável por engano, mesmo padrão já usado em 022 para
-- reserve_whatsapp_outbound_attempt.
drop function if exists public.apply_whatsapp_outbound_status_event(text, text, timestamptz);

-- Rollback deste bloco: "drop function if exists public.apply_whatsapp_outbound_status_event(text, text, timestamptz, uuid, text);" seguido de reaplicar o CREATE OR REPLACE FUNCTION da migration 020 (texto completo naquele arquivo, 3 parâmetros).

-------------------------------------------------------------------
-- C) confirm_whatsapp_outbound_sent — CREATE OR REPLACE. ÚNICA
-- mudança: a reconciliação de eventos pendentes (item 3 do pedido)
-- agora só reconcilia um evento em staging cuja integration_account_id
-- registrada corresponda EXATAMENTE à conta da própria mensagem sendo
-- confirmada — um evento estagiado para a conta errada nunca é
-- aplicado (fica pendente, visível para investigação, nunca apagado
-- silenciosamente). error_code de um evento 'failed' pendente também
-- é preservado ao reconciliar. Todo o restante (claim, conflitos de
-- wamid, idempotência) é preservado integralmente da 021, nunca
-- relaxado.
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
  v_integration_account_id uuid;
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

  select wm.status, wm.user_id, wm.lead_id, wm.integration_account_id, wm.lead_interaction_id, wm.content, wm.occurred_at, wm.external_message_id
    into v_status, v_user_id, v_lead_id, v_integration_account_id, v_existing_interaction_id, v_content, v_occurred_at, v_existing_wamid
  from public.whatsapp_messages wm
  where wm.id = p_message_id
  for update;

  if not found then
    raise exception 'confirm_whatsapp_outbound_sent: whatsapp_message % nao encontrado', p_message_id;
  end if;

  if v_status in ('sent', 'delivered', 'read') then
    if v_existing_wamid = p_external_message_id then
      return query select 'ALREADY_CONFIRMED'::text, v_existing_interaction_id;
      return;
    end if;

    insert into public.whatsapp_outbound_confirmation_conflicts (
      whatsapp_message_id, recorded_status, recorded_external_message_id, conflicting_external_message_id
    ) values (
      p_message_id, v_status, v_existing_wamid, p_external_message_id
    );
    return query select 'CONFLICT_DIFFERENT_WAMID'::text, v_existing_interaction_id;
    return;
  end if;

  if v_status = 'failed' then
    insert into public.whatsapp_outbound_confirmation_conflicts (
      whatsapp_message_id, recorded_status, recorded_external_message_id, conflicting_external_message_id
    ) values (
      p_message_id, v_status, v_existing_wamid, p_external_message_id
    );
    return query select 'CONFLICT_UNEXPECTED_STATE'::text, null::uuid;
    return;
  end if;

  if v_status not in ('sending', 'uncertain') then
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

  -- Fase 3.5.2.3 — reconciliação agora escopada também por conta: só
  -- eventos estagiados que relatam a MESMA integration_account_id
  -- desta mensagem são aplicados. Qualquer evento estagiado para uma
  -- conta diferente permanece pendente (nunca apagado, nunca
  -- aplicado) — visível numa consulta direta à tabela de staging para
  -- investigação manual.
  for v_pending in
    select id, new_status, event_timestamp, error_code
    from public.whatsapp_outbound_status_events
    where external_message_id = p_external_message_id
      and processed_at is null
      and integration_account_id = v_integration_account_id
    order by event_timestamp asc
  loop
    -- CORREÇÃO (Finding #1) — mesma política de transição do caminho
    -- direto (apply_whatsapp_outbound_status_event), aplicada também
    -- na reconciliação de eventos antecipados: lê o status ATUAL
    -- (pode já ter sido alterado por uma iteração anterior deste
    -- mesmo loop) antes de decidir.
    select wm.status into v_status from public.whatsapp_messages wm where wm.id = p_message_id;

    if v_pending.new_status = 'failed' and v_status in ('delivered', 'read') then
      -- Bloqueado propositalmente — nunca descartado em silêncio: a
      -- linha de staging é marcada processada (decisão tomada) e a
      -- anomalia é auditada.
      perform public.log_whatsapp_outbound_status_anomaly(
        'LATE_FAILURE_AFTER_DELIVERY', v_integration_account_id, v_integration_account_id,
        p_external_message_id, v_pending.new_status, v_status, v_pending.error_code, v_pending.event_timestamp
      );
    else
      update public.whatsapp_messages
      set status = v_pending.new_status,
          delivered_at = case when v_pending.new_status = 'delivered' then coalesce(delivered_at, v_pending.event_timestamp) else delivered_at end,
          read_at = case when v_pending.new_status = 'read' then coalesce(read_at, v_pending.event_timestamp) else read_at end,
          error_code = case
            when v_pending.new_status = 'failed' then v_pending.error_code
            when v_pending.new_status in ('delivered', 'read') then null
            else error_code
          end
      where id = p_message_id
        and status = any(
          case v_pending.new_status
            when 'delivered' then array['sent', 'failed']
            when 'read' then array['sent', 'delivered', 'failed']
            when 'failed' then array['sent']
            else array[]::text[]
          end
        );
    end if;

    update public.whatsapp_outbound_status_events
    set processed_at = now(), whatsapp_message_id = p_message_id
    where id = v_pending.id;
  end loop;

  return query select 'CONFIRMED'::text, v_interaction_id;
  return;
end;
$$;

comment on function public.confirm_whatsapp_outbound_sent(uuid, text) is
  'Fase 3.5.2.1 (base) + 3.5.2.2 + 3.5.2.3 (reconciliação escopada por integration_account_id) + correção pós-auditoria (mesma política de transição do caminho direto: failed nunca regride delivered/read, auditado quando bloqueado) — confirma atomicamente o aceite da Meta para uma tentativa de envio outbound.';

revoke all on function public.confirm_whatsapp_outbound_sent(uuid, text) from public;
revoke all on function public.confirm_whatsapp_outbound_sent(uuid, text) from anon;
revoke all on function public.confirm_whatsapp_outbound_sent(uuid, text) from authenticated;
grant execute on function public.confirm_whatsapp_outbound_sent(uuid, text) to service_role;

-- Rollback deste bloco: reaplicar o CREATE OR REPLACE FUNCTION da migration 021 (texto completo naquele arquivo) — nunca "drop function".
