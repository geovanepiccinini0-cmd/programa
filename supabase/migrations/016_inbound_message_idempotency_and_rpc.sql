-- Fase 3.3.1 — Inbound Transaction & Message Idempotency Foundation.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql — mas, como as
-- demais migrations desta série, aplique manualmente em instalações
-- existentes).
--
-- Depende de: 013 (integration_accounts), 014 (integration_events),
-- 015 (índice único de phone identity ativo). Rode só depois dessas.
--
-- Dois objetos, no MESMO boundary lógico e revertíveis juntos:
--
-- A) Índice único parcial (provider, external_message_id) em
--    integration_events — idempotência em nível de MENSAGEM comercial,
--    reservada desde a 014 mas deliberadamente deferida até agora (ver
--    comentário da coluna external_message_id em 014). DIFERENTE de
--    (provider, external_event_id) (já existente, idempotência de
--    ENTREGA de webhook): uma reentrega do mesmo webhook é o mesmo
--    event_id; a mesma mensagem comercial reaparecendo em deliveries
--    diferentes (ou um payload do provider agrupando múltiplas
--    mensagens num único event) é o problema que a unicidade de
--    external_message_id resolve. Nenhuma das duas substitui a outra.
--
-- B) Função process_inbound_whatsapp_event(...) — primeira RPC
--    transacional do projeto. Processa, atomicamente, UM
--    integration_event já persistido (received/processing/failed) e
--    associado a uma integration_account já resolvida: valida a conta
--    (ativa, correspondente ao evento), encontra ou cria o lead
--    (usando o índice único parcial da 015 via ON CONFLICT inferido
--    por colunas+predicado, nunca ON CONSTRAINT — Postgres não aceita
--    ON CONSTRAINT para um índice único PARCIAL, só para constraints
--    reais em pg_constraint), cria a interação inbound e marca o
--    evento como processed — tudo ou nada. Garantia central (Fase
--    3.3.0, seção 18): nenhum observador externo pode ver um lead novo
--    sem a interação que o originou, porque ambos só se tornam
--    visíveis no mesmo COMMIT.
--
-- user_id NUNCA é aceito como parâmetro: é derivado exclusivamente da
-- linha de integration_accounts (id = p_integration_account_id, active
-- = true), nunca de payload externo — a função então confirma que o
-- integration_event realmente pertence a essa conta (mesmo
-- provider + account_external_id) antes de qualquer escrita. produto/
-- etapa/canal de um lead NOVO são hardcoded nesta função V1 (não
-- aceitos do caller) — reduz deliberadamente o que um caller pode
-- decidir.
--
-- Zero SQL dinâmico, zero EXECUTE concatenado — só PL/pgSQL estático
-- com parâmetros tipados.
--
-- SECURITY INVOKER (explícito, é o default, mas declarado para nunca
-- depender do default implícito): não há necessidade de elevar
-- privilégio via SECURITY DEFINER — quem chamará esta função é
-- service_role, que já ignora RLS por definição do Postgres/Supabase
-- independente de como a função executa. search_path fixo mesmo assim
-- (defesa em profundidade) e toda referência a tabela é qualificada
-- com schema (public./auth.), nunca dependendo do search_path da
-- sessão. Grants explícitos ao final: REVOKE de anon/authenticated,
-- GRANT só para service_role — esta função nunca pode se tornar uma
-- API chamável pelo browser para criar leads de outro tenant.
--
-- Rollback: "drop function if exists public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb); drop index if exists public.integration_events_provider_external_message_id_key;"

-------------------------------------------------------------------
-- A) ÍNDICE ÚNICO PARCIAL — message-level idempotency
-------------------------------------------------------------------

do $$
declare
  v_dup_count integer;
begin
  -------------------------------------------------------------------
  -- PRECHECK: zero duplicidade de (provider, external_message_id)
  -- entre linhas com external_message_id não-nulo — reconfirmado
  -- agora, nunca reaproveitando uma contagem histórica. Se houver
  -- duplicata real, a migration aborta e NÃO corrige/apaga nada
  -- automaticamente — intervenção manual é necessária.
  -------------------------------------------------------------------
  select count(*) into v_dup_count
  from (
    select provider, external_message_id
    from public.integration_events
    where external_message_id is not null
    group by provider, external_message_id
    having count(*) > 1
  ) as dups;
  if v_dup_count <> 0 then
    raise exception 'Precheck falhou: % grupo(s) (provider, external_message_id) duplicado(s) em integration_events — nao e seguro criar o indice', v_dup_count;
  end if;
