import { FOLLOW_UP_STATUS } from './followUpEngine.js';

// Etapa C — Adiamento de follow-ups ("Adiar"/"Cancelar adiamento").
//
// Função pura, determinística, sem Supabase/React/efeitos colaterais —
// mesmo padrão de followUpEngine.js/followUpPolicyConfig.js. Camada
// INTEIRAMENTE externa a followUpEngine.js (que permanece com ZERO
// diff nesta fase, mesma disciplina já praticada em nextBestAction.js/
// nextBestActionPolicy.js) — aplica o adiamento SOBRE uma evaluation
// JÁ CALCULADA por evaluateFollowUpEligibility, nunca duplica nem
// reimplementa blockers/reason/dueAt/attemptCount.
//
// DISTINÇÃO EXPLÍCITA (requisito da autorização da Etapa C):
// - Nunca confundido com tarefas de agenda (`tasks`, origem
//   'lead-agenda'/'auto') — adiamento não cria, altera nem remove
//   nenhuma task.
// - Nunca confundido com histórico comercial (`lead_interactions`) —
//   adiar/cancelar adiamento nunca lê nem escreve lá.
// - Nunca confundido com a política por etapa (Etapa B,
//   followUpPolicyConfig.js) — adiamento é por LEAD, prazo por
//   ETAPA; os dois se compõem (ver followUpQueue.js): a política por
//   etapa decide QUANDO o motor consideraria vencido; o adiamento só
//   SUPRIME esse "vencido" temporariamente, nunca o contrário.
// - Nunca altera etapa, nunca arquiva (deleted_at), nunca cria
//   contato automático — a única escrita é na própria tabela de
//   adiamento (follow_up_snoozes, migration 027).

export const SNOOZE_PRESETS = [
  { key: '1h', label: '1 hora', hours: 1 },
  { key: '1d', label: '1 dia', hours: 24 },
  { key: '1w', label: '1 semana', hours: 24 * 7 },
];

const SNOOZE_PRESETS_BY_KEY = SNOOZE_PRESETS.reduce((acc, p) => { acc[p.key] = p; return acc; }, {});

// Reason code PRÓPRIO deste módulo — deliberadamente NUNCA adicionado
// ao enum FOLLOW_UP_REASON de followUpEngine.js (isso exigiria
// modificar aquele módulo, quebrando a disciplina de "zero diff").
// Todo consumidor downstream (nextBestAction.js, nextBestActionPolicy.js)
// já trata qualquer reason fora do próprio mapa como "sem
// recomendação" (retornam null, nunca lançam) — confirmado por
// leitura: nenhuma mudança foi necessária nesses módulos.
export const SNOOZE_REASON = 'snoozed';

// now injetado pelo chamador (nunca Date.now() interno, mesmo
// princípio de followUpEngine.js). Preset desconhecido -> null,
// nunca lança, nunca inventa um prazo.
export function computeSnoozeUntil(now, presetKey) {
  const preset = SNOOZE_PRESETS_BY_KEY[presetKey];
  if (!preset || !now) return null;
  return new Date(now.getTime() + preset.hours * 3600 * 1000).toISOString();
}

// Adiamento ainda em vigor? Qualquer entrada malformada (data
// inválida, ausente) -> false, nunca lança.
export function isSnoozeActive(snoozedUntil, now) {
  if (!snoozedUntil || !now) return false;
  const t = new Date(snoozedUntil).getTime();
  if (Number.isNaN(t)) return false;
  return t > now.getTime();
}

// API principal — aplica o adiamento a UMA evaluation já calculada.
//
// Regras:
// - evaluation ausente/'blocked' -> devolve a MESMA referência, sem
//   nenhuma alteração (adiamento nunca desbloqueia um lead Ganho/
//   Perdido/deletado/com agendamento pendente — isso continua
//   decidido exclusivamente por evaluateFollowUpEligibility).
// - sem adiamento ativo (snoozedUntil ausente, inválido, ou já
//   vencido) -> devolve a MESMA referência — "ao vencer o prazo, o
//   lead volta automaticamente à fila, desde que continue elegível"
//   é satisfeito por CONSTRUÇÃO: a elegibilidade nunca foi persistida,
//   é sempre recalculada a partir dos dados reais a cada chamada
//   (mesmo princípio já usado por whatsapp_unread_counts() — nunca um
//   contador/estado que possa divergir).
// - adiamento ativo e evaluation não-blocked -> força status=WAITING,
//   reason=SNOOZED, dueAt=snoozedUntil (requisito 3: a UI mostra essa
//   data) — nunca altera blockers/suggestedAction/attemptCount
//   (preservados do cálculo original, para o histórico/contagem
//   continuarem corretos mesmo durante o adiamento).
export function applySnoozeToEvaluation(evaluation, snoozedUntil, now) {
  if (!evaluation || evaluation.status === FOLLOW_UP_STATUS.BLOCKED) return evaluation;
  if (!isSnoozeActive(snoozedUntil, now)) return evaluation;
  return {
    ...evaluation,
    status: FOLLOW_UP_STATUS.WAITING,
    eligible: false,
    reason: SNOOZE_REASON,
    dueAt: snoozedUntil,
    snoozedUntil,
  };
}

