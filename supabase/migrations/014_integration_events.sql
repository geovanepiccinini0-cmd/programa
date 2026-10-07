-- Fase 3.1.3.1 — Integration Events (schema aditivo).
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em nenhuma existente.
-- Depende de public.integration_accounts (013), public.leads e
-- public.lead_interactions (ambas já existentes desde a Fase 1 V2) e
-- auth.users (nativa do Supabase) — rode esta migration só depois da
-- 013. Responsabilidades: idempotência de eventos externos,
-- observabilidade (status/retry/erro), rastreabilidade. NÃO é a
-- timeline comercial do lead — isso continua sendo exclusivamente
-- public.lead_interactions, nunca substituída ou duplicada aqui. Zero
-- consumidor de produção existe ainda (nenhum Edge Function, nenhuma
-- RPC, nenhum frontend) — esta migration só cria a estrutura.
-- Rollback: "drop table if exists public.integration_events;" (rode
-- antes de reverter 013, por causa da FK integration_account_id).

create table if not exists public.integration_events (
  id uuid primary key default gen_random_uuid(),

  provider text not null,
  external_event_id text not null,
  -- Nullable de propósito nesta fase: a coluna existe, mas nenhuma
  -- constraint de unicidade é criada sobre ela ainda (ver comentário
  -- de idempotência mais abaixo — DEFER até se conhecer o payload real
  -- do provider, Fase 3.9).
  external_message_id text,

  -- Snapshot congelado do identificador externo da conta NO MOMENTO do
  -- evento — nunca lido via JOIN em integration_accounts, de propósito:
  -- se a conta for desativada/alterada depois, este evento histórico
  -- continua provando de qual conta externa ele realmente veio.
  account_external_id text not null,
  -- Resolução atual/navegável (pode mudar de sentido se a conta for
  -- reatribuída) — coexiste com account_external_id acima por
  -- propósitos diferentes (histórico imutável vs. relação atual).
  integration_account_id uuid references public.integration_accounts(id) on delete set null,

  event_type text not null,

  status text not null default 'received',

  -- Subconjunto mínimo necessário para processamento/retry/auditoria/
  -- debug — nunca o payload bruto inteiro "por garantia". Nunca deve
  -- conter credentials/secrets/tokens do provider. Quais chaves exatas
  -- serão armazenadas depende do provider real, ainda não integrado
  -- (Fase 3.9) — esta migration não assume nenhum formato.
  payload_minimized jsonb,

  -- Momento em que o evento foi recebido/persistido. Sem default: é
  -- setado explicitamente pela aplicação/RPC no momento real da
  -- recepção, nunca inferido pelo banco.
  received_at timestamptz not null,
  processing_started_at timestamptz,
  processed_at timestamptz,

  retry_count integer not null default 0,
  error_code text,

  -- Auditoria histórica: "este evento foi atribuído a este usuário no
  -- momento em que ocorreu" — pode divergir de
  -- integration_account_id.user_id se o assignment mudar depois.
  resolved_user_id uuid references auth.users(id) on delete set null,
  resolved_lead_id uuid references public.leads(id) on delete set null,
  resolved_interaction_id uuid references public.lead_interactions(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint integration_events_provider_external_event_id_key
    unique (provider, external_event_id),

  constraint integration_events_status_check
    check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),

  constraint integration_events_retry_count_check
    check (retry_count >= 0),

  -- Checks estruturais baratos (nunca regra semântica de provider):
  -- só impedem string vazia/só-whitespace/com whitespace nas bordas
  -- nos campos obrigatórios de identificação do evento.
  --
  -- Fase 3.1.3.2.1 — hardening (achado F-04 da auditoria 3.1.3.2):
  -- a versão anterior usava trim(campo) <> '', que no Postgres só
  -- remove o caractere espaço comum — um valor só com tab/newline
  -- ('\t', '\n') passaria o check incorretamente. A expressão abaixo
  -- usa a classe POSIX [:space:] (cobre espaço/tab/newline/etc.) e
  -- exige um primeiro E um último caractere não-whitespace — rejeita
  -- '', qualquer string só-whitespace, e whitespace líder/final,
  -- sem transformar/canonicalizar o valor e sem restringir whitespace
  -- interno (ver mesmo raciocínio documentado em 013).
  constraint integration_events_provider_shape_check
    check (provider ~ '^[^[:space:]](.*[^[:space:]])?$'),
  constraint integration_events_external_event_id_shape_check
    check (external_event_id ~ '^[^[:space:]](.*[^[:space:]])?$'),
  constraint integration_events_account_external_id_shape_check
    check (account_external_id ~ '^[^[:space:]](.*[^[:space:]])?$'),
  constraint integration_events_event_type_shape_check
    check (event_type ~ '^[^[:space:]](.*[^[:space:]])?$')
);

