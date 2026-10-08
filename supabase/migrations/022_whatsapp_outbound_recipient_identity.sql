-- Fase 3.5.2.2 — Correção do vínculo seguro de destinatário.
-- Depende de 018/019/020/021 (nunca os edita — mesmo precedente já
-- usado por 020/021 sobre 018: o arquivo histórico nunca muda, só uma
-- CREATE OR REPLACE/ALTER posterior substitui o que ele criou). ZERO
-- execução em produção, ZERO migration real aplicada, ZERO secret
-- real.
--
-- PROBLEMA CORRIGIDO (ver relatório da auditoria adversarial): o
-- destinatário do envio outbound era lido de leads.phone_normalized —
-- um campo editável pelo próprio dono do lead a qualquer momento (ver
-- src/lib/db.js, leadToRow — qualquer update que toque "telefone"
-- recalcula phone_normalized). Isso significa que editar o telefone
-- cadastral de um lead DENTRO da janela de 24h redirecionava
-- silenciosamente o próximo envio para um número diferente do que
-- efetivamente enviou a mensagem inbound que abriu essa janela — sem
-- nenhuma revalidação cruzada.
--
-- CAUSA RAIZ ESTRUTURAL: nenhuma linha de whatsapp_messages guardava a
-- identidade do remetente de forma imutável — só o vínculo (mutável)
-- via lead_id -> leads.phone_normalized. A Fase 3.3.3.1
-- (whatsappWebhook.ts, parseWhatsAppWebhookPayload) já EXTRAI
-- rawMessage.from (o wa_id real informado pela própria Meta para
-- aquela mensagem específica, imutável por natureza) e já o leva, via
-- normalizePhoneIdentity, a process_inbound_whatsapp_event como
-- p_phone_normalized — mas esse valor, antes desta migration, era
-- usado SOMENTE para localizar/criar o lead, nunca persistido em si
-- na própria linha de whatsapp_messages.
--
-- CORREÇÃO (menor alteração estrutural suficiente, nunca uma suposição
-- sobre dados não validados): uma única coluna nova,
-- whatsapp_messages.contact_phone_normalized — para INBOUND, grava o
-- wa_id real da própria mensagem (imutável a partir da criação, nunca
-- atualizado por nenhum caminho); para OUTBOUND, grava a identidade
-- JÁ VALIDADA e vinculada à intenção de envio NO MOMENTO da reserva,
-- dentro da MESMA transação do claim (reserve_whatsapp_outbound_attempt
-- revalida essa identidade de forma independente, nunca confiando
-- apenas no que o chamador informou — defesa em profundidade, mesmo
-- princípio já usado para ownership de lead/conta). A partir desta
-- migration, o destinatário outbound NUNCA é lido de
-- leads.phone_normalized em nenhum caminho novo.
--
-- Rollback: ver comentário de cada bloco.

-------------------------------------------------------------------
-- PRECONDIÇÕES
-------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'start_whatsapp_outbound_attempt_call'
  ) then
    raise exception 'Precondicao falhou: start_whatsapp_outbound_attempt_call (migration 021) nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- B) whatsapp_messages.contact_phone_normalized — identidade WhatsApp
-- do CONTATO (quem enviou, no inbound; para quem se reservou o envio,
-- no outbound), imutável a partir da criação da linha. Mesmo formato
-- de leads.phone_normalized (dígitos apenas) — nunca com "+" ou
-- espaços, mesma convenção já estabelecida em normalizePhoneIdentity.
-------------------------------------------------------------------
alter table public.whatsapp_messages
  add column if not exists contact_phone_normalized text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_messages_contact_phone_normalized_shape_check'
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_contact_phone_normalized_shape_check
      check (contact_phone_normalized is null or contact_phone_normalized ~ '^[0-9]+$');
  end if;

  -- Toda nova linha OUTBOUND passa a exigir esta identidade resolvida
  -- (reserve_whatsapp_outbound_attempt, seção D abaixo, sempre a
  -- popula). Linhas INBOUND criadas por versões anteriores de
  -- process_inbound_whatsapp_event (016/017/019, antes desta
  -- migration) permanecem com valor NULL — dado histórico nunca
  -- retroativamente inventado; tratadas como identidade indisponível
  -- por quem consumir esta coluna (ver whatsappSendContextRepository.ts).
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_messages_contact_phone_normalized_outbound_check'
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_contact_phone_normalized_outbound_check
      check (direction = 'inbound' or contact_phone_normalized is not null);
  end if;
end $$;

