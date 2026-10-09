// Fase 3.5.2.4 — Interface de envio outbound WhatsApp (caixa de
// entrada). Lógica pura de orquestração da chamada à Edge Function
// `whatsapp-send` (supabase/functions/whatsapp-send/) — zero import de
// React aqui, testável em isolamento (mesmo padrão de
// whatsappMessages.js). O client Supabase é sempre injetado (nunca
// criado aqui), para permanecer testável sem rede real.
//
// CONTRATO DE SEGURANÇA (nunca relaxado por este arquivo):
//   - O payload enviado à Edge Function é SEMPRE { leadId, content,
//     clientToken } — nunca telefone, nunca integrationAccountId,
//     nunca userId (a Edge Function resolve tudo a partir do JWT da
//     sessão e da conversa inbound já existente).
//   - O clientToken é gerado UMA vez por intenção de envio explícita
//     do usuário (generateClientToken) e nunca regenerado
//     silenciosamente para "tentar de novo" o mesmo clique — ver
//     useWhatsAppInbox.js (o hook nunca chama invokeWhatsappSend duas
//     vezes com o mesmo token por decisão própria, e nunca gera um
//     token novo a partir de um resultado 'uncertain' sem uma nova
//     ação explícita do usuário).
//   - 'ACCEPTED' (a Meta aceitou o envio) NUNCA é mapeado para
//     'delivered' — só para 'sent'. Entregue/lido só chegam depois,
//     via Supabase Realtime, a partir da própria linha autoritativa de
//     whatsapp_messages (populada pelo webhook de status, fora deste
//     arquivo).

export function generateClientToken() {
  return crypto.randomUUID();
}

// Mesma janela de atendimento de 24h da Edge Function
// (whatsappSendContextRepository.ts, OUTBOUND_MESSAGING_WINDOW_MS) —
// duplicada aqui deliberadamente (módulo Deno-only não é importável
// pelo bundle do browser). Usada SÓ para um aviso client-side
// antecipado; a validação real e definitiva continua sendo a Edge
// Function (resposta WINDOW_CLOSED), nunca substituída por esta
// heurística.
export const OUTBOUND_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

// Decide se o composer deve permitir tentar enviar, a partir das
// mensagens já carregadas da conversa (heurística client-side,
// baseada na mensagem inbound mais recente visível). Nunca a
// autoridade final — só evita uma chamada HTTP claramente fadada ao
// WINDOW_CLOSED/NO_INBOUND_CONVERSATION que a própria Edge Function já
// rejeitaria. threadMessages pode estar em qualquer ordem.
export function computeSendGateStatus(threadMessages, now = new Date()) {
  const lastInbound = threadMessages
    .filter((m) => m.direction === 'inbound')
    .reduce((latest, m) => {
      if (!latest) return m;
      return new Date(m.occurredAt).getTime() > new Date(latest.occurredAt).getTime() ? m : latest;
    }, null);

  if (!lastInbound) {
    return { canSend: false, reason: 'no_identity', windowExpiresAt: null };
  }

  const windowExpiresAt = new Date(new Date(lastInbound.occurredAt).getTime() + OUTBOUND_MESSAGING_WINDOW_MS);
  if (now.getTime() > windowExpiresAt.getTime()) {
    return { canSend: false, reason: 'window_closed', windowExpiresAt };
  }
  return { canSend: true, reason: null, windowExpiresAt };
}

// Mensagem otimista exibida imediatamente ao clicar "Enviar", antes de
// qualquer resposta de rede. id = `pending-${clientToken}` (nunca
// colide com um uuid real de whatsapp_messages.id) — permite remover a
// mensagem otimista por id quando necessário, e mergeOptimisticWithAuthoritative
// (abaixo) a reconcilia pelo clientToken quando a linha autoritativa
// (Realtime) chega.
export function buildOptimisticMessage({ leadId, userId, content, clientToken, now = new Date() }) {
  const nowIso = now.toISOString();
  return {
    id: `pending-${clientToken}`,
    userId,
    leadId,
    integrationAccountId: null,
    integrationEventId: null,
    leadInteractionId: null,
    provider: 'whatsapp',
    externalMessageId: null,
    direction: 'outbound',
    messageType: 'text',
    content,
    status: 'sending',
    errorCode: null,
    occurredAt: nowIso,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    createdAt: nowIso,
    clientToken,
    pending: true,
  };
}

