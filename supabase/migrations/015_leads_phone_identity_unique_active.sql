-- Fase 3.1.6 — Unique Active Phone Identity (schema aditivo).
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Garante no banco que não existam dois leads ATIVOS (deleted_at IS
-- NULL) do mesmo vendedor (user_id) com o mesmo phone_normalized.
-- NULL nunca participa (ver predicado abaixo) — leads sem identidade
-- calculada nunca colidem entre si. Leads soft-deleted (coluna
-- existente desde a migration 009, ainda não ativada no produto)
-- nunca participam da unicidade — um histórico apagado pode conviver
-- com um lead ativo do mesmo telefone.
--
-- Pré-requisitos já homologados: migration 012 (phone_normalized),
-- writer synchronization (Fase 3.1.4.1) e o backfill canônico (Fase
-- 3.1.5.4). Esta migration NÃO executa nenhum backfill — ela valida
-- a REGRA DE INTEGRIDADE (zero duplicidade ativa, zero formato
-- inválido) em tempo de aplicação, nunca hardcoda uma contagem
-- histórica de linhas como requisito estrutural.
--
-- PostgreSQL não permite "WHERE" em uma UNIQUE constraint de tabela —
-- uma restrição parcial só é possível via índice único parcial
-- (CREATE UNIQUE INDEX ... WHERE ...). Por isso este objeto aparece
-- em pg_indexes/pg_index, não em pg_constraint — a imposição de
-- unicidade no armazenamento é idêntica a uma constraint, só a
-- representação catalográfica difere. Consequência prática: este
-- índice não pode ser alvo de uma FOREIGN KEY (nenhuma tabela do
-- projeto precisa disso hoje).
--
-- Não CONCURRENTLY, de propósito (Fase 3.1.6.0, seção 3): a tabela
-- tem poucas centenas de linhas nesta fase — o lock SHARE de um
-- CREATE INDEX não-concorrente dura milissegundos. Rodar dentro de
-- uma única transação explícita (LOCK + precheck + CREATE INDEX +
-- postcheck + COMMIT) fecha a janela de corrida contra o writer
-- synchronization já ativo em produção — isso é impossível com
-- CONCURRENTLY, que proíbe rodar dentro de um bloco de transação e,
-- se falhar, deixa um índice INVALID residual.
--
-- Fase 3.1.6.3 — hardening (achados da auditoria 3.1.6.2): a checagem
-- de idempotência original só validava indisunique + colunas +
-- predicate, sem nunca checar indisvalid/indisready/indrelid. Um
-- índice pré-existente INVALID com definição aparentemente correta
-- passaria sem erro (CREATE INDEX IF NOT EXISTS vira no-op por nome,
-- independente de validade) — a migration "sucederia" enquanto a
-- proteção real estaria inativa. A checagem abaixo (pré-criação E
-- pós-criação, nas DUAS DO blocks) agora valida explicitamente:
-- relkind='i' (é índice), indrelid=public.leads, indisunique,
-- indisvalid, indisready, exatamente 2 key attributes sem nenhuma
-- chave de expressão, colunas exatamente (user_id, phone_normalized)
-- nessa ordem, e o predicate parcial. Um objeto não-índice ocupando
-- o nome é detectado explicitamente (RAISE EXCEPTION com mensagem
-- clara), nunca deixado cair no erro genérico do CREATE INDEX.
--
-- Estratégia de predicate (não relaxada): pg_get_expr() reconstrói a
-- expressão a partir da árvore interna, não preserva o texto-fonte —
-- formatação de espaço/caixa pode variar entre versões do Postgres,
-- mas a comparação continua sendo uma igualdade EXATA de string após
-- normalizar só espaço (colapsado) e caixa (minúsculas) — nunca uma
-- comparação parcial/fuzzy/semântica que pudesse aceitar um predicate
-- realmente diferente. Qualquer divergência real continua abortando.
--
-- Fase 3.1.6.7 — fix (primeira tentativa controlada de apply falhou
-- corretamente antes do COMMIT, zero alteração persistida): o
-- Postgres de produção renderiza pg_get_expr(indpred, indrelid) com
-- um par EXTRA de parênteses externos envolvendo o predicado inteiro
-- — "((deleted_at IS NULL) AND (phone_normalized IS NOT NULL))" em
-- vez de "(deleted_at IS NULL) AND (phone_normalized IS NOT NULL)".
-- É só diferença de representação/deparse (mesma árvore interna,
-- mesmo AND, mesmas duas colunas, mesmos operadores IS NULL/IS NOT
-- NULL) — nunca uma diferença semântica. A correção NÃO remove
-- parênteses genericamente (isso poderia mascarar um predicate
-- realmente diferente) — ela aceita EXATAMENTE as duas formas
-- literais conhecidas (com e sem o par externo), nada além disso.
-- Qualquer outro texto — incluindo trocar AND por OR, negar uma
-- condição, remover uma condição ou adicionar qualquer outra —
-- continua divergindo de ambas as formas aceitas e abortando.
--
-- Rollback: "drop index if exists public.leads_user_id_phone_normalized_active_key;"