end $$;

do $$
declare
  v_relkind "char";
  v_indrelid regclass;
  v_indisunique boolean;
  v_indisvalid boolean;
  v_indisready boolean;
  v_indnkeyatts smallint;
  v_indkey int2vector;
  v_has_expression_key boolean;
  v_key_count integer;
  v_col_names text[];
  v_predicate_raw text;
  v_predicate_normalized text;
  v_expected_predicate text;
begin
  -------------------------------------------------------------------
  -- EXISTING-OBJECT CHECK (mesmo padrão hardened da 015): se já
  -- existe QUALQUER objeto com este nome, nunca assumir — provar
  -- estruturalmente que é exatamente o índice esperado, ou abortar.
  -------------------------------------------------------------------
  select c.relkind into v_relkind
  from pg_class c
  where c.relname = 'integration_events_provider_external_message_id_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_relkind is not null and v_relkind <> 'i' then
    raise exception 'Objeto "integration_events_provider_external_message_id_key" ja existe em public mas NAO e um indice (relkind=%) — colisao de nome, intervencao manual necessaria, nada foi alterado', v_relkind;
  end if;

  if v_relkind = 'i' then
    select
      pgi.indrelid, pgi.indisunique, pgi.indisvalid, pgi.indisready, pgi.indnkeyatts, pgi.indkey,
      pg_get_expr(pgi.indpred, pgi.indrelid)
      into v_indrelid, v_indisunique, v_indisvalid, v_indisready, v_indnkeyatts, v_indkey, v_predicate_raw
    from pg_class c
    join pg_index pgi on pgi.indexrelid = c.oid
    where c.relname = 'integration_events_provider_external_message_id_key'
      and c.relnamespace = 'public'::regnamespace;

    if v_indrelid is distinct from 'public.integration_events'::regclass then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas aponta para outra tabela (indrelid=%, esperado public.integration_events) — intervencao manual necessaria, nada foi alterado', v_indrelid;
    end if;

    if v_indisvalid is distinct from true then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas esta INVALID — intervencao manual necessaria, nada foi alterado';
    end if;

    if v_indisready is distinct from true then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas NAO esta pronto (indisready=false) — possivel build concorrente em andamento, nao prosseguir';
    end if;

    if v_indisunique is distinct from true then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas NAO e unique — intervencao manual necessaria, nada foi alterado';
    end if;

    select
      bool_or(k.attnum = 0),
      count(*),
      array_agg(a.attname order by k.ordinality)
      into v_has_expression_key, v_key_count, v_col_names
    from unnest(v_indkey) with ordinality as k(attnum, ordinality)
    left join pg_attribute a on a.attrelid = v_indrelid and a.attnum = k.attnum
    where k.ordinality <= v_indnkeyatts;

    if v_has_expression_key is distinct from false then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas possui chave de expressao inesperada — intervencao manual necessaria, nada foi alterado';
    end if;

    if v_key_count <> 2 or v_col_names is distinct from array['provider', 'external_message_id'] then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas colunas/ordem divergem do esperado (encontrado: %, esperado: {provider,external_message_id}) — intervencao manual necessaria, nada foi alterado', v_col_names;
    end if;

    -- Predicado de uma única condição (sem AND/OR) — confirmado
    -- empiricamente em Postgres 16 local que pg_get_expr NUNCA
    -- adiciona um par de parênteses extra aqui (o problema da 015 só
    -- ocorre com uma conjunção de duas condições). Mesmo assim,
    -- normaliza espaço/caixa antes de comparar, nunca remoção
    -- genérica de parênteses.
    v_predicate_normalized := lower(regexp_replace(coalesce(v_predicate_raw, ''), '\s+', ' ', 'g'));
    v_expected_predicate := lower(regexp_replace('(external_message_id IS NOT NULL)', '\s+', ' ', 'g'));
    if v_predicate_normalized is distinct from v_expected_predicate then
      raise exception 'Indice integration_events_provider_external_message_id_key existe mas o predicate diverge do esperado (encontrado: %) — intervencao manual necessaria, nada foi alterado', v_predicate_raw;
    end if;

    raise notice 'Indice integration_events_provider_external_message_id_key ja existe, e valido, esta pronto e com definicao exatamente esperada — CREATE INDEX IF NOT EXISTS abaixo sera no-op (rerun seguro).';
  end if;
