import { describe, expect, test } from 'vitest';
import {
  sanitizeStagePolicyOverride,
  resolveFollowUpPolicyForStage,
  buildStagePolicyOverridesMap,
  emptyStagePolicyForm,
  overrideToForm,
  formToOverride,
  validateStagePolicyForm,
  shouldSyncStagePolicyForm,
  shouldApplyStagePolicyResult,
} from './followUpPolicyConfig.js';
import { FOLLOW_UP_POLICY } from './followUpEngine.js';

describe('sanitizeStagePolicyOverride', () => {
  test('mantém só campos válidos (número finito dentro do limite)', () => {
    const result = sanitizeStagePolicyOverride({
      attempt: { hoursUntilDue: 12 },
      proposal: { hoursUntilDue: 36 },
      noNewAttemptSinceEngagement: { hoursUntilDue: 72 },
      maxAttempts: 5,
      reactivationAfterMaxAttempts: { daysUntilDue: 14 },
    });
    expect(result).toEqual({
      attempt: { hoursUntilDue: 12 },
      proposal: { hoursUntilDue: 36 },
      noNewAttemptSinceEngagement: { hoursUntilDue: 72 },
      maxAttempts: 5,
      reactivationAfterMaxAttempts: { daysUntilDue: 14 },
    });
  });

  test('valores inválidos (negativo, zero, string, NaN, Infinity) são descartados campo a campo, nunca lançam', () => {
    const result = sanitizeStagePolicyOverride({
      attempt: { hoursUntilDue: -5 },
      proposal: { hoursUntilDue: 0 },
      noNewAttemptSinceEngagement: { hoursUntilDue: 'abc' },
      maxAttempts: NaN,
      reactivationAfterMaxAttempts: { daysUntilDue: Infinity },
    });
    expect(result).toEqual({});
  });

  test('valor fora do limite máximo (ex. 1 ano em horas) é descartado', () => {
    const result = sanitizeStagePolicyOverride({ attempt: { hoursUntilDue: 24 * 365 } });
    expect(result).toEqual({});
  });

  test('um campo inválido nunca invalida os demais campos válidos do mesmo override', () => {
    const result = sanitizeStagePolicyOverride({
      attempt: { hoursUntilDue: 10 },
      proposal: { hoursUntilDue: -1 },
    });
    expect(result).toEqual({ attempt: { hoursUntilDue: 10 } });
  });

  test('override vazio/nulo/indefinido/não-objeto -> {}, nunca lança', () => {
    expect(sanitizeStagePolicyOverride({})).toEqual({});
    expect(sanitizeStagePolicyOverride(null)).toEqual({});
    expect(sanitizeStagePolicyOverride(undefined)).toEqual({});
    expect(sanitizeStagePolicyOverride('texto')).toEqual({});
    expect(sanitizeStagePolicyOverride(42)).toEqual({});
  });

  test('maxAttempts no limite (1 e 20) é aceito; fora do limite (0 e 21) é descartado', () => {
    expect(sanitizeStagePolicyOverride({ maxAttempts: 1 })).toEqual({ maxAttempts: 1 });
    expect(sanitizeStagePolicyOverride({ maxAttempts: 20 })).toEqual({ maxAttempts: 20 });
    expect(sanitizeStagePolicyOverride({ maxAttempts: 0 })).toEqual({});
    expect(sanitizeStagePolicyOverride({ maxAttempts: 21 })).toEqual({});
  });

  test('sub-objeto malformado (ex. attempt não é objeto) é descartado sem lançar', () => {
    expect(sanitizeStagePolicyOverride({ attempt: 10 })).toEqual({});
    expect(sanitizeStagePolicyOverride({ attempt: null })).toEqual({});
  });
});

