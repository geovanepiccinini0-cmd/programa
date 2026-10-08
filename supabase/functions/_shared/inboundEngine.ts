// Fase 3.3.2 — Automatic Inbound Engine V1.
// Fase 3.3.3.3.1 — Hardening: reconciliação pós-exceção ambígua da RPC.
//
// Responsabilidade ÚNICA: orquestrar, de forma determinística e
// testável, a decisão PROCESS/IGNORE/FAIL para um evento inbound já
// canônico (extraído por um futuro Provider Adapter, Fase 3.3.3 — este
// módulo NUNCA conhece payload Meta/Graph API bruto). Delega toda
// lógica de negócio já existente:
//   - resolução de conta: resolveIntegrationAccount (src/lib/integrationAccount.js);
//   - identidade de telefone: normalizePhoneIdentity (src/lib/phoneIdentity.js);
//   - criação atômica de lead+interaction: a RPC process_inbound_whatsapp_event
//     (migration 016/017), chamada aqui via dependência injetada, nunca
//     importada/criada diretamente.
// Nunca reimplementa nenhuma dessas regras.
//
// Dependency injection total — zero Deno.env, zero createClient, zero
// npm: import, zero fetch, zero runtime Deno obrigatório. 100%
// testável em Vitest/Node. O binding real (findAccountCandidates →
// integrationAccountService.ts + supabaseServiceRuntime.ts;
// processInboundWhatsAppEvent → chamada real da RPC via supabase-js;
// getIntegrationEventById/markIntegrationEvent{Ignored,Failed} →
// integrationEventRepository.ts + client real) fica para quem
// efetivamente consumir este Engine (futuro Edge Function endpoint,
// fora desta fase).
//
// user_id NUNCA é passado para a RPC — somente integrationAccountId.
// A RPC deriva user_id por conta própria a partir de
// integration_accounts (defesa em profundidade já estabelecida na
// Fase 3.3.1).
//
// IGNORE/FAILED são sempre valores de retorno normais, nunca
// exceptions — exceptions aqui significam exclusivamente violação de
// contrato de quem chama esta função (ex. integrationEventId ausente,
// deps malformadas), nunca uma decisão de domínio.
//
// AMBIGUOUS COMMIT (Fase 3.3.3.3.0, achados F2/F3/F23/F25 — HIGH):
// antes desta fase, uma exceção/timeout na chamada da RPC levava
// CEGAMENTE a markFailed, mesmo quando a RPC já tinha comitado
// 'processed' no servidor (o cliente só não recebeu a resposta). Como
// os finalizers agora usam UPDATE condicional (ver
// integrationEventRepository.ts), essa escrita cega seria apenas
// recusada (zero linhas afetadas) — mas sem reconciliação o Engine
// ainda devolveria FAILED para um evento que na verdade já está
// PROCESSED. O algoritmo abaixo relê o evento fresco ANTES de desistir:
// se já processado/ignorado, reconcilia para esse resultado real (nunca
// chama a RPC de novo, nunca cria interaction, nunca finaliza);
// só tenta markFailed condicional quando o estado fresco ainda é
// genuinamente não-terminal. Qualquer leitura/estado que não possa ser
// interpretado com segurança falha fechado como
// EVENT_RECONCILIATION_FAILED — nunca finaliza um estado que não
// entende.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

import { resolveIntegrationAccount, INTEGRATION_ACCOUNT_RESOLUTION_STATUS } from '../../../src/lib/integrationAccount.js';
import { normalizePhoneIdentity, PHONE_IDENTITY_STATUS } from '../../../src/lib/phoneIdentity.js';
import type { RepositoryResult } from './integrationAccountRepository.ts';
import type {
  EventFinalizationResult,
  GetIntegrationEventByIdResult,
  IntegrationEventTerminalSnapshot,
} from './integrationEventRepository.ts';

export interface CanonicalInboundEvent {
  provider: unknown;
  externalEventId: unknown;
  externalAccountId: unknown;
  externalMessageId: unknown;
  occurredAt: unknown;
  senderPhoneRaw: unknown;
  senderDisplayName?: unknown;
  text?: unknown;
  messageType?: unknown;
}

export type EngineIgnoredReason =
  | 'account_not_found'
  | 'account_inactive'
  | 'invalid_sender_phone'
  | 'ambiguous_sender_phone';

export type EngineFailedReason =
  | 'invalid_event'
  | 'account_ambiguous'
  | 'account_resolution_invalid_input'
  | 'account_repository_error'
  | 'processing_error';

