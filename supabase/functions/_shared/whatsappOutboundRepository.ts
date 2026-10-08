// Fase 3.5.2.1 — Contratos TypeScript para as RPCs transacionais de
// envio outbound WhatsApp (migration 020). Mesmo padrão já estabelecido
// em integrationAccountRepository.ts/integrationEventIngressRepository.ts:
// client sempre injetado, nunca criado aqui; nunca lê Deno.env; 100%
// testável em Vitest/Node, zero Deno/Supabase/Meta reais necessários.
//
// Este módulo NUNCA chama a Graph API (zero fetch, zero
// access_token, zero rede) — só compõe o caminho de dados entre uma
// futura Edge Function (Fase 3.5.2.2, fora desta fase) e as RPCs já
// criadas na migration 020. ZERO mensagem real é enviada por este
// arquivo.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export interface ReserveOutboundAttemptInput {
  clientToken: string;
  userId: string;
  leadId: string;
  integrationAccountId: string;
  content: string;
}

export type ReserveOutboundAttemptResult =
  | { outcome: 'CLAIMED'; messageId: string; attemptNumber: number }
  | { outcome: 'ALREADY_IN_FLIGHT'; messageId: string; currentStatus: string }
  | { outcome: 'ALREADY_RESOLVED'; messageId: string; currentStatus: string }
  | { outcome: 'IDENTITY_CONFLICT'; messageId: string; currentStatus: string }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export interface ConfirmOutboundSentInput {
  messageId: string;
  externalMessageId: string;
}

export type ConfirmOutboundSentResult =
  | { outcome: 'CONFIRMED'; leadInteractionId: string }
  | { outcome: 'ALREADY_CONFIRMED'; leadInteractionId: string | null }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export type OutboundAttemptFailureOutcome = 'failed_transient' | 'failed_terminal';

export interface MarkOutboundAttemptResultInput {
  messageId: string;
  outcome: OutboundAttemptFailureOutcome;
  errorCode: string;
  httpStatus: number | null;
}

export type MarkOutboundAttemptResultResult =
  | { outcome: OutboundAttemptFailureOutcome; currentStatus: string }
  | { outcome: 'IGNORED_ALREADY_RESOLVED'; currentStatus: string }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export type OutboundStatusEventStatus = 'delivered' | 'read' | 'failed';

export interface ApplyOutboundStatusEventInput {
  externalMessageId: string;
  newStatus: OutboundStatusEventStatus;
  eventTimestamp: string;
}

export type ApplyOutboundStatusEventResult =
  | { outcome: 'APPLIED'; messageId: string }
  | { outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE'; messageId: string }
  | { outcome: 'PENDING_WAMID'; messageId: null }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

// Contrato estrutural mínimo do client injetado — só `.rpc(fn, params)`,
// nunca o tipo completo de @supabase/supabase-js.
export interface WhatsappOutboundServiceClient {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidClient(client: unknown): WhatsappOutboundServiceClient {
  if (
    client === null
    || typeof client !== 'object'
    || typeof (client as { rpc?: unknown }).rpc !== 'function'
  ) {
    throw new TypeError('whatsappOutboundRepository: supabaseServiceClient deve expor um metodo rpc(fn, params)');
  }
  return client as WhatsappOutboundServiceClient;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row = data[0];
  return (row !== null && typeof row === 'object') ? (row as Record<string, unknown>) : null;
}

export async function reserveWhatsappOutboundAttempt(
  input: ReserveOutboundAttemptInput,
  supabaseServiceClient: unknown,
): Promise<ReserveOutboundAttemptResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.clientToken)) {
    throw new TypeError('reserveWhatsappOutboundAttempt: clientToken deve ser uma string nao vazia');
  }
  if (!isNonBlankString(input?.content)) {
    throw new TypeError('reserveWhatsappOutboundAttempt: content deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('reserve_whatsapp_outbound_attempt', {
      p_client_token: input.clientToken,
      p_user_id: input.userId,
      p_lead_id: input.leadId,
      p_integration_account_id: input.integrationAccountId,
      p_content: input.content,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('reserve_whatsapp_outbound_attempt: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;
    const messageId = row.message_id as string;

    if (outcome === 'CLAIMED') {
      return { outcome: 'CLAIMED', messageId, attemptNumber: row.attempt_number as number };
    }
    if (outcome === 'ALREADY_IN_FLIGHT' || outcome === 'ALREADY_RESOLVED' || outcome === 'IDENTITY_CONFLICT') {
      return { outcome, messageId, currentStatus: row.current_status as string };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`reserve_whatsapp_outbound_attempt: outcome desconhecido (${String(outcome)})`) };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}

export async function confirmWhatsappOutboundSent(
  input: ConfirmOutboundSentInput,
  supabaseServiceClient: unknown,
): Promise<ConfirmOutboundSentResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.externalMessageId)) {
    throw new TypeError('confirmWhatsappOutboundSent: externalMessageId deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('confirm_whatsapp_outbound_sent', {
      p_message_id: input.messageId,
      p_external_message_id: input.externalMessageId,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('confirm_whatsapp_outbound_sent: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;
    if (outcome === 'CONFIRMED') {
      return { outcome: 'CONFIRMED', leadInteractionId: row.lead_interaction_id as string };
    }
    if (outcome === 'ALREADY_CONFIRMED') {
      return { outcome: 'ALREADY_CONFIRMED', leadInteractionId: (row.lead_interaction_id as string | null) ?? null };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`confirm_whatsapp_outbound_sent: outcome desconhecido (${String(outcome)})`) };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}

export async function markWhatsappOutboundAttemptResult(
  input: MarkOutboundAttemptResultInput,
  supabaseServiceClient: unknown,
): Promise<MarkOutboundAttemptResultResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (input?.outcome !== 'failed_transient' && input?.outcome !== 'failed_terminal') {
    throw new TypeError('markWhatsappOutboundAttemptResult: outcome deve ser failed_transient ou failed_terminal');
  }
  if (!isNonBlankString(input?.errorCode)) {
    throw new TypeError('markWhatsappOutboundAttemptResult: errorCode deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('mark_whatsapp_outbound_attempt_result', {
      p_message_id: input.messageId,
      p_outcome: input.outcome,
      p_error_code: input.errorCode,
      p_http_status: input.httpStatus,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('mark_whatsapp_outbound_attempt_result: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;
    if (outcome === 'failed_transient' || outcome === 'failed_terminal' || outcome === 'IGNORED_ALREADY_RESOLVED') {
      return { outcome, currentStatus: row.current_status as string };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`mark_whatsapp_outbound_attempt_result: outcome desconhecido (${String(outcome)})`) };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}

export async function applyWhatsappOutboundStatusEvent(
  input: ApplyOutboundStatusEventInput,
  supabaseServiceClient: unknown,
): Promise<ApplyOutboundStatusEventResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.externalMessageId)) {
    throw new TypeError('applyWhatsappOutboundStatusEvent: externalMessageId deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('apply_whatsapp_outbound_status_event', {
      p_external_message_id: input.externalMessageId,
      p_new_status: input.newStatus,
      p_event_timestamp: input.eventTimestamp,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('apply_whatsapp_outbound_status_event: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;
    if (outcome === 'APPLIED' || outcome === 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE') {
      return { outcome, messageId: row.message_id as string };
    }
    if (outcome === 'PENDING_WAMID') {
      return { outcome: 'PENDING_WAMID', messageId: null };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`apply_whatsapp_outbound_status_event: outcome desconhecido (${String(outcome)})`) };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}
