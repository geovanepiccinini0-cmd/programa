import { evaluateFollowUpEligibility, FOLLOW_UP_STATUS, FOLLOW_UP_POLICY } from './followUpEngine.js';
import { evaluateNextBestAction } from './nextBestAction.js';
import { presentNextBestAction } from './nextBestActionPresentation.js';
import { buildCommercialInteractionHistory } from './commercialInteractionHistory.js';
import { evaluateNextBestActionPolicy } from './nextBestActionPolicy.js';
import { compareNextBestActions } from './nextBestActionShadow.js';
import { selectOperationalRecommendation, OPERATIONAL_RECOMMENDATION_SOURCE } from './operationalRecommendation.js';

// Fase 2E.5.1B — fonte operacional centralizada. Único ponto de
// seleção no código inteiro (seção 4 da especificação: "não espalhar
// string 'commercial_policy' por vários arquivos") — rollback para o
// comportamento pré-2E.5.1B é trocar esta única linha para
// `OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT` e nada mais (nenhuma UI,
// nenhum outro módulo, precisa saber que essa troca aconteceu).
const ACTIVE_OPERATIONAL_SOURCE = OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY;

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
//
// Fase 2E.3 — Next Best Action (evaluateNextBestAction, 2E.1 +
// presentNextBestAction, 2E.2) — nenhuma das duas reavalia reason/
// blockers/attemptCount, só leem o que evaluateFollowUpEligibility já
// decidiu. `nbaPresentation`/`operationalRecommendation` nunca
// participam de status/reason/dueAt/attemptCount/sort/filtros — isso
// continua sendo decidido exclusivamente por `evaluation`.
//
// Fase 2E.4.3 — Shadow comparison entre o NBA atual e o candidato da
// Commercial Policy V1 (nextBestActionPolicy.js, 2E.4.2). `history` é
// construído a partir EXATAMENTE do mesmo `leadInteractions` já usado
// para `evaluation` (mesma variável, mesma referência de array) —
// garantia estrutural, não só por convenção, de que evaluation/
// currentNba/history/candidateNba nascem do mesmo dataset desta mesma
// execução (guardrail registrado na 2E.4.2 sobre reason/anchor/history
// inconsistentes).
//
// Fase 2E.5.1B (ver abaixo) — ATENÇÃO: desde esta fase, `candidate`
// (via `operationalRecommendation`) PASSA a alimentar `nbaPresentation`
// e a decidir o CTA em FollowUpQueue.jsx — o parágrafo acima descreve
// 2E.4.3, não o estado atual. `evaluation.suggestedAction` nunca é
// escrito por nada aqui (seção inalterada), mas deixou de ser a fonte
// do CTA — ver comentário da ativação abaixo.
//
// Fase 2E.4.3.2 — hardening de isolamento de falha (achado HIGH da
// auditoria 2E.4.3.1, provado empiricamente: um throw exclusivo no
// shadow caía no catch externo e apagava evaluation/nba/nbaPresentation
// já calculados com sucesso). Princípio: SHADOW PODE FALHAR, o caminho
// operacional NÃO PODE FALHAR POR CAUSA DELE. Por isso o cálculo do
// shadow (abaixo, dentro da função) tem seu PRÓPRIO try/catch interno,
// estritamente mais estreito que o externo — cobre só
// buildCommercialInteractionHistory/evaluateNextBestActionPolicy/
// compareNextBestActions, nunca evaluateFollowUpEligibility/
// evaluateNextBestAction/presentNextBestAction (que continuam com a
// semântica de erro pré-existente, sob o catch externo).
//
// Fase 2E.5.1B — ATIVAÇÃO: a Commercial Policy V1 (`candidateNba`)
// passa a ser a fonte de `operationalRecommendation`/`nbaPresentation`
// (o que a UI exibe e o que decide o CTA — ver FollowUpQueue.jsx) via
// `ACTIVE_OPERATIONAL_SOURCE` acima. `currentNba` continua calculado
// (nunca removido — necessário para `nbaShadow`, para o fallback
// técnico abaixo, e para rollback) mas deixa de alimentar a UI
// diretamente.
//
// Três semânticas de falha DISTINTAS, deliberadamente não unificadas
// num só catch (achado da especificação: "NULL VÁLIDO vs. ERRO
// TÉCNICO" precisam ser diferenciáveis):
//
// 1) `buildCommercialInteractionHistory`/`evaluateNextBestActionPolicy`
//    lançam (erro técnico, não "sem recomendação"): `candidateNba`
//    nunca chega a existir de verdade -> fallback técnico explícito
//    para `currentNba` (nunca para `null`) e `nbaShadow` fica `null`
//    (não há candidate válido para comparar). Isso é estrutural e
//    diferente de "candidate decidiu null": aqui a Policy nem chegou a
//    decidir nada.
// 2) `candidateNba === null` (resultado VÁLIDO e deliberado da Policy —
//    ex. Proposal Leak fechado, follow_up/other suprimidos, blocked):
//    `selectOperationalRecommendation` com source=COMMERCIAL_POLICY
//    devolve exatamente esse `null` — nunca um fallback para
//    `currentNba` (regra crítica da especificação: candidate null NUNCA
//    cai para current; só erro técnico cai).
// 3) só `compareNextBestActions` lança (candidate já foi calculado com
//    sucesso): `nbaShadow` fica `null`, mas `operationalRecommendation`
//    continua sendo `candidateNba` normalmente — o comparator é
//    observabilidade pura, nunca participa da operação.
//
// Nenhuma das três exceções (ou ausência delas) gera console/telemetry/
// write — permanecem silenciosas, como já era o padrão da 2E.4.3.2.

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
      const currentNba = evaluateNextBestAction({ lead, followUpEvaluation: evaluation });

      // Boundary 1 (seção 28-D do plano de ativação): história + policy
      // juntas, como já era. Falha aqui é ERRO TÉCNICO, nunca "candidate
      // decidiu null" — por isso rastreada separadamente
      // (`candidateComputationFailed`), nunca confundida com
      // `candidateNba = null`.
      let candidateNba = null;
      let candidateComputationFailed = false;
      try {
        const history = buildCommercialInteractionHistory(leadInteractions);
        candidateNba = evaluateNextBestActionPolicy({ lead, followUpEvaluation: evaluation, history });
      } catch {
        candidateComputationFailed = true;
      }

      // Boundary 2 (seção 28-E): comparator, só tentado se o candidate
      // em si foi calculado com sucesso — comparar contra um candidate
      // que nunca existiu de verdade não produz uma comparação válida.
      // Falha aqui nunca afeta `operationalRecommendation` (o candidate
      // já estava calculado antes desta linha).
      let nbaShadow = null;
      if (!candidateComputationFailed) {
        try {
          nbaShadow = compareNextBestActions(currentNba, candidateNba);
        } catch {
          nbaShadow = null;
        }
      }

      // Seleção operacional: erro técnico no boundary 1 -> fallback
      // explícito para `currentNba` (nunca `null` fabricado); sucesso ->
      // seletor puro (operationalRecommendation.js), que já garante
      // estruturalmente que candidate===null nunca cai para current.
      const operationalRecommendation = candidateComputationFailed
        ? currentNba
        : selectOperationalRecommendation({ source: ACTIVE_OPERATIONAL_SOURCE, current: currentNba, candidate: candidateNba });

      const operationalPresentation = presentNextBestAction(operationalRecommendation);

      return { lead, evaluation, error: null, nbaPresentation: operationalPresentation, nbaShadow, operationalRecommendation };
    } catch (e) {
      return { lead, evaluation: null, error: (e && e.message) || 'Falha ao avaliar este lead.', nbaPresentation: null, nbaShadow: null, operationalRecommendation: null };
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

// Fase 2C.2B.1 — diferente do fallback de sortDueFollowUps (dueAt
// ausente conta como timestamp 0, "mais vencido" — decisão deliberada e
// já publicada para o cenário real never_contacted), aqui um dueAt
// ausente/inválido conta como +Infinity: fica DEPOIS de qualquer item
// com prazo conhecido, nunca antes. Para 'waiting' (ordenado por "mais
// próximo de vencer"), tratar "não sei quando vence" como "é o mais
// urgente" seria o oposto do que a lista comunica. Na prática o motor
// nunca produz um item waiting sem dueAt válido (status só vira 'waiting'
// quando dueAt existe e é futuro) — isto é só hardening defensivo, não
// um caminho real hoje.
function waitingSortTime(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

function nomeIdKey(lead) {
  return `${lead.nome || ''}:${lead.id}`;
}

// Fase 2C.2B — ranking de 'waiting': só dueAt crescente (mais próximo de
// vencer primeiro) — sem priority/temperature nesta V1 (reason explícita:
// é uma aba secundária, não a fila principal; se um dia precisar dos
// mesmos critérios de due, isso é decisão de produto nova, não um
// "esquecimento" aqui). Nunca muta o array recebido.
export function sortWaitingFollowUps(items) {
  return items
    .filter((item) => item.evaluation && item.evaluation.status === FOLLOW_UP_STATUS.WAITING)
    .sort((a, b) => {
      const dueA = waitingSortTime(a.evaluation.dueAt);
      const dueB = waitingSortTime(b.evaluation.dueAt);
      if (dueA !== dueB) return dueA - dueB;

      const keyA = nomeIdKey(a.lead);
      const keyB = nomeIdKey(b.lead);
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      return 0;
    });
}

// Fase 2C.2B — ranking de 'blocked': alfabético por nome, id como
// desempate — determinístico, sem depender de dueAt (blocked nunca tem
// um prazo real, ver evaluateFollowUpEligibility) nem de priority/
// temperature. Nunca muta o array recebido.
export function sortBlockedFollowUps(items) {
  return items
    .filter((item) => item.evaluation && item.evaluation.status === FOLLOW_UP_STATUS.BLOCKED)
    .sort((a, b) => {
      const keyA = nomeIdKey(a.lead);
      const keyB = nomeIdKey(b.lead);
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