// Falha técnica de RECONCILIAÇÃO — nunca uma decisão de domínio. Emitido
// somente quando o Engine não consegue provar com segurança qual é o
// estado real do evento após uma exceção/resultado ambíguo da RPC.
// Nunca finaliza o evento neste caminho (poderia mascarar um
// 'processed'/'ignored' real) — a camada HTTP futura decide retry.
export type EngineReconciliationFailedReason =
  | 'read_failed'
  | 'event_not_found'
  | 'processed_invariants_missing'
  | 'ignored_reason_unknown'
  | 'unexpected_terminal_state';

export type EngineResult =
  | { status: 'PROCESSED'; leadId: string; interactionId: string; wasNewLead: boolean }
  | { status: 'IGNORED'; reason: EngineIgnoredReason }
  | { status: 'FAILED'; reason: EngineFailedReason; retryable: boolean }
  | {
      status: 'EVENT_FINALIZATION_FAILED';
      attemptedStatus: 'ignored' | 'failed';
      reason: EngineIgnoredReason | EngineFailedReason;
      finalizationError: unknown;
    }
  | { status: 'EVENT_RECONCILIATION_FAILED'; reason: EngineReconciliationFailedReason };

export interface ProcessInboundWhatsAppEventInput {
  integrationEventId: string;
  integrationAccountId: string;
  phoneNormalized: string;
  telefoneDisplay: string;
  nome: string;
  occurredAt: string;
  content: string | null;
  metadata: Record<string, unknown>;
}

export interface InboundEngineDeps {
  findAccountCandidates: (provider: string, externalAccountId: string) => Promise<RepositoryResult>;
  processInboundWhatsAppEvent: (input: ProcessInboundWhatsAppEventInput) => Promise<unknown>;
  getIntegrationEventById: (eventId: string) => Promise<GetIntegrationEventByIdResult>;
  markIntegrationEventIgnored: (input: {
    eventId: string;
    errorCode: string;
    integrationAccountId?: string;
  }) => Promise<EventFinalizationResult>;
  markIntegrationEventFailed: (input: { eventId: string; errorCode: string }) => Promise<EventFinalizationResult>;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function assertValidDeps(deps: unknown): InboundEngineDeps {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('processInboundEvent: deps deve ser um objeto');
  }
  const d = deps as Record<string, unknown>;
  for (const key of [
    'findAccountCandidates',
    'processInboundWhatsAppEvent',
    'getIntegrationEventById',
    'markIntegrationEventIgnored',
    'markIntegrationEventFailed',
  ]) {
    if (!isFunction(d[key])) {
      throw new TypeError(`processInboundEvent: deps.${key} deve ser uma function`);
    }
  }
  return deps as InboundEngineDeps;
}

function isValidOccurredAt(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'string' && value.trim().length > 0) {
    return !Number.isNaN(new Date(value).getTime());
  }
  return false;
}

interface ValidatedCanonicalInboundEvent {
  provider: string;
  externalAccountId: string;
  occurredAtIso: string;
  senderPhoneRaw: string;
  senderDisplayName: unknown;
  text: string | null;
  messageType: string | null;
}

