import { CONTACT_ATTEMPT_TYPES } from '../constants.js';

// Fase 2E.4.1 — "memória comercial estruturada". Função pura e
// determinística que transforma o histórico BRUTO de lead_interactions
// de UM lead em um snapshot de sinais comerciais prontos para uma
// policy futura consumir (2E.4.2+). Esta camada NÃO decide nada: não
// escolhe canal, não recomenda ação, não sabe o que é "melhor". Só
// descreve o que já aconteceu, de forma neutra e auditável.
//
// Zero Supabase/fetch/window/document/localStorage/sessionStorage/
// Date.now/Math.random/React/hooks. Determinística: mesma entrada,
// mesma saída, sempre. Nunca lança para entrada malformada — só exclui
// com segurança o que não pode ser classificado.
//
// Import único de produção: CONTACT_ATTEMPT_TYPES (constants.js) — é a
// MESMA lista que followUpEngine.js e useAppState.js já reaproveitam
// (constants.js é módulo-folha, zero imports transitivos), para que a
// definição de "tipo de tentativa comercial" nunca divirja entre esta
// camada e o Follow-up Engine (ver seção 24 da investigação 2E.4.0 —
// paridade). Nenhum outro helper é importado do engine: os predicados
// abaixo são reimplementados aqui, de propósito (ver investigação:
// "se a reutilização exigir alterar o engine, preferir implementação
// pura independente") — followUpEngine.js permanece INTOCADO nesta
// fase (zero diff, confirmado pelo gate de diff da seção 29).

// --- Predicados de classificação ------------------------------------
//
// Espelham EXATAMENTE a semântica já homologada em followUpEngine.js
// (isContactAttemptInteraction/isProposalSentInteraction/
// isEngagementInteraction, funções privadas, não exportadas) — mesma
// leitura de type/direction/metadata.activity_class, mesmo resultado
// para os mesmos fatos. Isso é o que os testes de paridade (seção 24)
// comprovam: não uma garantia estrutural de import compartilhado
// (impossível sem alterar o engine), mas uma garantia comportamental
// testada contra fixtures equivalentes.

function isContactAttempt(it) {
  if (!CONTACT_ATTEMPT_TYPES.includes(it.type)) return false;
  if (it.direction !== 'outbound') return false;
  const cls = it.metadata && it.metadata.activity_class;
  return cls === 'attempt' || cls === 'engagement';
}

function isEngagement(it) {
  return Boolean(it.metadata) && it.metadata.activity_class === 'engagement';
}

// type==='proposal' + direction outbound + activity_class==='attempt' —
// mesmo contrato real usado por computeCommercialInteractionData
// (useAppState.js) para a chave 'proposal_sent'. Uma proposta legada
// sem metadata/activity_class não é promovida artificialmente a
// "proposta válida" (seção 7/20) — fica de fora de `proposals`, mas
// nunca derruba a função.
function isProposal(it) {
  return it.type === 'proposal' && it.direction === 'outbound' && Boolean(it.metadata) && it.metadata.activity_class === 'attempt';
}

// Projeção independente das outras três: type==='meeting' é um FATO
// estrutural direto (não uma inferência sobre metadata), por isso não
// exige activity_class para ser reconhecida como "um encontro
// aconteceu" — diferente de attempt/engagement, que são classificações
// que dependem de metadata. Uma reunião também pode (e tipicamente vai)
// aparecer em `attempts` e `engagements` simultaneamente — ver seção 8/17
// da especificação: não é duplicação semântica, são três perguntas
// diferentes sobre o mesmo fato ("foi uma tentativa de contato?", "foi
// um engajamento do cliente?", "foi uma reunião?").
function isMeeting(it) {
  return it.type === 'meeting';
}

// --- Canal -------------------------------------------------------------
//
// Espelho mínimo e documentado de EXECUTABLE_ACTION_CHANNEL
// (followUpEngine.js, privada, não exportada) — mesma duplicação já
// aceita em nextBestAction.js/nextBestActionPresentation.js para o
// mesmo propósito (não alterar o engine só para exportar uma constante).
// Só cobre os 3 tipos que também são contact attempts — 'proposal' fica
// de fora de propósito (canal 'manual' não é um canal comercial
// estruturado desta camada, ver seção 13).
const ATTEMPT_TYPE_CHANNEL = { call: 'phone', whatsapp: 'whatsapp', meeting: 'in_person' };

// Mesma precedência de buildSuggestedAction (followUpEngine.js): o
// `channel` já gravado na interaction vence quando presente; só cai
// para o mapa type->channel quando ausente (legado). Nunca inventa um
// canal fora dos 3 reconhecidos.
function resolveChannel(it) {
  return it.channel || ATTEMPT_TYPE_CHANNEL[it.type] || null;
}

