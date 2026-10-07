// Fase 2E.2 — camada de apresentação pura do Next Best Action. Traduz
// o contrato estruturado de evaluateNextBestAction (2E.1) em copy
// PT-BR mínima para a futura UI — nunca decide nada, só DESCREVE o que
// o engine já decidiu. Mesmo padrão já estabelecido por
// followUpPresentation.js (REASON_COPY) para o Follow-up Engine: a
// camada de apresentação nunca reimplementa a lógica de quem já decidiu.
//
// Zero imports de produção, de propósito — nem de nextBestAction.js:
// os mapas que esta camada precisa (type->channel, reasonCode->intent)
// não são exportados de lá (não alterado nesta fase) e são pequenos o
// bastante para existirem aqui como espelhos mínimos e documentados,
// usados SÓ para validação estrutural de fronteira (nunca para decidir
// o que recomendar — isso já veio decidido no `nba` recebido).
//
// Nunca usa Date.now(), nunca conhece status due/waiting/blocked
// (não recebido, não relevante aqui), nunca recebe lead/interactions/
// tasks/followUpEvaluation — só o objeto NBA já pronto, ou null.

const ACTION_LABEL = {
  call: 'Ligação',
  whatsapp: 'WhatsApp',
  meeting: 'Reunião',
  proposal: 'Proposta',
};

// Espelho mínimo de EXECUTABLE_ACTION_CHANNEL (followUpEngine.js, não
// exportada) — só para validar coerência estrutural type<->channel na
// fronteira de entrada (seção 16: nunca corrige, só recusa com null se
// incoerente). Mesma duplicação documentada já aceita em nextBestAction.js.
const TYPE_CHANNEL = {
  call: 'phone',
  whatsapp: 'whatsapp',
  meeting: 'in_person',
  proposal: 'manual',
};

// reasonCode é a fonte principal da copy (mais precisa que intent, que
// agrupa vários reasons sob o mesmo "retry" — ver nextBestAction.js).
// Wording deliberadamente curto e factual: nunca afirma timing
// ("agora"/"vencido"/"aguarde") nem fato comercial não comprovado pelo
// reason (ex. nunca "cliente interessado" — só o que o reason já prova).
const REASON_LABEL = {
  never_contacted: 'Primeiro contato',
  no_response_after_attempt: 'Nova tentativa de contato',
  cadence_exhausted: 'Cadência de contato esgotada',
  reactivation_due: 'Reativação',
  no_new_attempt_since_engagement: 'Retomar após resposta do cliente',
  no_response_after_proposal: 'Follow-up da proposta',
};

// Fase 2E.5.1A — espelho do mapa reasonCode->intent, mas agora POR
// CONJUNTO, não por valor único. Até a 2E.4, só o NBA atual
// (nextBestAction.js) alimentava esta camada, e ele produz exatamente
// 1 intent por reason. A partir da preparação para a Commercial Policy
// V1 (nextBestActionPolicy.js) assumir a recomendação operacional,
// esta camada precisa aceitar TAMBÉM os intents legítimos que a Policy
// produz — sem afrouxar o gate para "qualquer intent conhecido",
// preservando reason<->intent como um par fechado (seção 15/17 da
// especificação: nunca "aceita qualquer coisa").
//
// Conjunto confirmado por leitura direta dos dois módulos reais (nunca
// assumido de memória/especificação):
// - nextBestAction.js (NBA atual): never_contacted->first_contact,
//   no_response_after_attempt->retry, cadence_exhausted->retry,
//   reactivation_due->reactivate, no_new_attempt_since_engagement->retry,
//   no_response_after_proposal->proposal_follow_up (1 valor fixo por
//   reason, independente de confidence).
// - nextBestActionPolicy.js (Commercial Policy V1): never_contacted->
//   first_contact; no_response_after_attempt->retry (attemptCount<=1)
//   OU switch_channel (attemptCount>=2) OU retry (explicit, via seu
//   próprio REASON_INTENT base); cadence_exhausted->switch_channel
//   (rule) OU retry (explicit); reactivation_due->reactivate (rule e
//   explicit); no_new_attempt_since_engagement->continue_conversation
//   (rule e explicit); no_response_after_proposal->proposal_follow_up
//   (rule e explicit).
// União das duas fontes = o conjunto abaixo. `switch_channel` só é
// legítimo para no_response_after_attempt/cadence_exhausted — nunca
// para os outros 4 reasons (preserva o gate fechado).
const REASON_VALID_INTENTS = {
  never_contacted: new Set(['first_contact']),
  no_response_after_attempt: new Set(['retry', 'switch_channel']),
  cadence_exhausted: new Set(['retry', 'switch_channel']),
  reactivation_due: new Set(['reactivate']),
  no_new_attempt_since_engagement: new Set(['retry', 'continue_conversation']),
  no_response_after_proposal: new Set(['proposal_follow_up']),
};

function isKnownConfidence(confidence) {
  return confidence === 'rule' || confidence === 'explicit';
}

// Fase 2E.2 — única função pública desta camada. Recebe exatamente o
// que evaluateNextBestAction devolve (null, ou {type, channel, intent,
// reasonCode, confidence}) e devolve null ou {actionLabel, reasonLabel}.
// `confidence` nunca aparece no retorno (metadado interno, não copy de
// usuário — seção 12), mas sua presença/validade ainda é verificada:
// faz parte do contrato estrutural da 2E.1, e um valor ausente/
// desconhecido é tratado como contrato inválido (seção 18), igual a
// qualquer outro campo malformado — nunca "ignorado em silêncio".
export function presentNextBestAction(nba) {
  if (!nba || typeof nba !== 'object') return null;

  const { type, channel, intent, reasonCode, confidence } = nba;

  if (!Object.prototype.hasOwnProperty.call(ACTION_LABEL, type)) return null;
  if (channel !== TYPE_CHANNEL[type]) return null; // ausente OU incoerente: mesmo null, nunca corrigido
  if (!Object.prototype.hasOwnProperty.call(REASON_LABEL, reasonCode)) return null;
  if (!REASON_VALID_INTENTS[reasonCode].has(intent)) return null; // ausente OU fora do conjunto legítimo deste reason: mesmo null
  if (!isKnownConfidence(confidence)) return null;

  return {
    actionLabel: ACTION_LABEL[type],
    reasonLabel: REASON_LABEL[reasonCode],
  };
}
