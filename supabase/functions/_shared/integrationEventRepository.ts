// Fase 3.3.2 — Server-only Integration Event (finalization) Repository.
// Fase 3.3.3.3.1 — Hardening: UPDATE condicional por status + read-after-zero.
//
// Responsabilidade ÚNICA: finalizar um integration_event já persistido
// para 'ignored' ou 'failed' quando o Automatic Inbound Engine decide
// NÃO chamar (ou a chamada de) process_inbound_whatsapp_event (migration
// 016/017) — essa RPC só cobre o caminho PROCESS (RESOLVED + telefone
// válido). Decisões determinísticas de domínio (conta não encontrada/
// inativa, telefone inválido/ambíguo) e falhas técnicas (repository
// error, RPC rejeitada) precisam de uma fronteira mínima para que o
// evento nunca fique eternamente em status='received'.
//
// HARDENING (Fase 3.3.3.3.1, achados F1/F2/F6/F9 da auditoria
// 3.3.3.3.0): os dois finalizers nunca escreviam um predicate de status
// no UPDATE (só `WHERE id = ?`), permitindo regressão de estado
// terminal (`processed -> failed`, `processed -> ignored`). O UPDATE
// agora inclui `AND status IN ('received','processing','failed')` —
// a MESMA condição vale para os dois finalizers, porque o domínio real
// (ver inboundEngine.ts) permite que um evento chegue a 'failed' antes
// de uma tentativa posterior decidir 'ignored' (ex. conta desativada
// entre duas tentativas), e idempotência failed->failed/ignored->ignored
// é esperada. `processed` e `ignored` são SEMPRE terminais para estes
// dois finalizers — nenhum dos dois jamais os sobrescreve, mesmo sob
// corrida genuína (a condição está na própria query, nunca num
// check-then-act em JS, o que eliminaria o TOCTOU só na aparência).
//
// Client sempre injetado (mesmo padrão de integrationAccountRepository.ts)
// — nunca cria seu próprio client, nunca lê Deno.env, nunca importa
// @supabase/supabase-js. 100% testável em Vitest/Node.
//
// UPDATE mínimo: somente integration_events, somente as colunas
// coerentes com cada status (ver comentário de cada função). Nunca
// aceita user_id como input, nunca toca leads/lead_interactions, nunca
// lê/loga payload_minimized.
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

// Único conjunto de partida aceito pelos DOIS finalizers — nunca
// 'processed'/'ignored' (ambos terminais e protegidos). Ver comentário
// de topo para o raciocínio de domínio (failed->ignored é real;
// failed->failed/ignored->ignored são idempotentes por definição).
const FINALIZABLE_FROM_STATUSES: readonly IntegrationEventStatus[] = ['received', 'processing', 'failed'];

export interface IntegrationEventTerminalSnapshot {
  id: unknown;
  status: IntegrationEventStatus;
  errorCode: unknown;
  resolvedUserId: unknown;
  resolvedLeadId: unknown;
  resolvedInteractionId: unknown;
  integrationAccountId: unknown;
  processedAt: unknown;
}

// Resultado discriminado explícito — nunca um REPOSITORY_ERROR genérico
// para um estado terminal real encontrado após a corrida (Fase
// 3.3.3.3.1, seção 8). REPOSITORY_ERROR continua reservado a falha
// real de query/transporte.
export type EventFinalizationResult =
  | { status: 'OK' }
  | { status: 'ALREADY_PROCESSED'; event: IntegrationEventTerminalSnapshot }
  | { status: 'ALREADY_IGNORED'; event: IntegrationEventTerminalSnapshot }
  | { status: 'EVENT_NOT_FOUND' }
  | { status: 'STATE_CONFLICT'; event: IntegrationEventTerminalSnapshot }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

export type GetIntegrationEventByIdResult =
  | { status: 'FOUND'; event: IntegrationEventTerminalSnapshot }
  | { status: 'NOT_FOUND' }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

export interface MarkIntegrationEventIgnoredInput {
  eventId: unknown;
  errorCode: unknown;
  // Opcional de propósito (guard de presença, não `!== undefined`):
  // NOT_FOUND nunca tem uma conta resolvida; INACTIVE tem. Omitir a
  // chave inteira quando ausente evita escrever um `integration_account_id
  // = null` sobre um valor que porventura já exista na linha.
  integrationAccountId?: unknown;
}

export interface MarkIntegrationEventFailedInput {
  eventId: unknown;
  errorCode: unknown;
}

export interface SupabaseUpdateResult {
  data: unknown[] | null;
  error: unknown | null;
}

