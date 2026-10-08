-- Fase 3.4.1 — Fundação transacional das conversas WhatsApp: tabela
-- public.whatsapp_messages. Rode este arquivo no SQL Editor do seu
-- projeto Supabase, depois de 013 (integration_accounts), 014
-- (integration_events), 015 (índice único de phone identity ativo) e
-- 016/017 (RPC de inbound) — esta migration só CRIA a estrutura; a
-- extensão da RPC para efetivamente popular esta tabela vive na 019,
-- separada de propósito (mesmo padrão 016/017: schema primeiro,
-- função depois, cada uma revertível independentemente).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em nenhuma
-- existente (leads/lead_interactions/integration_accounts/
-- integration_events/process_inbound_whatsapp_event continuam
-- intocados por este arquivo). Zero consumidor existe ainda após esta
-- migration isolada — a 019 é o primeiro consumidor real.
--
-- RESPONSABILIDADE: granularidade de MENSAGEM individual para a futura
-- caixa de entrada (Fase 3.4, diagnóstico read-only) — inbound E
-- outbound (outbound ainda não implementado, mas o schema já reserva
-- o campo `direction` e os timestamps de status para não precisar de
-- uma segunda migration disruptiva quando o envio for implementado).
-- NÃO substitui nem duplica public.lead_interactions (a timeline
-- comercial continua sendo exclusivamente ela — ver 019 para como as
-- duas coexistem na mesma transação). NÃO é consumida ainda pelo
-- Activity Engine/Next-Best-Action (eles continuam lendo só
-- lead_interactions, nunca esta tabela).
--
-- CONTEUDO MINIMIZADO (seção 4 do diagnóstico 3.4.0): `content` é
-- SOMENTE o corpo de texto (mensagens type='text') ou uma legenda,
-- nunca payload bruto do provider, nunca mídia binária, nunca URL/ID
-- de mídia da Graph API — isso é uma decisão explícita desta fase,
-- não uma omissão. Para mensagens não-textuais, `content` permanece
-- NULL e `message_type` já identifica o tipo (ex. 'image', 'audio') —
-- suficiente para a UI mostrar um placeholder ("[imagem]") sem
-- precisar do payload. Armazenar/baixar mídia é uma decisão de produto
-- explicitamente FORA do escopo desta fase (ver relatório 3.4.0).
--
-- Rollback: "drop table if exists public.whatsapp_messages cascade;"
-- (nenhuma outra tabela depende desta — CASCADE aqui só afeta FKs que
-- apontem PARA esta tabela, que não existem ainda).

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),

  -- Ownership — NUNCA aceito como input externo em nenhum caminho
  -- futuro (mesmo princípio já estabelecido em integration_events/
  -- process_inbound_whatsapp_event): sempre derivado de
  -- integration_accounts.user_id pela camada que insere (a RPC, na
  -- 019). O trigger de consistência abaixo é a segunda linha de
  -- defesa — nunca a primeira.
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Identidade/associação comercial.
  lead_id uuid not null references public.leads(id) on delete cascade,
  integration_account_id uuid not null references public.integration_accounts(id) on delete restrict,

  -- Proveniência — nunca obrigatória por desenho (mensagens outbound
  -- futuras não têm um integration_event de origem; só inbound tem).
  -- ON DELETE SET NULL: um integration_event nunca deveria ser
  -- apagado na prática (nenhum caminho do projeto faz isso), mas se
  -- algum dia for, a mensagem em si (prova comercial) nunca deve ser
  -- apagada em cascata por causa disso.
  integration_event_id uuid references public.integration_events(id) on delete set null,
  -- Vínculo com a timeline comercial (public.lead_interactions) —
  -- nunca a fonte de verdade comercial (essa continua sendo
  -- lead_interactions), só uma referência cruzada para a UI nunca
  -- precisar adivinhar qual linha de lead_interactions corresponde a
  -- qual mensagem. ON DELETE SET NULL: a mensagem nunca desaparece só
  -- porque a interação associada foi removida por algum caminho futuro.
  lead_interaction_id uuid references public.lead_interactions(id) on delete set null,

  -- Fase 3.4.1 é EXCLUSIVA para whatsapp (mesmo guard de provider já
  -- usado em process_inbound_whatsapp_event desde a 017) — um check
  -- fixo aqui, nunca um domínio aberto "para o futuro", porque nenhum
  -- código deste projeto hoje sabe lidar com outro provider.
  provider text not null default 'whatsapp',

  -- wamid da mensagem. Nullable por desenho: idempotência de MENSAGEM
  -- (abaixo) só é exigível quando este valor existe — mesma deferência
  -- já usada em integration_events.external_message_id (migration 014)
  -- antes do índice único parcial da 016. Na prática, toda mensagem
  -- INBOUND desta fase sempre o carrega (a RPC 019 só insere quando a
  -- 017 já validou um external_message_id não-nulo/não-vazio) — a
  -- nulidade só fica reservada para um caminho outbound futuro, antes
  -- da Graph API responder com o wamid real.
  external_message_id text,

  direction text not null,
  message_type text,
  content text,

  status text not null default 'received',
  error_code text,

  occurred_at timestamptz not null,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,

  created_at timestamptz not null default now(),

  constraint whatsapp_messages_provider_check
    check (provider = 'whatsapp'),

  constraint whatsapp_messages_direction_check
    check (direction in ('inbound', 'outbound')),

  constraint whatsapp_messages_status_check
    check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),

  -- Mesma classe de guard estrutural (POSIX [:space:], nunca
  -- btrim()='') já usada em integration_events/integration_accounts —
  -- só quando o valor não é NULL (a coluna é nullable, ver comentário
  -- acima).
  constraint whatsapp_messages_external_message_id_shape_check
    check (external_message_id is null or external_message_id ~ '^[^[:space:]](.*[^[:space:]])?$')
);

