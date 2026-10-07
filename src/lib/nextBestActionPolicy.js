import { FOLLOW_UP_REASON, FOLLOW_UP_STATUS } from './followUpEngine.js';

// Fase 2E.4.2 — policy comercial pura ("O QUE recomendar"), construída
// sobre duas fontes já existentes e intocadas nesta fase:
//   - followUpEvaluation (followUpEngine.js) — única fonte de verdade
//     de QUANDO agir (status/reason/attemptCount/anchorOccurredAt);
//   - history (buildCommercialInteractionHistory, 2E.4.1) — "memória
//     comercial estruturada", só histórico bruto, zero decisão.
//
// Esta função NÃO substitui evaluateNextBestAction (nextBestAction.js,
// 2E.1) — convivem em paralelo nesta fase, sem nenhuma integração.
// NÃO é chamada por nenhum componente de produção ainda.
//
// Zero Supabase/fetch/window/document/storage/React/hooks/Date.now/
// Math.random/writes. Determinística: mesma entrada, mesma saída.
// Nunca lança para entrada malformada — sempre prefere `null`.
//
// Único import de produção: os enums já públicos de followUpEngine.js
// (leitura, não alteração — followUpEngine.js permanece com zero diff
// nesta fase). Não importa buildCommercialInteractionHistory nem
// nextBestAction.js/nextBestActionPresentation.js — `history` é tratado
// de forma duck-typed (o contrato da 2E.4.1), sem acoplamento de import.

// --- Mapas de canal ------------------------------------------------------

// Mapeamento canônico do nextActionType EXPLÍCITO — os 4 tipos que o
// humano pode escolher no LeadModal e que representam uma ação
// executável de verdade (ver investigação 2E.4.0, seção 20). 'follow_up'
// e 'other' ficam de fora de propósito (seção 7 — supressão, não mapeamento).
const EXPLICIT_CHANNEL = { call: 'phone', whatsapp: 'whatsapp', meeting: 'in_person', proposal: 'manual' };

// Intent base por reason — mesmo papel do REASON_INTENT de
// nextBestAction.js (2E.1), mas com os 2 novos nomes aprovados nesta
// fase (continue_conversation substitui o antigo 'retry' genérico do
// NBA V1 para no_new_attempt_since_engagement — ver seção 30, diferença
// deliberada nº4). Usado tanto para validar "reasonCode é conhecido?"
// quanto para o `intent` da resposta EXPLÍCITA (que é sempre o intent
// base do reason, nunca 'switch_channel' — alternância é uma decisão de
// regra automática, não algo que a intenção humana "faz").
const REASON_INTENT = {
  [FOLLOW_UP_REASON.NEVER_CONTACTED]: 'first_contact',
  [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT]: 'retry',
  [FOLLOW_UP_REASON.CADENCE_EXHAUSTED]: 'retry',
  [FOLLOW_UP_REASON.REACTIVATION_DUE]: 'reactivate',
  [FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT]: 'continue_conversation',
  [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL]: 'proposal_follow_up',
};

// Canal -> type automático. Só phone/whatsapp entram aqui de propósito
// (seção 4/24): a policy automática NUNCA inventa meeting/proposal —
// esses só existem como resposta EXPLÍCITA (seção 18).
const CHANNEL_TO_AUTO_TYPE = { phone: 'call', whatsapp: 'whatsapp' };

function isKnownReason(reasonCode) {
  return Boolean(reasonCode) && Object.prototype.hasOwnProperty.call(REASON_INTENT, reasonCode);
}

// Única porta de entrada para "este canal pode virar recomendação
// AUTOMÁTICA?" (seção 24) — somente phone/whatsapp. in_person/manual/
// desconhecido/ausente nunca passam, nunca são "corrigidos" para outra
// coisa. Usada por TODOS os reasons que dependem de history, garantindo
// a mesma regra em todos eles (nunca duplicada com variações sutis).
function validAutoChannel(channel) {
  return channel === 'phone' || channel === 'whatsapp' ? channel : null;
}

// Leitura defensiva de um campo do history: history ausente/null/não-
// objeto nunca lança, só devolve null (seção 23 — "conservadora").
function historyChannel(history, key) {
  if (!history || typeof history !== 'object') return null;
  return validAutoChannel(history[key]);
}