comment on table public.integration_events is
  'Fase 3.1 — registro de eventos externos recebidos de integrações (ex. Click-to-WhatsApp), com idempotência via (provider, external_event_id). Responsabilidades: idempotência, observabilidade (status/retry/erro), rastreabilidade. NÃO é a timeline comercial do lead (isso continua sendo public.lead_interactions). Zero escrita/leitura pelo frontend — RLS está habilitado sem nenhuma policy para authenticated, de propósito. Nenhum campo de attribution estruturada (campaign_id/ad_id/etc.) existe ainda nesta fase — payload_minimized já reserva espaço suficiente até essa decisão ser tomada (Fase 3.8).';

comment on column public.integration_events.external_message_id is
  'Fase 3.1 — reservado para idempotência em nível de MENSAGEM comercial (diferente de external_event_id, que é idempotência em nível de ENTREGA de webhook). A coluna existe desde já, mas nenhuma constraint de unicidade é criada sobre ela nesta fase — DEFER até o payload real do provider ser conhecido (Fase 3.9), para evitar desenhar uma unique prematura e incorreta.';

comment on column public.integration_events.status is
  'received = evento persistido e aguardando processamento. processing = processamento iniciado. processed = processamento concluído com sucesso (resolved_* preenchidos). ignored = evento tecnicamente recebido mas deliberadamente não processável/não acionável (ex. telefone INVALID/AMBIGUOUS/NULL — ver error_code) — nunca reprocessado automaticamente, pois a decisão é determinística e estável. failed = falha técnica, candidata a retry (ver retry_count). Nenhuma invariante temporal entre os timestamps é validada por CHECK nesta fase — isso será testado/implementado junto do processor/RPC futuro, não no schema.';

comment on column public.integration_events.payload_minimized is
  'Subconjunto mínimo necessário para processamento, retry, auditoria e debugging. NUNCA deve conter credentials/secrets/tokens do provider. O conjunto exato de chaves armazenadas ainda não é definido (depende do provider real, Fase 3.9) — esta coluna só reserva a capacidade técnica.';

comment on column public.integration_events.account_external_id is
  'Snapshot do identificador externo da conta no momento do evento — nunca derivado via JOIN em integration_accounts, para preservar o histórico mesmo se a conta for alterada/desativada depois.';

comment on column public.integration_events.resolved_user_id is
  'Auditoria histórica de qual usuário recebeu este evento no momento em que ele ocorreu. Pode divergir do assignment atual de integration_accounts se ele mudar depois — isso é esperado e não deve ser "corrigido" retroativamente.';

alter table public.integration_events enable row level security;

-- Nenhuma policy para "authenticated" é criada de propósito — mesmo
-- princípio de integration_accounts (013): RLS habilitado sem nenhuma
-- policy nega acesso a todos os papéis exceto service_role. Nenhuma
-- policy de service_role é criada aqui: service_role já ignora RLS por
-- definição do Postgres/Supabase, sem precisar de policy explícita.

-- Indexes: só os justificados por um padrão de consulta operacional já
-- identificado no design (Fase 3.1.3.0, seção 30). (provider,
-- external_event_id) já tem índice implícito via a UNIQUE constraint
-- acima — não duplicado aqui.
create index if not exists integration_events_status_idx
  on public.integration_events (status);
create index if not exists integration_events_resolved_lead_id_idx
  on public.integration_events (resolved_lead_id);
create index if not exists integration_events_integration_account_id_idx
  on public.integration_events (integration_account_id);
