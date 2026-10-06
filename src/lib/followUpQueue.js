import { evaluateFollowUpEligibility, FOLLOW_UP_STATUS, FOLLOW_UP_POLICY } from './followUpEngine.js';

// Fase 2C.2A — camada de domínio da fila de follow-up ("Shadow Mode").
// Pura: sem Supabase, sem React, sem useAppState, sem fetch, nunca muta
// os inputs. Recebe dados já carregados e devolve um resultado auditável
// por lead, chamando evaluateFollowUpEligibility como única fonte de
// verdade (nunca reimplementa blockers/reasons aqui).
//
// IMPORTANTE: esta função avalia TODOS os leads recebidos, inclusive
// Ganho/Perdido/deletedAt — o motor já os marca como 'blocked' sozinho.
// Filtrar o que a UI mostra por padrão é responsabilidade da camada de
// apresentação (Fase 2C.2B), não desta função. Isso mantém o domínio
// auditável por completo (inclusive para Shadow Mode conferir blockers
// de leads terminais, se precisar).

// Agrupa uma lista em um Map<leadId, item[]> numa única passagem —
// evita O(leads × interactions)/O(leads × tasks): a indexação é
// O(interactions)/O(tasks), e cada lead só lê sua própria fatia depois,
// então o custo total fica O(leads + interactions + tasks) (fora o
// custo interno de avaliação de cada lead, que já é O(suas próprias
// interactions/tasks) dentro de evaluateFollowUpEligibility).
function indexByLeadId(items) {
  const map = new Map();
  items.forEach((item) => {
    const existing = map.get(item.leadId);
    if (existing) existing.push(item);
    else map.set(item.leadId, [item]);
  });
  return map;
}

// Retorna um item por lead: { lead, evaluation, error }. Em caso de
// falha ao avaliar UM lead (ex. dado malformado), os demais continuam
// avaliados normalmente — error carrega só uma mensagem curta, nunca a
// stack trace/objeto bruto da exceção.
export function buildFollowUpQueue({ leads, interactions, tasks, now, policy = FOLLOW_UP_POLICY }) {
  const interactionsByLead = indexByLeadId(interactions);
  const tasksByLead = indexByLeadId(tasks);

  return leads.map((lead) => {
    try {
      const leadInteractions = interactionsByLead.get(lead && lead.id) || [];
      const leadTasks = tasksByLead.get(lead && lead.id) || [];
      const evaluation = evaluateFollowUpEligibility({ lead, interactions: leadInteractions, tasks: leadTasks, now, policy });
      return { lead, evaluation, error: null };
    } catch (e) {
      return { lead, evaluation: null, error: (e && e.message) || 'Falha ao avaliar este lead.' };
    }
  });
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const TEMPERATURE_RANK = { hot: 0, warm: 1, cold: 2 };

function priorityRank(priority) {
  return priority in PRIORITY_RANK ? PRIORITY_RANK[priority] : PRIORITY_RANK.normal;
}

function temperatureRank(temperature) {
  // vazio/desconhecido fica por último, depois de cold.
  return temperature in TEMPERATURE_RANK ? TEMPERATURE_RANK[temperature] : 3;
}

// Fase 2C.2A — ranking V1, deliberadamente simples e determinístico:
// 1) priority (urgent > high > normal > low)
// 2) dentro da mesma priority, mais vencido primeiro (dueAt mais antigo)
// 3) empate: leadTemperature (hot > warm > cold > vazio)
// 4) empate total: nome + id (tie-break estável, nunca "ordem do array")
//
// De propósito, NÃO entram no ranking: reason, etapa, valor do lead,
// attemptCount — são informativos no card (2C.2B), não critério de
// ordenação, para não criar um algoritmo obscuro.
//
// Filtra E ordena: o resultado é só a fila DUE, já ranqueada — os itens
// que não são 'due' não fazem parte do que esta função devolve (são
// responsabilidade de getWaitingFollowUps/getBlockedFollowUps abaixo).
// Nunca muta o array recebido (filter já devolve uma cópia nova).
export function sortDueFollowUps(items) {
  return items
    .filter((item) => item.evaluation && item.evaluation.status === FOLLOW_UP_STATUS.DUE)
    .sort((a, b) => {
      const byPriority = priorityRank(a.lead.priority) - priorityRank(b.lead.priority);
      if (byPriority !== 0) return byPriority;

      const dueA = a.evaluation.dueAt ? new Date(a.evaluation.dueAt).getTime() : 0;
      const dueB = b.evaluation.dueAt ? new Date(b.evaluation.dueAt).getTime() : 0;
      if (dueA !== dueB) return dueA - dueB; // mais antigo (mais vencido) primeiro

      const byTemperature = temperatureRank(a.lead.leadTemperature) - temperatureRank(b.lead.leadTemperature);
      if (byTemperature !== 0) return byTemperature;

      const keyA = `${a.lead.nome || ''}:${a.lead.id}`;
      const keyB = `${b.lead.nome || ''}:${b.lead.id}`;
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      return 0;
    });
}

// Filtros puros simples para a futura UI (2C.2B) — nenhum estado novo,
// só derivação sobre o resultado de buildFollowUpQueue.
export function getDueFollowUps(items) {
  return items.filter((item) => item.evaluation && item.evaluation.status === FOLLOW_UP_STATUS.DUE);
}

export function getWaitingFollowUps(items) {
  return items.filter((item) => item.evaluation && item.evaluation.status === FOLLOW_UP_STATUS.WAITING);
}

export function getBlockedFollowUps(items) {
  return items.filter((item) => item.evaluation && item.evaluation.status === FOLLOW_UP_STATUS.BLOCKED);
}