export interface SupabaseSelectResult {
  data: unknown[] | null;
  error: unknown | null;
}

// Contrato estrutural mínimo do client injetado — só o suficiente para
// um UPDATE...WHERE id=...AND status IN (...)...RETURNING id, e um
// SELECT...WHERE id=... de leitura. Nunca o tipo completo do
// @supabase/supabase-js. .select() ao final do UPDATE é exigido
// deliberadamente: sem ele, um UPDATE do supabase-js não informa
// quantas linhas foram afetadas.
export interface IntegrationEventsClientLike {
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(column: string, value: unknown): {
        in(column: string, values: readonly string[]): {
          select(columns: string): PromiseLike<SupabaseUpdateResult>;
        };
      };
    };
    select(columns: string): {
      eq(column: string, value: unknown): PromiseLike<SupabaseSelectResult>;
    };
  };
}

const TABLE = 'integration_events';

const SNAPSHOT_COLUMNS = [
  'id',
  'status',
  'error_code',
  'resolved_user_id',
  'resolved_lead_id',
  'resolved_interaction_id',
  'integration_account_id',
  'processed_at',
].join(', ');

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKnownStatus(value: unknown): value is IntegrationEventStatus {
  return typeof value === 'string' && (STATUS_DOMAIN as readonly string[]).includes(value);
}

function assertValidClient(client: unknown): IntegrationEventsClientLike {
  if (
    client === null
    || typeof client !== 'object'
    || typeof (client as { from?: unknown }).from !== 'function'
  ) {
    throw new TypeError('integrationEventRepository: supabaseServiceClient deve expor um metodo from(table)');
  }
  return client as IntegrationEventsClientLike;
}

// Fail-closed: uma row sem os campos mínimos, ou com status fora do
// domínio conhecido, nunca é mapeada como sucesso.
function mapRowToSnapshot(row: unknown): IntegrationEventTerminalSnapshot | null {
  if (!isPlainObject(row)) return null;

  const {
    id,
    status,
    error_code: errorCode,
    resolved_user_id: resolvedUserId,
    resolved_lead_id: resolvedLeadId,
    resolved_interaction_id: resolvedInteractionId,
    integration_account_id: integrationAccountId,
    processed_at: processedAt,
  } = row;

  if (!isNonBlankString(id)) return null;
  if (!isKnownStatus(status)) return null;

  return { id, status, errorCode, resolvedUserId, resolvedLeadId, resolvedInteractionId, integrationAccountId, processedAt };
}

// Leitura simples por id — usada tanto internamente (read-after-zero)
// quanto injetada diretamente no Engine (reconciliação pós-exceção da
// RPC, Fase 3.3.3.3.1). Nunca aceita filtro além de `id`, nunca decide
// nada sobre o significado do status retornado — só expõe o fato.
export async function getIntegrationEventById(
  eventId: unknown,
  supabaseServiceClient: unknown,
): Promise<GetIntegrationEventByIdResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(eventId)) {
    throw new TypeError('getIntegrationEventById: eventId deve ser uma string nao vazia e nao so-whitespace');
  }

  try {
    const { data, error } = await client.from(TABLE).select(SNAPSHOT_COLUMNS).eq('id', eventId);

    if (error) {
      return { status: 'REPOSITORY_ERROR', error };
    }
    if (!Array.isArray(data)) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('getIntegrationEventById: Supabase client retornou data inconsistente (nao e array e nenhum error foi reportado)'),
      };
    }
    if (data.length === 0) {
      return { status: 'NOT_FOUND' };
    }
    if (data.length > 1) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error(`getIntegrationEventById: mais de uma linha encontrada para id=${eventId} — esperado no maximo 1 (chave primaria deveria impedir isso)`),
      };
    }

    const snapshot = mapRowToSnapshot(data[0]);
    if (!snapshot) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error(`getIntegrationEventById: linha retornada para id=${eventId} esta malformada`),
      };
    }
    return { status: 'FOUND', event: snapshot };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}

