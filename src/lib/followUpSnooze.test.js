import { describe, expect, test } from 'vitest';
import { FOLLOW_UP_STATUS } from './followUpEngine.js';
import {
  SNOOZE_PRESETS,
  SNOOZE_REASON,
  computeSnoozeUntil,
  isSnoozeActive,
  applySnoozeToEvaluation,
  buildSnoozeMap,
  shouldApplySnoozeResult,
  formatSnoozedUntilLabel,
} from './followUpSnooze.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('computeSnoozeUntil', () => {
  test.each(SNOOZE_PRESETS.map((p) => [p.key, p.hours]))('preset %s soma %d horas a now', (key, hours) => {
    const result = computeSnoozeUntil(NOW, key);
    expect(new Date(result).getTime()).toBe(NOW.getTime() + hours * 3600 * 1000);
  });

  test('preset desconhecido -> null, nunca lança', () => {
    expect(computeSnoozeUntil(NOW, 'bogus')).toBeNull();
  });

  test('now ausente -> null', () => {
    expect(computeSnoozeUntil(null, '1h')).toBeNull();
  });
});

describe('isSnoozeActive', () => {
  test('data futura -> true', () => {
    expect(isSnoozeActive('2026-06-01T13:00:00.000Z', NOW)).toBe(true);
  });

  test('data passada (vencido) -> false', () => {
    expect(isSnoozeActive('2026-06-01T11:00:00.000Z', NOW)).toBe(false);
  });

  test('igual a now -> false (nunca ativo no limite exato)', () => {
    expect(isSnoozeActive(NOW.toISOString(), NOW)).toBe(false);
  });

  test('ausente/inválido -> false, nunca lança', () => {
    expect(isSnoozeActive(null, NOW)).toBe(false);
    expect(isSnoozeActive('not-a-date', NOW)).toBe(false);
    expect(isSnoozeActive('2026-06-01T13:00:00.000Z', null)).toBe(false);
  });
});

describe('applySnoozeToEvaluation', () => {
  function evalFixture(overrides = {}) {
    return {
      status: FOLLOW_UP_STATUS.DUE,
      eligible: true,
      reason: 'NEVER_CONTACTED',
      dueAt: '2026-05-30T00:00:00.000Z',
      attemptCount: 0,
      blockers: [],
      suggestedAction: 'call',
      ...overrides,
    };
  }

  test('adiamento ativo -> força WAITING/snoozed/dueAt=snoozedUntil, preserva blockers/suggestedAction/attemptCount', () => {
    const evaluation = evalFixture({ attemptCount: 2, blockers: ['x'], suggestedAction: 'whatsapp' });
    const snoozedUntil = '2026-06-01T18:00:00.000Z';
    const result = applySnoozeToEvaluation(evaluation, snoozedUntil, NOW);

    expect(result.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(SNOOZE_REASON);
    expect(result.dueAt).toBe(snoozedUntil);
    expect(result.snoozedUntil).toBe(snoozedUntil);
    expect(result.attemptCount).toBe(2);
    expect(result.blockers).toEqual(['x']);
    expect(result.suggestedAction).toBe('whatsapp');
  });

  test('sem adiamento -> mesma referência, sem alteração', () => {
    const evaluation = evalFixture();
    expect(applySnoozeToEvaluation(evaluation, null, NOW)).toBe(evaluation);
  });

  test('adiamento vencido -> mesma referência (volta ao normal automaticamente)', () => {
    const evaluation = evalFixture();
    expect(applySnoozeToEvaluation(evaluation, '2026-06-01T10:00:00.000Z', NOW)).toBe(evaluation);
  });

  test('evaluation blocked -> nunca desbloqueado por um adiamento', () => {
    const evaluation = evalFixture({ status: FOLLOW_UP_STATUS.BLOCKED, eligible: false });
    expect(applySnoozeToEvaluation(evaluation, '2026-06-01T18:00:00.000Z', NOW)).toBe(evaluation);
  });

  test('evaluation ausente -> devolve o próprio valor ausente, nunca lança', () => {
    expect(applySnoozeToEvaluation(null, '2026-06-01T18:00:00.000Z', NOW)).toBeNull();
  });
});

describe('buildSnoozeMap', () => {
  test('mapeia leadId -> snoozedUntil', () => {
    const rows = [
      { leadId: 'lead-1', snoozedUntil: '2026-06-02T00:00:00.000Z' },
      { leadId: 'lead-2', snoozedUntil: '2026-06-03T00:00:00.000Z' },
    ];
    expect(buildSnoozeMap(rows)).toEqual({
      'lead-1': '2026-06-02T00:00:00.000Z',
      'lead-2': '2026-06-03T00:00:00.000Z',
    });
  });

  test('linhas vazias/ausentes/malformadas são ignoradas, nunca lançam', () => {
    expect(buildSnoozeMap(null)).toEqual({});
    expect(buildSnoozeMap([])).toEqual({});
    expect(buildSnoozeMap([null, {}, { leadId: 'lead-1' }, { snoozedUntil: 'x' }])).toEqual({});
  });
});

describe('shouldApplySnoozeResult — guarda de corrida', () => {
  test('mesmo usuário e mesma sequência -> true', () => {
    expect(shouldApplySnoozeResult({ requestUserId: 'u1', currentUserId: 'u1', requestSeq: 3, currentSeq: 3 })).toBe(true);
  });

  test('usuário trocou durante a chamada -> false', () => {
    expect(shouldApplySnoozeResult({ requestUserId: 'u1', currentUserId: 'u2', requestSeq: 3, currentSeq: 3 })).toBe(false);
  });

  test('outra operação mais recente já rodou para o mesmo lead -> false', () => {
    expect(shouldApplySnoozeResult({ requestUserId: 'u1', currentUserId: 'u1', requestSeq: 3, currentSeq: 4 })).toBe(false);
  });
});

describe('formatSnoozedUntilLabel', () => {
  test('formata data/hora local', () => {
    const label = formatSnoozedUntilLabel('2026-06-01T18:00:00.000Z');
    expect(label).toMatch(/^Adiado até /);
  });

  test('ausente/inválido -> null', () => {
    expect(formatSnoozedUntilLabel(null)).toBeNull();
    expect(formatSnoozedUntilLabel('not-a-date')).toBeNull();
  });
});