begin;

-- Fecha a janela de corrida contra escritas concorrentes (writer
-- synchronization já ativo em produção) durante o precheck + criação
-- abaixo — nenhum INSERT/UPDATE/DELETE em public.leads pode comitar
-- entre o precheck e a criação do índice.
lock table public.leads in share mode;

do $$
declare
  v_dup_count integer;
  v_invalid_format_count integer;
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
  v_expected_predicate_a text;
  v_expected_predicate_b text;
begin
  -------------------------------------------------------------------
  -- DATA ASSERTION 1: zero duplicidade ativa — regra de integridade,
  -- reconfirmada AGORA (nunca reaproveitando um número histórico de
  -- uma auditoria anterior, que pode ter ficado stale desde então).
  -------------------------------------------------------------------
  select count(*) into v_dup_count
  from (
    select user_id, phone_normalized
    from public.leads
    where deleted_at is null
      and phone_normalized is not null
    group by user_id, phone_normalized
    having count(*) > 1
  ) as dups;
  if v_dup_count <> 0 then
    raise exception 'Precheck falhou: % grupo(s) (user_id, phone_normalized) duplicado(s) entre leads ativos — nao e seguro criar o indice', v_dup_count;
  end if;

  -------------------------------------------------------------------
  -- DATA ASSERTION 2: zero formato inválido (defensivo — já coberto
  -- pelo CHECK da migration 012, mas o índice não depende dele).
  -------------------------------------------------------------------
  select count(*) into v_invalid_format_count
  from public.leads
  where phone_normalized is not null
    and phone_normalized !~ '^[0-9]+$';
  if v_invalid_format_count <> 0 then
    raise exception 'Precheck falhou: % linha(s) com phone_normalized em formato invalido', v_invalid_format_count;
  end if;

  -------------------------------------------------------------------
  -- EXISTING-OBJECT CHECK (hardened, Fase 3.1.6.3): se já existe
  -- QUALQUER objeto com este nome em public, nunca assumir — provar
  -- estruturalmente que é exatamente o índice esperado, ou abortar.
  -------------------------------------------------------------------
  select c.relkind into v_relkind
  from pg_class c
  where c.relname = 'leads_user_id_phone_normalized_active_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_relkind is not null and v_relkind <> 'i' then
    raise exception 'Objeto "leads_user_id_phone_normalized_active_key" ja existe em public mas NAO e um indice (relkind=%) — colisao de nome, intervencao manual necessaria, nada foi alterado', v_relkind;
  end if;

  if v_relkind = 'i' then
    select
      pgi.indrelid,
      pgi.indisunique,
      pgi.indisvalid,
      pgi.indisready,
      pgi.indnkeyatts,
      pgi.indkey,
      pg_get_expr(pgi.indpred, pgi.indrelid)
      into v_indrelid, v_indisunique, v_indisvalid, v_indisready, v_indnkeyatts, v_indkey, v_predicate_raw
    from pg_class c
    join pg_index pgi on pgi.indexrelid = c.oid
    where c.relname = 'leads_user_id_phone_normalized_active_key'
      and c.relnamespace = 'public'::regnamespace;

    if v_indrelid is distinct from 'public.leads'::regclass then
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas aponta para outra tabela (indrelid=%, esperado public.leads) — intervencao manual necessaria, nada foi alterado', v_indrelid;
    end if;

    if v_indisvalid is distinct from true then
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas esta INVALID (indisvalid=false) — um build anterior falhou ou ficou incompleto; remova manualmente (drop index) antes de repetir esta migration, nada foi alterado';
    end if;

    if v_indisready is distinct from true then
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas NAO esta pronto (indisready=false) — possivel build concorrente em andamento; nao prosseguir, nada foi alterado';
    end if;

    if v_indisunique is distinct from true then
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas NAO e unique (indisunique=%) — intervencao manual necessaria, nada foi alterado', v_indisunique;
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
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas possui chave de expressao inesperada (esperado apenas colunas simples) — intervencao manual necessaria, nada foi alterado';
    end if;

    if v_key_count <> 2 or v_col_names is distinct from array['user_id', 'phone_normalized'] then
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas colunas/ordem divergem do esperado (encontrado: %, esperado: {user_id,phone_normalized}) — intervencao manual necessaria, nada foi alterado', v_col_names;
    end if;

    v_predicate_normalized := lower(regexp_replace(coalesce(v_predicate_raw, ''), '\s+', ' ', 'g'));
    -- Fase 3.1.6.7: aceita EXATAMENTE as duas formas literais
    -- conhecidas (com e sem o par externo redundante que o
    -- pg_get_expr de producao adiciona) — nunca remocao generica de
    -- parenteses, que poderia mascarar um predicate realmente
    -- diferente (ver header).
    v_expected_predicate_a := lower(regexp_replace('(deleted_at IS NULL) AND (phone_normalized IS NOT NULL)', '\s+', ' ', 'g'));
    v_expected_predicate_b := lower(regexp_replace('((deleted_at IS NULL) AND (phone_normalized IS NOT NULL))', '\s+', ' ', 'g'));
    if v_predicate_normalized is distinct from v_expected_predicate_a
       and v_predicate_normalized is distinct from v_expected_predicate_b
    then
      raise exception 'Indice leads_user_id_phone_normalized_active_key existe mas o predicate parcial diverge do esperado (encontrado: %) — intervencao manual necessaria, nada foi alterado', v_predicate_raw;
    end if;

    raise notice 'Indice leads_user_id_phone_normalized_active_key ja existe, e valido, esta pronto e com definicao exatamente esperada — CREATE INDEX IF NOT EXISTS abaixo sera no-op (rerun seguro).';
  end if;
