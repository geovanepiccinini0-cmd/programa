import { CONTACT_ATTEMPT_TYPES } from '../constants.js';

// Fase 2C.1 — Follow-up Eligibility Engine.
//
// Função pura, determinística, sem Supabase/React/efeitos colaterais.
// Avalia UM lead por vez e responde: ele precisa de follow-up agora, está
// numa janela de espera, ou está bloqueado — e por quê. Não cria task,
// não altera etapa, não escreve nada. `now` é sempre injetado pelo
// chamador (nunca `Date.now()`/`new Date()` interno).
//
// Reaproveita deliberadamente CONTACT_ATTEMPT_TYPES de constants.js — a
// mesma lista de tipos que já define "última tentativa" nos relógios de
// atividade (computeLastContactAttemptAt, em useAppState.js). Isso
// garante que a noção de "tentativa de contato" nunca diverge entre os
// dois módulos, SEM que este módulo dependa de useAppState.js (que
// carrega React/Supabase) — constants.js é um módulo-folha, zero
// imports (Fase 2C.1.1 — hardening arquitetural).

export const FOLLOW_UP_STATUS = { DUE: 'due', WAITING: 'waiting', BLOCKED: 'blocked' };

export const FOLLOW_UP_REASON = {
  NEVER_CONTACTED: 'never_contacted',
  NO_RESPONSE_AFTER_ATTEMPT: 'no_response_after_attempt',
  NO_RESPONSE_AFTER_PROPOSAL: 'no_response_after_proposal',
  NO_NEW_ATTEMPT_SINCE_ENGAGEMENT: 'no_new_attempt_since_engagement',
  CADENCE_EXHAUSTED: 'cadence_exhausted',
  REACTIVATION_DUE: 'reactivation_due',
};

export const FOLLOW_UP_BLOCKER = {
  DELETED: 'deleted',
  ETAPA_GANHO: 'etapa_ganho',
  ETAPA_PERDIDO: 'etapa_perdido',
  PROXIMO_CONTATO_AGENDADO: 'proximo_contato_agendado',
  LEAD_AGENDA_PENDENTE: 'lead_agenda_pendente',
  FOLLOW_UP_AUTOMATICO_PENDENTE: 'follow_up_automatico_pendente',
  // Não-absoluto: não muda `status`, só suprime suggestedAction de
  // call/whatsapp. Ver buildSuggestedAction.
  SEM_TELEFONE: 'sem_telefone',
};

// Blockers que, sozinhos, já definem status='blocked'. SEM_TELEFONE
// fica fora de propósito — é um aviso sobre a ação sugerida, não sobre
// a elegibilidade do lead.
const ABSOLUTE_BLOCKERS = new Set([
  FOLLOW_UP_BLOCKER.DELETED,
  FOLLOW_UP_BLOCKER.ETAPA_GANHO,
  FOLLOW_UP_BLOCKER.ETAPA_PERDIDO,
  FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO,
  FOLLOW_UP_BLOCKER.LEAD_AGENDA_PENDENTE,
  FOLLOW_UP_BLOCKER.FOLLOW_UP_AUTOMATICO_PENDENTE,
]);

// Policy centralizada — nenhum prazo solto no corpo da função. Valores
// experimentais aprovados para a V1, não definitivos.
export const FOLLOW_UP_POLICY = {
  attempt: { hoursUntilDue: 24 },
  proposal: { hoursUntilDue: 48 },
  noNewAttemptSinceEngagement: { hoursUntilDue: 96 },
  maxAttempts: 3,
  reactivationAfterMaxAttempts: { daysUntilDue: 7 },
};

// type -> canal, só para os tipos que o Activity Engine já sabe executar
// (mesma convenção de computeCommercialInteractionData). 'follow_up' e
// 'other' (de NEXT_ACTION_TYPES) ficam de fora de propósito: não são um
// canal concreto, não dá para sugerir uma ação executável a partir deles.
const EXECUTABLE_ACTION_CHANNEL = {
  call: 'phone',
  whatsapp: 'whatsapp',
  meeting: 'in_person',
  proposal: 'manual',
};

