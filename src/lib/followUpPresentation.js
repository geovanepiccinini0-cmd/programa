import { FOLLOW_UP_REASON, FOLLOW_UP_STATUS, FOLLOW_UP_POLICY } from './followUpEngine.js';
import { NEXT_ACTION_TYPES } from '../constants.js';
import { formatRelativeTime } from '../utils.js';

// Fase 2C.2B — camada de apresentação do Shadow Mode. Pura: sem React,
// sem Supabase, sem efeitos colaterais. Só traduz o resultado já
// calculado por followUpEngine.js/followUpQueue.js em texto PT-BR para a
// UI — nunca decide status/reason/blockers, nunca reimplementa nada do
// motor. formatRelativeTime (utils.js) é reaproveitado como está, não
// alterado nesta fase.

const REASON_COPY = {
  [FOLLOW_UP_REASON.NEVER_CONTACTED]: {
    label: 'Nunca contatado',
    subtitle: 'Lead cadastrado, ainda sem nenhuma tentativa de contato.',
  },
  [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT]: {
    label: 'Sem resposta após tentativa',
    subtitle: 'Você tentou contato e ainda não teve retorno do cliente.',
  },
  [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL]: {
    label: 'Sem resposta após proposta',
    subtitle: 'A proposta foi enviada e o cliente ainda não respondeu.',
  },
  [FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT]: {
    label: 'Sem novo contato desde a resposta',
    subtitle: 'O cliente respondeu, mas ainda não houve uma nova tentativa sua.',
  },
  [FOLLOW_UP_REASON.CADENCE_EXHAUSTED]: {
    label: 'Cadência esgotada',
    subtitle: 'Todas as tentativas previstas já foram feitas. Aguardando janela de reativação.',
  },
  [FOLLOW_UP_REASON.REACTIVATION_DUE]: {
    label: 'Pronto para reativar',
    subtitle: 'Passou o tempo de espera — é hora de tentar reativar o contato.',
  },
};

// null quando blocked (reason sempre null nesse status, ver
// evaluateFollowUpEligibility) ou qualquer reason fora do mapa acima
// (nunca deveria ocorrer, mas não lança — só não mostra nada).
export function formatFollowUpReason(evaluation) {
  if (!evaluation || !evaluation.reason) return null;
  return REASON_COPY[evaluation.reason] || null;
}

// Prefixo depende de status+reason, o diff em si vem de formatRelativeTime
// (não alterado). blocked nunca tem dueAt (ver engine) -> nunca inventa
// prazo. reactivation_due é o único due que NÃO usa o framing "Vencido"
// (decisão aprovada: "Reativação disponível", sem relógio).
export function formatFollowUpTimeLabel(evaluation, now) {
  if (!evaluation || evaluation.status === FOLLOW_UP_STATUS.BLOCKED) return null;
  if (evaluation.reason === FOLLOW_UP_REASON.REACTIVATION_DUE) return 'Reativação disponível';
  if (!evaluation.dueAt) return null;
  const rel = formatRelativeTime(evaluation.dueAt, now);
  if (evaluation.status === FOLLOW_UP_STATUS.DUE) return `Vencido ${rel}`;
  if (evaluation.reason === FOLLOW_UP_REASON.CADENCE_EXHAUSTED) return `Reativação ${rel}`;
  return `Vence ${rel}`;
}

// Reaproveita NEXT_ACTION_TYPES (constants.js) em vez de duplicar o mapa
// call/whatsapp/meeting/proposal -> label. Texto puro, nunca um botão.
export function formatSuggestedAction(evaluation) {
  if (!evaluation || !evaluation.suggestedAction) return null;
  const found = NEXT_ACTION_TYPES.find((t) => t.value === evaluation.suggestedAction.type);
  return found ? found.label : null;
}

// Allow-list deliberada (não deny-list): só os blockers que o vendedor
// precisa revisar operacionalmente no dia a dia. Estruturais (deleted,
// etapa_ganho, etapa_perdido) e o aviso não-absoluto (sem_telefone) ficam
// de fora de propósito — nunca aparecem na aba "Bloqueados".
const OPERATIONAL_BLOCKER_COPY = {
  proximo_contato_agendado: 'Já tem contato agendado',
  lead_agenda_pendente: 'Tarefa de contato já pendente',
  follow_up_automatico_pendente: 'Já existe um follow-up pendente',
};

export function getOperationalBlockers(evaluation) {
  if (!evaluation || !evaluation.blockers) return [];
  return evaluation.blockers.filter((b) => b in OPERATIONAL_BLOCKER_COPY);
}

export function formatOperationalBlocker(blockerCode) {
  return OPERATIONAL_BLOCKER_COPY[blockerCode] || null;
}

export function hasMissingPhoneWarning(evaluation) {
  return Boolean(evaluation && evaluation.blockers && evaluation.blockers.includes('sem_telefone'));
}

// Só mostra "N/3 tentativas" onde attemptCount é informativo de verdade.
// never_contacted (sempre 0), no_response_after_proposal e
// no_new_attempt_since_engagement (sempre 0 por definição — attemptCount
// conta só tentativas DEPOIS do último engajamento) ficam de fora: o
// número seria redundante ou confuso, não uma informação nova.
const REASONS_WITH_ATTEMPT_COUNT = new Set([
  FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT,
  FOLLOW_UP_REASON.CADENCE_EXHAUSTED,
  FOLLOW_UP_REASON.REACTIVATION_DUE,
]);

export function shouldShowAttemptCount(evaluation) {
  return Boolean(evaluation && REASONS_WITH_ATTEMPT_COUNT.has(evaluation.reason));
}

// Denominador vem da policy (nunca hardcoded "3" no JSX).
export function formatAttemptCount(evaluation, policy = FOLLOW_UP_POLICY) {
  return `${evaluation.attemptCount}/${policy.maxAttempts} tentativas`;
}