function timeOrNull(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function alternate(channel) {
  return channel === 'phone' ? 'whatsapp' : 'phone';
}

function buildAutoResult(channel, intent, reasonCode) {
  return { type: CHANNEL_TO_AUTO_TYPE[channel], channel, intent, reasonCode, confidence: 'rule' };
}

// Fase 2E.4.2 — API principal. `history` é o output de
// buildCommercialInteractionHistory (2E.4.1) — esta função nunca o
// constrói nem recebe `interactions` brutas (seção 3). Não recalcula
// elegibilidade: `followUpEvaluation.status`/`.reason`/`.attemptCount`/
// `.anchorOccurredAt` são sempre a fonte de verdade para QUANDO agir e
// "em qual rodada da cadência estamos" — `history.attemptCount` (total
// bruto, sem semântica temporal) NUNCA é usado para essa decisão (seção
// 11), só `history.lastAttempt`/`.previousAttempt`/`.lastEngagement`/
// `.lastAttemptChannel`/`.previousAttemptChannel`/`.lastEngagementChannel`
// entram aqui, para decidir O QUE recomendar.
export function evaluateNextBestActionPolicy({ lead, followUpEvaluation, history }) {
  // --- Gate 1: evaluation válida, não-blocked, status conhecido -------
  if (!followUpEvaluation || typeof followUpEvaluation !== 'object') return null;
  if (followUpEvaluation.status === FOLLOW_UP_STATUS.BLOCKED) return null;
  if (followUpEvaluation.status !== FOLLOW_UP_STATUS.DUE && followUpEvaluation.status !== FOLLOW_UP_STATUS.WAITING) return null;

  // --- Gate 2: reasonCode conhecido ------------------------------------
  const reasonCode = followUpEvaluation.reason;
  if (!isKnownReason(reasonCode)) return null;

  // --- Gate 3: intenção humana explícita vence TUDO --------------------
  //
  // Precisa vir antes de qualquer inferência (seção 19: "Explicit deve
  // vencer TODAS as regras"). follow_up/other são um tipo diferente de
  // "explícito": não mapeiam para uma ação executável, e a decisão
  // aprovada (seção 7) é suprimir qualquer inferência automática nesse
  // caso — nunca tratá-los como "ausente".
  const nextActionType = lead && lead.nextActionType;

  if (nextActionType === 'follow_up' || nextActionType === 'other') return null;

  if (nextActionType && Object.prototype.hasOwnProperty.call(EXPLICIT_CHANNEL, nextActionType)) {
    return {
      type: nextActionType,
      channel: EXPLICIT_CHANNEL[nextActionType],
      intent: REASON_INTENT[reasonCode],
      reasonCode,
      confidence: 'explicit',
    };
  }

  // Daqui em diante: nextActionType ausente/vazio/não-reconhecido ->
  // inferência automática por reason. Nunca usa lead.etapa/
  // leadTemperature/priority/produto/tipo/telefone/nextActionNote/
  // tasks/now/dueAt/attemptCountByChannel/suggestedAction (seção 25).

  if (reasonCode === FOLLOW_UP_REASON.NEVER_CONTACTED) {
    // Única regra que não depende de history (seção 8/23) — canal
    // padrão comercial aprovado para primeiro contato.
    return { type: 'call', channel: 'phone', intent: 'first_contact', reasonCode, confidence: 'rule' };
  }

  if (reasonCode === FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT) {
    const channel = historyChannel(history, 'lastAttemptChannel');
    if (!channel) return null;

    const attemptCount = followUpEvaluation.attemptCount;
    if (typeof attemptCount !== 'number' || !Number.isFinite(attemptCount)) return null;

    if (attemptCount <= 1) {
      // Repete o canal da última tentativa (seção 9.A).
      return buildAutoResult(channel, 'retry', reasonCode);
    }
    // attemptCount >= 2: alterna (seção 9.B + 10).
    return buildAutoResult(alternate(channel), 'switch_channel', reasonCode);
  }

  if (reasonCode === FOLLOW_UP_REASON.CADENCE_EXHAUSTED) {
    const channel = historyChannel(history, 'lastAttemptChannel');
    if (!channel) return null;
    return buildAutoResult(alternate(channel), 'switch_channel', reasonCode);
  }

  if (reasonCode === FOLLOW_UP_REASON.REACTIVATION_DUE) {
    const channel = historyChannel(history, 'lastAttemptChannel');
    if (!channel) return null;
    // intent literal da especificação (seção 13): 'reactivate', não
    // 'switch_channel' — mesmo alternando o canal, o reason em si já
    // comunica "reativação", e esse é o intent que deve aparecer.
    return buildAutoResult(alternate(channel), 'reactivate', reasonCode);
  }

  if (reasonCode === FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT) {
    // Canal do PRÓPRIO engajamento (seção 14) — nunca o da tentativa
    // anterior a ele (diferença deliberada nº4 vs. NBA V1, seção 30).
    const channel = historyChannel(history, 'lastEngagementChannel');
    if (!channel) return null;
    return buildAutoResult(channel, 'continue_conversation', reasonCode);
  }

  if (reasonCode === FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL) {
    // Guardrail explícito (seção 16 — "Proposal Leak"): NUNCA usar
    // followUpEvaluation.suggestedAction como fallback aqui. Só um
    // engajamento CONFIÁVEL — isto é, que ocorreu antes ou no mesmo
    // instante da proposta que originou este reason (anchorOccurredAt)
    // — pode justificar uma recomendação. Sem anchor confiável, ou sem
    // engajamento, ou engajamento posterior à proposta (inconsistência
    // entre history/evaluation que não deveria ocorrer com dados
    // reais, mas é tratada de forma conservadora): null.
    const anchor = timeOrNull(followUpEvaluation.anchorOccurredAt);
    if (anchor === null) return null;

    const lastEngagement = history && typeof history === 'object' ? history.lastEngagement : null;
    if (!lastEngagement || typeof lastEngagement !== 'object') return null;

    const engagementTime = timeOrNull(lastEngagement.occurredAt);
    if (engagementTime === null || engagementTime > anchor) return null;

    const channel = historyChannel(history, 'lastEngagementChannel');
    if (!channel) return null;
    return buildAutoResult(channel, 'proposal_follow_up', reasonCode);
  }

  // Inalcançável: isKnownReason já filtrou qualquer reasonCode fora dos
  // 6 tratados acima. Mantido só como rede de segurança conservadora.
  return null;
}
