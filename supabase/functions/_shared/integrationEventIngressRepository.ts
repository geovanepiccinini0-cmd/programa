// Fase 3.3.3.2 — Integration Event Ingress Repository.
//
// Responsabilidade ÚNICA: garantir a existência de exatamente UM
// integration_event lógico (status inicial 'received') para uma
// unidade canônica de mensagem, ANTES de qualquer execução do
// Automatic Inbound Engine (supabase/functions/_shared/inboundEngine.ts,
// Fase 3.3.2) — este módulo nunca importa/chama o Engine, nunca decide
// processed/failed/retry, nunca cria lead/interaction. Ele resolve
// apenas a camada "existe um evento?", não "o que fazer com ele?".
//
// Client sempre injetado (mesmo padrão de integrationAccountRepository.ts
// e integrationEventRepository.ts) — nunca cria seu próprio client,
// nunca lê Deno.env, nunca importa @supabase/supabase-js.
//
// Ownership (user_id) nunca é lido, decidido ou aceito como input aqui
// — isso pertence exclusivamente a integration_accounts/resolver/RPC
// (migration 016). integration_account_id também nunca é escrito no
// INSERT desta fase: só pode ser preenchido depois que uma conta for
// legitimamente resolvida (fase de composição futura).
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export type IntegrationEventStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'ignored'
  | 'failed';

const STATUS_DOMAIN: readonly IntegrationEventStatus[] = [
  'received',
  'processing',
  'processed',
  'ignored',
  'failed',
];

export interface IntegrationEventView {
  id: unknown;
  provider: unknown;
  externalEventId: unknown;
  externalMessageId: unknown;
  accountExternalId: unknown;
  integrationAccountId: unknown;
  eventType: unknown;
  status: IntegrationEventStatus;
  receivedAt: unknown;
  processingStartedAt: unknown;
  processedAt: unknown;
  retryCount: unknown;
  errorCode: unknown;
  resolvedUserId: unknown;
  resolvedLeadId: unknown;
  resolvedInteractionId: unknown;
}

// Whitelist estrita (Fase 3.3.3.2, seção 41): payloadMinimized nunca é
// persistido como o objeto arbitrário do caller — um novo objeto é
// construído somente a partir destas chaves, só valores string/null.
// Qualquer outra chave (incluindo content/text/body/raw_payload/
// headers/signature/token/secret) é silenciosamente descartada, nunca
// propagada ao INSERT.
const PAYLOAD_MINIMIZED_ALLOWED_KEYS = [
  'message_type',
  'phone_number_id',
  'display_phone_number',
  'field',
] as const;

export interface CreateOrGetIntegrationEventInput {
  provider: unknown;
  externalEventId: unknown;
  externalMessageId: unknown;
  externalAccountId: unknown;
  eventType: unknown;
  payloadMinimized: unknown;
  receivedAt: unknown;
}

export type CreateOrGetIntegrationEventResult =
  | { status: 'CREATED'; event: IntegrationEventView }
  | { status: 'DUPLICATE'; event: IntegrationEventView }
  | { status: 'IDENTITY_CONFLICT'; eventIdByEventId: unknown; eventIdByMessageId: unknown }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

export interface SupabaseInsertSelectResult {
  data: unknown[] | null;
  error: { code?: unknown; [key: string]: unknown } | null;
}

export interface SupabaseSelectResult {
  data: unknown[] | null;
  error: unknown | null;
}

// Contrato estrutural mínimo do client injetado — só o suficiente para
// um INSERT...RETURNING e um SELECT...WHERE provider=...AND <col>=...,
// nunca o tipo completo do @supabase/supabase-js.
export interface IntegrationEventsIngressClientLike {
  from(table: string): {
    insert(row: Record<string, unknown>): {
      select(columns: string): PromiseLike<SupabaseInsertSelectResult>;
    };
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): PromiseLike<SupabaseSelectResult>;
      };
    };
  };
}

const TABLE = 'integration_events';

const SELECT_COLUMNS = [
  'id',
  'provider',
  'external_event_id',
  'external_message_id',
  'account_external_id',
  'integration_account_id',
  'event_type',
  'status',
  'received_at',
  'processing_started_at',
  'processed_at',
  'retry_count',
  'error_code',
  'resolved_user_id',
  'resolved_lead_id',
  'resolved_interaction_id',
].join(', ');

const UNIQUE_VIOLATION_CODE = '23505';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidReceivedAt(value: unknown): value is string | Date {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'string' && value.trim().length > 0) return !Number.isNaN(new Date(value).getTime());
  return false;
}

function assertValidClient(client: unknown): IntegrationEventsIngressClientLike {
  if (
    client === null
    || typeof client !== 'object'
    || typeof (client as { from?: unknown }).from !== 'function'
  ) {
    throw new TypeError('integrationEventIngressRepository: supabaseServiceClient deve expor um metodo from(table)');
  }
  return client as IntegrationEventsIngressClientLike;
}

