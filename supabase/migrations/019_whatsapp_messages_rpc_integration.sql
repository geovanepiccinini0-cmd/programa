-- Fase 3.4.1 — Extensão controlada de process_inbound_whatsapp_event
-- para também persistir a mensagem individual em
-- public.whatsapp_messages (migration 018), na MESMA transação que já
-- cria/localiza o lead e registra a interação. Rode este arquivo
-- depois da 018.
--
-- CREATE OR REPLACE FUNCTION com a MESMA assinatura pública da 016/017
-- — nenhuma segunda função paralela é criada, nenhum caller precisa
-- mudar (o webhook/handler.ts/inboundEngine.ts já publicados em
-- produção continuam chamando exatamente a mesma RPC, com os mesmos
-- parâmetros, sem saber que esta tabela nova existe).
--
-- O QUE NÃO MUDA (preservado integralmente, nunca relaxado — mesma
-- lista já reafirmada na 017, reconfirmada aqui):
-- SECURITY INVOKER; search_path fixo; lock FOR UPDATE no evento e FOR
-- SHARE na conta; derivação de user_id exclusivamente de
-- integration_accounts (zero p_user_id); idempotência de 'processed'
-- (early-return sem nova interaction NEM nova whatsapp_messages);
-- 'ignored' nunca reprocessado; guard de residuo 'failed' (F3/F23);
-- guard provider=whatsapp (F6); guards de external_message_id/
-- external_event_id (F7); guard de metadata shape (F8); semântica de
-- find-or-create de lead via o índice único parcial da 015 (nunca
-- reativa soft-delete); produto/etapa/canal hardcoded; atomicidade
-- (tudo numa única transação); GRANTs restritos a service_role.
--
-- O QUE MUDA: imediatamente após criar a lead_interaction (passo 6) e
-- ANTES de marcar o evento 'processed' (passo 7), um INSERT adicional
-- em public.whatsapp_messages, dentro da MESMA transação — logo,
-- atômico com tudo o resto: se esse insert falhar (ex. o trigger de
-- consistência da 018 rejeitar, ou a unique key de mensagem da 018
-- disparar), a transação INTEIRA aborta (ROLLBACK total) — nenhum
-- lead, nenhuma lead_interaction, nenhum avanço de status sobrevive
-- parcialmente. O evento permanece não-terminal (received/processing/
-- failed), e uma redelivery da Meta tenta de novo com segurança (o
-- ingress já é idempotente, a RPC já é idempotente para 'processed').
--
-- message_type vem de p_metadata->>'message_type' — o MESMO valor que
-- buildInboundMetadata (inboundEngine.ts) já popula a partir do
-- CanonicalInboundEvent.messageType (nunca um valor novo inventado por
-- esta função). status é hardcoded 'received' para todo INSERT
-- inbound desta função (o conceito de queued/sent/delivered/read
-- aplica-se a outbound, fora do escopo desta fase).
--
-- Rollback: reaplicar o CREATE OR REPLACE FUNCTION da migration 017
-- (texto completo naquele arquivo) — nunca "drop function".

