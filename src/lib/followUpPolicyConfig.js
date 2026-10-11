import { STAGES } from '../constants.js';
import { FOLLOW_UP_POLICY } from './followUpEngine.js';

// Etapa B — Follow-up configurável por etapa do funil.
//
// Função pura, determinística, sem Supabase/React/efeitos colaterais —
// mesmo padrão de followUpEngine.js/followUpQueue.js. Resolve, para UMA
// etapa, a política de PRAZOS (QUANDO agir) que evaluateFollowUpEligibility
// (followUpEngine.js) deve usar — nunca decide QUAL CANAL recomendar
// (isso continua exclusivo de nextBestActionPolicy.js, intocado nesta
// fase) e nunca decide SE o lead está elegível (isso continua exclusivo
// de evaluateFollowUpEligibility, também intocado — este módulo só
// prepara o `policy` que ele já aceita como parâmetro opcional).
//
// DISTINÇÃO EXPLÍCITA (requisito 6 da autorização): "etapa" aqui é
// SEMPRE lead.etapa (funil comercial, STAGES de constants.js) — nunca
// confundido com atualização de CADASTRO (ultimaAtualizacao/criadoEm,
// ver utils.js/getStaleLeads, Etapa A) nem com histórico de INTERAÇÃO
// comercial (lead_interactions, buildCommercialInteractionHistory).
// Mudar essa configuração nunca cria task/interação — é só um dado de
// configuração, lido pelo motor na próxima avaliação (ver
// followUpQueue.js).

// Campos configuráveis — mesma forma de FOLLOW_UP_POLICY, cada um
// OPCIONAL (override parcial). Nenhum campo fora desta lista é
// aceito — "política padrão conservadora" (requisito 2) significa
// nunca aceitar um campo desconhecido/extra silenciosamente.
const OVERRIDE_FIELD_PATHS = [
  ['attempt', 'hoursUntilDue'],
  ['proposal', 'hoursUntilDue'],
  ['noNewAttemptSinceEngagement', 'hoursUntilDue'],
  ['reactivationAfterMaxAttempts', 'daysUntilDue'],
];

// Limites conservadores — nunca 0/negativo/não-finito, nunca um prazo
// absurdamente longo que tornaria o follow-up praticamente desativado
// por engano de digitação (ex. "8760" horas = 1 ano). Decisão de
// produto desta fase, documentada aqui para nunca ficar implícita.
const MIN_HOURS = 1;
const MAX_HOURS = 24 * 90; // 90 dias
const MIN_DAYS = 1;
const MAX_DAYS = 180;
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 20;

function isValidNumberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function getPath(obj, path) {
  return path.reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

// Só os valores REALMENTE válidos (número finito dentro do limite)
// sobrevivem — qualquer outra coisa (string, negativo, NaN, Infinity,
// ausente, fora do limite) é descartada silenciosamente PARA AQUELE
// CAMPO, caindo no default correspondente — nunca para a configuração
// inteira (um campo inválido não invalida os demais campos válidos do
// mesmo override), e nunca lança. "Silencioso" aqui é deliberado e
// seguro (requisito 2: nunca substituir uma regra válida por um valor
// quebrado) — a UI (FollowUpPolicySettings.jsx) é responsável por dar
// feedback de validação ANTES de salvar; este módulo é só a última
// linha de defesa, para nenhum dado malformado (ex. de uma versão
// futura/antiga do app, ou editado direto no banco) corromper o motor.
export function sanitizeStagePolicyOverride(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const sanitized = {};

  if (isValidNumberInRange(getPath(raw, ['attempt', 'hoursUntilDue']), MIN_HOURS, MAX_HOURS)) {
    sanitized.attempt = { hoursUntilDue: raw.attempt.hoursUntilDue };
  }
  if (isValidNumberInRange(getPath(raw, ['proposal', 'hoursUntilDue']), MIN_HOURS, MAX_HOURS)) {
    sanitized.proposal = { hoursUntilDue: raw.proposal.hoursUntilDue };
  }
  if (isValidNumberInRange(getPath(raw, ['noNewAttemptSinceEngagement', 'hoursUntilDue']), MIN_HOURS, MAX_HOURS)) {
    sanitized.noNewAttemptSinceEngagement = { hoursUntilDue: raw.noNewAttemptSinceEngagement.hoursUntilDue };
  }
  if (isValidNumberInRange(raw.maxAttempts, MIN_ATTEMPTS, MAX_ATTEMPTS)) {
    sanitized.maxAttempts = raw.maxAttempts;
  }
  if (isValidNumberInRange(getPath(raw, ['reactivationAfterMaxAttempts', 'daysUntilDue']), MIN_DAYS, MAX_DAYS)) {
    sanitized.reactivationAfterMaxAttempts = { daysUntilDue: raw.reactivationAfterMaxAttempts.daysUntilDue };
  }
  return sanitized;
}

// Mesclagem RASA por sub-objeto (nunca por campo individual dentro de
// `attempt`/`proposal`/etc., porque cada um deles só tem um campo hoje
// — mas mantém o contrato explícito: um override de `attempt` sempre
// substitui o `attempt` inteiro do base, nunca mescla parcialmente
// campos futuros que esse sub-objeto possa ganhar). `maxAttempts` é
// escalar, substitui direto.
function mergePolicy(basePolicy, override) {
  return {
    attempt: override.attempt || basePolicy.attempt,
    proposal: override.proposal || basePolicy.proposal,
    noNewAttemptSinceEngagement: override.noNewAttemptSinceEngagement || basePolicy.noNewAttemptSinceEngagement,
    maxAttempts: typeof override.maxAttempts === 'number' ? override.maxAttempts : basePolicy.maxAttempts,
    reactivationAfterMaxAttempts: override.reactivationAfterMaxAttempts || basePolicy.reactivationAfterMaxAttempts,
  };
}

// API principal — resolve a política efetiva para UMA etapa.
//
// `overridesByStage`: mapa { [etapa]: overrideParcialJÁSANITIZADO }
// (ver buildStagePolicyOverridesMap abaixo, que sempre sanitiza antes
// de montar o mapa — esta função AINDA sanitiza de novo o override
// encontrado, nunca confia ciegamente nem numa segunda chamada: defesa
// em profundidade, custo desprezível).
//
// Etapa ausente do mapa, mapa ausente/vazio, ou etapa desconhecida
// (fora de STAGES) -> devolve `basePolicy` SEM NENHUMA alteração,
// pelo mesmo objeto de referência quando não há override algum
// (nunca cria uma cópia desnecessária) — exatamente o comportamento
// anterior a esta fase (requisito 3: "preserve a compatibilidade",
// requisito 2: "sem substituir silenciosamente as regras existentes"
// quando não há configuração).
export function resolveFollowUpPolicyForStage(etapa, overridesByStage, basePolicy = FOLLOW_UP_POLICY) {
  if (!overridesByStage || typeof overridesByStage !== 'object') return basePolicy;
  if (!etapa || !STAGES.includes(etapa)) return basePolicy;

  const rawOverride = overridesByStage[etapa];
  if (!rawOverride) return basePolicy;

  const override = sanitizeStagePolicyOverride(rawOverride);
  if (Object.keys(override).length === 0) return basePolicy;

  return mergePolicy(basePolicy, override);
}

// Constrói o mapa { [etapa]: override } a partir das linhas já
// carregadas do banco (ver followUpStagePoliciesApi.fetchAll, db.js) —
// cada linha já vem mapeada para camelCase por
// followUpStagePolicyFromRow. Linhas de etapas desconhecidas (fora de
// STAGES — ex. uma etapa renomeada/removida depois que a configuração
// foi salva) são ignoradas, nunca quebram as demais. Sempre sanitiza
// cada override antes de guardar — nunca confia em dado vindo do
// banco sem validar de novo (pode ter sido escrito por uma versão
// futura/antiga do app).
export function buildStagePolicyOverridesMap(rows) {
  const map = {};
  for (const row of rows || []) {
    if (!row || !row.etapa || !STAGES.includes(row.etapa)) continue;
    const override = sanitizeStagePolicyOverride(row);
    if (Object.keys(override).length > 0) map[row.etapa] = override;
  }
  return map;
}