end $$;

-- Criação idempotente nativa (CREATE INDEX suporta IF NOT EXISTS,
-- diferente de ADD CONSTRAINT — sem necessidade do workaround via DO
-- block já usado na migration 012 para esse caso específico). Se o
-- bloco acima detectou um objeto incorreto com o mesmo nome, a
-- transação já foi abortada antes de chegar aqui.
create unique index if not exists leads_user_id_phone_normalized_active_key
  on public.leads (user_id, phone_normalized)
  where deleted_at is null and phone_normalized is not null;

comment on index public.leads_user_id_phone_normalized_active_key is
  'Fase 3.1.6 — garante que cada vendedor (user_id) tenha no máximo um lead ATIVO (deleted_at IS NULL) por identidade telefônica canônica (phone_normalized). NULL nunca participa. Suporte à idempotência do futuro resolver automático de WhatsApp — nunca deve ser dropado sem entender o impacto em integrações futuras.';

-- POSTCHECK (hardened, Fase 3.1.6.3, dentro da transação): revalida,
-- depois da criação, exatamente os mesmos critérios estruturais do
-- EXISTING-OBJECT CHECK — nunca confia apenas em indisunique.
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
  v_expected_predicate_a text;
  v_expected_predicate_b text;
  v_not_null_count integer;
  v_null_count integer;
