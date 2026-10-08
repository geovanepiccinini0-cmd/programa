-- Fase 3.3.3.3.1 — Pre-Exposure Hardening de process_inbound_whatsapp_event.
-- Rode este arquivo no SQL Editor do seu projeto Supabase, depois da
-- migration 016 (esta migration SUBSTITUI a função criada lá via
-- CREATE OR REPLACE, preservando exatamente a mesma assinatura pública
-- — nenhuma segunda função paralela é criada).
--
-- Motivação (achados confirmados na auditoria adversarial 3.3.3.3.0,
-- read-only, HIGH):
--
-- F4 (HIGH) — a interação criada gravava
-- metadata.external_event_id = p_integration_event_id::text (o UUID
-- INTERNO da linha, parâmetro da função), nunca
-- integration_events.external_event_id (o id real atribuído pelo
-- provider). Corrigido: lê-se explicitamente a coluna real da linha
-- (v_event_external_event_id) e ela é usada no metadata — o UUID
-- interno nunca aparece como se fosse a identidade do provider.
--
-- F6 (MEDIUM) — a função só exigia que event.provider e
-- account.provider fossem iguais ENTRE SI, nunca que qualquer um dos
-- dois fosse literalmente 'whatsapp'. Corrigido: guard explícito
-- exigindo provider='whatsapp' em ambas as linhas, antes de qualquer
-- escrita.
--
-- F7 (MEDIUM) — nenhuma validação de que external_message_id (coluna
-- nullable desde a 014) fosse não-nulo/não-vazio antes de processar.
-- Corrigido: guard explícito, mesma classe de verificação (POSIX \S)
-- já usada para p_nome desde a 016.
--
-- F8 (MEDIUM) — p_metadata podia ser um array ou escalar jsonb; o
-- operador `||` contra um array resulta num ARRAY (não um objeto),
-- perdendo silenciosamente os campos de sistema
-- (activity_class/source/provider/external_event_id/
-- external_message_id) sem erro algum. Corrigido: guard explícito
-- `jsonb_typeof(p_metadata) = 'object'` quando não-nulo.
--
-- F3/F23 (HIGH, complementar ao hardening TypeScript desta mesma fase
-- em integrationEventRepository.ts/inboundEngine.ts) — um evento
-- 'failed' com resíduo de um commit anterior (resolved_lead_id/
-- resolved_interaction_id/processed_at já preenchidos — sinal de
-- ambiguous commit ou linha legada) podia ser retried cegamente,
-- criando uma SEGUNDA lead_interactions para a mesma mensagem (zero
-- unique constraint em lead_interactions protege contra isso — ver
-- achado F5). Corrigido: guard explícito que recusa (RAISE EXCEPTION)
-- processar um evento 'failed' que já carregue qualquer um desses três
-- sinais — nunca insere uma segunda interação sobre um resíduo
-- ambíguo. Depois do hardening TypeScript desta mesma fase (Engine
-- nunca mais regride processed/ignored para failed via finalizer sem
-- predicate — ver integrationEventRepository.ts), novos ambiguous
-- commits não deveriam mais produzir esse resíduo; este guard é a
-- segunda linha de defesa para linhas legadas/residuais e para
-- qualquer caminho futuro que ainda não exista hoje.
--
-- F10 (LOW/INFO) — p_occurred_at NULL já abortava atomicamente via o
-- NOT NULL de lead_interactions.occurred_at (rollback garantido, zero
-- estado parcial). Adicionado guard explícito só para uma mensagem de
-- erro mais clara — não é um fix de integridade, o DB já garantia
-- segurança estrutural.
--
-- O QUE NÃO MUDA (preservado integralmente, nunca relaxado):
-- SECURITY INVOKER; search_path fixo; lock FOR UPDATE no evento e FOR
-- SHARE na conta; derivação de user_id exclusivamente de
-- integration_accounts (zero p_user_id); idempotência de 'processed'
-- (early-return sem nova interaction); 'ignored' nunca reprocessado;
-- semântica de find-or-create de lead via o índice único parcial da
-- 015 (nunca reativa soft-delete); produto/etapa/canal hardcoded;
-- atomicidade (tudo numa única transação); GRANTs restritos a
-- service_role.
--
-- Esta migration NÃO altera nenhuma tabela, NÃO cria nenhum índice
-- novo, NÃO faz backfill, NÃO altera RLS — só substitui o corpo da
-- função via CREATE OR REPLACE FUNCTION com a mesma assinatura.
--
-- Rollback: reaplicar o CREATE OR REPLACE FUNCTION da migration 016
-- (o texto completo da função anterior está naquele arquivo) — o
-- rollback NUNCA é "drop function", pois isso removeria a função por
-- completo; substituir pelo corpo anterior é a forma correta de
-- reverter apenas esta hardening.

