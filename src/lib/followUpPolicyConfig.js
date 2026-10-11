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

// Limites conservadores — nunca 0/negativo/não-finito/não-inteiro,
// nunca um prazo absurdamente longo que tornaria o follow-up
// praticamente desativado por engano de digitação (ex. "8760" horas =
// 1 ano). Decisão de produto desta fase, documentada aqui para nunca
// ficar implícita.
const MIN_HOURS = 1;
const MAX_HOURS = 24 * 90; // 90 dias
const MIN_DAYS = 1;
const MAX_DAYS = 180;
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 20;

// Correção pós-revisão do PR #74 (achado CONFIRMED): exige INTEIRO,
// não só "número finito". As colunas da migration 026 são `integer` —
// um valor como 2.5 passava por Number.isFinite, era aceito em JS, e
// só falhava tarde (na gravação, com um erro de banco pouco claro
// para o usuário) ou era truncado silenciosamente pelo driver. Agora
// a MESMA regra (inteiro dentro do limite) vale tanto para
// sanitizeStagePolicyOverride (defesa em profundidade/dado vindo do
// banco) quanto para validateStagePolicyForm (feedback imediato na
// UI, ver abaixo) — nunca duas definições divergentes do que é
// "válido".
function isValidIntegerInRange(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
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

  if (isValidIntegerInRange(getPath(raw, ['attempt', 'hoursUntilDue']), MIN_HOURS, MAX_HOURS)) {
    sanitized.attempt = { hoursUntilDue: raw.attempt.hoursUntilDue };
  }
  if (isValidIntegerInRange(getPath(raw, ['proposal', 'hoursUntilDue']), MIN_HOURS, MAX_HOURS)) {
    sanitized.proposal = { hoursUntilDue: raw.proposal.hoursUntilDue };
  }
  if (isValidIntegerInRange(getPath(raw, ['noNewAttemptSinceEngagement', 'hoursUntilDue']), MIN_HOURS, MAX_HOURS)) {
    sanitized.noNewAttemptSinceEngagement = { hoursUntilDue: raw.noNewAttemptSinceEngagement.hoursUntilDue };
  }
  if (isValidIntegerInRange(raw.maxAttempts, MIN_ATTEMPTS, MAX_ATTEMPTS)) {
    sanitized.maxAttempts = raw.maxAttempts;
  }
  if (isValidIntegerInRange(getPath(raw, ['reactivationAfterMaxAttempts', 'daysUntilDue']), MIN_DAYS, MAX_DAYS)) {
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

// --- Formulário (FollowUpPolicySettings.jsx) ---------------------------
//
// Correção pós-revisão do PR #74 (achado CONFIRMED) — movidas do
// componente para aqui: puras, testáveis sem renderizar React/sem
// nenhuma biblioteca de teste de componente nova (este projeto nunca
// usou React Testing Library — mantém a convenção de testar a LÓGICA
// extraída, nunca o JSX em si).

const FORM_FIELD_SPECS = [
  { key: 'attemptHours', path: ['attempt', 'hoursUntilDue'], label: 'Retorno após tentativa (horas)', min: MIN_HOURS, max: MAX_HOURS },
  { key: 'proposalHours', path: ['proposal', 'hoursUntilDue'], label: 'Retorno após proposta (horas)', min: MIN_HOURS, max: MAX_HOURS },
  { key: 'noNewAttemptHours', path: ['noNewAttemptSinceEngagement', 'hoursUntilDue'], label: 'Parado após engajamento (horas)', min: MIN_HOURS, max: MAX_HOURS },
  { key: 'maxAttempts', path: ['maxAttempts'], label: 'Número de tentativas', min: MIN_ATTEMPTS, max: MAX_ATTEMPTS },
  { key: 'reactivationDays', path: ['reactivationAfterMaxAttempts', 'daysUntilDue'], label: 'Reativação (dias)', min: MIN_DAYS, max: MAX_DAYS },
];

export function emptyStagePolicyForm() {
  return { attemptHours: '', proposalHours: '', noNewAttemptHours: '', maxAttempts: '', reactivationDays: '' };
}

// override (forma aninhada, já sanitizada ou não) -> form (strings de
// <input>, uma por campo). Campo ausente no override = string vazia
// (nunca "0"/"undefined") — representa "sem configuração", o mesmo
// significado usado por formToOverride/sanitizeStagePolicyOverride.
export function overrideToForm(override) {
  const form = emptyStagePolicyForm();
  if (!override || typeof override !== 'object') return form;
  for (const { key, path } of FORM_FIELD_SPECS) {
    const value = getPath(override, path);
    if (typeof value === 'number') form[key] = String(value);
  }
  return form;
}

// form -> override (forma aninhada). Campo vazio/ausente nunca entra
// no resultado — nunca um 0/NaN que pareceria um valor real
// configurado. Não valida (ver validateStagePolicyForm/
// sanitizeStagePolicyOverride) — só reestrutura.
export function formToOverride(form) {
  const override = {};
  for (const { key, path } of FORM_FIELD_SPECS) {
    const raw = form && form[key];
    if (raw === '' || raw === undefined || raw === null) continue;
    const container = path.length === 2 ? (override[path[0]] = override[path[0]] || {}) : override;
    const leafKey = path[path.length - 1];
    container[leafKey] = Number(raw);
  }
  return override;
}

// Correção pós-revisão do PR #74 (achado CONFIRMED, item 1) —
// validação PARA A UI, distinta de sanitizeStagePolicyOverride: aqui
// um campo PREENCHIDO mas inválido (decimal, negativo, fora do
// limite, não-numérico) gera um erro ESPECÍFICO para aquele campo e
// NUNCA é descartado silenciosamente — o chamador (FollowUpPolicySettings.jsx)
// deve bloquear o salvamento inteiro enquanto houver qualquer erro,
// nunca salvar só os campos válidos e ignorar os inválidos. Campo
// vazio nunca é erro (significa "não configurar este campo").
// Mesma regra de validade de sanitizeStagePolicyOverride
// (isValidIntegerInRange) — nunca uma segunda definição de "válido".
export function validateStagePolicyForm(form) {
  const errors = {};
  for (const { key, label, min, max } of FORM_FIELD_SPECS) {
    const raw = form && form[key];
    if (raw === '' || raw === undefined || raw === null) continue;
    const num = Number(raw);
    if (!isValidIntegerInRange(num, min, max)) {
      errors[key] = `${label}: informe um número inteiro entre ${min} e ${max}.`;
    }
  }
  return errors;
}

// --- Sincronização do formulário com dados assíncronos ------------------
//
// Correção pós-revisão do PR #74 (achado CONFIRMED, item 2) —
// FollowUpPolicySettings.jsx inicializava `form` a partir das props
// ANTES do fetch assíncrono de stagePolicyOverrides terminar; depois
// de carregar, nada forçava uma nova sincronização, então o
// formulário podia ficar vazio mesmo havendo configuração salva — e
// salvar nesse estado sobrescreveria (zeraria) a configuração
// existente. A correção: só resincroniza quando a etapa EXIBIDA
// ainda não corresponde à etapa cujo dado já carregado foi aplicado
// (`initializedStage`) E o carregamento já terminou — nunca
// resincroniza em cima de uma edição em andamento na MESMA etapa já
// inicializada (ex. uma atualização de Realtime/re-fetch não deve
// apagar o que o usuário está digitando).
export function shouldSyncStagePolicyForm({ loading, selectedStage, initializedStage }) {
  if (loading) return false;
  return initializedStage !== selectedStage;
}

// --- Guarda de corrida para save/remove assíncronos (useAppState.js) ----
//
// Correção pós-revisão do PR #74 (achado CONFIRMED, item 3) —
// saveStagePolicy/removeStagePolicy são chamadas assíncronas; sem
// esta guarda, dois cenários corrompiam o estado local:
// 1) o usuário troca de sessão (logout/login de outro usuário)
//    enquanto uma chamada da sessão ANTERIOR ainda está em voo — ao
//    resolver, ela aplicaria dados de um usuário à sessão do usuário
//    NOVO.
// 2) duas operações concorrentes para a MESMA etapa (ex. dois cliques
//    rápidos em "Salvar", ou "Salvar" seguido de "Voltar ao padrão"
//    antes do primeiro terminar) resolvem fora de ordem — sem
//    nenhuma guarda, a resposta mais LENTA venceria mesmo sendo a
//    mais ANTIGA, desfazendo silenciosamente a ação mais recente do
//    usuário.
// Pura — recebe só os quatro identificadores já capturados pelo
// chamador (nunca lê estado/closures diretamente), testável sem
// mockar Supabase/React. `true` só quando a chamada que está
// resolvendo ainda é, ao mesmo tempo, da sessão atual E a operação
// mais recente iniciada para aquela etapa.
export function shouldApplyStagePolicyResult({ requestUserId, currentUserId, requestSeq, currentSeq }) {
  return requestUserId === currentUserId && requestSeq === currentSeq;
}