comment on table public.whatsapp_messages is
  'Fase 3.4.1 — granularidade de MENSAGEM individual (inbound/outbound) para a futura caixa de entrada WhatsApp. NÃO substitui public.lead_interactions (timeline comercial) nem é lida pelo Activity Engine/Next-Best-Action — é uma projeção adicional, populada na MESMA transação de process_inbound_whatsapp_event (ver migration 019) para o caminho inbound. content é minimizado por desenho (texto/legenda apenas, nunca payload bruto/mídia binária/URL — ver comentário de topo do arquivo desta migration).';

comment on column public.whatsapp_messages.content is
  'Corpo de texto (message_type=text) ou legenda — NUNCA payload bruto do provider, NUNCA mídia binária, NUNCA URL/ID de mídia da Graph API. NULL para mensagens não-textuais sem legenda; message_type já basta para a UI renderizar um placeholder.';

comment on column public.whatsapp_messages.external_message_id is
  'wamid da mensagem. Nullable só para reservar um caminho outbound futuro (antes da Graph API responder) — toda mensagem inbound desta fase sempre o carrega (guard já imposto por process_inbound_whatsapp_event desde a 017).';

alter table public.whatsapp_messages enable row level security;

-- RLS mínima (seção 1 do pedido): SOMENTE leitura para dono/admin.
-- NENHUMA policy de insert/update/delete para authenticated/anon —
-- toda escrita nesta fase acontece exclusivamente via service_role
-- (dentro da RPC hardened, que ignora RLS por definição do Postgres/
-- Supabase). Diferente de lead_interactions (que tem policy de insert
-- para suportar nota manual pelo vendedor): esta tabela não tem ainda
-- nenhum caminho de escrita autenticada por desenho — menor superfície
-- possível até uma fase futura de envio explicitamente decidir que
-- precisa de uma.
create policy "whatsapp_messages: dono pode ler"
  on public.whatsapp_messages
  for select using (user_id = auth.uid());

create policy "whatsapp_messages: admin pode ler tudo"
  on public.whatsapp_messages
  for select using (public.is_admin());

-- Índices — padrão de consulta já conhecido (lista de conversas por
-- lead ordenada por tempo, filtro por conta, filtro por status para
-- retry/observabilidade futura). (provider, external_message_id) já
-- tem índice implícito via o índice único parcial abaixo.
create index if not exists whatsapp_messages_lead_id_idx
  on public.whatsapp_messages (lead_id);
create index if not exists whatsapp_messages_user_id_idx
  on public.whatsapp_messages (user_id);
create index if not exists whatsapp_messages_lead_id_occurred_at_idx
  on public.whatsapp_messages (lead_id, occurred_at desc);
create index if not exists whatsapp_messages_integration_account_id_idx
  on public.whatsapp_messages (integration_account_id);
create index if not exists whatsapp_messages_status_idx
  on public.whatsapp_messages (status);

-- Idempotência de MENSAGEM — mesma estratégia exata de
-- integration_events_provider_external_message_id_key (migration 016):
-- índice único PARCIAL, NULL nunca participa. Esta é a SEGUNDA camada
-- de defesa contra duplicidade (a primeira, e já suficiente por si só,
-- é o índice homônimo em integration_events) — nunca confiada como
-- única linha de defesa, mas também nunca omitida (defesa em
-- profundidade, mesmo princípio já aplicado em todo o projeto).
create unique index if not exists whatsapp_messages_provider_external_message_id_key
  on public.whatsapp_messages (provider, external_message_id)
  where external_message_id is not null;

comment on index public.whatsapp_messages_provider_external_message_id_key is
  'Fase 3.4.1 — segunda camada de idempotência de mensagem (a primeira e já suficiente é integration_events_provider_external_message_id_key, migration 016). NULL nunca participa.';

