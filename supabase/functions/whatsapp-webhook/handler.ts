// Fase 3.3.3.3 — WhatsApp Webhook Composition Root (handler puro, testável).
//
// Responsabilidade ÚNICA: orquestrar os módulos já aprovados
// (whatsappWebhook.ts, integrationEventIngressRepository.ts,
// integrationEventRepository.ts, inboundEngine.ts,
// integrationAccountRepository.ts) numa única requisição HTTP de
// webhook — NENHUMA regra de negócio nova nasce aqui. Este arquivo
// nunca importa Deno.serve/Deno.env/npm: specifiers — só os módulos
// puros/testáveis já existentes mais uma forma mínima e estrutural do
// client Supabase (igual ao padrão já usado em
// integrationAccountRepository.ts/integrationEventRepository.ts: um
// contrato estrutural mínimo, nunca o tipo completo de
// @supabase/supabase-js).
//
// Vive em supabase/functions/whatsapp-webhook/ — fora de src/, nunca
// alcançado pelo build do Vite/bundle do browser. 100% testável em
// Vitest/Node: zero Deno real, zero Supabase real, zero Meta real,
// zero rede real necessários para testar este arquivo.
//
// ZERO SIDE EFFECT ANTES DA ASSINATURA (Fase 3.3.3.3, seção 9): o
// client service-role só é criado (via `deps.getServiceClient()`, uma
// factory lazy, nunca chamada antecipadamente) depois que a assinatura
// HMAC do POST já foi validada E já se sabe que existe ao menos um
// evento canônico para processar (mensagem inbound OU, desde a Fase
// 3.5.2.3, evento de status outbound). GET nunca cria client. Payload
// unsupported/sem nenhuma mensagem OU status válido nunca cria
// client. JSON inválido nunca cria client.

import {
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  parseWhatsAppWebhookPayload,
  type CanonicalInboundEvent,
  type CanonicalOutboundStatusEvent,
} from '../_shared/whatsappWebhook.ts';
import {
  createOrGetIntegrationEvent,
  type CreateOrGetIntegrationEventResult,
} from '../_shared/integrationEventIngressRepository.ts';
import {
  getIntegrationEventById,
  markIntegrationEventIgnored,
  markIntegrationEventFailed,
} from '../_shared/integrationEventRepository.ts';
import { findIntegrationAccountCandidates } from '../_shared/integrationAccountRepository.ts';
import {
  processInboundEvent,
  type InboundEngineDeps,
  type ProcessInboundWhatsAppEventInput,
  type EngineResult,
} from '../_shared/inboundEngine.ts';
import { resolveIntegrationAccount, INTEGRATION_ACCOUNT_RESOLUTION_STATUS } from '../../../src/lib/integrationAccount.js';
import {
  applyWhatsappOutboundStatusEvent,
  type OutboundStatusEventStatus,
} from '../_shared/whatsappOutboundRepository.ts';

// ===========================================================================
// CONTRATO HTTP MÍNIMO — nunca o Request/Response real do Deno. index.ts
// (o adapter runtime) faz a tradução nos dois sentidos. Isso é o que
// mantém este arquivo 100% testável sem Deno real.
// ===========================================================================

export interface WebhookGetVerification {
  mode: unknown;
  verifyToken: unknown;
  challenge: unknown;
}

export interface WebhookHttpRequest {
  method: unknown;
  // Presente/relevante somente para GET.
  getVerification?: WebhookGetVerification;
  // Presentes/relevantes somente para POST. rawBody é o texto EXATO do
  // corpo, lido uma única vez pelo adapter, nunca reserializado.
  rawBody?: unknown;
  signatureHeader?: unknown;
}

export interface WebhookHttpResponse {
  status: number;
  body: string;
  contentType: 'text/plain' | 'application/json';
}

// Contrato estrutural mínimo do client injetado — só o suficiente para
// repassar aos repositories já aprovados (cada um valida sua própria
// forma) mais `.rpc()` para a chamada da RPC hardened. Nunca o tipo
// completo de @supabase/supabase-js.
export type WhatsappWebhookServiceClient = unknown;