// Mapa { leadId -> snoozedUntil(ISO) } a partir das linhas já
// carregadas do banco (ver followUpSnoozesApi.fetchAll, db.js) — cada
// linha já vem mapeada para camelCase. Linha sem leadId/snoozedUntil
// válido é ignorada, nunca quebra as demais.
export function buildSnoozeMap(rows) {
  const map = {};
  for (const row of rows || []) {
    if (row && row.leadId && row.snoozedUntil) map[row.leadId] = row.snoozedUntil;
  }
  return map;
}

// Guarda de corrida para saveSnooze/removeSnooze assíncronos
// (useAppState.js) — MESMO contrato/MESMA lógica de
// shouldApplyStagePolicyResult (followUpPolicyConfig.js, Etapa B),
// deliberadamente duplicada aqui (3 linhas) em vez de importada: os
// dois módulos resolvem corridas para conceitos DIFERENTES (etapa de
// política vs. lead de adiamento) e cada um deve poder evoluir sem
// acoplar os dois domínios. Mesmo princípio de duplicação pequena e
// documentada já praticado em nextBestAction.js (EXECUTABLE_NEXT_ACTION_TYPES).
// `true` só quando a chamada que está resolvendo ainda é, ao mesmo
// tempo, da sessão ATUAL e a operação MAIS RECENTE iniciada para
// aquele lead.
export function shouldApplySnoozeResult({ requestUserId, currentUserId, requestSeq, currentSeq }) {
  return requestUserId === currentUserId && requestSeq === currentSeq;
}

// Correção pós-revisão do PR #75 (achado 6 — duplo clique/corrida).
// Extraídas como funções puras (mesmo princípio de
// shouldApplySnoozeResult acima) para serem testáveis isoladamente,
// sem precisar renderizar FollowUpQueue.jsx (este projeto não tem
// React Testing Library — mesma decisão já tomada nas Etapas A/B).
//
// `shouldStartSnoozeSave`: só prossegue com o salvamento se o preset
// clicado pertence ao MESMO lead cujo picker está aberto E não há
// nenhum salvamento já em voo (`saving`) — um segundo clique (no
// mesmo preset ou em outro) enquanto a primeira chamada ainda está
// em andamento é ignorado, nunca dispara uma segunda escrita
// concorrente para o mesmo lead.
export function shouldStartSnoozeSave({ snoozingLeadId, requestedLeadId, saving }) {
  return snoozingLeadId === requestedLeadId && !saving;
}

// `shouldStartSnoozeRemoval`: só prossegue com "Cancelar adiamento"
// se não há OUTRA remoção já em voo para o MESMO lead — remoções
// concorrentes para leads DIFERENTES continuam permitidas (cada card
// tem seu próprio estado de erro, ver removeSnoozeErrorsByLead em
// FollowUpQueue.jsx), só o mesmo lead nunca pode ter duas remoções
// simultâneas.
export function shouldStartSnoozeRemoval({ removingLeadId, requestedLeadId }) {
  return removingLeadId !== requestedLeadId;
}

// Rótulo humano local (horário do navegador do usuário — requisito
// "considere horário local"): a coluna no banco é armazenada em UTC
// (timestamptz, convertido automaticamente pelo driver/Postgres), e
// `new Date(iso)` + Intl aqui já exibem no fuso LOCAL do navegador,
// nunca UTC bruto. `null`/inválido -> null, nunca lança.
export function formatSnoozedUntilLabel(snoozedUntil) {
  if (!snoozedUntil) return null;
  const date = new Date(snoozedUntil);
  if (Number.isNaN(date.getTime())) return null;
  const datePart = date.toLocaleDateString('pt-BR');
  const timePart = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `Adiado até ${datePart} ${timePart}`;
}