function isContactAttemptInteraction(it) {
  if (!CONTACT_ATTEMPT_TYPES.includes(it.type)) return false;
  if (it.direction !== 'outbound') return false;
  const cls = it.metadata && it.metadata.activity_class;
  return cls === 'attempt' || cls === 'engagement';
}

function isProposalSentInteraction(it) {
  return it.type === 'proposal' && it.direction === 'outbound' && Boolean(it.metadata) && it.metadata.activity_class === 'attempt';
}

function isEngagementInteraction(it) {
  return Boolean(it.metadata) && it.metadata.activity_class === 'engagement';
}

// Devolve a INTERAÇÃO inteira (não só a data), para servir de anchor.
// Registros legados (metadata null, ou {from_stage,to_stage} sem
// activity_class) falham os três predicados acima sem lançar exceção —
// são ignorados com segurança, nunca "contam" como attempt/engagement.
function maxInteractionBy(interactions, predicate) {
  let best = null;
  let bestTime = -Infinity;
  interactions.forEach((it) => {
    if (!predicate(it)) return;
    if (!it.occurredAt) return;
    const t = new Date(it.occurredAt).getTime();
    if (Number.isNaN(t) || t <= bestTime) return;
    bestTime = t;
    best = it;
  });
  return best;
}

// Tentativas comerciais (mesmo predicado de computeLastContactAttemptAt)
// ocorridas DEPOIS do último engajamento — ou todas, se nunca houve
// engajamento. Independente da ordem do array (percorre tudo).
function countAttemptsSinceEngagement(interactions, lastEngagementOccurredAt) {
  const boundary = lastEngagementOccurredAt ? new Date(lastEngagementOccurredAt).getTime() : -Infinity;
  let count = 0;
  interactions.forEach((it) => {
    if (!isContactAttemptInteraction(it)) return;
    if (!it.occurredAt) return;
    const t = new Date(it.occurredAt).getTime();
    if (Number.isNaN(t)) return;
    if (t > boundary) count += 1;
  });
  return count;
}

function hasPendingTaskWithOrigem(tasks, leadId, origem) {
  return tasks.some((t) => t.leadId === leadId && t.origem === origem && !t.concluida);
}

function addHoursIso(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString();
}

function addDaysIso(iso, days) {
  return addHoursIso(iso, days * 24);
}

// Ordem: 1) nextActionType humano (se mapear para um canal executável);
// 2) canal da última tentativa; 3) null — nunca inventa canal sem base
// nenhuma das duas. Em qualquer um dos dois casos, se o tipo resultante
// for 'call'/'whatsapp' e o lead não tiver telefone, a ação não é
// sugerida (esse CRM não tem campo de WhatsApp separado — reaproveita
// `telefone` para os dois canais) e SEM_TELEFONE é sinalizado.
function buildSuggestedAction(lead, lastAttemptInteraction) {
  let candidateType = null;
  let candidateChannel = null;

  if (lead.nextActionType && EXECUTABLE_ACTION_CHANNEL[lead.nextActionType]) {
    candidateType = lead.nextActionType;
    candidateChannel = EXECUTABLE_ACTION_CHANNEL[candidateType];
  } else if (lastAttemptInteraction && EXECUTABLE_ACTION_CHANNEL[lastAttemptInteraction.type]) {
    candidateType = lastAttemptInteraction.type;
    candidateChannel = lastAttemptInteraction.channel || EXECUTABLE_ACTION_CHANNEL[candidateType];
  }

  if (!candidateType) return { suggestedAction: null, suppressedByMissingPhone: false };

  const needsPhone = candidateType === 'call' || candidateType === 'whatsapp';
  if (needsPhone && !lead.telefone) return { suggestedAction: null, suppressedByMissingPhone: true };

  return { suggestedAction: { type: candidateType, channel: candidateChannel }, suppressedByMissingPhone: false };
}

