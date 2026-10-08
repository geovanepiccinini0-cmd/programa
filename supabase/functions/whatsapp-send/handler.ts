// Fase 3.5.2.2 — WhatsApp Send Edge Function — Composition Root (handler
// puro, testável).
//
// Responsabilidade ÚNICA: orquestrar os módulos já aprovados
// (whatsappSendAuth.ts, whatsappSendContextRepository.ts,
// whatsappOutboundRateLimiter.ts, whatsappOutboundRepository.ts —
// RPCs 020/021 — e whatsappGraphSendAdapter.ts) numa única requisição
// HTTP de envio — NENHUMA regra de negócio nova nasce aqui. Este
// arquivo nunca importa Deno.serve/Deno.env/npm: specifiers — só os
// módulos puros/testáveis já existentes mais um contrato estrutural
// mínimo do client Supabase (mesmo padrão de whatsapp-webhook/handler.ts).
//
// CONTRATO DE SEGURANÇA (nunca relaxado por este arquivo):
//   - user_id SEMPRE vem de verifyAuthenticatedIdentity (auth.getUser,
//     verificação real no servidor) — NUNCA do body.
//   - integration_account_id / phone_number_id / destinatário NUNCA
//     vêm do body — sempre derivados por resolveOutboundSendContext a
//     partir da conversa inbound já existente.
//   - access token NUNCA é lido por este arquivo — chega já resolvido
//     via deps.getMetaCredentials() (lido de secrets pelo adapter
//     runtime, nunca por aqui) e nunca é incluído em nenhuma resposta
//     HTTP nem logado.
//   - ZERO chamada a deps.sendGraphMessage antes de
//     startWhatsappOutboundAttemptCall retornar outcome='STARTED' —
//     essa é a ÚNICA autorização real para chamar a Meta (ver
//     migration 021, seção F).
//   - ZERO log de token/telefone/conteúdo em qualquer lugar deste
//     arquivo (não há nenhuma chamada a console.* aqui).
//
// Vive em supabase/functions/whatsapp-send/ — fora de src/, nunca
// alcançado pelo build do Vite/bundle do browser. 100% testável em
// Vitest/Node: zero Deno real, zero Supabase real, zero Meta real,
// zero rede real necessários para testar este arquivo.

import { verifyAuthenticatedIdentity, type AuthClientLike } from '../_shared/whatsappSendAuth.ts';
import {
  resolveOutboundSendContext,
  type SendContextServiceClient,
  type ResolvedOutboundSendContext,
} from '../_shared/whatsappSendContextRepository.ts';
import { checkOutboundRateLimit, type RateLimitServiceClient } from '../_shared/whatsappOutboundRateLimiter.ts';
import {
  reserveWhatsappOutboundAttempt,
  startWhatsappOutboundAttemptCall,
  confirmWhatsappOutboundSent,
  markWhatsappOutboundAttemptResult,
  type WhatsappOutboundServiceClient,
} from '../_shared/whatsappOutboundRepository.ts';
import type { GraphSendInput, GraphSendResult } from '../_shared/whatsappGraphSendAdapter.ts';

// ===========================================================================
// CONTRATO HTTP MÍNIMO — nunca o Request/Response real do Deno.
// ===========================================================================

export interface SendHttpRequest {
  method: unknown;
  authorizationHeader: unknown;
  rawBody: unknown;
}

export interface SendHttpResponse {
  status: number;
  body: string;
  contentType: 'application/json';
}

// Contrato estrutural mínimo do client injetado — usado por TODOS os
// módulos desta composição (auth, resolução de contexto, rate limit,
// RPCs de outbound). Um único client, uma única conexão por
// requisição — nunca um client por módulo.
export type WhatsappSendServiceClient = AuthClientLike & SendContextServiceClient & RateLimitServiceClient & WhatsappOutboundServiceClient;

export interface MetaCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export interface WhatsappSendHandlerDeps {
  // Factory lazy do client service-role — chamada no máximo 1 vez por
  // requisição, nunca memorizada fora do escopo de uma chamada.
  getServiceClient: () => WhatsappSendServiceClient;
  // Lê o access token a partir de secrets (nunca por este arquivo) —
  // `null` significa "ausente ou configuração inválida" (item de
  // teste obrigatório), tratado como falha de configuração, NUNCA uma
  // tentativa de chamada com credenciais vazias.
  getMetaCredentials: () => MetaCredentials | null;
  sendGraphMessage: (input: GraphSendInput) => Promise<GraphSendResult>;
  now: () => Date;
}