// --- Tie-break determinístico -------------------------------------------
//
// occurredAt -> createdAt -> id. Nunca Date.now()/Math.random() (ver
// seção 10). occurredAt é sempre o critério primário (já filtrado como
// válido antes de chegar aqui — ver validOccurredAtTime); em caso de
// empate exato (dois registros com o mesmo occurredAt, cenário real
// possível com importação em lote ou relógio de cliente arredondado),
// createdAt desempata; se também faltar/empatar, o id (string,
// comparação lexicográfica) garante uma ordem 100% determinística, sem
// depender da ordem incidental do array de entrada.
function timeOrNull(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function compareChronological(a, b) {
  const ta = timeOrNull(a.occurredAt);
  const tb = timeOrNull(b.occurredAt);
  if (ta !== tb) return ta - tb;

  const ca = timeOrNull(a.createdAt);
  const cb = timeOrNull(b.createdAt);
  if (ca !== null && cb !== null && ca !== cb) return ca - cb;
  if (ca !== null && cb === null) return -1;
  if (ca === null && cb !== null) return 1;

  const ida = a.id != null ? String(a.id) : '';
  const idb = b.id != null ? String(b.id) : '';
  if (ida < idb) return -1;
  if (ida > idb) return 1;
  return 0;
}

// Só participa de QUALQUER projeção desta camada (attempts/engagements/
// proposals/meetings) quem tem occurredAt válido — ver seção 11.
// Nenhuma das quatro listas tem sentido sem ordenação cronológica
// confiável, então a exclusão é uniforme para as quatro, nunca um
// timestamp fabricado. Uma interaction excluída aqui não conta para
// attemptCount/attemptCountByChannel (que são derivados de `attempts`),
// nem aparece em lastX/previousX — ela simplesmente não existiu para
// esta camada, de forma conservadora.
function hasValidOccurredAt(it) {
  return timeOrNull(it.occurredAt) !== null;
}

function isPlainInteraction(it) {
  return Boolean(it) && typeof it === 'object';
}

function sortedProjection(interactions, predicate) {
  return interactions
    .filter((it) => isPlainInteraction(it) && hasValidOccurredAt(it) && predicate(it))
    .sort(compareChronological);
}

const EMPTY_ATTEMPT_COUNT_BY_CHANNEL = { phone: 0, whatsapp: 0, in_person: 0 };

// Fase 2E.4.1 — API principal. Recebe SOMENTE as interactions já
// pertencentes a um lead (nunca busca banco, nunca recebe leadId/
// userId/tasks/lead/now — ver seção 4). Tolera null/undefined como
// "sem histórico" (equivalente a array vazio) para não empurrar uma
// checagem defensiva redundante para todo chamador — qualquer outra
// entrada não-array é tratada do mesmo jeito (seção 23.B).
//
// Nunca ordena/muta o array recebido (cada projeção é um array NOVO,
// resultado de filter+sort sobre uma cópia); os objetos de interaction
// dentro das projeções são as MESMAS referências originais (nunca
// clonadas) — a função nunca os modifica, então isso é seguro (ver
// seção 12).
//
// IMPORTANTE: esta camada descreve histórico BRUTO. attemptCount/
// attemptCountByChannel são totais sobre TODO o histórico fornecido —
// não aplicam nenhuma noção de "desde o último engagement" (isso é
// uma decisão de Follow-up Engine/policy, não desta camada, ver seção
// 18). Não decide canal, não recomenda ação, não sabe o que é due/
// waiting/blocked.
export function buildCommercialInteractionHistory(interactions) {
  const list = Array.isArray(interactions) ? interactions : [];

  const attempts = sortedProjection(list, isContactAttempt);
  const engagements = sortedProjection(list, isEngagement);
  const proposals = sortedProjection(list, isProposal);
  const meetings = sortedProjection(list, isMeeting);

  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const previousAttempt = attempts.length > 1 ? attempts[attempts.length - 2] : null;
  const lastEngagement = engagements.length ? engagements[engagements.length - 1] : null;
  const lastProposal = proposals.length ? proposals[proposals.length - 1] : null;
  const lastMeeting = meetings.length ? meetings[meetings.length - 1] : null;

  const attemptCountByChannel = { ...EMPTY_ATTEMPT_COUNT_BY_CHANNEL };
  attempts.forEach((it) => {
    const channel = resolveChannel(it);
    if (Object.prototype.hasOwnProperty.call(attemptCountByChannel, channel)) {
      attemptCountByChannel[channel] += 1;
    }
  });

  return {
    attempts,
    engagements,
    proposals,
    meetings,

    lastAttempt,
    previousAttempt,

    lastEngagement,
    lastProposal,
    lastMeeting,

    attemptCount: attempts.length,
    attemptCountByChannel,

    lastAttemptChannel: lastAttempt ? resolveChannel(lastAttempt) : null,
    previousAttemptChannel: previousAttempt ? resolveChannel(previousAttempt) : null,
    lastEngagementChannel: lastEngagement ? resolveChannel(lastEngagement) : null,
  };
}