export interface WhatsappWebhookHandlerDeps {
  // Secrets já lidos pelo adapter runtime (Deno.env) — nunca lidos
  // aqui. Ausência/vazio é tratado como fail-closed pelos helpers
  // aprovados (verifyWhatsAppWebhookChallenge/Signature), nunca por
  // este módulo reimplementando a checagem.
  verifyToken: unknown;
  appSecret: unknown;
  // Factory lazy do client service-role — chamada NO MÁXIMO 1 vez por
  // requisição, e só quando genuinamente necessário (ver seção 9 no
  // topo do arquivo). Nunca memorizada fora do escopo de uma única
  // chamada a handleWhatsappWebhookRequest (zero estado module-level
  // compartilhado entre requisições).
  getServiceClient: () => WhatsappWebhookServiceClient;
  // Clock injetável — usado exclusivamente como fallback de
  // receivedAt para o parser (seção 14). Nunca espalhado como
  // Date.now()/new Date() direto pelo resto deste arquivo.
  now: () => Date;
}

function respond(status: number, body: string, contentType: 'text/plain' | 'application/json' = 'text/plain'): WebhookHttpResponse {
  return { status, body, contentType };
}

const ACK_OK = respond(200, JSON.stringify({ ok: true }), 'application/json');
const RESPONSE_FORBIDDEN = respond(403, 'forbidden');
const RESPONSE_UNAUTHORIZED = respond(401, 'unauthorized');
const RESPONSE_BAD_REQUEST = respond(400, 'bad request');
const RESPONSE_METHOD_NOT_ALLOWED = respond(405, 'method not allowed');
const RESPONSE_INTERNAL_ERROR = respond(500, 'internal error');

// ===========================================================================
// GET — META WEBHOOK VERIFICATION
// ===========================================================================

function handleGet(request: WebhookHttpRequest, deps: WhatsappWebhookHandlerDeps): WebhookHttpResponse {
  const verification = request.getVerification;
  const result = verifyWhatsAppWebhookChallenge(
    {
      mode: verification?.mode,
      verifyToken: verification?.verifyToken,
      challenge: verification?.challenge,
    },
    deps.verifyToken,
  );

  if (!result.valid) {
    return RESPONSE_FORBIDDEN;
  }
  return respond(200, result.challenge);
}

// ===========================================================================
// POST — INGRESS + ENGINE COMPOSITION
// ===========================================================================

// Whitelist idêntica à já imposta internamente pelo ingress repository
// (seção 31/32) — construída aqui só para deixar explícito, na própria
// composição, que o texto da mensagem (`event.text`) NUNCA é incluído
// no payload minimizado (ele segue para lead_interactions.content via
// Engine/RPC, nunca para payload_minimized). O repository já reforça
// essa whitelist internamente de forma independente — esta função
// nunca depende apenas da disciplina deste arquivo.
function buildPayloadMinimized(event: CanonicalInboundEvent): Record<string, unknown> {
  return {
    message_type: typeof event.messageType === 'string' ? event.messageType : null,
    phone_number_id: typeof event.externalAccountId === 'string' ? event.externalAccountId : null,
    field: 'messages',
  };
}

type EventOutcomeCategory = 'handled' | 'retryable_failure' | 'non_retryable_failure';

// Liga as dependências do Engine ao client desta requisição — nenhuma
// lógica de domínio nova, só dependency injection dos módulos já
// aprovados (seção 21). user_id NUNCA é lido/aceito em lugar nenhum
// desta ligação.
function buildEngineDeps(client: WhatsappWebhookServiceClient): InboundEngineDeps {
  return {
    findAccountCandidates: (provider, externalAccountId) =>
      findIntegrationAccountCandidates({ provider, externalAccountId }, client as never),
    processInboundWhatsAppEvent: (input) => callProcessInboundWhatsAppEventRpc(client, input),
    getIntegrationEventById: (eventId) => getIntegrationEventById(eventId, client),
    markIntegrationEventIgnored: (input) => markIntegrationEventIgnored(input, client),
    markIntegrationEventFailed: (input) => markIntegrationEventFailed(input, client),
  };
}

interface RpcClientLike {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

function isRpcClient(client: unknown): client is RpcClientLike {
  return client !== null && typeof client === 'object' && typeof (client as { rpc?: unknown }).rpc === 'function';
}

// Única ligação nova desta fase entre o contrato de
// ProcessInboundWhatsAppEventInput (camelCase, já estabelecido pelo
// inboundEngine.ts) e a chamada real da RPC hardened (017) via
// `.rpc()` do Supabase client — nomes de parâmetro (`p_*`) exatamente
// como a assinatura publicada da função. Nunca passa p_user_id (esse
// parâmetro nem existe na RPC). Qualquer erro do client ou resposta
// malformada é propagado via throw — o Engine já trata isso como
// resultado ambíguo (reconciliação pós-exceção, nunca mascarado como
// sucesso).
async function callProcessInboundWhatsAppEventRpc(
  client: WhatsappWebhookServiceClient,
  input: ProcessInboundWhatsAppEventInput,
): Promise<unknown> {
  if (!isRpcClient(client)) {
    throw new TypeError('callProcessInboundWhatsAppEventRpc: client deve expor um metodo rpc(fn, params)');
  }

  const { data, error } = await client.rpc('process_inbound_whatsapp_event', {
    p_integration_event_id: input.integrationEventId,
    p_integration_account_id: input.integrationAccountId,
    p_phone_normalized: input.phoneNormalized,
    p_telefone_display: input.telefoneDisplay,
    p_nome: input.nome,
    p_occurred_at: input.occurredAt,
    p_content: input.content,
    p_metadata: input.metadata,
  });

  if (error) {
    throw error;
  }
  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error('process_inbound_whatsapp_event: resposta inesperada (esperada exatamente 1 linha)');
  }