function respond(status: number, outcome: string, extra: Record<string, unknown> = {}): SendHttpResponse {
  return {
    status,
    body: JSON.stringify({ outcome, ...extra }),
    contentType: 'application/json',
  };
}

const RESPONSE_METHOD_NOT_ALLOWED = respond(405, 'METHOD_NOT_ALLOWED');
const RESPONSE_UNAUTHENTICATED = respond(401, 'UNAUTHENTICATED');
const RESPONSE_INVALID_REQUEST = respond(400, 'INVALID_REQUEST');
const RESPONSE_CONFIG_ERROR = respond(500, 'CONFIG_ERROR');
const RESPONSE_INTERNAL_ERROR = respond(500, 'INTERNAL_ERROR');
const RESPONSE_RATE_LIMITED = respond(429, 'RATE_LIMITED');
const RESPONSE_LEAD_NOT_FOUND = respond(404, 'LEAD_NOT_FOUND');
const RESPONSE_LEAD_DELETED = respond(410, 'LEAD_DELETED');
const RESPONSE_NO_INBOUND_CONVERSATION = respond(422, 'NO_INBOUND_CONVERSATION');
const RESPONSE_ACCOUNT_INACTIVE = respond(422, 'ACCOUNT_INACTIVE');

const MAX_CONTENT_LENGTH = 4096;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ===========================================================================
// VALIDAÇÃO DE ENTRADA — item 7 do pedido (tamanho/formato do
// conteúdo) + forma básica de leadId/clientToken. Nunca aceita
// user_id/integration_account_id/phone_number_id/destinatário daqui
// (item 2) — esses campos nem fazem parte do contrato de entrada.
// ===========================================================================

interface ParsedSendRequestBody {
  leadId: string;
  content: string;
  clientToken: string;
}

