// Fase 3.5.2.1 — Contratos TypeScript para as RPCs transacionais de
// envio outbound WhatsApp (migrations 020 + 021 — máquina de estados
// corrigida após a auditoria adversarial). Mesmo padrão já estabelecido
// em integrationAccountRepository.ts/integrationEventIngressRepository.ts:
// client sempre injetado, nunca criado aqui; nunca lê Deno.env; 100%
// testável em Vitest/Node, zero Deno/Supabase/Meta reais necessários.
//
// Este módulo NUNCA chama a Graph API (zero fetch, zero
// access_token, zero rede) — só compõe o caminho de dados entre uma
// futura Edge Function (Fase 3.5.2.2, fora desta fase) e as RPCs já
// criadas nas migrations 020/021. ZERO mensagem real é enviada por
// este arquivo.
//
// CONTRATO OBRIGATÓRIO para quem consumir este módulo (Edge Function
// futura): reserveWhatsappOutboundAttempt (CLAIMED) ->
// startWhatsappOutboundAttemptCall (deve retornar STARTED) -> SÓ ENTÃO
// a chamada HTTP à Meta pode ser feita -> confirmWhatsappOutboundSent
// (sucesso) OU markWhatsappOutboundAttemptResult (uncertain |
// rejected_by_provider | failed_before_call). Pular
// startWhatsappOutboundAttemptCall e chamar confirm/mark diretamente é
// uma violação de contrato que a RPC rejeita (falha fechada).
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export interface ReserveOutboundAttemptInput {
  clientToken: string;
  userId: string;
  leadId: string;
  integrationAccountId: string;
  content: string;
  // Fase 3.5.2.2 — identidade WhatsApp do destinatário, resolvida pelo
  // chamador a partir da conversa inbound (NUNCA de leads.phone_normalized,
  // que é editável). A RPC revalida este valor de forma independente e
  // transacional — nunca confia apenas nele (ver IDENTITY_MISMATCH/
  // IDENTITY_AMBIGUOUS/IDENTITY_UNAVAILABLE).
  contactPhoneNormalized: string;
}

export type ReserveOutboundAttemptResult =
  | { outcome: 'CLAIMED'; messageId: string; attemptNumber: number }
  | { outcome: 'CLAIMED_WITH_PRIOR_UNCERTAIN'; messageId: string; attemptNumber: number }
  | { outcome: 'ALREADY_IN_FLIGHT'; messageId: string; currentStatus: string }
  | { outcome: 'ALREADY_CALLING'; messageId: string; currentStatus: string }
  | { outcome: 'UNCERTAIN_BLOCKED'; messageId: string; currentStatus: string }
  | { outcome: 'ALREADY_RESOLVED'; messageId: string; currentStatus: string }
  | { outcome: 'IDENTITY_CONFLICT'; messageId: string; currentStatus: string }
  | { outcome: 'IDENTITY_UNAVAILABLE' }
  | { outcome: 'IDENTITY_AMBIGUOUS' }
  | { outcome: 'IDENTITY_MISMATCH' }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export interface StartOutboundAttemptCallInput {
  messageId: string;
}

export type StartOutboundAttemptCallResult =
  | { outcome: 'STARTED'; currentStatus: 'sending' }
  | { outcome: 'ALREADY_STARTED_OR_RESOLVED'; currentStatus: string }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export interface ConfirmOutboundSentInput {
  messageId: string;
  externalMessageId: string;
}

export type ConfirmOutboundSentResult =
  | { outcome: 'CONFIRMED'; leadInteractionId: string }
  | { outcome: 'ALREADY_CONFIRMED'; leadInteractionId: string | null }
  | { outcome: 'CONFLICT_DIFFERENT_WAMID'; leadInteractionId: string | null }
  | { outcome: 'CONFLICT_UNEXPECTED_STATE'; leadInteractionId: null }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export type OutboundAttemptFailureOutcome = 'failed_before_call' | 'uncertain' | 'rejected_by_provider';

export interface MarkOutboundAttemptResultInput {
  messageId: string;
  outcome: OutboundAttemptFailureOutcome;
  errorCode: string;
  httpStatus: number | null;
}

export type MarkOutboundAttemptResultResult =
  | { outcome: OutboundAttemptFailureOutcome; currentStatus: string }
  | { outcome: 'IGNORED_ALREADY_RESOLVED'; currentStatus: string }
  | { outcome: 'IGNORED_INVALID_TRANSITION'; currentStatus: string }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

// Fase 3.5.2.3 — 'sent' incluído (evento Meta real, sempre um
// duplicado/fora de ordem quando a linha já existe — ver migration
// 023).
export type OutboundStatusEventStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface ApplyOutboundStatusEventInput {
  externalMessageId: string;
  newStatus: OutboundStatusEventStatus;
  eventTimestamp: string;
  // Fase 3.5.2.3 — conta WhatsApp que reportou o evento, resolvida
  // pelo webhook a partir do phone_number_id do payload (NUNCA
  // informada pelo cliente do CRM). A RPC valida de forma
  // independente que a mensagem (quando já existe) pertence a esta
  // MESMA conta — ver ACCOUNT_MISMATCH.
  integrationAccountId: string;
  // Só relevante para newStatus='failed' — código de erro da Meta,
  // nunca conteúdo de mensagem nem token.
  errorCode?: string | null;
}