// Validação do contrato canônico V1. externalEventId/externalMessageId
// são exigidos pelo contrato (seções 7/8) mas não propagados por este
// módulo para nenhuma dependência — identidade de entrega/mensagem já
// foi resolvida antes desta chamada (o integration_event já existe,
// precondição da Fase 3.3.2) e a RPC os deriva do próprio
// integration_event, nunca de um parâmetro desta função.
function validateCanonicalInboundEvent(event: unknown): ValidatedCanonicalInboundEvent | null {
  if (event === null || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;

  if (!isNonBlankString(e.provider)) return null;
  if (!isNonBlankString(e.externalEventId)) return null;
  if (!isNonBlankString(e.externalAccountId)) return null;
  if (!isNonBlankString(e.externalMessageId)) return null;
  if (!isNonBlankString(e.senderPhoneRaw)) return null;
  if (!isValidOccurredAt(e.occurredAt)) return null;

  const occurredAtIso = e.occurredAt instanceof Date ? e.occurredAt.toISOString() : new Date(e.occurredAt as string).toISOString();

  return {
    provider: e.provider,
    externalAccountId: e.externalAccountId,
    occurredAtIso,
    senderPhoneRaw: e.senderPhoneRaw,
    senderDisplayName: e.senderDisplayName,
    text: typeof e.text === 'string' ? e.text : null,
    messageType: typeof e.messageType === 'string' && e.messageType.trim().length > 0 ? e.messageType : null,
  };
}

// Regra congelada (Fase 3.3.1): senderDisplayName é só nome inicial de
// EXIBIÇÃO, nunca identidade verificada. Fallback determinístico a
// partir dos últimos 4 dígitos do telefone canônico (já normalizado) —
// nunca inventa nome, nunca usa placeholder genérico que esconda a
// origem. Esta função é pura, exportada para teste direto.
export function buildInboundLeadName(senderDisplayName: unknown, phoneNormalized: string): string {
  if (typeof senderDisplayName === 'string') {
    const trimmed = senderDisplayName.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const lastFour = phoneNormalized.slice(-4);
  return `WhatsApp • ${lastFour}`;
}

function buildInboundMetadata(messageType: string | null): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (messageType) {
    metadata.message_type = messageType;
  }
  return metadata;
}

interface MappedRpcResult {
  leadId: string;
  interactionId: string;
  wasNewLead: boolean;
}

// Nunca confia cegamente no shape retornado pela dependência da RPC —
// um resultado malformado (ou event_status != 'processed') é tratado
// como falha técnica, nunca mascarado como sucesso.
function mapRpcResult(raw: unknown): MappedRpcResult | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.event_status !== 'processed') return null;
  if (!isNonBlankString(r.lead_id) || !isNonBlankString(r.interaction_id)) return null;
  if (typeof r.was_new_lead !== 'boolean') return null;
  return { leadId: r.lead_id, interactionId: r.interaction_id, wasNewLead: r.was_new_lead };
}

const KNOWN_IGNORED_REASONS: readonly EngineIgnoredReason[] = [
  'account_not_found',
  'account_inactive',
  'invalid_sender_phone',
  'ambiguous_sender_phone',
];

// Reconcilia um snapshot TERMINAL (processed/ignored) observado durante
// a recuperação de ambiguous-commit ou via resultado rico do finalizer
// (ALREADY_PROCESSED/ALREADY_IGNORED) para o EngineResult real
// correspondente. Nunca chama a RPC de novo, nunca cria interaction,
// nunca finaliza nada — só traduz um fato já comitado. Falha fechado
// (EVENT_RECONCILIATION_FAILED) se as invariantes esperadas não se
// sustentarem, em vez de fingir sucesso.
function reconcileTerminalSnapshot(event: IntegrationEventTerminalSnapshot): EngineResult {
  if (event.status === 'processed') {
    if (isNonBlankString(event.resolvedLeadId) && isNonBlankString(event.resolvedInteractionId)) {
      // wasNewLead=false: esta invocação não criou nada agora — está
      // apenas observando um fato já comitado anteriormente.
      return { status: 'PROCESSED', leadId: event.resolvedLeadId, interactionId: event.resolvedInteractionId, wasNewLead: false };
    }
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'processed_invariants_missing' };
  }

  if (event.status === 'ignored') {
    if (typeof event.errorCode === 'string' && (KNOWN_IGNORED_REASONS as readonly string[]).includes(event.errorCode)) {
      return { status: 'IGNORED', reason: event.errorCode as EngineIgnoredReason };
    }
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'ignored_reason_unknown' };
  }

  return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'unexpected_terminal_state' };
}

// Interpreta qualquer resultado NÃO-OK de um finalizer (ver
// integrationEventRepository.ts) — chamado a partir dos três pontos
// que finalizam um evento (finalizeIgnored, finalizeFailed,
// finalizeFailedAfterReconciliation). 'processed'/'ignored' observados
// aqui SEMPRE vencem sobre a finalização que esta chamada tentava
// fazer (nunca sobrescritos) — é exatamente a garantia de que um
// finalizer concorrente nunca regride um estado terminal (Fase
// 3.3.3.3.1, seções 9/15).
function interpretNonOkFinalization(
  result: Exclude<EventFinalizationResult, { status: 'OK' }>,
  attemptedStatus: 'ignored' | 'failed',
  reason: EngineIgnoredReason | EngineFailedReason,
): EngineResult {
  if (result.status === 'ALREADY_PROCESSED' || result.status === 'ALREADY_IGNORED') {
    return reconcileTerminalSnapshot(result.event);
  }
  if (result.status === 'EVENT_NOT_FOUND') {
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'event_not_found' };
  }
  if (result.status === 'STATE_CONFLICT') {
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'unexpected_terminal_state' };
  }
  // REPOSITORY_ERROR
  return { status: 'EVENT_FINALIZATION_FAILED', attemptedStatus, reason, finalizationError: result.error };
}