function parseRequestBody(rawBody: unknown): ParsedSendRequestBody | null {
  if (typeof rawBody !== 'string' || rawBody.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') return null;
  const { leadId, content, clientToken } = parsed as Record<string, unknown>;

  if (typeof leadId !== 'string' || !UUID_SHAPE.test(leadId)) return null;
  if (typeof clientToken !== 'string' || !UUID_SHAPE.test(clientToken)) return null;
  if (typeof content !== 'string') return null;

  const trimmed = content.trim();
  if (trimmed.length === 0 || content.length > MAX_CONTENT_LENGTH) return null;

  return { leadId, content, clientToken };
}

// ===========================================================================
// MAPEAMENTO DE OUTCOMES DAS RPCs PARA A RESPOSTA HTTP — nunca
// confunde "aceite pela Meta" com "entrega ao cliente" (todas as
// mensagens de ACCEPTED dizem explicitamente "aceito pela Meta").
// ===========================================================================

function respondForBlockedReserveStatus(outcome: string, messageId: string, currentStatus: string): SendHttpResponse {
  if (outcome === 'IDENTITY_CONFLICT') {
    return respond(409, 'IDENTITY_CONFLICT', { messageId });
  }
  if (outcome === 'ALREADY_IN_FLIGHT' || outcome === 'ALREADY_CALLING') {
    return respond(409, 'IN_PROGRESS', { messageId });
  }
  if (outcome === 'UNCERTAIN_BLOCKED') {
    return respond(409, 'UNCERTAIN', {
      messageId,
      note: 'Uma tentativa anterior com este clientToken ficou com resultado desconhecido. Nunca reenviado automaticamente — use um novo clientToken para uma nova intenção explícita.',
    });
  }
  if (outcome === 'ALREADY_RESOLVED') {
    if (currentStatus === 'sent' || currentStatus === 'delivered' || currentStatus === 'read') {
      return respond(200, 'DUPLICATE_ALREADY_SENT', {
        messageId,
        note: 'Esta intencao (clientToken) ja foi aceita pela Meta anteriormente. Nenhuma nova chamada foi feita.',
      });
    }
    // currentStatus === 'failed'
    return respond(409, 'ALREADY_FAILED', {
      messageId,
      note: 'Esta intencao (clientToken) ja terminou em falha definitiva. Nunca reenviado automaticamente — use um novo clientToken.',
    });
  }
  return RESPONSE_INTERNAL_ERROR;
}

// Mapeia o currentStatus devolvido por start_whatsapp_outbound_attempt_call
// quando outro chamador já venceu a corrida (outcome !== 'STARTED').
// 'queued' nunca ocorre aqui por construção (o CAS só devolve
// ALREADY_STARTED_OR_RESOLVED quando o status já deixou de ser
// 'queued').
function respondForRaceLostAtStartCall(messageId: string, currentStatus: string): SendHttpResponse {
  if (currentStatus === 'sending') {
    return respond(409, 'IN_PROGRESS', { messageId });
  }
  if (currentStatus === 'uncertain') {
    return respond(409, 'UNCERTAIN', {
      messageId,
      note: 'Outra chamada ja declarou esta tentativa como resultado desconhecido. Nunca reenviado automaticamente — use um novo clientToken para uma nova intencao explicita.',
    });
  }
  if (currentStatus === 'sent' || currentStatus === 'delivered' || currentStatus === 'read') {
    return respond(200, 'DUPLICATE_ALREADY_SENT', {
      messageId,
      note: 'Esta intencao (clientToken) ja foi aceita pela Meta por outra chamada. Nenhuma nova chamada foi feita.',
    });
  }
  if (currentStatus === 'failed') {
    return respond(409, 'ALREADY_FAILED', {
      messageId,
      note: 'Esta intencao (clientToken) ja terminou em falha definitiva por outra chamada. Nunca reenviado automaticamente — use um novo clientToken.',
    });
  }
  return RESPONSE_INTERNAL_ERROR;
}

async function sendAndReconcile(
  context: ResolvedOutboundSendContext,
  content: string,
  messageId: string,
  credentials: MetaCredentials,
  client: WhatsappSendServiceClient,
  deps: WhatsappSendHandlerDeps,
): Promise<SendHttpResponse> {
  const graphResult = await deps.sendGraphMessage({
    accessToken: credentials.accessToken,
    phoneNumberId: context.phoneNumberId,
    toE164: context.recipientPhoneNormalized,
    body: content,
  });

  if (graphResult.outcome === 'ACCEPTED') {
    // A Meta JÁ aceitou (prova inequívoca: wamid em mãos). A partir
    // daqui, NUNCA podemos "desistir" silenciosamente — confirm é
    // idempotente para o MESMO wamid, então é seguro tentar algumas
    // vezes se a própria chamada à RPC falhar por motivo de
    // transporte (nunca por um conflito de SQL, que é um resultado
    // legítimo, não um erro de transporte).
    const externalMessageId = graphResult.externalMessageId;
    let lastRepositoryError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const confirmResult = await confirmWhatsappOutboundSent({ messageId, externalMessageId }, client);

      if (confirmResult.outcome === 'CONFIRMED' || confirmResult.outcome === 'ALREADY_CONFIRMED') {
        return respond(200, 'ACCEPTED', {
          messageId,
          externalMessageId,
          note: 'Mensagem aceita pela Meta. Isto NAO confirma entrega ao destinatario — apenas o aceite do envio.',
        });
      }
      if (confirmResult.outcome === 'CONFLICT_DIFFERENT_WAMID' || confirmResult.outcome === 'CONFLICT_UNEXPECTED_STATE') {
        // Conflito real (ja registrado em auditoria pela propria RPC)
        // — nunca reportado como sucesso simples nem como falha
        // simples. Precisa de investigacao manual.
        return respond(500, 'CONFIRMATION_CONFLICT', {
          messageId,
          note: 'A Meta aceitou a mensagem mas a confirmacao transacional entrou em conflito com um estado existente. Registrado para investigacao manual — nenhuma lead_interaction duplicada foi criada.',
        });
      }
      // REPOSITORY_ERROR — falha de TRANSPORTE na propria chamada da
      // RPC (nunca um conflito de SQL). Retry e seguro porque
      // confirm_whatsapp_outbound_sent e idempotente para o MESMO
      // wamid.
      lastRepositoryError = confirmResult.error;
    }

    // Esgotadas as tentativas: a Meta aceitou (temos o wamid), mas
    // nao conseguimos persistir a confirmacao. NUNCA inventamos
    // sucesso nem falha — devolvemos o wamid ao proprio chamador
    // autenticado (dono legitimo desta requisicao, nunca um log) para
    // que a reconciliacao manual tenha a informacao necessaria.
    return respond(500, 'CONFIRMATION_UNCERTAIN_RETRY_EXHAUSTED', {
      messageId,
      externalMessageId,
      note: 'A Meta aceitou a mensagem mas nao foi possivel confirmar no banco apos tentativas. Reconciliacao manual necessaria usando o externalMessageId informado.',
      repositoryErrorPresent: lastRepositoryError !== null,
    });
  }

  if (graphResult.outcome === 'REJECTED_DEFINITIVE') {
    await markWhatsappOutboundAttemptResult(
      { messageId, outcome: 'rejected_by_provider', errorCode: graphResult.errorCode, httpStatus: graphResult.httpStatus },
      client,
    );
    return respond(422, 'REJECTED', { messageId, errorCode: graphResult.errorCode });
  }

  // UNCERTAIN — nunca presumido como falha nem como sucesso.
  await markWhatsappOutboundAttemptResult(
    { messageId, outcome: 'uncertain', errorCode: graphResult.reason, httpStatus: graphResult.httpStatus },
    client,
  );
  return respond(200, 'UNCERTAIN', {
    messageId,
    note: 'Resultado desconhecido apos iniciar a chamada a Meta (timeout, erro de rede, 5xx ou resposta ambigua). Nao presuma sucesso nem falha. Esta intencao (clientToken) esta bloqueada para novas tentativas — uma nova intencao explicita exige um clientToken novo.',
  });
}