begin
  select c.relkind into v_relkind
  from pg_class c
  where c.relname = 'leads_user_id_phone_normalized_active_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_relkind is distinct from 'i' then
    raise exception 'Postcheck falhou: leads_user_id_phone_normalized_active_key nao existe como indice apos a criacao (relkind=%)', v_relkind;
  end if;

  select
    pgi.indrelid, pgi.indisunique, pgi.indisvalid, pgi.indisready, pgi.indnkeyatts, pgi.indkey,
    pg_get_expr(pgi.indpred, pgi.indrelid)
    into v_indrelid, v_indisunique, v_indisvalid, v_indisready, v_indnkeyatts, v_indkey, v_predicate_raw
  from pg_class c
  join pg_index pgi on pgi.indexrelid = c.oid
  where c.relname = 'leads_user_id_phone_normalized_active_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_indrelid is distinct from 'public.leads'::regclass then
    raise exception 'Postcheck falhou: indice nao aponta para public.leads (indrelid=%)', v_indrelid;
  end if;

  if v_indisunique is distinct from true then
    raise exception 'Postcheck falhou: indisunique=%, esperado true', v_indisunique;
  end if;

  if v_indisvalid is distinct from true then
    raise exception 'Postcheck falhou: indisvalid=%, esperado true', v_indisvalid;
  end if;

  if v_indisready is distinct from true then
    raise exception 'Postcheck falhou: indisready=%, esperado true', v_indisready;
  end if;

  select
    bool_or(k.attnum = 0),
    count(*),
    array_agg(a.attname order by k.ordinality)
    into v_has_expression_key, v_key_count, v_col_names
  from unnest(v_indkey) with ordinality as k(attnum, ordinality)
  left join pg_attribute a on a.attrelid = v_indrelid and a.attnum = k.attnum
  where k.ordinality <= v_indnkeyatts;

  if v_has_expression_key is distinct from false
     or v_key_count <> 2
     or v_col_names is distinct from array['user_id', 'phone_normalized']
  then
    raise exception 'Postcheck falhou: colunas/ordem divergem do esperado (encontrado: %, esperado: {user_id,phone_normalized})', v_col_names;
  end if;

  v_predicate_normalized := lower(regexp_replace(coalesce(v_predicate_raw, ''), '\s+', ' ', 'g'));
  -- Fase 3.1.6.7: mesma estratégia exata do existing-object check
  -- acima — aceita só as duas formas literais conhecidas, nunca
  -- remoção genérica de parênteses.
  v_expected_predicate_a := lower(regexp_replace('(deleted_at IS NULL) AND (phone_normalized IS NOT NULL)', '\s+', ' ', 'g'));
  v_expected_predicate_b := lower(regexp_replace('((deleted_at IS NULL) AND (phone_normalized IS NOT NULL))', '\s+', ' ', 'g'));
  if v_predicate_normalized is distinct from v_expected_predicate_a
     and v_predicate_normalized is distinct from v_expected_predicate_b
  then
    raise exception 'Postcheck falhou: predicate diverge do esperado (encontrado: %)', v_predicate_raw;
  end if;

  -- Contagens informativas apenas — a REGRA DE INTEGRIDADE já foi
  -- validada acima estruturalmente; estes números nunca são um
  -- requisito hardcoded desta migration.
  select count(*) into v_not_null_count from public.leads where phone_normalized is not null;
  select count(*) into v_null_count from public.leads where phone_normalized is null;
  raise notice 'Indice confirmado: unique=true, valid=true, ready=true, colunas=(user_id,phone_normalized), predicate OK. phone_normalized NOT NULL=%, NULL=% (informativo).', v_not_null_count, v_null_count;
end $$;

commit;
