import { FOLLOW_UP_REASON, FOLLOW_UP_STATUS } from './followUpEngine.js';

// Fase 2E.1 — fundação pura do Next Best Action ("o que fazer"),
// deliberadamente separada do Follow-up Engine ("quando agir").
//
// Zero React, zero Supabase, zero DOM, zero efeito colateral. Importa
// só os ENUMS já públicos de followUpEngine.js (FOLLOW_UP_REASON/
// FOLLOW_UP_STATUS) — leitura, não alteração (zero diff nesse arquivo) —
// para nunca duplicar os códigos de reason como strings mágicas soltas;
// esse módulo em si não importa React/Supabase, então a cadeia
// permanece pura. Nunca usa Date.now() internamente (now/policy não são
// necessários na política desta fase — ver comentário no fim do
// arquivo). Determinística: mesma entrada, mesma saída, sempre.
//
// PRINCÍPIO CENTRAL DESTA FASE: evaluateNextBestAction NUNCA recalcula
// reason/blockers/dueAt/attemptCount nem re-caminha `interactions` para
// redescobrir "qual foi a última tentativa" — followUpEvaluation já é a
// fonte de verdade para isso, e `followUpEvaluation.suggestedAction`
// (produzido por followUpEngine.js) já contém exatamente o par
// {type, channel} inferido com a precedência correta (nextActionType
// explícito > última tentativa executável). Reaproveitar esse valor em
// vez de recalculá-lo é o que elimina qualquer necessidade de reproduzir
// o tie-break de maxInteractionBy (ver seção "TIE-BREAK" abaixo) — a
// menor duplicação possível é nenhuma duplicação.
//
// `interactions`/`tasks`/`now`/`policy` permanecem no contrato da função
// (estabilidade de assinatura para fases futuras — ver investigação
// 2E.0, seção 31, reaproveitamento das mesmas fatias já indexadas por
// buildFollowUpQueue), mas NÃO são lidos pela política desta fase: nada
// aqui precisa deles, e introduzir lógica só para "usar o parâmetro"
// seria lógica artificial (fora do escopo pedido).

// Espelho mínimo e documentado de EXECUTABLE_ACTION_CHANNEL
// (followUpEngine.js) — essa constante não é exportada de lá (módulo
// intencionalmente intocado nesta fase) e mover/exportar constantes
// existentes está fora do escopo da 2E.1. Por isso: só o CONJUNTO de
// chaves (nunca os valores de canal, que nunca são recomputados aqui —
// sempre vêm de followUpEvaluation.suggestedAction.channel). Se esse
// conjunto mudar em followUpEngine.js, este espelho precisa acompanhar
// manualmente — duplicação temporária, documentada de propósito.
const EXECUTABLE_NEXT_ACTION_TYPES = new Set(['call', 'whatsapp', 'meeting', 'proposal']);

function isExplicitExecutable(nextActionType) {
  return Boolean(nextActionType) && EXECUTABLE_NEXT_ACTION_TYPES.has(nextActionType);
}

// Fase 2E.1 — mapa reason -> intent. Só os 6 reasons reais de
// followUpEngine.js (FOLLOW_UP_REASON) entram aqui — qualquer reason
// fora deste mapa (incluindo null, do caso blocked, ou um valor
// desconhecido/legado) nunca produz uma recomendação: null é sempre
// preferível a uma intent fabricada (ver investigação 2E.0, seção 21).
const REASON_INTENT = {
  [FOLLOW_UP_REASON.NEVER_CONTACTED]: 'first_contact',
  [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT]: 'retry',
  [FOLLOW_UP_REASON.CADENCE_EXHAUSTED]: 'retry',
  [FOLLOW_UP_REASON.REACTIVATION_DUE]: 'reactivate',
  [FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT]: 'retry',
  [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL]: 'proposal_follow_up',
};

// Fase 2E.1 — política V1: reproduz o comportamento atual de
// suggestedAction, exceto por uma decisão explícita e documentada:
// `no_response_after_proposal` SEM intenção explícita do vendedor
// SEMPRE retorna null, mesmo que followUpEvaluation.suggestedAction
// esteja preenchido. Motivo (confirmado por investigação 2E.0 + teste
// de regressão abaixo): se existir uma tentativa (call/whatsapp/meeting)
// ANTERIOR à proposta, buildSuggestedAction ainda a usa como fallback —
// isso recomendaria repetir um canal já obsoleto desde que a proposta
// foi enviada, o que não corresponde à intenção comercial real deste
// reason ("proposta sem resposta"). Fechar esse vazamento é uma decisão
// consciente desta fase (gate explícito, não um bug novo) — NÃO é o
// fechamento do gap mais amplo ("qual ação recomendar após proposta"),
// que continua null até uma decisão de produto futura (2E.0, seção 13).
export function evaluateNextBestAction({ lead, followUpEvaluation }) {
  if (!followUpEvaluation || followUpEvaluation.status === FOLLOW_UP_STATUS.BLOCKED) return null;

  const reasonCode = followUpEvaluation.reason;
  if (!reasonCode || !Object.prototype.hasOwnProperty.call(REASON_INTENT, reasonCode)) return null;

  const explicit = isExplicitExecutable(lead && lead.nextActionType);

  if (reasonCode === FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL && !explicit) return null;

  const suggested = followUpEvaluation.suggestedAction;
  if (!suggested) return null;

  return {
    type: suggested.type,
    channel: suggested.channel,
    intent: REASON_INTENT[reasonCode],
    reasonCode,
    confidence: explicit ? 'explicit' : 'rule',
  };
}