  const row = data[0] as Record<string, unknown>;
  return {
    lead_id: row.lead_id,
    interaction_id: row.interaction_id,
    was_new_lead: row.was_new_lead,
    event_status: row.event_status,
  };
}

function classifyEngineResult(result: EngineResult): EventOutcomeCategory {
  if (result.status === 'PROCESSED' || result.status === 'IGNORED') {
    return 'handled';
  }
  if (result.status === 'FAILED') {
    return result.retryable ? 'retryable_failure' : 'non_retryable_failure';
  }
  if (result.status === 'EVENT_FINALIZATION_FAILED') {
    // O evento permanece não-terminal no DB (a finalização em si
    // falhou) — uma redelivery de Meta refaz o mesmo caminho com
    // segurança (idempotência do ingress + do próprio finalizer).
    return 'retryable_failure';
  }
  // EVENT_RECONCILIATION_FAILED — somente 'read_failed' é uma falha de
  // leitura genuinamente transitória; os demais reasons representam
  // uma anomalia estrutural que uma redelivery não resolveria.
  return result.reason === 'read_failed' ? 'retryable_failure' : 'non_retryable_failure';
}

// Matriz de duplicate (Fase 3.3.3.3, seção 16/17) — usa exclusivamente
// os nomes reais de status já definidos em
// integrationEventRepository.ts (IntegrationEventStatus). 'processed'/
// 'ignored'/'processing' NUNCA alcançam o Engine — são ACK direto.
// 'received'/'failed' seguem para o Engine (o guard hardened da RPC
// 017 protege 'failed' com resíduo).
const DUPLICATE_TERMINAL_STATUSES = new Set(['processed', 'ignored', 'processing']);

async function processSingleCanonicalEvent(
  event: CanonicalInboundEvent,
  client: WhatsappWebhookServiceClient,
  now: () => Date,
): Promise<EventOutcomeCategory> {
  let ingressResult: CreateOrGetIntegrationEventResult;
  try {
    ingressResult = await createOrGetIntegrationEvent(
      {
        provider: event.provider,
        externalEventId: event.externalEventId,
        externalMessageId: event.externalMessageId,
        externalAccountId: event.externalAccountId,
        eventType: 'message',
        payloadMinimized: buildPayloadMinimized(event),
        receivedAt: now(),
      },
      client,
    );
  } catch {
    // Precondição de contrato violada (nunca deveria ocorrer com um
    // CanonicalInboundEvent já validado pelo parser) — fail-closed
    // como falha retryable, nunca mascarado como sucesso.
    return 'retryable_failure';
  }

  if (ingressResult.status === 'REPOSITORY_ERROR') {
    return 'retryable_failure';
  }
  if (ingressResult.status === 'IDENTITY_CONFLICT') {
    // Nunca escolhe um lado, nunca chama o Engine. Anomalia estrutural
    // — uma redelivery não resolveria por si só.
    return 'non_retryable_failure';
  }

  // CREATED ou DUPLICATE — ambos carregam `.event` com o status REAL
  // persistido (CREATED é sempre 'received' por construção).
  const persistedEvent = ingressResult.event;

  if (DUPLICATE_TERMINAL_STATUSES.has(persistedEvent.status as string)) {
    // DUPLICATE processed/ignored/processing é sagrado (seção 17):
    // ACK direto, zero Engine, zero RPC, zero segunda interaction.
    return 'handled';
  }

  // status é 'received' (CREATED ou DUPLICATE received) ou 'failed'
  // (DUPLICATE failed, retry sob o contrato hardened atual).
  const engineDeps = buildEngineDeps(client);
  let engineResult: EngineResult;
  try {
    engineResult = await processInboundEvent(persistedEvent.id, event, engineDeps);
  } catch {
    return 'retryable_failure';
  }

  return classifyEngineResult(engineResult);
}

