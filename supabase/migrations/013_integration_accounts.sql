-- Fase 3.1.3.1 — Integration Accounts (schema aditivo).
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em nenhuma existente.
-- Mapeia uma conta externa integrada (ex. um número de WhatsApp) para o
-- vendedor (user_id) responsável por ela — resolve "qual user_id deve
-- receber um evento desta conta?" sem hardcode em código-fonte.
-- Zero credentials/tokens são armazenados aqui nesta fase. Zero
-- consumidor de produção existe ainda (nenhum Edge Function, nenhuma
-- RPC, nenhum frontend) — esta migration só cria a estrutura.
-- Rollback: "drop table if exists public.integration_accounts;".

create table if not exists public.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_account_id text not null,
  -- Dono da conta (o vendedor que recebe os eventos). ON DELETE
  -- RESTRICT deliberado (nunca CASCADE): apagar um vendedor não deve
  -- apagar silenciosamente a configuração de qual conta está integrada
  -- a ele — essa é configuração operacional da empresa, não dado
  -- pessoal do vendedor. Se o vendedor saiu, a conta deve ser
  -- reatribuída (UPDATE desta linha), nunca desaparecer junto.
  user_id uuid not null references auth.users(id) on delete restrict,
  -- false = não aceitar/processar novos eventos desta conta. Nunca
  -- apaga histórico (nem desta tabela, nem de integration_events já
  -- vinculados a ela).
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint integration_accounts_provider_external_account_id_key
    unique (provider, external_account_id),

  -- Fase 3.1.3.2.1 — hardening (achados F-02/F-03 da auditoria
  -- 3.1.3.2). '^[^[:space:]](.*[^[:space:]])?$' exige um primeiro E um
  -- último caractere não-whitespace (classe POSIX [:space:], que cobre
  -- espaço/tab/newline/etc. — nunca só espaço comum, diferente de
  -- trim()/btrim(), que cobririam só espaço). Rejeita: '', só
  -- espaço/tab/newline, e qualquer valor com whitespace líder ou
  -- final (' meta', 'meta '). NUNCA transforma/canonicaliza o valor —
  -- só rejeita o malformado; whitespace INTERNO continua livre
  -- (identificadores reais de provider podem legitimamente ter
  -- espaço no meio). Case sensitivity é deliberadamente preservada
  -- (seção 7 da especificação 3.1.3.2.1) — canonicalização de
  -- provider (ex. sempre minúsculo) é responsabilidade do futuro
  -- writer/RPC, nunca do banco.
  constraint integration_accounts_provider_shape_check
    check (provider ~ '^[^[:space:]](.*[^[:space:]])?$'),
  constraint integration_accounts_external_account_id_shape_check
    check (external_account_id ~ '^[^[:space:]](.*[^[:space:]])?$')
);

comment on table public.integration_accounts is
  'Fase 3.1 — mapeia uma conta externa integrada (provider + external_account_id, ex. um número de WhatsApp Business) para o user_id (vendedor) responsável por ela. Resolve o assignment de inbound automático sem hardcode. NÃO armazena credentials/tokens/secrets nesta fase. Zero escrita/leitura pelo frontend — RLS está habilitado sem nenhuma policy para authenticated, de propósito (ver comentário de RLS abaixo). (provider, external_account_id) é globalmente único: uma conta externa não pode apontar para dois vendedores ao mesmo tempo — isso é ownership de conta, DIFERENTE de uma futura estratégia de assignment multi-vendedor/round-robin, que seria uma camada acima desta tabela, nunca uma alteração desta unicidade.';

comment on column public.integration_accounts.provider is
  'Identificador textual livre do provedor de integração (ex. "whatsapp"). Sem enum/CHECK de valor-conhecido de propósito — mesma convenção já usada em public.leads.canal/next_action_type. O CHECK existente (integration_accounts_provider_shape_check) só valida formato estrutural (não-vazio, sem whitespace nas bordas), nunca a lista de providers válidos.';

comment on column public.integration_accounts.external_account_id is
  'Identificador da conta no provedor externo (formato definido pelo provider real, ainda não integrado nesta fase).';

comment on column public.integration_accounts.active is
  'false = não aceitar/processar novos eventos desta conta. Nunca apaga histórico.';

alter table public.integration_accounts enable row level security;

-- Nenhuma policy para "authenticated" é criada de propósito: RLS
-- habilitado sem nenhuma policy nega acesso a TODOS os papéis exceto
-- service_role (que ignora RLS por definição do Postgres/Supabase).
-- Isso é a defesa real no banco pedida pela Fase 3.1.3.0 — não "não
-- usamos isso na UI", e sim "o frontend não consegue mesmo que tente".
-- Nenhuma policy de admin/service_role é criada aqui: o acesso
-- server-side futuro (Edge Function) usará a service_role key, que já
-- contorna RLS sem precisar de uma policy explícita.