// ===========================================================================
// FLUXO PRINCIPAL
// ===========================================================================

async function handlePost(request: SendHttpRequest, deps: WhatsappSendHandlerDeps): Promise<SendHttpResponse> {
  // 1) Identidade — SEMPRE antes de qualquer outra coisa, SEMPRE via
  // auth.getUser (verificacao real), NUNCA decodificacao local.
  let client: WhatsappSendServiceClient;
  try {
    client = deps.getServiceClient();
  } catch {
    return RESPONSE_INTERNAL_ERROR;
  }

  const identityResult = await verifyAuthenticatedIdentity(request.authorizationHeader, client);
  if (identityResult.status === 'UNAUTHENTICATED') {
    return RESPONSE_UNAUTHENTICATED;
  }
  if (identityResult.status === 'REPOSITORY_ERROR') {
    return RESPONSE_INTERNAL_ERROR;
  }
  const userId = identityResult.identity.userId;

  // 2) Validacao de entrada — leadId/clientToken/content. user_id
  // NUNCA vem do body (ja resolvido acima); integration_account_id/
  // phone_number_id/destinatario NUNCA fazem parte do contrato de
  // entrada (item 2) — so sao resolvidos no passo 4, a partir do
  // banco.
  const parsedBody = parseRequestBody(request.rawBody);
  if (parsedBody === null) {
    return RESPONSE_INVALID_REQUEST;
  }
  const { leadId, content, clientToken } = parsedBody;

  // 3) Credenciais da Meta — verificadas ANTES de qualquer reserva,
  // para que uma configuracao ausente/invalida NUNCA deixe uma
  // mensagem presa em 'queued'/'sending' por culpa nossa.
  let credentials: MetaCredentials | null;
  try {
    credentials = deps.getMetaCredentials();
  } catch {
    return RESPONSE_CONFIG_ERROR;
  }
  if (
    credentials === null
    || typeof credentials !== 'object'
    || typeof credentials.accessToken !== 'string'
    || credentials.accessToken.trim().length === 0
  ) {
    return RESPONSE_CONFIG_ERROR;
  }

  // 4) Resolucao de contexto — lead/conta/janela de 24h, SEMPRE a
  // partir da conversa inbound existente, NUNCA do body.
  const contextResult = await resolveOutboundSendContext({ userId, leadId }, client, deps.now);
  switch (contextResult.status) {
    case 'LEAD_NOT_FOUND':
    case 'LEAD_FORBIDDEN':
      return RESPONSE_LEAD_NOT_FOUND;
    case 'LEAD_DELETED':
      return RESPONSE_LEAD_DELETED;
    case 'NO_INBOUND_CONVERSATION':
      return RESPONSE_NO_INBOUND_CONVERSATION;
    case 'INTEGRATION_ACCOUNT_INACTIVE':
      return RESPONSE_ACCOUNT_INACTIVE;
    case 'WINDOW_CLOSED':
      return respond(422, 'WINDOW_CLOSED', { windowExpiresAt: contextResult.windowExpiresAt.toISOString() });
    case 'REPOSITORY_ERROR':
      return RESPONSE_INTERNAL_ERROR;
    default:
      break;
  }
  const context = contextResult.context;

  // 5) Rate limiting (item 8) — proteção de abuso best-effort, NUNCA
  // a fronteira de segurança contra duplicidade (essa é o claim/CAS
  // dos passos 6/7).
  const rateResult = await checkOutboundRateLimit({ userId }, client, deps.now);
  if (rateResult.status === 'RATE_LIMITED') {
    return RESPONSE_RATE_LIMITED;
  }
  if (rateResult.status === 'REPOSITORY_ERROR') {
    return RESPONSE_INTERNAL_ERROR;
  }

  // 6) Registrar a intenção + reservar a tentativa (RPC
  // reserve_whatsapp_outbound_attempt, migrations 020/021).
  const reserveResult = await reserveWhatsappOutboundAttempt(
    { clientToken, userId, leadId, integrationAccountId: context.integrationAccountId, content },
    client,
  );
  if (reserveResult.outcome === 'REPOSITORY_ERROR') {
    return RESPONSE_INTERNAL_ERROR;
  }
  if (reserveResult.outcome !== 'CLAIMED' && reserveResult.outcome !== 'CLAIMED_WITH_PRIOR_UNCERTAIN') {
    return respondForBlockedReserveStatus(reserveResult.outcome, reserveResult.messageId, reserveResult.currentStatus);
  }
  const messageId = reserveResult.messageId;
  const hadPriorUncertain = reserveResult.outcome === 'CLAIMED_WITH_PRIOR_UNCERTAIN';

  // 7) Transição atômica para "sending" — ÚNICA autorização real para
  // chamar a Meta (migration 021, seção F). Se outro chamador já
  // venceu essa corrida (ex. duplo clique, start_call concorrente),
  // NUNCA chamamos a Meta.
  const startResult = await startWhatsappOutboundAttemptCall({ messageId }, client);
  if (startResult.outcome === 'REPOSITORY_ERROR') {
    return RESPONSE_INTERNAL_ERROR;
  }
  if (startResult.outcome !== 'STARTED') {
    return respondForRaceLostAtStartCall(messageId, startResult.currentStatus);
  }

  // 8/9) SOMENTE agora a chamada HTTP real à Meta, seguida da
  // confirmação/declaração de resultado transacional correspondente.
  const response = await sendAndReconcile(context, content, messageId, credentials, client, deps);

  if (hadPriorUncertain) {
    // Aviso de possivel duplicidade (sempre anexado, qualquer que
    // seja o resultado desta tentativa) — o lead tinha uma mensagem
    // anterior com resultado desconhecido pendente; a nova intencao
    // explicita (novo clientToken) foi permitida normalmente, mas o
    // chamador precisa saber que pode haver duas mensagens reais no
    // WhatsApp do destinatario.
    const parsedResponseBody = JSON.parse(response.body) as Record<string, unknown>;
    return {
      ...response,
      body: JSON.stringify({ ...parsedResponseBody, priorUncertainWarning: true }),
    };
  }
  return response;
}

export async function handleWhatsappSendRequest(
  request: SendHttpRequest,
  deps: WhatsappSendHandlerDeps,
): Promise<SendHttpResponse> {
  if (request.method !== 'POST') {
    return RESPONSE_METHOD_NOT_ALLOWED;
  }
  try {
    return await handlePost(request, deps);
  } catch {
    return RESPONSE_INTERNAL_ERROR;
  }
}