// ===========================================================================
// POST — PROCESSAMENTO DE STATUS OUTBOUND (Fase 3.5.2.3)
//
// Reutiliza o MESMO webhook, a MESMA validação de assinatura e o
// MESMO mecanismo de resolução de conta (findIntegrationAccountCandidates
// + resolveIntegrationAccount, já aprovado para inbound) — nunca um
// segundo endpoint público. integration_account_id NUNCA vem do
// payload diretamente (metadata.phone_number_id é só um identificador
// a RESOLVER, nunca confiado como chave primária) — exatamente o
// mesmo princípio já aplicado ao caminho inbound.
// ===========================================================================

const SUPPORTED_OUTBOUND_STATUS_VALUES = new Set(['sent', 'delivered', 'read', 'failed']);

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function processSingleStatusEvent(
  event: CanonicalOutboundStatusEvent,
  client: WhatsappWebhookServiceClient,
): Promise<EventOutcomeCategory> {
  // Precondições de contrato (o parser já deveria garantir isto — uma
  // violação aqui é um bug de composição, nunca um estado de negócio).
  if (
    !isNonBlankString(event.provider)
    || !isNonBlankString(event.externalAccountId)
    || !isNonBlankString(event.externalMessageId)
    || !isNonBlankString(event.occurredAt)
    || typeof event.status !== 'string'
    || !SUPPORTED_OUTBOUND_STATUS_VALUES.has(event.status)
  ) {
    return 'non_retryable_failure';
  }

  // 1) IDENTIFICAÇÃO DA CONTA pelo identificador CONFIÁVEL da Meta
  // (phone_number_id) — NUNCA um identificador fornecido pelo cliente
  // do CRM (item obrigatório do pedido). Mesmo resolver puro já usado
  // pelo caminho inbound (inboundEngine.ts) — nunca duplicado.
  let candidatesResult;
  try {
    candidatesResult = await findIntegrationAccountCandidates(
      { provider: event.provider, externalAccountId: event.externalAccountId },
      client as never,
    );
  } catch {
    return 'retryable_failure';
  }
  if (candidatesResult.status === 'REPOSITORY_ERROR') {
    return 'retryable_failure';
  }

  const resolution = resolveIntegrationAccount(event.provider, event.externalAccountId, candidatesResult.candidates);

  if (
    resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.NOT_FOUND
    || resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.INACTIVE
  ) {
    // Nenhuma conta nossa corresponde (ou está inativa) — nada a
    // aplicar, zero retry útil. Mesmo tratamento já dado pelo
    // caminho inbound para estes dois status de resolução.
    return 'handled';
  }
  if (
    resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.AMBIGUOUS
    || resolution.status === INTEGRATION_ACCOUNT_RESOLUTION_STATUS.INVALID_INPUT
  ) {
    // Anomalia estrutural — uma redelivery não resolveria por si só.
    return 'non_retryable_failure';
  }

  const { integrationAccountId } = resolution;

  // 2) APLICAÇÃO — a RPC (migration 023) revalida de forma
  // independente que a mensagem (quando já existe) pertence a esta
  // MESMA conta (ACCOUNT_MISMATCH caso contrário — nunca uma segunda
  // conta altera uma mensagem que não é dela), suporta reentregas e
  // eventos fora de ordem (idempotência própria), e faz staging
  // quando o wamid ainda é desconhecido (evento antecipado).
  let result;
  try {
    result = await applyWhatsappOutboundStatusEvent(
      {
        externalMessageId: event.externalMessageId,
        newStatus: event.status as OutboundStatusEventStatus,
        eventTimestamp: event.occurredAt,
        integrationAccountId,
        errorCode: isNonBlankString(event.errorCode) ? event.errorCode : null,
      },
      client,
    );
  } catch {
    return 'retryable_failure';
  }

  if (result.outcome === 'REPOSITORY_ERROR') {
    return 'retryable_failure';
  }
  if (result.outcome === 'ACCOUNT_MISMATCH') {
    // Anomalia (wamid pertence a outra conta) — nunca aplicado, nunca
    // retentável de forma útil (o payload não vai mudar numa
    // redelivery). ACK, não 500 — evita retry storm por um evento que
    // nunca vai se resolver sozinho.
    return 'non_retryable_failure';
  }
  // APPLIED / IGNORED_OUT_OF_ORDER_OR_DUPLICATE / PENDING_WAMID /
  // IGNORED_LATE_FAILURE_PROTECTED_DELIVERY (correção pós-auditoria,
  // Finding #1 — 'failed' tardio bloqueado por 'delivered'/'read' já
  // comprovados e auditado pela RPC) — todos são sucesso do PONTO DE
  // VISTA DO WEBHOOK (o evento foi corretamente processado,
  // corretamente estagiado, ou corretamente recusado e auditado;
  // nunca perdido).
  return 'handled';
}