// Precondição de contrato (erro de programação de quem chama, nunca um
// outcome de negócio/DB) — lança de forma síncrona, antes de qualquer
// query. user_id/integration_account_id/status/resolved_*/retry_count/
// error_code NÃO fazem parte do input aceito (seção 26/27): não há
// nem como passá-los, por não existirem como chave no tipo de input.
function assertValidInput(input: CreateOrGetIntegrationEventInput): void {
  if (!isNonBlankString(input?.provider)) {
    throw new TypeError('createOrGetIntegrationEvent: provider deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(input?.externalEventId)) {
    throw new TypeError('createOrGetIntegrationEvent: externalEventId deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(input?.externalMessageId)) {
    throw new TypeError('createOrGetIntegrationEvent: externalMessageId deve ser uma string nao vazia e nao so-whitespace (obrigatorio para V1)');
  }
  if (!isNonBlankString(input?.externalAccountId)) {
    throw new TypeError('createOrGetIntegrationEvent: externalAccountId deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(input?.eventType)) {
    throw new TypeError('createOrGetIntegrationEvent: eventType deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isValidReceivedAt(input?.receivedAt)) {
    throw new TypeError('createOrGetIntegrationEvent: receivedAt deve ser uma string/Date valida e parseavel');
  }
  if (input?.payloadMinimized !== null && input?.payloadMinimized !== undefined && !isPlainObject(input.payloadMinimized)) {
    throw new TypeError('createOrGetIntegrationEvent: payloadMinimized deve ser null ou um plain object');
  }
}

// Constrói o objeto efetivamente persistido somente a partir da
// whitelist — nunca aceita o objeto do caller diretamente (seção 40/41:
// proteção contra leakage de content/raw_payload/headers/signature/
// token/secret, mesmo que o caller viole o contrato documentado).
function buildPayloadMinimized(input: unknown): Record<string, string | null> | null {
  if (!isPlainObject(input)) return null;

  const result: Record<string, string | null> = {};
  for (const key of PAYLOAD_MINIMIZED_ALLOWED_KEYS) {
    const value = input[key];
    if (typeof value === 'string' || value === null) {
      result[key] = value;
    }
  }
  return result;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isKnownStatus(value: unknown): value is IntegrationEventStatus {
  return typeof value === 'string' && (STATUS_DOMAIN as readonly string[]).includes(value);
}

// Fail-closed: uma row sem os campos mínimos de identidade, ou com
// status fora do domínio conhecido, nunca é mapeada como sucesso —
// isso indicaria um client/DB estruturalmente inconsistente com o
// schema real (seção 24/25).
function mapRowToView(row: unknown): IntegrationEventView | null {
  if (!isPlainObject(row)) return null;

  const {
    id,
    provider,
    external_event_id: externalEventId,
    external_message_id: externalMessageId,
    account_external_id: accountExternalId,
    integration_account_id: integrationAccountId,
    event_type: eventType,
    status,
    received_at: receivedAt,
    processing_started_at: processingStartedAt,
    processed_at: processedAt,
    retry_count: retryCount,
    error_code: errorCode,
    resolved_user_id: resolvedUserId,
    resolved_lead_id: resolvedLeadId,
    resolved_interaction_id: resolvedInteractionId,
  } = row;

  if (!isNonBlankString(id)) return null;
  if (!isNonBlankString(provider)) return null;
  if (!isNonBlankString(externalEventId)) return null;
  if (!isNonBlankString(accountExternalId)) return null;
  if (!isNonBlankString(eventType)) return null;
  if (!isKnownStatus(status)) return null;

  return {
    id,
    provider,
    externalEventId,
    externalMessageId,
    accountExternalId,
    integrationAccountId,
    eventType,
    status,
    receivedAt,
    processingStartedAt,
    processedAt,
    retryCount,
    errorCode,
    resolvedUserId,
    resolvedLeadId,
    resolvedInteractionId,
  };
}

async function findByColumn(
  client: IntegrationEventsIngressClientLike,
  provider: string,
  column: 'external_event_id' | 'external_message_id',
  value: string,
): Promise<{ status: 'OK'; row: unknown | null } | { status: 'REPOSITORY_ERROR'; error: unknown }> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq('provider', provider)
      .eq(column, value);

    if (error) {
      return { status: 'REPOSITORY_ERROR', error };
    }
    if (!Array.isArray(data)) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('integrationEventIngressRepository: Supabase client retornou data inconsistente (nao e array e nenhum error foi reportado)'),
      };
    }
    if (data.length === 0) {
      return { status: 'OK', row: null };
    }
    if (data.length > 1) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error(`integrationEventIngressRepository: mais de uma linha encontrada para (provider, ${column}) — esperado no maximo 1 (unique constraint deveria impedir isso)`),
      };
    }
    return { status: 'OK', row: data[0] };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}