// Funde as mensagens pendentes (otimistas, locais) com as mensagens
// autoritativas (vindas do banco/Realtime) — nunca duplica: qualquer
// pendente cujo clientToken já apareça numa mensagem autoritativa é
// descartado (a linha real já chegou, assume o lugar da otimista sem
// nenhum "flash" de desaparecimento, pois a troca só ocorre quando a
// substituta já está presente). Mensagens autoritativas nunca são
// alteradas por este merge.
export function mergeOptimisticWithAuthoritative(authoritative, pending) {
  if (!pending || pending.length === 0) return authoritative;
  const authoritativeTokens = new Set(
    authoritative.map((m) => m.clientToken).filter((t) => t != null),
  );
  const stillPending = pending.filter((p) => !authoritativeTokens.has(p.clientToken));
  return [...authoritative, ...stillPending];
}

// Status de bubble exibido para cada outcome que JÁ TEM messageId (ou
// seja, uma linha real existe no banco) — nunca 'delivered'/'read'
// aqui (só a Edge Function confirma aceite da Meta, nunca entrega
// real). `null` sinaliza "nenhuma linha foi criada — remova a
// mensagem otimista e mostre erro", nunca um status de bubble.
export function statusForOutcomeKind(kind) {
  switch (kind) {
    case 'accepted': return 'sent';
    case 'uncertain':
    case 'network_uncertain': return 'uncertain';
    case 'in_progress': return 'sending';
    case 'already_failed':
    case 'rejected': return 'failed';
    default: return null;
  }
}

// Mensagens de erro exibidas no composer quando NENHUMA linha foi
// criada (messageId ausente) — a mensagem otimista é removida e o
// usuário vê só este aviso, nunca uma bolha "fantasma".
export const SEND_ERROR_MESSAGES = {
  window_closed: 'A janela de 24 horas para responder esta conversa está encerrada. Aguarde uma nova mensagem do contato.',
  identity_unavailable: 'Não é possível enviar: esta conversa ainda não tem uma identidade de WhatsApp validada.',
  no_identity: 'Não é possível enviar: esta conversa ainda não recebeu nenhuma mensagem.',
  account_inactive: 'A conta do WhatsApp conectada está inativa.',
  rate_limited: 'Muitos envios em um curto período. Aguarde um instante e tente novamente.',
  lead_unavailable: 'Este lead não está mais disponível.',
  auth_error: 'Sessão expirada. Faça login novamente.',
  invalid_request: 'Não foi possível enviar esta mensagem.',
  internal_error: 'Erro ao enviar a mensagem. Tente novamente em alguns instantes.',
  // Abaixo: kinds que JÁ TÊM uma linha real no banco (statusForOutcomeKind
  // retorna um status de bubble) — exibidos como aviso complementar à
  // própria bolha, nunca como "a mensagem não foi enviada".
  uncertain: 'Resultado desconhecido: não foi possível confirmar se a mensagem chegou ao WhatsApp. Não reenviada automaticamente.',
  network_uncertain: 'Resultado desconhecido: falha de conexão ao confirmar o envio. Não reenviada automaticamente — verifique antes de tentar de novo.',
  rejected: 'O WhatsApp rejeitou esta mensagem.',
  already_failed: 'Esta tentativa de envio já havia falhado definitivamente antes.',
  in_progress: 'Já existe um envio em andamento para esta conversa.',
  identity_conflict: 'A identidade do destinatário mudou durante o envio. Verifique a conversa.',
};

