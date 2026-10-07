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
-- 3.1.5.4 — 0 colisões ativas e 0 formato inválido confirmados na
-- auditoria 3.1.5.3). Esta migration NÃO executa nenhum backfill —
-- assume que phone_normalized já reflete a identidade canônica para
-- todas as linhas-alvo, e reconfirma isso em tempo de aplicação via
-- os prechecks abaixo (nunca confia em números de uma auditoria
-- anterior, que podem ter ficado stale desde então).
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
-- tem ~124 linhas nesta fase — o lock SHARE de um CREATE INDEX
-- não-concorrente dura milissegundos. Rodar dentro de uma única
-- transação explícita (LOCK + precheck + CREATE INDEX + postcheck +
-- COMMIT) fecha a janela de corrida contra o writer synchronization
-- já ativo em produção — isso é impossível com CONCURRENTLY, que
-- proíbe rodar dentro de um bloco de transação e, se falhar, deixa
-- um índice INVALID residual que exigiria limpeza manual.
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
  v_existing_indisunique boolean;
  v_existing_indpred text;
  v_existing_cols text;
begin
  -------------------------------------------------------------------
  -- PRECHECK 1: zero duplicidade ativa — reconfirmado AGORA, não
  -- reaproveitando o número da auditoria 3.1.5.3/3.1.5.4 (que pode
  -- ter ficado stale desde então, dado o writer sync ativo).
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
    raise exception 'Precheck 1 falhou: % grupo(s) (user_id, phone_normalized) duplicado(s) entre leads ativos — nao e seguro criar o indice', v_dup_count;
  end if;

  -------------------------------------------------------------------
  -- PRECHECK 2: zero formato inválido (defensivo — já coberto pelo
  -- CHECK da migration 012, mas o índice não depende dele existir).
  -------------------------------------------------------------------
  select count(*) into v_invalid_format_count
  from public.leads
  where phone_normalized is not null
    and phone_normalized !~ '^[0-9]+$';
  if v_invalid_format_count <> 0 then
    raise exception 'Precheck 2 falhou: % linha(s) com phone_normalized em formato invalido', v_invalid_format_count;
  end if;

  -------------------------------------------------------------------
  -- Idempotência real: se já existe um índice com este nome, NUNCA
  -- substituir silenciosamente — valida que é exatamente o esperado
  -- antes de seguir. "IF NOT EXISTS" por si só só checa o NOME, não
  -- a definição — por isso esta validação explícita vem primeiro.
  -------------------------------------------------------------------
  select pgi.indisunique,
         pg_get_expr(pgi.indpred, pgi.indrelid),
         (
           select string_agg(a.attname, ',' order by k.ordinality)
           from unnest(pgi.indkey) with ordinality as k(attnum, ordinality)
           join pg_attribute a
             on a.attrelid = pgi.indrelid and a.attnum = k.attnum
         )
    into v_existing_indisunique, v_existing_indpred, v_existing_cols
  from pg_class c
  join pg_index pgi on pgi.indexrelid = c.oid
  where c.relname = 'leads_user_id_phone_normalized_active_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_existing_indisunique is not null then
    if v_existing_indisunique is distinct from true
       or v_existing_cols is distinct from 'user_id,phone_normalized'
       or v_existing_indpred is distinct from '(deleted_at IS NULL) AND (phone_normalized IS NOT NULL)'
    then
      raise exception
        'Indice leads_user_id_phone_normalized_active_key ja existe com definicao DIFERENTE da esperada (unique=%, cols=%, predicado=%) — intervencao manual necessaria, nada foi alterado',
        v_existing_indisunique, v_existing_cols, v_existing_indpred;
    end if;
    raise notice 'Indice leads_user_id_phone_normalized_active_key ja existe com a definicao esperada — CREATE INDEX IF NOT EXISTS abaixo sera no-op (rerun seguro).';
  end if;
end $$;

-- Criação idempotente nativa (CREATE INDEX suporta IF NOT EXISTS,
-- diferente de ADD CONSTRAINT — sem necessidade do workaround via DO
-- block já usado na migration 012 para esse caso específico).
create unique index if not exists leads_user_id_phone_normalized_active_key
  on public.leads (user_id, phone_normalized)
  where deleted_at is null and phone_normalized is not null;

comment on index public.leads_user_id_phone_normalized_active_key is
  'Fase 3.1.6 — garante que cada vendedor (user_id) tenha no máximo um lead ATIVO (deleted_at IS NULL) por identidade telefônica canônica (phone_normalized). NULL nunca participa. Suporte à idempotência do futuro resolver automático de WhatsApp — nunca deve ser dropado sem entender o impacto em integrações futuras.';

-- POSTCHECK (dentro da transação): confirma que o índice existe e é
-- realmente único antes de confirmar a transação.
do $$
declare
  v_is_unique boolean;
  v_not_null_count integer;
  v_null_count integer;
begin
  select indisunique into v_is_unique
  from pg_class c
  join pg_index pgi on pgi.indexrelid = c.oid
  where c.relname = 'leads_user_id_phone_normalized_active_key'
    and c.relnamespace = 'public'::regnamespace;

  if v_is_unique is distinct from true then
    raise exception 'Postcheck falhou: indice leads_user_id_phone_normalized_active_key nao existe ou nao e unique apos a criacao';
  end if;

  select count(*) into v_not_null_count from public.leads where phone_normalized is not null;
  select count(*) into v_null_count from public.leads where phone_normalized is null;
  raise notice 'Indice confirmado (indisunique=true). phone_normalized NOT NULL = %, NULL = %.', v_not_null_count, v_null_count;
end $$;

commit;