// Reconciliação pós-conflito (seção 14/15/22/23): um 23505 pode ter
// vindo do índice único (provider, external_event_id) OU do índice
// único parcial (provider, external_message_id) — nunca assumimos qual
// dos dois sem olhar o banco. Faz lookup exato pelas duas identidades e
// classifica:
//   - ambos apontam pra mesma linha (ou só uma das duas existe)  → DUPLICATE
//   - apontam para linhas DIFERENTES                              → IDENTITY_CONFLICT
//   - nenhuma prova (nenhuma linha encontrada)                    → REPOSITORY_ERROR
async function reconcileAfterConflict(
  client: IntegrationEventsIngressClientLike,
  provider: string,
  externalEventId: string,
  externalMessageId: string,
): Promise<CreateOrGetIntegrationEventResult> {
  const [byEventId, byMessageId] = await Promise.all([
    findByColumn(client, provider, 'external_event_id', externalEventId),
    findByColumn(client, provider, 'external_message_id', externalMessageId),
  ]);

  if (byEventId.status === 'REPOSITORY_ERROR') return byEventId;
  if (byMessageId.status === 'REPOSITORY_ERROR') return byMessageId;

  const rowByEventId = byEventId.row;
  const rowByMessageId = byMessageId.row;

  if (!rowByEventId && !rowByMessageId) {
    return {
      status: 'REPOSITORY_ERROR',
      error: new Error('integrationEventIngressRepository: unique violation (23505) reportada, mas nenhuma linha encontrada por external_event_id nem external_message_id — nao foi possivel provar a duplicata'),
    };
  }

  if (rowByEventId && rowByMessageId) {
    const viewByEventId = mapRowToView(rowByEventId);
    const viewByMessageId = mapRowToView(rowByMessageId);
    if (!viewByEventId || !viewByMessageId) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('integrationEventIngressRepository: linha retornada na reconciliacao pos-conflito esta malformada'),
      };
    }
    if (viewByEventId.id !== viewByMessageId.id) {
      // Nunca escolhe uma das duas — identidade inconsistente precisa
      // de intervenção humana, não de uma decisão silenciosa (seção 15/37).
      return {
        status: 'IDENTITY_CONFLICT',
        eventIdByEventId: viewByEventId.id,
        eventIdByMessageId: viewByMessageId.id,
      };
    }
    return { status: 'DUPLICATE', event: viewByEventId };
  }

  const singleRow = rowByEventId ?? rowByMessageId;
  const view = mapRowToView(singleRow);
  if (!view) {
    return {
      status: 'REPOSITORY_ERROR',
      error: new Error('integrationEventIngressRepository: linha retornada na reconciliacao pos-conflito esta malformada'),
    };
  }
  return { status: 'DUPLICATE', event: view };
}

export async function createOrGetIntegrationEvent(
  input: CreateOrGetIntegrationEventInput,
  supabaseServiceClient: unknown,
): Promise<CreateOrGetIntegrationEventResult> {
  assertValidInput(input);
  const client = assertValidClient(supabaseServiceClient);

  const provider = input.provider as string;
  const externalEventId = input.externalEventId as string;
  const externalMessageId = input.externalMessageId as string;
  const externalAccountId = input.externalAccountId as string;
  const eventType = input.eventType as string;
  const receivedAtIso = toIsoString(input.receivedAt as string | Date);
  const payloadMinimized = buildPayloadMinimized(input.payloadMinimized);

  // INSERT explícito somente das colunas congeladas (seção 12): nunca
  // integration_account_id, processing_started_at, processed_at,
  // retry_count, error_code, resolved_* — esses ficam em default do DB
  // ou são preenchidos por camadas futuras legítimas.
  const insertRow: Record<string, unknown> = {
    provider,
    external_event_id: externalEventId,
    external_message_id: externalMessageId,
    account_external_id: externalAccountId,
    event_type: eventType,
    status: 'received',
    payload_minimized: payloadMinimized,
    received_at: receivedAtIso,
  };

  try {
    const { data, error } = await client
      .from(TABLE)
      .insert(insertRow)
      .select(SELECT_COLUMNS);

    if (error) {
      if (error.code === UNIQUE_VIOLATION_CODE) {
        return reconcileAfterConflict(client, provider, externalEventId, externalMessageId);
      }
      return { status: 'REPOSITORY_ERROR', error };
    }

    if (!Array.isArray(data) || data.length !== 1) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('integrationEventIngressRepository: INSERT nao retornou exatamente 1 linha'),
      };
    }

    const view = mapRowToView(data[0]);
    if (!view) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('integrationEventIngressRepository: linha inserida retornada esta malformada'),
      };
    }

    return { status: 'CREATED', event: view };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}