end $$;

create unique index if not exists integration_events_provider_external_message_id_key
  on public.integration_events (provider, external_message_id)
  where external_message_id is not null;

comment on index public.integration_events_provider_external_message_id_key is
  'Fase 3.3.1 — idempotência em nível de MENSAGEM comercial (diferente de integration_events_provider_external_event_id_key, que é idempotência de ENTREGA de webhook). NULL nunca participa. Impede que process_inbound_whatsapp_event crie duas interações para a mesma mensagem, mesmo que ela apareça em deliveries/eventos diferentes.';

-- POSTCHECK (dentro do mesmo DO da existing-object check seria
-- redundante aqui, já que CREATE UNIQUE INDEX teria abortado a
-- transação inteira em caso de violação real de unicidade — mas
-- revalidamos estruturalmente por completo, mesmo padrão da 015).
do $$
declare
  v_relkind "char";
  v_indrelid regclass;
  v_indisunique boolean;
  v_indisvalid boolean;
  v_indisready boolean;
begin
  select c.relkind into v_relkind
  from pg_class c
  where c.relname = 'integration_events_provider_external_message_id_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_relkind is distinct from 'i' then
    raise exception 'Postcheck falhou: integration_events_provider_external_message_id_key nao existe como indice apos a criacao (relkind=%)', v_relkind;
  end if;

  select pgi.indrelid, pgi.indisunique, pgi.indisvalid, pgi.indisready
    into v_indrelid, v_indisunique, v_indisvalid, v_indisready
  from pg_class c
  join pg_index pgi on pgi.indexrelid = c.oid
  where c.relname = 'integration_events_provider_external_message_id_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_indrelid is distinct from 'public.integration_events'::regclass
     or v_indisunique is distinct from true
     or v_indisvalid is distinct from true
     or v_indisready is distinct from true
  then
    raise exception 'Postcheck falhou: indice integration_events_provider_external_message_id_key nao esta no estado esperado (indrelid=%, unique=%, valid=%, ready=%)', v_indrelid, v_indisunique, v_indisvalid, v_indisready;
  end if;

  raise notice 'Postcheck OK: integration_events_provider_external_message_id_key confirmado unique=true, valid=true, ready=true.';
end $$;

-------------------------------------------------------------------
-- B) RPC TRANSACIONAL — process_inbound_whatsapp_event
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
  v_event_account_external_id text;
  v_event_integration_account_id uuid;
  v_event_external_message_id text;
  v_event_resolved_lead_id uuid;
  v_event_resolved_interaction_id uuid;

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
  -- pode comitar enquanto esta transacao estiver aberta.
  -------------------------------------------------------------------
  select
    ie.status, ie.provider, ie.account_external_id, ie.integration_account_id,
    ie.external_message_id, ie.resolved_lead_id, ie.resolved_interaction_id
    into
    v_event_status, v_event_provider, v_event_account_external_id, v_event_integration_account_id,
    v_event_external_message_id, v_event_resolved_lead_id, v_event_resolved_interaction_id
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
  --   processar (failed e retryable por definicao — migration 014).
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
  -------------------------------------------------------------------
  v_interaction_metadata := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
    'activity_class', 'engagement',
    'source', 'integration',
    'provider', v_event_provider,
    'external_event_id', p_integration_event_id::text,
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
  'Fase 3.3.1 — processa atomicamente um integration_event de WhatsApp inbound ja persistido e associado a uma integration_account resolvida: valida a conta (ativa, correspondente ao evento), encontra ou cria o lead (ON CONFLICT inferido pelo indice parcial da migration 015), cria a interacao inbound e marca o evento processed — tudo na mesma transacao. user_id nunca e aceito como parametro, somente derivado de integration_accounts. Chamavel apenas por service_role (ver GRANTs abaixo) — nunca uma API privilegiada exposta a browser/authenticated.';

-- GRANTS — somente service_role pode executar. REVOKE explicito de
-- anon/authenticated (alem do REVOKE FROM PUBLIC, que ja cobriria
-- ambos nesta instalacao, mas o pedido e explicito e harmless/
-- idempotente mesmo sendo redundante).
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from public;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from anon;
revoke all on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) from authenticated;
grant execute on function public.process_inbound_whatsapp_event(uuid, uuid, text, text, text, timestamptz, text, jsonb) to service_role;