comment on column public.whatsapp_messages.contact_phone_normalized is
  'Fase 3.5.2.2 — identidade WhatsApp do contato (dígitos apenas), IMUTÁVEL a partir da criação da linha — reforçado por trigger (whatsapp_messages_identity_immutability_check_trigger, seção B2 abaixo), nunca apenas por disciplina de código. Inbound: o wa_id real informado pela Meta para ESTA mensagem especificamente (nunca leads.phone_normalized, que é editável). Outbound: a identidade validada e vinculada à intenção de envio no momento da reserva (reserve_whatsapp_outbound_attempt revalida de forma independente, por lead E por conta — nunca confia apenas no chamador). NULL só em linhas inbound históricas anteriores a esta migration — NUNCA preenchido retroativamente por backfill (a seção B2 bloqueia exatamente essa tentativa, já que seria um UPDATE).';

-- Rollback deste bloco: "alter table public.whatsapp_messages drop constraint if exists whatsapp_messages_contact_phone_normalized_outbound_check; alter table public.whatsapp_messages drop constraint if exists whatsapp_messages_contact_phone_normalized_shape_check; alter table public.whatsapp_messages drop column if exists contact_phone_normalized;" (aditivo, sem dado histórico dependente fora desta própria coluna).

-------------------------------------------------------------------
-- B2) IMUTABILIDADE REFORÇADA PELO BANCO (correção da auditoria final
-- — achado CONFIRMED: um UPDATE direto, mesmo por service_role,
-- conseguia rescrever contact_phone_normalized sem nenhuma
-- resistência, provado empiricamente). Esta trigger BEFORE UPDATE
-- bloqueia qualquer alteração a contact_phone_normalized — de um
-- número para outro, de um número para NULL, OU de NULL para um
-- número (o que bloqueia, pelo próprio desenho, qualquer backfill
-- especulativo via UPDATE, inclusive um baseado em
-- leads.phone_normalized: nenhum caminho legítimo de código precisa
-- desse UPDATE, pois a coluna é sempre definida no momento do INSERT,
-- nunca depois). Também bloqueia lead_id/integration_account_id/
-- direction/provider — qualquer um desses mudando depois da criação
-- seria um redirecionamento INDIRETO da mesma gravidade (associar a
-- mensagem, e sua identidade já estabelecida, a um lead/conta/sentido
-- diferente). Nenhuma RPC existente (018-022) jamais altera nenhuma
-- dessas 5 colunas via UPDATE — todas as atualizações legítimas
-- (status, attempt_claimed_at, sent_at, delivered_at, read_at,
-- error_code, external_message_id, lead_interaction_id, attempt_count,
-- last_attempted_at) continuam livres. SECURITY INVOKER — vale também
-- para service_role, que ignora RLS mas NUNCA ignora triggers (mesmo
-- princípio já usado no trigger de prevenção de DELETE em
-- whatsapp_outbound_attempts, migration 020).
-------------------------------------------------------------------
create or replace function public.whatsapp_messages_identity_immutability_check()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.contact_phone_normalized is distinct from old.contact_phone_normalized then
    raise exception 'whatsapp_messages: contact_phone_normalized e imutavel apos a criacao da linha (id=%, valor atual=%, valor tentado=%) — nenhum caminho legitimo altera esta coluna via UPDATE, nem mesmo service_role; nunca um backfill especulativo', old.id, old.contact_phone_normalized, new.contact_phone_normalized;
  end if;
  if new.lead_id is distinct from old.lead_id then
    raise exception 'whatsapp_messages: lead_id e imutavel apos a criacao da linha (id=%) — mudar isso seria um redirecionamento indireto', old.id;
  end if;
  if new.integration_account_id is distinct from old.integration_account_id then
    raise exception 'whatsapp_messages: integration_account_id e imutavel apos a criacao da linha (id=%) — mudar isso seria um redirecionamento indireto', old.id;
  end if;
  if new.direction is distinct from old.direction then
    raise exception 'whatsapp_messages: direction e imutavel apos a criacao da linha (id=%)', old.id;
  end if;
  if new.provider is distinct from old.provider then
    raise exception 'whatsapp_messages: provider e imutavel apos a criacao da linha (id=%)', old.id;
  end if;
  return new;
end;
$$;

comment on function public.whatsapp_messages_identity_immutability_check() is
  'Fase 3.5.2.2 (correção da auditoria final) — reforça no banco, via trigger, que contact_phone_normalized/lead_id/integration_account_id/direction/provider de whatsapp_messages nunca mudam depois do INSERT. Vale até para service_role (triggers nunca são ignorados, diferente de RLS).';