async function handlePost(request: WebhookHttpRequest, deps: WhatsappWebhookHandlerDeps): Promise<WebhookHttpResponse> {
  const rawBody = request.rawBody;
  const bodyForSignature = typeof rawBody === 'string' ? rawBody : '';

  // ZERO client/DB/Engine antes deste ponto — verificado estaticamente
  // (seção 9) e por teste dedicado (nenhuma chamada a
  // deps.getServiceClient ocorre em nenhum ramo acima desta linha).
  let signatureResult: { valid: boolean };
  try {
    signatureResult = await verifyWhatsAppWebhookSignature(bodyForSignature, request.signatureHeader, deps.appSecret);
  } catch {
    // Falha inesperada da própria Web Crypto API nunca é mascarada
    // como "assinatura inválida" (contrato do helper) — mas também
    // nunca cria client/persiste nada; é uma falha interna genuína.
    return RESPONSE_INTERNAL_ERROR;
  }

  if (!signatureResult.valid) {
    return RESPONSE_UNAUTHORIZED;
  }

  // Só DEPOIS de assinatura válida: parse JSON do raw body exato.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyForSignature);
  } catch {
    return RESPONSE_BAD_REQUEST;
  }

  const parseResult = parseWhatsAppWebhookPayload(parsedBody, deps.now());

  if (parseResult.outcome === 'UNSUPPORTED_PAYLOAD') {
    return ACK_OK;
  }
  if (parseResult.messages.length === 0 && parseResult.statusEvents.length === 0) {
    // Nenhuma mensagem inbound válida E nenhum evento de status
    // outbound válido — ACK, zero persistência, zero client.
    return ACK_OK;
  }

  // A partir daqui existe ao menos 1 evento canônico (mensagem ou
  // status) a processar — client criado agora, exatamente 1 vez para
  // toda a requisição.
  let client: WhatsappWebhookServiceClient;
  try {
    client = deps.getServiceClient();
  } catch {
    return RESPONSE_INTERNAL_ERROR;
  }

  // Per-event isolation (seção 13/39): cada mensagem/status é sua
  // própria unidade — zero transação HTTP global, uma falha num
  // evento nunca desfaz outro. Ordem sequencial determinística (seção
  // 40) — V1 não paraleliza. Mensagens inbound processadas antes dos
  // status outbound (ordem arbitrária entre os dois tipos, mas
  // determinística) — nenhuma dependência real entre eles nesta fase.
  let anyRetryableFailure = false;
  for (const event of parseResult.messages) {
    let outcome: EventOutcomeCategory;
    try {
      outcome = await processSingleCanonicalEvent(event, client, deps.now);
    } catch {
      outcome = 'retryable_failure';
    }
    if (outcome === 'retryable_failure') {
      anyRetryableFailure = true;
    }
  }
  for (const statusEvent of parseResult.statusEvents) {
    let outcome: EventOutcomeCategory;
    try {
      outcome = await processSingleStatusEvent(statusEvent, client);
    } catch {
      outcome = 'retryable_failure';
    }
    if (outcome === 'retryable_failure') {
      anyRetryableFailure = true;
    }
  }

  // Política de ACK/retry (seção 23/24): 200 sempre que nenhuma
  // mensagem do batch precisa de retry — isso cobre handled e
  // non_retryable_failure (retry não ajudaria, evita retry storm).
  // 500 se QUALQUER mensagem teve falha genuinamente retryable — a
  // idempotência persistida (ingress + Engine + RPC hardened) torna
  // uma redelivery do batch inteiro segura: mensagens já
  // processadas/ignoradas voltam como DUPLICATE terminal (ACK
  // instantâneo), só a que falhou tenta de novo.
  return anyRetryableFailure ? RESPONSE_INTERNAL_ERROR : ACK_OK;
}

// ===========================================================================
// ENTRY POINT
// ===========================================================================

export async function handleWhatsappWebhookRequest(
  request: WebhookHttpRequest,
  deps: WhatsappWebhookHandlerDeps,
): Promise<WebhookHttpResponse> {
  const method = request.method;

  if (method === 'GET') {
    return handleGet(request, deps);
  }
  if (method === 'POST') {
    try {
      return await handlePost(request, deps);
    } catch {
      return RESPONSE_INTERNAL_ERROR;
    }
  }
  return RESPONSE_METHOD_NOT_ALLOWED;
}