// Após um UPDATE condicional afetar zero linhas, desambigua a causa
// relendo o evento — nunca trata genericamente como REPOSITORY_ERROR
// (Fase 3.3.3.3.1, seção 8). STATE_CONFLICT é o catch-all defensivo
// para o caso teoricamente impossível (status ainda em
// FINALIZABLE_FROM_STATUSES mesmo após o UPDATE condicional falhar) —
// nunca deveria ocorrer sob a semântica real do Postgres, mas nunca é
// disfarçado de sucesso nem de erro de repository indistinguível.
async function readAfterZero(
  client: IntegrationEventsClientLike,
  eventId: string,
): Promise<EventFinalizationResult> {
  const read = await getIntegrationEventById(eventId, client);

  if (read.status === 'REPOSITORY_ERROR') {
    return read;
  }
  if (read.status === 'NOT_FOUND') {
    return { status: 'EVENT_NOT_FOUND' };
  }

  const { event } = read;
  if (event.status === 'processed') {
    return { status: 'ALREADY_PROCESSED', event };
  }
  if (event.status === 'ignored') {
    return { status: 'ALREADY_IGNORED', event };
  }
  return { status: 'STATE_CONFLICT', event };
}

// UPDATE condicional real: a condição de status vive NA QUERY (`.in()`
// encadeado ANTES do `.select()`), nunca um check-then-act separado em
// JS — isso é o que de fato elimina o TOCTOU (Fase 3.3.3.3.1, seção 7),
// apoiado na semântica real do Postgres: um UPDATE concorrente que
// precisou esperar o lock de outra transação reavalia seu WHERE contra
// a linha já comitada (EvalPlanQual) antes de decidir aplicar.
async function applyConditionalUpdate(
  client: IntegrationEventsClientLike,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<EventFinalizationResult> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .update(patch)
      .eq('id', eventId)
      .in('status', FINALIZABLE_FROM_STATUSES)
      .select('id');

    if (error) {
      return { status: 'REPOSITORY_ERROR', error };
    }
    if (!Array.isArray(data)) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('integrationEventRepository: Supabase client retornou data inconsistente (nao e array e nenhum error foi reportado)'),
      };
    }
    if (data.length > 0) {
      return { status: 'OK' };
    }

    return await readAfterZero(client, eventId);
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}

// Decisão determinística e estável de domínio (conta não encontrada/
// inativa, telefone inválido/ambíguo) — nunca cria lead, nunca cria
// interaction, nunca preenche resolved_lead_id/resolved_interaction_id.
// integrationAccountId só é escrito quando explicitamente fornecido
// (ex. account_inactive, onde a conta FOI identificada, só não está
// ativa) — nunca inventa ownership para NOT_FOUND. NUNCA sobrescreve
// 'processed'/'ignored' (UPDATE condicional, ver applyConditionalUpdate).
export async function markIntegrationEventIgnored(
  input: MarkIntegrationEventIgnoredInput,
  supabaseServiceClient: unknown,
): Promise<EventFinalizationResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.eventId)) {
    throw new TypeError('markIntegrationEventIgnored: eventId deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(input?.errorCode)) {
    throw new TypeError('markIntegrationEventIgnored: errorCode deve ser uma string nao vazia e nao so-whitespace');
  }

  const patch: Record<string, unknown> = {
    status: 'ignored',
    processed_at: new Date().toISOString(),
    error_code: input.errorCode,
  };
  if (Object.prototype.hasOwnProperty.call(input, 'integrationAccountId') && input.integrationAccountId !== undefined) {
    if (!isNonBlankString(input.integrationAccountId)) {
      throw new TypeError('markIntegrationEventIgnored: integrationAccountId, quando fornecido, deve ser uma string nao vazia e nao so-whitespace');
    }
    patch.integration_account_id = input.integrationAccountId;
  }

  return applyConditionalUpdate(client, input.eventId, patch);
}

// Falha técnica (repository error, RPC rejeitada/malformada,
// inconsistência de contrato do evento canônico) — candidata a retry
// por quem futuramente implementar o scheduler (Fase 3.3.x). Nunca
// incrementa retry_count aqui (semântica de incremento pertence a quem
// efetivamente tentar novamente, nunca a este marcador de falha) e
// nunca cria lead/interaction. NUNCA sobrescreve 'processed'/'ignored'
// (UPDATE condicional, ver applyConditionalUpdate) — failed->failed é
// idempotente por definição (permanece em FINALIZABLE_FROM_STATUSES).
export async function markIntegrationEventFailed(
  input: MarkIntegrationEventFailedInput,
  supabaseServiceClient: unknown,
): Promise<EventFinalizationResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.eventId)) {
    throw new TypeError('markIntegrationEventFailed: eventId deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(input?.errorCode)) {
    throw new TypeError('markIntegrationEventFailed: errorCode deve ser uma string nao vazia e nao so-whitespace');
  }

  const patch: Record<string, unknown> = {
    status: 'failed',
    error_code: input.errorCode,
  };

  return applyConditionalUpdate(client, input.eventId, patch);
}