drop trigger if exists whatsapp_messages_identity_immutability_check_trigger on public.whatsapp_messages;
create trigger whatsapp_messages_identity_immutability_check_trigger
  before update on public.whatsapp_messages
  for each row execute function public.whatsapp_messages_identity_immutability_check();

-- Rollback deste bloco: "drop trigger if exists whatsapp_messages_identity_immutability_check_trigger on public.whatsapp_messages; drop function if exists public.whatsapp_messages_identity_immutability_check();"

-------------------------------------------------------------------
-- C) process_inbound_whatsapp_event — CREATE OR REPLACE (mesma
-- assinatura pública da 016/017/019, nenhum caller precisa mudar).
-- ÚNICA mudança: persiste contact_phone_normalized = p_phone_normalized
-- (o wa_id já validado por normalizePhoneIdentity, o MESMO valor que
-- já era usado para localizar/criar o lead) na linha de
-- whatsapp_messages inserida no passo 6b — nunca um valor novo
-- inventado, nunca uma segunda fonte de verdade. Todo o restante
-- (claim, status handling, guards de residuo/provider/external ids,
-- find-or-create de lead, interaction) é preservado integralmente da
-- 019, nunca relaxado.
-------------------------------------------------------------------
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

  if v_event_status = 'failed'
     and (v_event_resolved_interaction_id is not null
          or v_event_resolved_lead_id is not null
          or v_event_processed_at is not null)
  then
    raise exception 'process_inbound_whatsapp_event: integration_event % esta failed mas ja possui evidencia de processamento comitado (resolved_lead_id=%, resolved_interaction_id=%, processed_at=%) — residuo de possivel ambiguous commit, retry recusado para evitar lead_interactions duplicada; investigacao manual necessaria', p_integration_event_id, v_event_resolved_lead_id, v_event_resolved_interaction_id, v_event_processed_at;
  end if;

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

  if v_event_external_message_id is null or v_event_external_message_id !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao possui external_message_id valido (nulo ou vazio) — obrigatorio para idempotencia de mensagem WhatsApp', p_integration_event_id;
  end if;

  if v_event_external_event_id is null or v_event_external_event_id !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao possui external_event_id valido (nulo ou vazio)', p_integration_event_id;
  end if;

  if p_phone_normalized is null or p_phone_normalized !~ '^[0-9]+$' then
    raise exception 'process_inbound_whatsapp_event: p_phone_normalized invalido (esperado somente digitos, nao vazio)';
  end if;

  if p_nome is null or p_nome !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: p_nome ausente ou vazio';
  end if;

  if p_occurred_at is null then
    raise exception 'process_inbound_whatsapp_event: p_occurred_at nao pode ser nulo';
  end if;

  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'process_inbound_whatsapp_event: p_metadata deve ser SQL NULL ou um objeto jsonb (recebido: %)', jsonb_typeof(p_metadata);
  end if;

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

  v_message_type := p_metadata ->> 'message_type';

  -- Fase 3.5.2.2 — ÚNICA mudança desta migration: persiste
  -- contact_phone_normalized = p_phone_normalized (o MESMO wa_id já
  -- usado acima para localizar/criar o lead — nunca um valor novo).
  -- Esta é a identidade imutável que whatsappSendContextRepository.ts
  -- passará a usar como destinatário outbound, nunca mais
  -- leads.phone_normalized.
  insert into public.whatsapp_messages (
    user_id, lead_id, integration_account_id, integration_event_id, lead_interaction_id,
    provider, external_message_id, direction, message_type, content, status, occurred_at,
    contact_phone_normalized
  )
  values (
    v_ia_user_id, v_lead_id, p_integration_account_id, p_integration_event_id, v_interaction_id,
    'whatsapp', v_event_external_message_id, 'inbound', v_message_type, p_content, 'received', p_occurred_at,
    p_phone_normalized
  )
  returning id into v_message_id;

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
  'Fase 3.3.1 (base) + 3.3.3.3.1 + 3.4.1 + 3.5.2.2 (persiste tambem contact_phone_normalized, identidade imutavel do remetente) — processa atomicamente um integration_event de WhatsApp inbound. Ver comentarios de 016/017/019 para o restante do contrato, integralmente preservado.';

revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from public;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from anon;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from authenticated;
grant execute on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) to service_role;

-- Rollback deste bloco: reaplicar o CREATE OR REPLACE FUNCTION da migration 019 (texto completo naquele arquivo) — nunca "drop function".