-------------------------------------------------------------------
-- TRIGGER DE CONSISTENCIA — associações owner/lead/account.
-------------------------------------------------------------------
-- CHECK constraints do Postgres são sempre locais à própria linha —
-- nunca podem referenciar outra tabela. A exigência de que user_id
-- corresponda SIMULTANEAMENTE ao owner do lead E ao owner da
-- integration_account (seção 1, "restrições que impeçam associações
-- inconsistentes") só é possível via trigger. Mesma filosofia
-- fail-closed já usada na RPC: RAISE EXCEPTION aborta a transação
-- inteira (nunca insere/atualiza silenciosamente um estado
-- inconsistente). SECURITY INVOKER (default, declarado explicitamente
-- por nunca depender do default implícito) — quem efetivamente insere
-- é service_role, que já ignora RLS mas NUNCA ignora triggers; este
-- guard vale também para qualquer insert futuro feito por
-- service_role fora da RPC (ex. um backfill manual revisado).
--
-- TRATAMENTO DE LEAD EXCLUÍDO (seção 1): um lead com deleted_at
-- preenchido nunca pode receber uma mensagem nova — falha fechada,
-- igual a um lead inexistente. Isso nunca deveria ocorrer no caminho
-- real (a RPC de inbound só encontra/cria leads ATIVOS, nunca
-- reativa um soft-deleted — ver comentário da 016/017), mas o guard
-- existe para qualquer caminho futuro (ex. um bug, ou uma chamada
-- direta fora da RPC) nunca conseguir associar uma mensagem a um lead
-- já excluído.
create or replace function public.whatsapp_messages_consistency_check()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_lead_user_id uuid;
  v_lead_deleted_at timestamptz;
  v_account_user_id uuid;
begin
  select l.user_id, l.deleted_at into v_lead_user_id, v_lead_deleted_at
  from public.leads l
  where l.id = new.lead_id;

  if v_lead_user_id is null then
    raise exception 'whatsapp_messages: lead % nao encontrado', new.lead_id;
  end if;

  if v_lead_deleted_at is not null then
    raise exception 'whatsapp_messages: lead % esta excluido (deleted_at=%), nao pode receber nova mensagem', new.lead_id, v_lead_deleted_at;
  end if;

  if v_lead_user_id is distinct from new.user_id then
    raise exception 'whatsapp_messages: user_id (%) nao corresponde ao owner do lead % (%)', new.user_id, new.lead_id, v_lead_user_id;
  end if;

  select ia.user_id into v_account_user_id
  from public.integration_accounts ia
  where ia.id = new.integration_account_id;

  if v_account_user_id is null then
    raise exception 'whatsapp_messages: integration_account % nao encontrada', new.integration_account_id;
  end if;

  if v_account_user_id is distinct from new.user_id then
    raise exception 'whatsapp_messages: user_id (%) nao corresponde ao owner da integration_account % (%)', new.user_id, new.integration_account_id, v_account_user_id;
  end if;

  return new;
end;
$$;

comment on function public.whatsapp_messages_consistency_check() is
  'Fase 3.4.1 — guard de consistencia owner/lead/account para whatsapp_messages, via trigger (CHECK constraint nao pode referenciar outra tabela). Recusa (RAISE EXCEPTION, aborta a transacao) qualquer linha cujo user_id nao corresponda EXATAMENTE ao owner do lead e da integration_account referenciados, ou cujo lead esteja soft-deleted (deleted_at preenchido).';

drop trigger if exists whatsapp_messages_consistency_check_trigger on public.whatsapp_messages;
create trigger whatsapp_messages_consistency_check_trigger
  before insert or update on public.whatsapp_messages
  for each row execute function public.whatsapp_messages_consistency_check();

-- Realtime — mesmo padrão aditivo já usado para leads/lead_interactions
-- (schema.sql). Puramente de infraestrutura: nao implementa nenhuma UI
-- nova, nao habilita envio, só permite que uma fase futura do frontend
-- assine esta tabela sem precisar de outra migration.
alter publication supabase_realtime add table public.whatsapp_messages;

-- GRANTS — mesmo padrão de leads/lead_interactions: RLS já restringe
-- SELECT a dono/admin; nenhum GRANT explícito de INSERT/UPDATE/DELETE
-- para authenticated/anon é necessário (nenhuma policy os permitiria
-- mesmo com GRANT de tabela — RLS nega por ausência de policy). Zero
-- GRANT adicional além do que authenticated/anon já têm por padrão em
-- esquemas Supabase (SELECT/INSERT/UPDATE/DELETE concedido a nivel de
-- tabela pelo proprio Supabase, mas sempre filtrado pela RLS).