export type ApplyOutboundStatusEventResult =
  | { outcome: 'APPLIED'; messageId: string }
  | { outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE'; messageId: string }
  // Correção pós-auditoria (Finding #1) — 'failed' tardio bloqueado
  // por 'delivered'/'read' já comprovados. Nunca aplicado, nunca
  // descartado em silêncio: a RPC grava uma anomalia auditável
  // (whatsapp_outbound_status_anomalies). Distinto de
  // IGNORED_OUT_OF_ORDER_OR_DUPLICATE para permitir observabilidade
  // específica deste caso.
  | { outcome: 'IGNORED_LATE_FAILURE_PROTECTED_DELIVERY'; messageId: string }
  | { outcome: 'PENDING_WAMID'; messageId: null }
  | { outcome: 'ACCOUNT_MISMATCH'; messageId: null }
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
  if (!isNonBlankString(input?.contactPhoneNormalized)) {
    throw new TypeError('reserveWhatsappOutboundAttempt: contactPhoneNormalized deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('reserve_whatsapp_outbound_attempt', {
      p_client_token: input.clientToken,
      p_user_id: input.userId,
      p_lead_id: input.leadId,
      p_integration_account_id: input.integrationAccountId,
      p_content: input.content,
      p_contact_phone_normalized: input.contactPhoneNormalized,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('reserve_whatsapp_outbound_attempt: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;

    if (outcome === 'IDENTITY_UNAVAILABLE' || outcome === 'IDENTITY_AMBIGUOUS' || outcome === 'IDENTITY_MISMATCH') {
      return { outcome };
    }

    const messageId = row.message_id as string;

    if (outcome === 'CLAIMED' || outcome === 'CLAIMED_WITH_PRIOR_UNCERTAIN') {
      return { outcome, messageId, attemptNumber: row.attempt_number as number };
    }
    if (
      outcome === 'ALREADY_IN_FLIGHT'
      || outcome === 'ALREADY_CALLING'
      || outcome === 'UNCERTAIN_BLOCKED'
      || outcome === 'ALREADY_RESOLVED'
      || outcome === 'IDENTITY_CONFLICT'
    ) {
      return { outcome, messageId, currentStatus: row.current_status as string };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`reserve_whatsapp_outbound_attempt: outcome desconhecido (${String(outcome)})`) };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}

export async function startWhatsappOutboundAttemptCall(
  input: StartOutboundAttemptCallInput,
  supabaseServiceClient: unknown,
): Promise<StartOutboundAttemptCallResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.messageId)) {
    throw new TypeError('startWhatsappOutboundAttemptCall: messageId deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('start_whatsapp_outbound_attempt_call', {
      p_message_id: input.messageId,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('start_whatsapp_outbound_attempt_call: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;
    if (outcome === 'STARTED') {
      return { outcome: 'STARTED', currentStatus: 'sending' };
    }
    if (outcome === 'ALREADY_STARTED_OR_RESOLVED') {
      return { outcome: 'ALREADY_STARTED_OR_RESOLVED', currentStatus: row.current_status as string };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`start_whatsapp_outbound_attempt_call: outcome desconhecido (${String(outcome)})`) };
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
    if (outcome === 'ALREADY_CONFIRMED' || outcome === 'CONFLICT_DIFFERENT_WAMID') {
      return { outcome, leadInteractionId: (row.lead_interaction_id as string | null) ?? null };
    }
    if (outcome === 'CONFLICT_UNEXPECTED_STATE') {
      return { outcome: 'CONFLICT_UNEXPECTED_STATE', leadInteractionId: null };
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

  if (
    input?.outcome !== 'failed_before_call'
    && input?.outcome !== 'uncertain'
    && input?.outcome !== 'rejected_by_provider'
  ) {
    throw new TypeError('markWhatsappOutboundAttemptResult: outcome deve ser failed_before_call, uncertain ou rejected_by_provider');
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
    if (
      outcome === 'failed_before_call'
      || outcome === 'uncertain'
      || outcome === 'rejected_by_provider'
      || outcome === 'IGNORED_ALREADY_RESOLVED'
      || outcome === 'IGNORED_INVALID_TRANSITION'
    ) {
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
  if (!isNonBlankString(input?.integrationAccountId)) {
    throw new TypeError('applyWhatsappOutboundStatusEvent: integrationAccountId deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('apply_whatsapp_outbound_status_event', {
      p_external_message_id: input.externalMessageId,
      p_new_status: input.newStatus,
      p_event_timestamp: input.eventTimestamp,
      p_integration_account_id: input.integrationAccountId,
      p_error_code: input.errorCode ?? null,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = firstRow(data);
    if (!row) {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('apply_whatsapp_outbound_status_event: resposta inesperada (esperada exatamente 1 linha)') };
    }

    const outcome = row.outcome;
    if (
      outcome === 'APPLIED'
      || outcome === 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE'
      || outcome === 'IGNORED_LATE_FAILURE_PROTECTED_DELIVERY'
    ) {
      return { outcome, messageId: row.message_id as string };
    }
    if (outcome === 'PENDING_WAMID' || outcome === 'ACCOUNT_MISMATCH') {
      return { outcome, messageId: null };
    }
    return { outcome: 'REPOSITORY_ERROR', error: new Error(`apply_whatsapp_outbound_status_event: outcome desconhecido (${String(outcome)})`) };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}