-------------------------------------------------------------------
-- PRECONDIÇÕES — falha fechada se o contrato esperado da 016 não
-- existir. Nunca assume silenciosamente que a 016 foi aplicada.
-------------------------------------------------------------------

do $$
declare
  v_function_exists boolean;
  v_index_exists boolean;
begin
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'process_inbound_whatsapp_event'
  ) into v_function_exists;

  if not v_function_exists then
    raise exception 'Precondicao falhou: public.process_inbound_whatsapp_event (migration 016) nao existe — nao e seguro aplicar esta hardening';
  end if;

  select exists (
    select 1
    from pg_class c
    where c.relname = 'integration_events_provider_external_message_id_key'
      and c.relnamespace = 'public'::regnamespace
  ) into v_index_exists;

  if not v_index_exists then
    raise exception 'Precondicao falhou: indice integration_events_provider_external_message_id_key (migration 016) nao existe — nao e seguro aplicar esta hardening';
  end if;
end $$;

-------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION — mesma assinatura publica da 016.
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
begin
  -------------------------------------------------------------------
  -- 1) CLAIM: lock exclusivo na linha do evento — serializa qualquer
  -- chamada concorrente desta RPC para o MESMO integration_event_id
  -- (ex. retry acidental). Nenhum outro INSERT/UPDATE deste evento
  -- pode comitar enquanto esta transacao estiver aberta. Agora também
  -- lê external_event_id (Fase 3.3.3.3.1, fix F4) e processed_at
  -- (Fase 3.3.3.3.1, guard de residuo F3/F23).
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
  -- processed: retorno idempotente, SEM criar nova interacao.
  -- ignored: terminal e estavel por decisao de dominio (Fase 3.3.0,
  --   secao 9/10/11) — esta RPC NUNCA reprocessa um evento ja
  --   decidido como ignored; isso seria inverter uma decisao
  --   deliberada da Engine (Fase 3.3.2), nao desta funcao.
  -- received/processing/failed: estados que esta RPC aceita
  --   processar (failed e retryable por definicao — migration 014) —
  --   MAS ver o guard de residuo imediatamente abaixo para 'failed'.
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
  -- Fase 3.3.3.3.1 — FAILED RETRY SAFETY (achados F3/F23, HIGH).
  -- Um evento 'failed' que já carregue QUALQUER evidência de
  -- processamento comitado anteriormente (resolved_lead_id,
  -- resolved_interaction_id ou processed_at) nunca é reprocessado
  -- cegamente — isso seria a janela exata de ambiguous-commit que
  -- cria uma segunda lead_interactions para a mesma mensagem, já que
  -- lead_interactions não tem nenhuma unique constraint que impeça
  -- isso (achado F5). Falha fechada: intervenção manual é necessária
  -- para resolver um resíduo real. Um 'failed' GENUÍNO (nenhum desses
  -- três campos preenchido) continua podendo ser reprocessado
  -- normalmente, sem esta restrição.
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
  -- andamento (fecha a janela de corrida entre a resolucao da conta
  -- feita pela Engine, fora desta transacao, e esta validacao).
  -- NENHUM lead e criado antes desta validacao passar.
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
  -- Fase 3.3.3.3.1 — PROVIDER GUARD (achado F6, MEDIUM). A checagem
  -- de igualdade abaixo (preservada da 016) só garantia consistencia
  -- ENTRE event e account — nunca que qualquer um dos dois fosse
  -- realmente 'whatsapp'. Esta funcao e exclusiva para WhatsApp (ela
  -- hardcoda type='whatsapp'/channel='whatsapp' na interaction mais
  -- abaixo) — um event/account 'other'/'other' consistentes entre si
  -- NUNCA deveriam chegar aqui.
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
  -- Fase 3.3.3.3.1 — EXTERNAL MESSAGE/EVENT ID GUARDS (achado F7,
  -- MEDIUM, e defesa-em-profundidade para o fix F4). external_event_id
  -- já é NOT NULL + CHECK não-whitespace no schema (migration 014) —
  -- esta segunda checagem aqui é redundante por desenho (defesa em
  -- profundidade, mesmo estilo já usado no restante do projeto), nunca
  -- confiando silenciosamente que o schema nunca mudará.
  -- external_message_id, ao contrario, E nullable no schema — esta e a
  -- UNICA linha de defesa real contra um evento sem identidade de
  -- mensagem valida chegar a criar uma interaction.
  -------------------------------------------------------------------
  if v_event_external_message_id is null or v_event_external_message_id !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao possui external_message_id valido (nulo ou vazio) — obrigatorio para idempotencia de mensagem WhatsApp', p_integration_event_id;
  end if;

  if v_event_external_event_id is null or v_event_external_event_id !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: integration_event % nao possui external_event_id valido (nulo ou vazio)', p_integration_event_id;
  end if;

  -------------------------------------------------------------------
  -- 4) DEFESA MINIMA DE FORMA — a normalizacao completa (regras BR,
  -- DDD, nono digito) continua exclusivamente em
  -- src/lib/phoneIdentity.js (JS). Esta RPC nunca reimplementa essa
  -- regra — so rejeita o obviamente malformado, nunca tenta corrigir.
  -------------------------------------------------------------------
  -- Fase 3.3.1 — HIGH-risk review: usar "\S" (classe POSIX de
  -- nao-whitespace), nunca btrim() = '' para detectar vazio. btrim()
  -- sem argumento so remove o caractere espaco comum (0x20) — um
  -- valor so com tab/newline passaria incorretamente (exatamente a
  -- mesma classe de erro ja identificada e corrigida no CHECK de
  -- integration_events na migration 014, achado F-04). p_phone_normalized
  -- nao precisa dessa checagem separada: o regex ancorado
  -- '^[0-9]+$' already rejeita qualquer whitespace em qualquer
  -- posicao, inclusive string so-whitespace.
  if p_phone_normalized is null or p_phone_normalized !~ '^[0-9]+$' then
    raise exception 'process_inbound_whatsapp_event: p_phone_normalized invalido (esperado somente digitos, nao vazio)';
  end if;

  if p_nome is null or p_nome !~ '\S' then
    raise exception 'process_inbound_whatsapp_event: p_nome ausente ou vazio';
  end if;

  -------------------------------------------------------------------
  -- Fase 3.3.3.3.1 — OCCURRED_AT GUARD (achado F10, LOW/INFO). O
  -- NOT NULL de lead_interactions.occurred_at ja garantia rollback
  -- atomico sem estado parcial — este guard existe apenas para uma
  -- mensagem de erro mais clara (PL/pgSQL raise exception explicito em
  -- vez de uma violacao generica de constraint), nunca um fix de
  -- integridade (o DB ja era seguro aqui).
  -------------------------------------------------------------------
  if p_occurred_at is null then
    raise exception 'process_inbound_whatsapp_event: p_occurred_at nao pode ser nulo';
  end if;

  -------------------------------------------------------------------
  -- Fase 3.3.3.3.1 — METADATA SHAPE GUARD (achado F8, MEDIUM). O
  -- operador jsonb `||` contra um array ou escalar nao produz um
  -- merge de objeto — produz um ARRAY, perdendo silenciosamente os
  -- campos de sistema concatenados mais abaixo. JSON null explicito
  -- (jsonb 'null') e tratado como invalido tambem: so SQL NULL ou um
  -- objeto real sao aceitos.
  -------------------------------------------------------------------
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'process_inbound_whatsapp_event: p_metadata deve ser SQL NULL ou um objeto jsonb (recebido: %)', jsonb_typeof(p_metadata);
  end if;

  -------------------------------------------------------------------
  -- 5) FIND-OR-CREATE LEAD — ON CONFLICT por INFERENCIA de
  -- colunas+predicado (nunca ON CONSTRAINT: o indice da 015 e um
  -- indice unico PARCIAL, nao uma constraint em pg_constraint — ON
  -- CONSTRAINT so aceita constraints reais). produto/etapa/canal sao
  -- hardcoded nesta funcao V1 (decisao de produto congelada na Fase
  -- 3.3.1): 'A identificar' / 'Novo Lead' / 'whatsapp'. Lead
  -- EXISTENTE nunca e alterado por este INSERT (DO NOTHING) — nenhum
  -- campo seu e sobrescrito, nenhuma reativacao de soft-delete (o
  -- indice parcial so considera deleted_at IS NULL, entao um lead
  -- soft-deleted nunca entra em conflito — um lead novo ATIVO e
  -- criado ao lado dele, nunca reativando o antigo).
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
  -- 6) INTERACTION INBOUND — mesmo vocabulario ja reconhecido por
  -- src/lib/commercialInteractionHistory.js (activity_class=
  -- 'engagement'). source='integration' e um valor NOVO (antes so
  -- existia 'user', para log manual) — extensao aditiva, nunca lida
  -- por isEngagement/isAttemptOrEngagement (que so leem type/
  -- direction/activity_class), entao nao altera nenhuma decisao
  -- comercial existente. provider/external_event_id/
  -- external_message_id vem do PROPRIO integration_event (nunca
  -- aceitos cegamente via p_metadata do caller) — e os concatena por
  -- ULTIMO no jsonb (||), entao sempre vencem sobre qualquer chave
  -- igual que p_metadata eventualmente contenha.
  --
  -- Fase 3.3.3.3.1 — FIX F4 (HIGH): external_event_id agora usa
  -- v_event_external_event_id (a coluna REAL da linha, o id atribuido
  -- pelo provider), nunca p_integration_event_id::text (o UUID
  -- INTERNO desta tabela, que e o que a versao anterior gravava por
  -- engano). O UUID interno nao precisa de um campo proprio aqui — ele
  -- já é acessível via integration_events.id (resolved_interaction_id
  -- aponta de volta para esta interaction, e o vinculo inverso
  -- integration_events -> lead_interactions já existe).
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
  -- 7) MARK PROCESSED — unico lugar que avanca o evento para
  -- 'processed', sempre com os tres resolved_* preenchidos juntos.
  -- Como isto esta na MESMA transacao do INSERT de leads/
  -- lead_interactions acima, um COMMIT so pode tornar tudo visivel
  -- simultaneamente — qualquer falha anterior ja teria abortado a
  -- transacao inteira (ROLLBACK total, nenhum estado parcial
  -- observavel).
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
  'Fase 3.3.1 (base) + Fase 3.3.3.3.1 (hardening) — processa atomicamente um integration_event de WhatsApp inbound ja persistido e associado a uma integration_account resolvida: exige provider=whatsapp em ambas as linhas, exige external_message_id/external_event_id validos, valida a conta (ativa, correspondente ao evento), recusa retry de um failed com residuo de processamento comitado, encontra ou cria o lead (ON CONFLICT inferido pelo indice parcial da migration 015), cria a interacao inbound (metadata.external_event_id usa o id real do provider, nunca o UUID interno) e marca o evento processed — tudo na mesma transacao. user_id nunca e aceito como parametro, somente derivado de integration_accounts. Chamavel apenas por service_role (ver GRANTs abaixo) — nunca uma API privilegiada exposta a browser/authenticated.';

-- GRANTS — somente service_role pode executar. REVOKE explicito de
-- anon/authenticated (alem do REVOKE FROM PUBLIC, que ja cobriria
-- ambos nesta instalacao, mas o pedido e explicito e harmless/
-- idempotente mesmo sendo redundante). CREATE OR REPLACE FUNCTION
-- preserva os grants existentes quando a assinatura nao muda, mas
-- estes comandos sao reemitidos de forma defensiva/idempotente —
-- mesmo padrao ja usado na 016.
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from public;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from anon;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from authenticated;
grant execute on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) to service_role;