async function finalizeIgnored(
  eventId: string,
  reason: EngineIgnoredReason,
  integrationAccountId: string | undefined,
  deps: InboundEngineDeps,
): Promise<EngineResult> {
  let result: EventFinalizationResult;
  try {
    result = await deps.markIntegrationEventIgnored({
      eventId,
      errorCode: reason,
      ...(integrationAccountId !== undefined ? { integrationAccountId } : {}),
    });
  } catch (thrown) {
    return { status: 'EVENT_FINALIZATION_FAILED', attemptedStatus: 'ignored', reason, finalizationError: thrown };
  }
  if (result.status === 'OK') {
    return { status: 'IGNORED', reason };
  }
  return interpretNonOkFinalization(result, 'ignored', reason);
}

async function finalizeFailed(
  eventId: string,
  reason: EngineFailedReason,
  retryable: boolean,
  deps: InboundEngineDeps,
): Promise<EngineResult> {
  let result: EventFinalizationResult;
  try {
    result = await deps.markIntegrationEventFailed({ eventId, errorCode: reason });
  } catch (thrown) {
    return { status: 'EVENT_FINALIZATION_FAILED', attemptedStatus: 'failed', reason, finalizationError: thrown };
  }
  if (result.status === 'OK') {
    return { status: 'FAILED', reason, retryable };
  }
  return interpretNonOkFinalization(result, 'failed', reason);
}

// Indica se um snapshot 'failed' já carrega resíduo de um possível
// commit anterior (ambiguous commit pré-hardening, ou linha legada) —
// usado SOMENTE para calcular `retryable` com honestidade: nunca
// afirma que um retry é seguro quando há evidência de processamento
// já comitado (Fase 3.3.3.3.0, achado F3/F23).
function hasResolvedResidue(event: IntegrationEventTerminalSnapshot): boolean {
  return isNonBlankString(event.resolvedInteractionId) || isNonBlankString(event.resolvedLeadId) || event.processedAt !== null;
}

// Chamado SOMENTE a partir da reconciliação pós-exceção/resultado
// ambíguo da RPC (ver reconcileAmbiguousRpcOutcome), quando a leitura
// fresca já provou que o evento ainda está num estado não-terminal
// (received/processing/failed). Mesmo assim, o UPDATE condicional pode
// descobrir uma transição concorrente ENTRE essa leitura e agora
// (TOCTOU) — por isso o resultado rico do finalizer é sempre
// reinterpretado aqui, nunca assumido como um simples OK.
async function finalizeFailedAfterReconciliation(
  eventId: string,
  freshEvent: IntegrationEventTerminalSnapshot,
  deps: InboundEngineDeps,
): Promise<EngineResult> {
  let result: EventFinalizationResult;
  try {
    result = await deps.markIntegrationEventFailed({ eventId, errorCode: 'processing_error' });
  } catch (thrown) {
    return { status: 'EVENT_FINALIZATION_FAILED', attemptedStatus: 'failed', reason: 'processing_error', finalizationError: thrown };
  }
  if (result.status === 'OK') {
    const retryable = freshEvent.status === 'failed' ? !hasResolvedResidue(freshEvent) : true;
    return { status: 'FAILED', reason: 'processing_error', retryable };
  }
  return interpretNonOkFinalization(result, 'failed', 'processing_error');
}

// Ponto central de recuperação de ambiguous-commit (Fase 3.3.3.3.0,
// achados F2/F3/F23/F25). Chamado quando a chamada à RPC lançou OU
// retornou um resultado que não corresponde ao contrato esperado —
// NUNCA finaliza cegamente: primeiro relê o evento fresco para provar
// o que de fato já aconteceu no servidor.
async function reconcileAmbiguousRpcOutcome(
  integrationEventId: string,
  deps: InboundEngineDeps,
): Promise<EngineResult> {
  let fresh: GetIntegrationEventByIdResult;
  try {
    fresh = await deps.getIntegrationEventById(integrationEventId);
  } catch {
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'read_failed' };
  }

  if (fresh.status === 'REPOSITORY_ERROR') {
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'read_failed' };
  }
  if (fresh.status === 'NOT_FOUND') {
    return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'event_not_found' };
  }

  const { event } = fresh;

  if (event.status === 'processed' || event.status === 'ignored') {
    return reconcileTerminalSnapshot(event);
  }

  if (event.status === 'received' || event.status === 'processing' || event.status === 'failed') {
    return finalizeFailedAfterReconciliation(integrationEventId, event, deps);
  }

  return { status: 'EVENT_RECONCILIATION_FAILED', reason: 'unexpected_terminal_state' };
}

