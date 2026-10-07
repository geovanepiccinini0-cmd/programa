// Fase 2E.4.3 — comparador puro entre o NBA atual (produção,
// nextBestAction.js, 2E.1) e o NBA candidato (Commercial Policy V1,
// nextBestActionPolicy.js, 2E.4.2). Função mínima, sem decisão: só
// classifica a relação entre os dois outputs já calculados por quem
// chama — nunca recalcula nenhum dos dois, nunca lê lead/interactions/
// evaluation/history.
//
// Zero Supabase/fetch/window/document/storage/React/hooks/Date.now/
// Math.random/writes/imports de produção. Determinística.

// Mesmos 5 campos do contrato NBA (nextBestAction.js/
// nextBestActionPolicy.js): type, channel, intent, reasonCode,
// confidence. Comparação campo a campo, nunca JSON.stringify (ordem de
// propriedades nunca é garantida entre os dois módulos — ver seção 7
// da especificação) e nunca referência (===  de objeto): dois objetos
// NBA distintos com os mesmos 5 valores são operacionalmente iguais.
const NBA_FIELDS = ['type', 'channel', 'intent', 'reasonCode', 'confidence'];

function sameAction(a, b) {
  return NBA_FIELDS.every((field) => a[field] === b[field]);
}

export const NBA_SHADOW_STATUS = {
  MATCH: 'match',
  CHANGED_ACTION: 'changed_action',
  CURRENT_ONLY: 'current_only',
  CANDIDATE_ONLY: 'candidate_only',
  BOTH_NULL: 'both_null',
};

// Fase 2E.4.3 — API principal. Recebe os dois outputs JÁ CALCULADOS
// (current = evaluateNextBestAction(...), candidate =
// evaluateNextBestActionPolicy(...)) e devolve só a classificação da
// relação entre eles — nunca decide qual dos dois "está certo", nunca
// alimenta UI/CTA (isso é responsabilidade exclusiva de quem consome
// o resultado, e nesta fase ninguém consome para UI/CTA).
export function compareNextBestActions(current, candidate) {
  const hasCurrent = Boolean(current);
  const hasCandidate = Boolean(candidate);

  let status;
  if (!hasCurrent && !hasCandidate) {
    status = NBA_SHADOW_STATUS.BOTH_NULL;
  } else if (hasCurrent && !hasCandidate) {
    status = NBA_SHADOW_STATUS.CURRENT_ONLY;
  } else if (!hasCurrent && hasCandidate) {
    status = NBA_SHADOW_STATUS.CANDIDATE_ONLY;
  } else {
    status = sameAction(current, candidate) ? NBA_SHADOW_STATUS.MATCH : NBA_SHADOW_STATUS.CHANGED_ACTION;
  }

  return { status, current: current || null, candidate: candidate || null };
}
