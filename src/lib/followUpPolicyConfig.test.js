import { describe, expect, test } from 'vitest';
import {
  sanitizeStagePolicyOverride,
  resolveFollowUpPolicyForStage,
  buildStagePolicyOverridesMap,
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