export async function processInboundEvent(
  integrationEventId: unknown,
  event: CanonicalInboundEvent,
  deps: unknown,
): Promise<EngineResult> {
  const validDeps = assertValidDeps(deps);

  if (!isNonBlankString(integrationEventId)) {
    throw new TypeError('processInboundEvent: integrationEventId deve ser uma string nao vazia e nao so-whitespace');
  }

  const validated = validateCanonicalInboundEvent(event);
  if (!validated) {
    return finalizeFailed(integrationEventId, 'invalid_event', false, validDeps);
  }

  // 1) ACCOUNT RESOLUTION — nunca cria lead antes desta etapa.
  const candidatesResult = await validDeps.findAccountCandidates(validated.provider, validated.externalAccountId);
  if (candidatesResult.status === 'REPOSITORY_ERROR') {
    return finalizeFailed(integrationEventId, 'account_repository_error', true, validDeps);
  }

  const resolution = resolveIntegrationAccount(validated.provider, validated.externalAccountId, candidatesResult.candidates);

  if (resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.NOT_FOUND) {
    return finalizeIgnored(integrationEventId, 'account_not_found', undefined, validDeps);
  }
  if (resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.INACTIVE) {
    return finalizeIgnored(integrationEventId, 'account_inactive', resolution.integrationAccountId, validDeps);
  }
  if (resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.AMBIGUOUS) {
    return finalizeFailed(integrationEventId, 'account_ambiguous', false, validDeps);
  }
  if (resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.INVALID_INPUT) {
    return finalizeFailed(integrationEventId, 'account_resolution_invalid_input', false, validDeps);
  }

  // RESOLVED — userId do resolver NUNCA é repassado à RPC (seção 10):
  // somente integrationAccountId. A RPC deriva user_id por conta
  // própria a partir de integration_accounts.
  const { integrationAccountId } = resolution;

  // 2) PHONE IDENTITY — nunca reimplementa normalizePhoneIdentity.
  const phone = normalizePhoneIdentity(validated.senderPhoneRaw);
  if (phone.status === PHONE_IDENTITY_STATUS.INVALID) {
    return finalizeIgnored(integrationEventId, 'invalid_sender_phone', integrationAccountId, validDeps);
  }
  if (phone.status === PHONE_IDENTITY_STATUS.AMBIGUOUS) {
    return finalizeIgnored(integrationEventId, 'ambiguous_sender_phone', integrationAccountId, validDeps);
  }

  const phoneNormalized = phone.number as string;
  const nome = buildInboundLeadName(validated.senderDisplayName, phoneNormalized);
  const metadata = buildInboundMetadata(validated.messageType);

  // 3) PROCESS — chamada da RPC via dependencia injetada. Zero retry
  // automatico dentro desta invocacao: se a chamada lancar OU o
  // resultado vier malformado, NUNCA finaliza cegamente — primeiro
  // reconcilia via leitura fresca do evento (ambiguous commit, ver
  // reconcileAmbiguousRpcOutcome). A RPC em si nunca e chamada de novo
  // aqui.
  let mapped: MappedRpcResult | null = null;
  let rpcOutcomeIsAmbiguous = false;
  try {
    const rawResult = await validDeps.processInboundWhatsAppEvent({
      integrationEventId,
      integrationAccountId,
      phoneNormalized,
      telefoneDisplay: validated.senderPhoneRaw,
      nome,
      occurredAt: validated.occurredAtIso,
      content: validated.text,
      metadata,
    });
    mapped = mapRpcResult(rawResult);
    rpcOutcomeIsAmbiguous = !mapped;
  } catch {
    rpcOutcomeIsAmbiguous = true;
  }

  if (!rpcOutcomeIsAmbiguous && mapped) {
    return { status: 'PROCESSED', leadId: mapped.leadId, interactionId: mapped.interactionId, wasNewLead: mapped.wasNewLead };
  }

  return reconcileAmbiguousRpcOutcome(integrationEventId, validDeps);
}