-------------------------------------------------------------------
-- D) reserve_whatsapp_outbound_attempt — CREATE OR REPLACE. Novo
-- parâmetro obrigatório p_contact_phone_normalized: a identidade que o
-- CHAMADOR acredita ser a correta (resolvida por
-- whatsappSendContextRepository.ts a partir da conversa inbound). Esta
-- função NUNCA confia apenas nisso — revalida de forma independente,
-- DENTRO da mesma transação do claim, re-derivando a identidade a
-- partir das próprias mensagens inbound do lead (mesma query que o
-- repository usa) e comparando. Qualquer divergência (identidade
-- indisponível, ambígua, ou simplesmente diferente do que o chamador
-- informou — sinal de uma alteração concorrente entre a resolução de
-- contexto e esta chamada) é recusada ANTES de qualquer INSERT, nunca
-- depois. Isto fecha a corrida descrita no pedido de correção (item 4):
-- a identidade autorizada fica vinculada à intenção de envio DENTRO de
-- uma única operação transacional.
-------------------------------------------------------------------
create or replace function public.reserve_whatsapp_outbound_attempt(
  p_client_token uuid,
  p_user_id uuid,
  p_lead_id uuid,
  p_integration_account_id uuid,
  p_content text,
  p_contact_phone_normalized text
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
  v_contact_phone_normalized text;
  v_status text;
  v_attempt_claimed_at timestamptz;
  v_attempt_count integer;
  v_lead_owner uuid;
  v_account_owner uuid;
  v_account_provider text;
  v_has_prior_uncertain boolean;
  v_latest_inbound_contact text;
  v_distinct_inbound_contacts integer;
begin
  if p_client_token is null then
    raise exception 'reserve_whatsapp_outbound_attempt: p_client_token nao pode ser nulo';
  end if;
  if p_content is null or p_content !~ '\S' then
    raise exception 'reserve_whatsapp_outbound_attempt: p_content ausente ou vazio';
  end if;
  if p_contact_phone_normalized is null or p_contact_phone_normalized !~ '^[0-9]+$' then
    raise exception 'reserve_whatsapp_outbound_attempt: p_contact_phone_normalized invalido (esperado somente digitos, nao vazio)';
  end if;

  select user_id into v_lead_owner from public.leads where id = p_lead_id;
  if v_lead_owner is null then
    raise exception 'reserve_whatsapp_outbound_attempt: lead % nao encontrado', p_lead_id;
  end if;
  if v_lead_owner is distinct from p_user_id then
    raise exception 'reserve_whatsapp_outbound_attempt: lead % nao pertence ao usuario %', p_lead_id, p_user_id;
  end if;

  select user_id, provider into v_account_owner, v_account_provider
  from public.integration_accounts where id = p_integration_account_id and active = true;
  if v_account_owner is null then
    raise exception 'reserve_whatsapp_outbound_attempt: integration_account % nao encontrada ou inativa', p_integration_account_id;
  end if;
  if v_account_owner is distinct from p_user_id then
    raise exception 'reserve_whatsapp_outbound_attempt: integration_account % nao pertence ao usuario %', p_integration_account_id, p_user_id;
  end if;
  -- Fase 3.5.2.2 (item 2 do pedido) — exigencia EXPLICITA de
  -- provider='whatsapp', nunca inferida do contexto.
  if v_account_provider is distinct from 'whatsapp' then
    raise exception 'reserve_whatsapp_outbound_attempt: integration_account % nao e provider=whatsapp (provider=%)', p_integration_account_id, v_account_provider;
  end if;

  -------------------------------------------------------------------
  -- REVALIDAÇÃO TRANSACIONAL E INDEPENDENTE DA IDENTIDADE (item 1/4 da
  -- correção original + correção da auditoria final, item 2: a
  -- re-derivação é sempre por lead E por conta — nunca aceita como
  -- autorização uma mensagem inbound de OUTRA conta WhatsApp, mesmo
  -- pertencente ao mesmo usuário) — re-deriva, agora, dentro desta
  -- transação, qual é a identidade de contato mais recente para este
  -- lead NESTA conta especificamente, a partir das próprias mensagens
  -- inbound (nunca de leads.phone_normalized). Nunca confia no
  -- p_contact_phone_normalized informado sem confirmar.
  -------------------------------------------------------------------
  select wm.contact_phone_normalized into v_latest_inbound_contact
  from public.whatsapp_messages wm
  where wm.lead_id = p_lead_id
    and wm.integration_account_id = p_integration_account_id
    and wm.direction = 'inbound'
  order by wm.occurred_at desc
  limit 1;

  if v_latest_inbound_contact is null then
    return query select 'IDENTITY_UNAVAILABLE'::text, null::uuid, null::integer, null::text;
    return;
  end if;

  -- Ambiguidade (item 5 da correção original): mais de uma identidade
  -- de contato distinta entre as mensagens inbound deste lead NESTA
  -- MESMA conta, dentro da janela de 24h que fundamenta o atendimento
  -- atual — nunca escolhe uma silenciosamente. Escopada por conta
  -- (correção da auditoria final): duas contas diferentes, cada uma
  -- com sua própria identidade consistente, nunca geram uma
  -- ambiguidade espúria uma contra a outra.
  select count(distinct wm.contact_phone_normalized) into v_distinct_inbound_contacts
  from public.whatsapp_messages wm
  where wm.lead_id = p_lead_id
    and wm.integration_account_id = p_integration_account_id
    and wm.direction = 'inbound'
    and wm.occurred_at >= (
      select max(wm2.occurred_at) - interval '24 hours'
      from public.whatsapp_messages wm2
      where wm2.lead_id = p_lead_id
        and wm2.integration_account_id = p_integration_account_id
        and wm2.direction = 'inbound'
    );

  if v_distinct_inbound_contacts > 1 then
    return query select 'IDENTITY_AMBIGUOUS'::text, null::uuid, null::integer, null::text;
    return;
  end if;

  -- Divergencia entre o que o chamador informou e o que esta
  -- transacao acabou de revalidar de forma independente — sinal de
  -- alteracao concorrente (ex. uma nova mensagem inbound de outro
  -- numero chegou) entre a resolucao de contexto do chamador e esta
  -- chamada. Recusado, nunca redireciona silenciosamente.
  if v_latest_inbound_contact is distinct from p_contact_phone_normalized then
    return query select 'IDENTITY_MISMATCH'::text, null::uuid, null::integer, null::text;
    return;
  end if;

  loop
    select id, lead_id, integration_account_id, content, contact_phone_normalized, status, attempt_claimed_at
      into v_id, v_lead_id, v_integration_account_id, v_content, v_contact_phone_normalized, v_status, v_attempt_claimed_at
    from public.whatsapp_messages
    where client_token = p_client_token
    for update;

    if found then
      if v_lead_id is distinct from p_lead_id
         or v_integration_account_id is distinct from p_integration_account_id
         or v_content is distinct from p_content
         or v_contact_phone_normalized is distinct from p_contact_phone_normalized
      then
        return query select 'IDENTITY_CONFLICT'::text, v_id, null::integer, v_status;
        return;
      end if;

      if v_status = 'sending' then
        return query select 'ALREADY_CALLING'::text, v_id, null::integer, v_status;
        return;
      end if;

      if v_status = 'uncertain' then
        return query select 'UNCERTAIN_BLOCKED'::text, v_id, null::integer, v_status;
        return;
      end if;

      if v_status in ('sent', 'delivered', 'read', 'failed') then
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

    select exists (
      select 1 from public.whatsapp_messages
      where lead_id = p_lead_id and direction = 'outbound' and status = 'uncertain'
    ) into v_has_prior_uncertain;

    begin
      insert into public.whatsapp_messages (
        user_id, lead_id, integration_account_id, provider, direction, status,
        content, client_token, contact_phone_normalized, occurred_at, attempt_count, attempt_claimed_at, last_attempted_at
      ) values (
        p_user_id, p_lead_id, p_integration_account_id, 'whatsapp', 'outbound', 'queued',
        p_content, p_client_token, p_contact_phone_normalized, now(), 1, now(), now()
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

comment on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text, text) is
  'Fase 3.5.2.1 (base) + 3.5.2.2 (identidade de destinatario revalidada de forma transacional e independente, nunca confiada apenas ao chamador) — reserva uma tentativa de envio outbound com claim concorrencialmente seguro.';

revoke all on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text, text) from public;
revoke all on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text, text) from anon;
revoke all on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text, text) from authenticated;
grant execute on function public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text, text) to service_role;

-- A assinatura ANTERIOR (5 parâmetros, sem p_contact_phone_normalized)
-- deixa de ser a função chamável pelo nome simples, mas o Postgres
-- mantém ambas coexistindo (overloads distintas) — removida
-- explicitamente aqui para nunca deixar uma versão insegura (sem a
-- revalidação de identidade) ainda invocável por engano.
drop function if exists public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text);

-- Rollback deste bloco: "drop function if exists public.reserve_whatsapp_outbound_attempt(uuid, uuid, uuid, uuid, text, text);" seguido de reaplicar o CREATE OR REPLACE FUNCTION da migration 021 (texto completo naquele arquivo, 5 parâmetros).