describe('resolveFollowUpPolicyForStage — compatibilidade com o comportamento anterior', () => {
  test('sem overridesByStage (ausente/nulo) -> devolve basePolicy pela MESMA referência, nunca uma cópia', () => {
    expect(resolveFollowUpPolicyForStage('Proposta', undefined, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
    expect(resolveFollowUpPolicyForStage('Proposta', null, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
  });

  test('etapa sem nenhuma configuração salva -> devolve basePolicy pela MESMA referência', () => {
    expect(resolveFollowUpPolicyForStage('Proposta', {}, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
    expect(resolveFollowUpPolicyForStage('Proposta', { Negociação: { maxAttempts: 2 } }, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
  });

  test('etapa nula/vazia/desconhecida (fora de STAGES) -> devolve basePolicy, nunca lança', () => {
    const overrides = { Proposta: { maxAttempts: 1 } };
    expect(resolveFollowUpPolicyForStage(null, overrides, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
    expect(resolveFollowUpPolicyForStage('', overrides, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
    expect(resolveFollowUpPolicyForStage('Etapa Inexistente', overrides, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
  });

  test('override presente mas totalmente inválido (sanitiza para {}) -> devolve basePolicy, nunca um objeto quebrado', () => {
    const overrides = { Proposta: { maxAttempts: -1, attempt: { hoursUntilDue: 'nunca' } } };
    expect(resolveFollowUpPolicyForStage('Proposta', overrides, FOLLOW_UP_POLICY)).toBe(FOLLOW_UP_POLICY);
  });
});

describe('resolveFollowUpPolicyForStage — mesclagem de override parcial', () => {
  const base = FOLLOW_UP_POLICY;

  test('override parcial substitui só os campos configurados, preserva os demais do default', () => {
    const overrides = { Proposta: { proposal: { hoursUntilDue: 12 } } };
    const resolved = resolveFollowUpPolicyForStage('Proposta', overrides, base);
    expect(resolved).toEqual({
      attempt: base.attempt,
      proposal: { hoursUntilDue: 12 },
      noNewAttemptSinceEngagement: base.noNewAttemptSinceEngagement,
      maxAttempts: base.maxAttempts,
      reactivationAfterMaxAttempts: base.reactivationAfterMaxAttempts,
    });
  });

  test('override completo substitui todos os 5 campos', () => {
    const fullOverride = {
      attempt: { hoursUntilDue: 6 },
      proposal: { hoursUntilDue: 24 },
      noNewAttemptSinceEngagement: { hoursUntilDue: 48 },
      maxAttempts: 2,
      reactivationAfterMaxAttempts: { daysUntilDue: 3 },
    };
    const overrides = { Negociação: fullOverride };
    const resolved = resolveFollowUpPolicyForStage('Negociação', overrides, base);
    expect(resolved).toEqual(fullOverride);
  });

  test('outra etapa sem override continua com basePolicy inalterada (isolamento entre etapas)', () => {
    const overrides = { Proposta: { maxAttempts: 1 } };
    expect(resolveFollowUpPolicyForStage('Negociação', overrides, base)).toBe(base);
  });

  test('nunca muta basePolicy nem o override de entrada', () => {
    const overrides = { Proposta: { maxAttempts: 1 } };
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    const overridesSnapshot = JSON.parse(JSON.stringify(overrides));
    resolveFollowUpPolicyForStage('Proposta', overrides, base);
    expect(base).toEqual(baseSnapshot);
    expect(overrides).toEqual(overridesSnapshot);
  });
});

describe('buildStagePolicyOverridesMap', () => {
  test('monta o mapa etapa -> override a partir das linhas carregadas', () => {
    const rows = [
      { etapa: 'Proposta', maxAttempts: 2 },
      { etapa: 'Negociação', proposal: { hoursUntilDue: 10 } },
    ];
    expect(buildStagePolicyOverridesMap(rows)).toEqual({
      Proposta: { maxAttempts: 2 },
      Negociação: { proposal: { hoursUntilDue: 10 } },
    });
  });

  test('linha de etapa desconhecida (fora de STAGES) é ignorada, nunca quebra as demais', () => {
    const rows = [
      { etapa: 'Etapa Removida', maxAttempts: 2 },
      { etapa: 'Proposta', maxAttempts: 3 },
    ];
    expect(buildStagePolicyOverridesMap(rows)).toEqual({ Proposta: { maxAttempts: 3 } });
  });

  test('linha sem nenhum campo válido não entra no mapa', () => {
    const rows = [{ etapa: 'Proposta', maxAttempts: -1 }];
    expect(buildStagePolicyOverridesMap(rows)).toEqual({});
  });

  test('linha nula/sem etapa é ignorada, nunca lança', () => {
    expect(buildStagePolicyOverridesMap([null, { maxAttempts: 2 }, undefined])).toEqual({});
  });

  test('lista vazia/nula/indefinida -> mapa vazio, nunca lança', () => {
    expect(buildStagePolicyOverridesMap([])).toEqual({});
    expect(buildStagePolicyOverridesMap(null)).toEqual({});
    expect(buildStagePolicyOverridesMap(undefined)).toEqual({});
  });

  test('sempre sanitiza de novo — um valor inválido vindo do banco nunca chega ao mapa', () => {
    const rows = [{ etapa: 'Proposta', maxAttempts: 2, attempt: { hoursUntilDue: -10 } }];
    expect(buildStagePolicyOverridesMap(rows)).toEqual({ Proposta: { maxAttempts: 2 } });
  });
});

// Correção pós-revisão do PR #74 (achado CONFIRMED 1) — valores
// decimais devem ser rejeitados em TODOS os campos, tanto pelo
// sanitizador defensivo quanto pelo validador de formulário.
describe('sanitizeStagePolicyOverride — correção pós-revisão do PR #74 (exige inteiro)', () => {
  test('valor decimal (ex. 2.5) é descartado, mesmo dentro do limite numérico', () => {
    expect(sanitizeStagePolicyOverride({ attempt: { hoursUntilDue: 2.5 } })).toEqual({});
    expect(sanitizeStagePolicyOverride({ proposal: { hoursUntilDue: 10.1 } })).toEqual({});
    expect(sanitizeStagePolicyOverride({ maxAttempts: 2.5 })).toEqual({});
    expect(sanitizeStagePolicyOverride({ reactivationAfterMaxAttempts: { daysUntilDue: 3.9 } })).toEqual({});
  });

  test('valor inteiro continua aceito normalmente', () => {
    expect(sanitizeStagePolicyOverride({ attempt: { hoursUntilDue: 2 } })).toEqual({ attempt: { hoursUntilDue: 2 } });
  });
});

describe('overrideToForm / formToOverride (Etapa B, correção pós-revisão do PR #74)', () => {
  test('overrideToForm converte override aninhado para strings de formulário', () => {
    const override = {
      attempt: { hoursUntilDue: 10 },
      proposal: { hoursUntilDue: 20 },
      noNewAttemptSinceEngagement: { hoursUntilDue: 30 },
      maxAttempts: 4,
      reactivationAfterMaxAttempts: { daysUntilDue: 5 },
    };
    expect(overrideToForm(override)).toEqual({
      attemptHours: '10', proposalHours: '20', noNewAttemptHours: '30', maxAttempts: '4', reactivationDays: '5',
    });
  });

  test('overrideToForm com override vazio/nulo -> formulário vazio, nunca lança', () => {
    expect(overrideToForm({})).toEqual(emptyStagePolicyForm());
    expect(overrideToForm(null)).toEqual(emptyStagePolicyForm());
    expect(overrideToForm(undefined)).toEqual(emptyStagePolicyForm());
  });

  test('formToOverride converte de volta, ida e volta preserva o valor', () => {
    const override = { attempt: { hoursUntilDue: 7 }, maxAttempts: 2 };
    expect(formToOverride(overrideToForm(override))).toEqual(override);
  });

  test('formToOverride ignora campos vazios, nunca inventa 0', () => {
    const form = { ...emptyStagePolicyForm(), maxAttempts: '3' };
    expect(formToOverride(form)).toEqual({ maxAttempts: 3 });
  });
});

describe('validateStagePolicyForm (Etapa B, correção pós-revisão do PR #74 — achado 1)', () => {
  test('formulário totalmente vazio -> nenhum erro (nada para validar)', () => {
    expect(validateStagePolicyForm(emptyStagePolicyForm())).toEqual({});
  });

  test('todos os campos válidos (inteiros dentro do limite) -> nenhum erro', () => {
    const form = { attemptHours: '10', proposalHours: '20', noNewAttemptHours: '30', maxAttempts: '2', reactivationDays: '5' };
    expect(validateStagePolicyForm(form)).toEqual({});
  });

  test('campo decimal gera erro ESPECÍFICO para aquele campo, nunca descarta silenciosamente', () => {
    const form = { ...emptyStagePolicyForm(), attemptHours: '2.5' };
    const errors = validateStagePolicyForm(form);
    expect(errors).toHaveProperty('attemptHours');
    expect(errors.attemptHours).toMatch(/inteiro/);
  });

  test('um campo inválido NUNCA afeta a validação dos demais campos válidos', () => {
    const form = { ...emptyStagePolicyForm(), attemptHours: '10', proposalHours: '-5' };
    const errors = validateStagePolicyForm(form);
    expect(errors).toHaveProperty('proposalHours');
    expect(errors).not.toHaveProperty('attemptHours');
  });

  test('valor fora do limite (0, negativo, acima do máximo) gera erro', () => {
    expect(validateStagePolicyForm({ ...emptyStagePolicyForm(), maxAttempts: '0' })).toHaveProperty('maxAttempts');
    expect(validateStagePolicyForm({ ...emptyStagePolicyForm(), maxAttempts: '21' })).toHaveProperty('maxAttempts');
    expect(validateStagePolicyForm({ ...emptyStagePolicyForm(), reactivationDays: '-1' })).toHaveProperty('reactivationDays');
  });

  test('valor não-numérico (texto) gera erro, nunca lança', () => {
    const errors = validateStagePolicyForm({ ...emptyStagePolicyForm(), attemptHours: 'abc' });
    expect(errors).toHaveProperty('attemptHours');
  });

  test('múltiplos campos inválidos -> um erro por campo, todos reportados', () => {
    const form = { attemptHours: '2.5', proposalHours: '-1', noNewAttemptHours: '', maxAttempts: '100', reactivationDays: '0' };
    const errors = validateStagePolicyForm(form);
    expect(Object.keys(errors).sort()).toEqual(['attemptHours', 'maxAttempts', 'proposalHours', 'reactivationDays']);
  });
});

describe('shouldSyncStagePolicyForm (Etapa B, correção pós-revisão do PR #74 — achado 2)', () => {
  test('ainda carregando -> nunca sincroniza, mesmo com etapa diferente', () => {
    expect(shouldSyncStagePolicyForm({ loading: true, selectedStage: 'Proposta', initializedStage: null })).toBe(false);
  });

  test('carregamento concluído e etapa ainda não inicializada (null, primeiro carregamento) -> sincroniza', () => {
    expect(shouldSyncStagePolicyForm({ loading: false, selectedStage: 'Proposta', initializedStage: null })).toBe(true);
  });

  test('carregamento concluído e etapa selecionada MUDOU -> sincroniza (troca deliberada de etapa)', () => {
    expect(shouldSyncStagePolicyForm({ loading: false, selectedStage: 'Negociação', initializedStage: 'Proposta' })).toBe(true);
  });

  test('carregamento concluído e etapa selecionada é a MESMA já inicializada -> nunca ressincroniza (preserva edição em andamento)', () => {
    expect(shouldSyncStagePolicyForm({ loading: false, selectedStage: 'Proposta', initializedStage: 'Proposta' })).toBe(false);
  });
});

describe('shouldApplyStagePolicyResult (Etapa B, correção pós-revisão do PR #74 — achado 3)', () => {
  test('mesmo usuário e mesma sequência (nenhuma troca/corrida) -> aplica', () => {
    expect(shouldApplyStagePolicyResult({ requestUserId: 'u1', currentUserId: 'u1', requestSeq: 1, currentSeq: 1 })).toBe(true);
  });

  test('usuário trocou entre o início e a resolução da chamada -> nunca aplica', () => {
    expect(shouldApplyStagePolicyResult({ requestUserId: 'u1', currentUserId: 'u2', requestSeq: 1, currentSeq: 1 })).toBe(false);
  });

  test('uma operação mais nova para a mesma etapa já foi iniciada -> a resposta antiga nunca aplica', () => {
    expect(shouldApplyStagePolicyResult({ requestUserId: 'u1', currentUserId: 'u1', requestSeq: 1, currentSeq: 2 })).toBe(false);
  });

  test('usuário trocou E a sequência mudou (dois motivos simultâneos) -> ainda nunca aplica', () => {
    expect(shouldApplyStagePolicyResult({ requestUserId: 'u1', currentUserId: 'u2', requestSeq: 1, currentSeq: 2 })).toBe(false);
  });
});