// dedupeKey = leadId + reason + âncora (interaction id, ou occurredAt da
// âncora quando não há id, ou lead.createdAt para never_contacted).
// Nunca só leadId+reason — isso não distinguiria ciclos comerciais
// diferentes (ex. duas janelas "no_response_after_attempt" separadas
// por um engajamento no meio). 100% determinística: mesmos inputs,
// mesma chave, sempre.
function buildDedupeKey(lead, status, reason, anchorInteractionId, anchorOccurredAt) {
  if (status === FOLLOW_UP_STATUS.BLOCKED) return `${lead.id}:blocked`;
  const anchor = anchorInteractionId || anchorOccurredAt || lead.createdAt || 'none';
  return `${lead.id}:${reason}:${anchor}`;
}

export function evaluateFollowUpEligibility({ lead, interactions, tasks, now, policy = FOLLOW_UP_POLICY }) {
  const nowTime = now.getTime();

  // Defensivo: aceita tanto "só as interações/tasks deste lead" quanto
  // "tudo" — nos dois casos o resultado é correto.
  const leadInteractions = interactions.filter((it) => it.leadId === lead.id);
  const leadTasks = tasks.filter((t) => t.leadId === lead.id);

  const blockers = [];
  if (lead.deletedAt) blockers.push(FOLLOW_UP_BLOCKER.DELETED);
  if (lead.etapa === 'Ganho') blockers.push(FOLLOW_UP_BLOCKER.ETAPA_GANHO);
  if (lead.etapa === 'Perdido') blockers.push(FOLLOW_UP_BLOCKER.ETAPA_PERDIDO);
  // Ajuste 4 — conservador: QUALQUER sinal de agendamento pendente
  // bloqueia, esteja o proximoContato no passado, hoje ou no futuro, e
  // mesmo que só um dos dois sinais exista (estado hoje inconsistente
  // não deveria ocorrer — reconcileLeadAgendaActions mantém os dois em
  // sincronia — mas se ocorrer, o motor NÃO corrige, só bloqueia pelo
  // sinal que encontrar). Uma task lead-agenda vencida é um problema
  // operacional já sinalizado em outro lugar da UI (badge ATRASADO) —
  // não é lacuna que este motor deva preencher.
  if (lead.proximoContato) blockers.push(FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO);
  if (hasPendingTaskWithOrigem(leadTasks, lead.id, 'lead-agenda')) blockers.push(FOLLOW_UP_BLOCKER.LEAD_AGENDA_PENDENTE);
  if (hasPendingTaskWithOrigem(leadTasks, lead.id, 'automation')) blockers.push(FOLLOW_UP_BLOCKER.FOLLOW_UP_AUTOMATICO_PENDENTE);

  const isBlocked = blockers.some((b) => ABSOLUTE_BLOCKERS.has(b));

  const lastEngagementInteraction = maxInteractionBy(leadInteractions, isEngagementInteraction);
  const lastAttemptInteraction = maxInteractionBy(leadInteractions, isContactAttemptInteraction);
  const lastProposalInteraction = maxInteractionBy(leadInteractions, isProposalSentInteraction);
  const attemptCount = countAttemptsSinceEngagement(leadInteractions, lastEngagementInteraction && lastEngagementInteraction.occurredAt);

  let reason = null;
  let since = null;
  let dueAt = null;
  let anchorInteractionId = null;
  let anchorOccurredAt = null;

  if (!isBlocked) {
    if (!lastAttemptInteraction && !lastProposalInteraction && !lastEngagementInteraction) {
      // Cenário C — nunca contatado. Categoria própria, não é "sem
      // resposta" (nunca houve tentativa para não responder). Sem
      // policy de espera definida para este caso: fica due desde já.
      reason = FOLLOW_UP_REASON.NEVER_CONTACTED;
      since = lead.createdAt || null;
      dueAt = lead.createdAt || null;
    } else {
      const engagementTime = lastEngagementInteraction ? new Date(lastEngagementInteraction.occurredAt).getTime() : -Infinity;
      const attemptTime = lastAttemptInteraction ? new Date(lastAttemptInteraction.occurredAt).getTime() : -Infinity;
      const proposalTime = lastProposalInteraction ? new Date(lastProposalInteraction.occurredAt).getTime() : -Infinity;

      if (lastEngagementInteraction && engagementTime >= attemptTime && engagementTime >= proposalTime) {
        // O sinal mais recente é um engajamento, e ninguém tentou de
        // novo desde então.
        reason = FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT;
        anchorInteractionId = lastEngagementInteraction.id || null;
        anchorOccurredAt = lastEngagementInteraction.occurredAt;
        since = anchorOccurredAt;
        dueAt = addHoursIso(anchorOccurredAt, policy.noNewAttemptSinceEngagement.hoursUntilDue);
      } else if (attemptTime >= proposalTime) {
        // Tentativa (call/whatsapp/meeting outbound) é o sinal mais
        // recente. maxAttempts/reativação só se aplica a esta cadência
        // de tentativas repetidas — proposta e engajamento-parado têm
        // suas próprias janelas de uma via só.
        anchorInteractionId = lastAttemptInteraction.id || null;
        anchorOccurredAt = lastAttemptInteraction.occurredAt;
        since = anchorOccurredAt;
        if (attemptCount >= policy.maxAttempts) {
          const reactivationDueAt = addDaysIso(anchorOccurredAt, policy.reactivationAfterMaxAttempts.daysUntilDue);
          dueAt = reactivationDueAt;
          reason = nowTime >= new Date(reactivationDueAt).getTime()
            ? FOLLOW_UP_REASON.REACTIVATION_DUE
            : FOLLOW_UP_REASON.CADENCE_EXHAUSTED;
        } else {
          dueAt = addHoursIso(anchorOccurredAt, policy.attempt.hoursUntilDue);
          reason = FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT;
        }
      } else {
        // Proposta é o sinal mais recente. proposal_sent continua
        // activity_class='attempt' no Activity Engine — isso não muda
        // aqui — só não compartilha a janela/cadência genérica de
        // tentativa: tem prazo e reason próprios.
        reason = FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL;
        anchorInteractionId = lastProposalInteraction.id || null;
        anchorOccurredAt = lastProposalInteraction.occurredAt;
        since = anchorOccurredAt;
        dueAt = addHoursIso(anchorOccurredAt, policy.proposal.hoursUntilDue);
      }
    }
  }

  let status;
  if (isBlocked) {
    status = FOLLOW_UP_STATUS.BLOCKED;
  } else if (reason === FOLLOW_UP_REASON.NEVER_CONTACTED || (dueAt !== null && nowTime >= new Date(dueAt).getTime())) {
    status = FOLLOW_UP_STATUS.DUE;
  } else {
    status = FOLLOW_UP_STATUS.WAITING;
  }

  const { suggestedAction, suppressedByMissingPhone } = isBlocked
    ? { suggestedAction: null, suppressedByMissingPhone: false }
    : buildSuggestedAction(lead, lastAttemptInteraction);
  if (suppressedByMissingPhone) blockers.push(FOLLOW_UP_BLOCKER.SEM_TELEFONE);

  return {
    status,
    eligible: status === FOLLOW_UP_STATUS.DUE,
    reason: isBlocked ? null : reason,
    since,
    dueAt,
    anchorInteractionId,
    anchorOccurredAt,
    suggestedAction,
    attemptCount,
    blockers,
    dedupeKey: buildDedupeKey(lead, status, reason, anchorInteractionId, anchorOccurredAt),
  };
}