// Classifica o corpo JSON (ou a ausência de corpo, por falha de
// transporte) retornado pela chamada à Edge Function numa categoria de
// UI estável. Nunca interpreta 'ACCEPTED' como entrega — ver
// statusForOutcomeKind.
export function classifySendOutcome({ ok, body }) {
  if (!ok || !body || typeof body !== 'object') {
    // Falha de transporte (rede, timeout, DNS) — nunca sabemos se a
    // requisição chegou ao servidor. Nunca presumido como falha
    // definitiva nem como sucesso: mesma semântica do outcome
    // 'UNCERTAIN' da própria Edge Function.
    return { kind: 'network_uncertain', messageId: null };
  }
  const outcome = body.outcome;
  switch (outcome) {
    case 'ACCEPTED':
    case 'DUPLICATE_ALREADY_SENT':
      return { kind: 'accepted', messageId: body.messageId ?? null };
    case 'UNCERTAIN':
    case 'CONFIRMATION_CONFLICT':
    case 'CONFIRMATION_UNCERTAIN_RETRY_EXHAUSTED':
      return { kind: 'uncertain', messageId: body.messageId ?? null };
    case 'IN_PROGRESS':
      return { kind: 'in_progress', messageId: body.messageId ?? null };
    case 'ALREADY_FAILED':
      return { kind: 'already_failed', messageId: body.messageId ?? null };
    case 'REJECTED':
      return { kind: 'rejected', messageId: body.messageId ?? null, errorCode: body.errorCode ?? null };
    case 'IDENTITY_CONFLICT':
      return { kind: 'identity_conflict', messageId: body.messageId ?? null };
    case 'WINDOW_CLOSED':
      return { kind: 'window_closed', messageId: null, windowExpiresAt: body.windowExpiresAt ?? null };
    case 'NO_INBOUND_CONVERSATION':
    case 'IDENTITY_UNAVAILABLE':
    case 'IDENTITY_AMBIGUOUS':
    case 'IDENTITY_MISMATCH':
      return { kind: 'identity_unavailable', messageId: null };
    case 'ACCOUNT_INACTIVE':
      return { kind: 'account_inactive', messageId: null };
    case 'RATE_LIMITED':
      return { kind: 'rate_limited', messageId: null };
    case 'LEAD_NOT_FOUND':
    case 'LEAD_DELETED':
      return { kind: 'lead_unavailable', messageId: null };
    case 'UNAUTHENTICATED':
      return { kind: 'auth_error', messageId: null };
    case 'INVALID_REQUEST':
      return { kind: 'invalid_request', messageId: null };
    default:
      return { kind: 'internal_error', messageId: null };
  }
}

// Extrai {status, body} de uma resposta não-2xx do supabase-js
// (FunctionsHttpError expõe `.context` como a Response original).
// Nunca lança — falha ao parsear é tratada como transporte
// desconhecido (network_uncertain), nunca como corpo vazio = sucesso.
async function tryParseHttpErrorBody(error) {
  try {
    const response = error && error.context;
    if (!response || typeof response.json !== 'function') return null;
    const body = await response.json();
    return { status: response.status, body };
  } catch {
    return null;
  }
}

// Chamada HTTP real à Edge Function whatsapp-send — o client
// supabase-js já injeta automaticamente o Authorization: Bearer <JWT
// da sessão autenticada> (nunca montado manualmente aqui, nunca a
// service_role, nunca a anon key sozinha). Retorna sempre
// {ok, body} — nunca lança; chamadores usam classifySendOutcome no
// resultado.
export async function invokeWhatsappSend(supabaseClient, { leadId, content, clientToken }) {
  const { data, error } = await supabaseClient.functions.invoke('whatsapp-send', {
    body: { leadId, content, clientToken },
  });

  if (!error) {
    return { ok: true, body: data };
  }

  if (error.name === 'FunctionsHttpError') {
    const parsed = await tryParseHttpErrorBody(error);
    if (parsed) {
      return { ok: true, body: parsed.body };
    }
  }

  // FunctionsFetchError (rede) ou FunctionsRelayError, ou corpo de
  // erro HTTP ilegível — resultado de transporte desconhecido.
  return { ok: false, body: null };
}
