// Fase 3.3.2 — Server-only Integration Event (finalization) Repository.
//
// Responsabilidade ÚNICA: finalizar um integration_event já persistido
// para 'ignored' ou 'failed' quando o Automatic Inbound Engine decide
// NÃO chamar (ou a chamada de) process_inbound_whatsapp_event (migration
// 016) — essa RPC só cobre o caminho PROCESS (RESOLVED + telefone
// válido). Decisões determinísticas de domínio (conta não encontrada/
// inativa, telefone inválido/ambíguo) e falhas técnicas (repository
// error, RPC rejeitada) precisam de uma fronteira mínima para que o
// evento nunca fique eternamente em status='received'.
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

export type EventFinalizationResult =
  | { status: 'OK' }
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

// Contrato estrutural mínimo do client injetado — só o suficiente para
// um UPDATE...WHERE id=...RETURNING id, nunca o tipo completo do
// @supabase/supabase-js. .select() ao final é exigido deliberadamente:
// sem ele, um UPDATE do supabase-js não informa quantas linhas foram
// afetadas, e um eventId inexistente passaria como "sucesso" silencioso
// (fail-open) — aqui tratamos 0 linhas afetadas como REPOSITORY_ERROR.
export interface IntegrationEventsClientLike {
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(column: string, value: unknown): {
        select(columns: string): PromiseLike<SupabaseUpdateResult>;
      };
    };
  };
}

const TABLE = 'integration_events';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

async function applyUpdate(
  client: IntegrationEventsClientLike,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<EventFinalizationResult> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .update(patch)
      .eq('id', eventId)
      .select('id');

    if (error) {
      return { status: 'REPOSITORY_ERROR', error };
    }

    // Fail-closed: 0 linhas afetadas (eventId inexistente, ou já
    // removido) nunca é silenciosamente tratado como sucesso.
    if (!Array.isArray(data) || data.length === 0) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error(`integrationEventRepository: nenhuma linha afetada para integration_event id=${eventId}`),
      };
    }

    return { status: 'OK' };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}

// Decisão determinística e estável de domínio (conta não encontrada/
// inativa, telefone inválido/ambíguo) — nunca cria lead, nunca cria
// interaction, nunca preenche resolved_lead_id/resolved_interaction_id.
// integrationAccountId só é escrito quando explicitamente fornecido
// (ex. account_inactive, onde a conta FOI identificada, só não está
// ativa) — nunca inventa ownership para NOT_FOUND.
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

  return applyUpdate(client, input.eventId, patch);
}

// Falha técnica (repository error, RPC rejeitada/malformada,
// inconsistência de contrato do evento canônico) — candidata a retry
// por quem futuramente implementar o scheduler (Fase 3.3.x). Nunca
// incrementa retry_count aqui (semântica de incremento pertence a quem
// efetivamente tentar novamente, nunca a este marcador de falha) e
// nunca cria lead/interaction.
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

  return applyUpdate(client, input.eventId, patch);
}