create or replace function public.process_inbound_whatsapp_event(
  p_integration_event_id uuid,
  p_integration_account_id uuid,
  p_phone_normalized text,
  p_telefone_display text,
  p_nome text,
  p_occurred_at timestamptz,
  p_content text,
  p_metadata jsonb
)
returns table (
  lead_id uuid,
  interaction_id uuid,
  was_new_lead boolean,
  event_status text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event_status text;
  v_event_provider text;
  v_event_external_event_id text;
  v_event_account_external_id text;
  v_event_integration_account_id uuid;
  v_event_external_message_id text;
  v_event_resolved_lead_id uuid;
  v_event_resolved_interaction_id uuid;
  v_event_processed_at timestamptz;

  v_ia_user_id uuid;
  v_ia_active boolean;
  v_ia_provider text;
  v_ia_external_account_id text;

  v_lead_id uuid;
  v_was_new_lead boolean;
  v_interaction_id uuid;
  v_interaction_metadata jsonb;
  v_message_id uuid;
  v_message_type text;
begin
  -------------------------------------------------------------------
  -- 1) CLAIM: lock exclusivo na linha do evento — serializa qualquer
  -- chamada concorrente desta RPC para o MESMO integration_event_id
  -- (ex. retry acidental). Nenhum outro INSERT/UPDATE deste evento
  -- pode comitar enquanto esta transacao estiver aberta.
  -------------------------------------------------------------------
  select
    ie.status, ie.provider, ie.external_event_id, ie.account_external_id, ie.integration_account_id,
    ie.external_message_id, ie.resolved_lead_id, ie.resolved_interaction_id, ie.processed_at
    into
    v_event_status, v_event_provider, v_event_external_event_id, v_event_account_external_id, v_event_integration_account_id,
    v_event_external_message_id, v_event_resolved_lead_id, v_event_resolved_interaction_id, v_event_processed_at
  from public.integration_events ie
  where ie.id = p_integration_event_id
  for update;

  if not found then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao encontrado', p_integration_event_id;
  end if;

  -------------------------------------------------------------------
  -- 2) STATUS HANDLING — explicito, sem state machine implicita.
  -- processed: retorno idempotente, SEM criar nova interacao NEM nova
  --   whatsapp_messages (early-return antes de qualquer INSERT).
  -- ignored: terminal e estavel por decisao de dominio — esta RPC
  --   NUNCA reprocessa um evento ja decidido como ignored.
  -- received/processing/failed: estados que esta RPC aceita
  --   processar (failed e retryable por definicao) — MAS ver o guard
  --   de residuo imediatamente abaixo para 'failed'.
  -------------------------------------------------------------------
  if v_event_status = 'processed' then
    return query select v_event_resolved_lead_id, v_event_resolved_interaction_id, false, 'processed'::text;
    return;
  end if;

  if v_event_status = 'ignored' then
    raise exception 'process_inbound_whatsapp_event: integration_event % esta ignored — esta RPC nunca reprocessa um evento ignored', p_integration_event_id;
  end if;

  if v_event_status not in ('received', 'processing', 'failed') then
    raise exception 'process_inbound_whatsapp_event: integration_event % com status inesperado (%)', p_integration_event_id, v_event_status;
  end if;

  -------------------------------------------------------------------
  -- FAILED RETRY SAFETY (achados F3/F23, HIGH, preservado da 017). Um
  -- evento 'failed' que já carregue QUALQUER evidência de
  -- processamento comitado anteriormente nunca é reprocessado
  -- cegamente.
  -------------------------------------------------------------------
  if v_event_status = 'failed'
     and (v_event_resolved_interaction_id is not null
          or v_event_resolved_lead_id is not null
          or v_event_processed_at is not null)
  then
    raise exception 'process_inbound_whatsapp_event: integration_event % esta failed mas ja possui evidencia de processamento comitado (resolved_lead_id=%, resolved_interaction_id=%, processed_at=%) — residuo de possivel ambiguous commit, retry recusado para evitar lead_interactions duplicada; investigacao manual necessaria', p_integration_event_id, v_event_resolved_lead_id, v_event_resolved_interaction_id, v_event_processed_at;
  end if;

  -------------------------------------------------------------------
  -- 3) ACCOUNT SECURITY VALIDATION — user_id e derivado EXCLUSIVAMENTE
  -- desta linha, nunca de um parametro. FOR SHARE: impede que a conta
  -- seja desativada por outra transacao enquanto esta ainda esta em
  -- andamento. NENHUM lead e criado antes desta validacao passar.
  -------------------------------------------------------------------
  select ia.user_id, ia.active, ia.provider, ia.external_account_id
    into v_ia_user_id, v_ia_active, v_ia_provider, v_ia_external_account_id
  from public.integration_accounts ia
  where ia.id = p_integration_account_id
  for share;

  if not found then
    raise exception 'process_inbound_whatsapp_event: integration_account % nao encontrada', p_integration_account_id;
  end if;

  if v_ia_active is distinct from true then
    raise exception 'process_inbound_whatsapp_event: integration_account % esta inativa', p_integration_account_id;
  end if;

  -------------------------------------------------------------------
  -- PROVIDER GUARD (achado F6, preservado da 017).
  -------------------------------------------------------------------
  if v_event_provider is distinct from 'whatsapp' or v_ia_provider is distinct from 'whatsapp' then
    raise exception 'process_inbound_whatsapp_event: esta funcao e exclusiva para provider=whatsapp (event.provider=%, account.provider=%)', v_event_provider, v_ia_provider;
  end if;

  if v_event_provider is distinct from v_ia_provider
     or v_event_account_external_id is distinct from v_ia_external_account_id
  then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao corresponde a integration_account % (provider/account_external_id divergem)', p_integration_event_id, p_integration_account_id;
  end if;

  if v_event_integration_account_id is not null
     and v_event_integration_account_id is distinct from p_integration_account_id
  then
    raise exception 'process_inbound_whatsapp_event: integration_event % ja esta associado a outra integration_account', p_integration_event_id;
  end if;

  -------------------------------------------------------------------
  -- EXTERNAL MESSAGE/EVENT ID GUARDS (achado F7, preservado da 017).
  -------------------------------------------------------------------
  if v_event_external_message_id is null or v_event_external_message_id !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao possui external_message_id valido (nulo ou vazio) — obrigatorio para idempotencia de mensagem WhatsApp', p_integration_event_id;
  end if;

  if v_event_external_event_id is null or v_event_external_event_id !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao possui external_event_id valido (nulo ou vazio)', p_integration_event_id;
  end if;

  -------------------------------------------------------------------
  -- 4) DEFESA MINIMA DE FORMA — preservada integralmente da 016/017.
  -------------------------------------------------------------------
  if p_phone_normalized is null or p_phone_normalized !~ '^[0-9]+$' then
    raise exception 'process_inbound_whatsapp_event: p_phone_normalized invalido (esperado somente digitos, nao vazio)';
  end if;

  if p_nome is null or p_nome !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: p_nome ausente ou vazio';
  end if;

  if p_occurred_at is null then
    raise exception 'process_inbound_whatsapp_event: p_occurred_at nao pode ser nulo';
  end if;

  -------------------------------------------------------------------
  -- METADATA SHAPE GUARD (achado F8, preservado da 017).
  -------------------------------------------------------------------
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'process_inbound_whatsapp_event: p_metadata deve ser SQL NULL ou um objeto jsonb (recebido: %)', jsonb_typeof(p_metadata);
  end if;

  -------------------------------------------------------------------
  -- 5) FIND-OR-CREATE LEAD — preservado integralmente da 016/017.
  -------------------------------------------------------------------
  insert into public.leads (user_id, nome, telefone, phone_normalized, produto, etapa, canal)
  values (v_ia_user_id, p_nome, p_telefone_display, p_phone_normalized, 'A identificar', 'Novo Lead', 'whatsapp')
  on conflict (user_id, phone_normalized) where deleted_at is null and phone_normalized is not null
  do nothing
  returning id into v_lead_id;

  if v_lead_id is null then
    v_was_new_lead := false;
    select l.id into v_lead_id
    from public.leads l
    where l.user_id = v_ia_user_id
      and l.phone_normalized = p_phone_normalized
      and l.deleted_at is null;

    if v_lead_id is null then
      raise exception 'process_inbound_whatsapp_event: conflito no insert do lead mas nenhum lead ativo encontrado (user_id=%, phone_normalized=%) — estado inesperado', v_ia_user_id, p_phone_normalized;
    end if;
  else
    v_was_new_lead := true;
  end if;

  -------------------------------------------------------------------
  -- 6) INTERACTION INBOUND — preservado integralmente da 017 (fix F4:
  -- external_event_id usa a coluna real da linha, nunca o UUID
  -- interno).
  -------------------------------------------------------------------
  v_interaction_metadata := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
    'activity_class', 'engagement',
    'source', 'integration',
    'provider', v_event_provider,
    'external_event_id', v_event_external_event_id,
    'external_message_id', v_event_external_message_id
  );

  insert into public.lead_interactions (user_id, lead_id, type, direction, channel, content, metadata, occurred_at, created_by)
  values (v_ia_user_id, v_lead_id, 'whatsapp', 'inbound', 'whatsapp', p_content, v_interaction_metadata, p_occurred_at, null)
  returning id into v_interaction_id;

  -------------------------------------------------------------------
  -- Fase 3.4.1 — NOVO: 6b) WHATSAPP_MESSAGES INBOUND. Mesma
  -- transacao do INSERT de leads/lead_interactions acima — atomico
  -- com tudo o resto (ver comentario de topo do arquivo). message_type
  -- vem de p_metadata (o mesmo objeto que buildInboundMetadata, em
  -- inboundEngine.ts, ja popula com messageType do parser) — nunca um
  -- valor novo inventado aqui. direction e status sao hardcoded
  -- ('inbound'/'received') porque esta funcao e exclusiva para
  -- inbound (ver nome da funcao e guard de provider acima). O trigger
  -- whatsapp_messages_consistency_check_trigger (migration 018) revalida
  -- de forma independente que user_id corresponde ao owner do lead E
  -- da integration_account — nunca confiado apenas por esta funcao ja
  -- ter derivado v_ia_user_id corretamente (defesa em profundidade).
  -- Se este INSERT falhar por QUALQUER motivo (trigger, unique key de
  -- mensagem, FK), a excecao propaga e a transacao INTEIRA e abortada
  -- — nenhum lead/interaction criado acima sobrevive parcialmente.
  -------------------------------------------------------------------
  v_message_type := p_metadata ->> 'message_type';

  insert into public.whatsapp_messages (
    user_id, lead_id, integration_account_id, integration_event_id, lead_interaction_id,
    provider, external_message_id, direction, message_type, content, status, occurred_at
  )
  values (
    v_ia_user_id, v_lead_id, p_integration_account_id, p_integration_event_id, v_interaction_id,
    'whatsapp', v_event_external_message_id, 'inbound', v_message_type, p_content, 'received', p_occurred_at
  )
  returning id into v_message_id;

  -------------------------------------------------------------------
  -- 7) MARK PROCESSED — preservado integralmente da 016/017.
  -------------------------------------------------------------------
  update public.integration_events
  set status = 'processed',
      processing_started_at = coalesce(processing_started_at, now()),
      processed_at = now(),
      resolved_user_id = v_ia_user_id,
      resolved_lead_id = v_lead_id,
      resolved_interaction_id = v_interaction_id,
      integration_account_id = p_integration_account_id,
      error_code = null
  where id = p_integration_event_id;

  return query select v_lead_id, v_interaction_id, v_was_new_lead, 'processed'::text;
  return;
end;
$$;

comment on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) is
  'Fase 3.3.1 (base) + 3.3.3.3.1 (hardening) + 3.4.1 (persiste tambem em whatsapp_messages, mesma transacao) — processa atomicamente um integration_event de WhatsApp inbound ja persistido e associado a uma integration_account resolvida: exige provider=whatsapp em ambas as linhas, exige external_message_id/external_event_id validos, valida a conta (ativa, correspondente ao evento), recusa retry de um failed com residuo de processamento comitado, encontra ou cria o lead (ON CONFLICT inferido pelo indice parcial da migration 015), cria a interacao inbound, cria a mensagem individual em whatsapp_messages (migration 018, revalidada por trigger de consistencia owner/lead/account) e marca o evento processed — tudo na mesma transacao. user_id nunca e aceito como parametro, somente derivado de integration_accounts. Chamavel apenas por service_role (ver GRANTs abaixo) — nunca uma API privilegiada exposta a browser/authenticated.';

-- GRANTS — preservados integralmente (mesmo padrão da 016/017,
-- reemitidos de forma defensiva/idempotente).
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from public;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from anon;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from authenticated;
grant execute on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) to service_role;
