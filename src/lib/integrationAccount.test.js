import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_ACCOUNT_RESOLUTION_STATUS as STATUS,
  resolveIntegrationAccount,
} from './integrationAccount.js';

function makeCandidate(overrides = {}) {
  return {
    provider: 'whatsapp',
    externalAccountId: '1234567890',
    userId: 'user-1',
    integrationAccountId: 'account-1',
    active: true,
    ...overrides,
  };
}

describe('resolveIntegrationAccount — Fase 3.2.1', () => {
  it('1) conta ativa valida -> RESOLVED', () => {
    const candidate = makeCandidate();
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({
      status: STATUS.RESOLVED,
      userId: 'user-1',
      integrationAccountId: 'account-1',
    });
  });

  it('2) candidates vazio -> NOT_FOUND', () => {
    const result = resolveIntegrationAccount('whatsapp', '1234567890', []);
    expect(result).toEqual({ status: STATUS.NOT_FOUND });
  });

  it('3) candidates existem mas nenhum corresponde -> NOT_FOUND', () => {
    const candidates = [
      makeCandidate({ externalAccountId: 'outro-numero' }),
      makeCandidate({ provider: 'meta_lead_ads' }),
    ];
    const result = resolveIntegrationAccount('whatsapp', '1234567890', candidates);
    expect(result).toEqual({ status: STATUS.NOT_FOUND });
  });

  it('4) match inativo -> INACTIVE', () => {
    const candidate = makeCandidate({ active: false, integrationAccountId: 'account-inactive' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({ status: STATUS.INACTIVE, integrationAccountId: 'account-inactive' });
  });

  it('5) dois candidates correspondentes -> AMBIGUOUS, nunca escolhe um arbitrariamente', () => {
    const c1 = makeCandidate({ integrationAccountId: 'account-a', userId: 'user-a' });
    const c2 = makeCandidate({ integrationAccountId: 'account-b', userId: 'user-b' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [c1, c2]);
    expect(result.status).toBe(STATUS.AMBIGUOUS);
    expect(result.candidates).toEqual([c1, c2]);
  });

  it('6) mesmo externalAccountId sob provider diferente -> nunca cruza (NOT_FOUND)', () => {
    const candidate = makeCandidate({ provider: 'meta_lead_ads' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({ status: STATUS.NOT_FOUND });
  });

  it('7) mesmo provider com externalAccountId diferente -> nunca cruza (NOT_FOUND)', () => {
    const candidate = makeCandidate({ externalAccountId: '9999999999' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({ status: STATUS.NOT_FOUND });
  });

  it("8) provider '' -> INVALID_INPUT", () => {
    const result = resolveIntegrationAccount('', '1234567890', [makeCandidate()]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it("9) provider só-whitespace -> INVALID_INPUT", () => {
    const result = resolveIntegrationAccount('   ', '1234567890', [makeCandidate()]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it.each([null, undefined, 123, {}, [], true])('10) provider não-string (%p) -> INVALID_INPUT', (badProvider) => {
    const result = resolveIntegrationAccount(badProvider, '1234567890', [makeCandidate()]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it("11) externalAccountId '' -> INVALID_INPUT", () => {
    const result = resolveIntegrationAccount('whatsapp', '', [makeCandidate()]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it("12) externalAccountId só-whitespace -> INVALID_INPUT", () => {
    const result = resolveIntegrationAccount('whatsapp', '\t\n  ', [makeCandidate()]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it.each([null, undefined, 123, {}, [], true])('13) externalAccountId não-string (%p) -> INVALID_INPUT', (bad) => {
    const result = resolveIntegrationAccount('whatsapp', bad, [makeCandidate()]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it.each([null, undefined, {}, 'not-an-array', 42, true])('14) candidates não-array (%p) -> INVALID_INPUT', (badCandidates) => {
    const result = resolveIntegrationAccount('whatsapp', '1234567890', badCandidates);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it('15) candidate correspondente sem userId -> nunca RESOLVED', () => {
    const candidate = makeCandidate({ userId: undefined });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result.status).not.toBe(STATUS.RESOLVED);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it('15b) candidate correspondente com userId vazio/whitespace -> nunca RESOLVED', () => {
    const candidate = makeCandidate({ userId: '   ' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result.status).not.toBe(STATUS.RESOLVED);
  });

  it('16) candidate correspondente sem integrationAccountId -> nunca RESOLVED', () => {
    const candidate = makeCandidate({ integrationAccountId: undefined });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result.status).not.toBe(STATUS.RESOLVED);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
  });

  it('17a) active === false (booleano real) -> INACTIVE, nunca INVALID_INPUT', () => {
    const candidate = makeCandidate({ active: false, integrationAccountId: 'account-inactive-2' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({ status: STATUS.INACTIVE, integrationAccountId: 'account-inactive-2' });
  });

  it.each([undefined, null, 0, 1, 'false', 'true', {}, []])(
    '17b) active ausente ou não-booleano (%p) -> INVALID_INPUT (nunca INACTIVE, nunca RESOLVED)',
    (badActive) => {
      const candidate = makeCandidate({ active: badActive });
      const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
      expect(result.status).toBe(STATUS.INVALID_INPUT);
      expect(result.status).not.toBe(STATUS.INACTIVE);
      expect(result.status).not.toBe(STATUS.RESOLVED);
    },
  );

  it('17c) candidate inativo (active === false) SEM integrationAccountId -> INVALID_INPUT, nunca INACTIVE', () => {
    const candidate = makeCandidate({ active: false, integrationAccountId: undefined });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
    expect(result.status).not.toBe(STATUS.INACTIVE);
  });

  it('17d) candidate inativo (active === false) COM integrationAccountId válido -> INACTIVE', () => {
    const candidate = makeCandidate({ active: false, integrationAccountId: 'account-xyz' });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({ status: STATUS.INACTIVE, integrationAccountId: 'account-xyz' });
  });

  it('17e) candidate ativo (active === true) SEM userId -> INVALID_INPUT, nunca RESOLVED', () => {
    const candidate = makeCandidate({ active: true, userId: undefined });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
    expect(result.status).not.toBe(STATUS.RESOLVED);
  });

  it('17f) candidate ativo (active === true) SEM integrationAccountId -> INVALID_INPUT, nunca RESOLVED', () => {
    const candidate = makeCandidate({ active: true, integrationAccountId: undefined });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result.status).toBe(STATUS.INVALID_INPUT);
    expect(result.status).not.toBe(STATUS.RESOLVED);
  });

  it('17g) candidate ativo (active === true) válido -> RESOLVED', () => {
    const candidate = makeCandidate({ active: true });
    const result = resolveIntegrationAccount('whatsapp', '1234567890', [candidate]);
    expect(result).toEqual({
      status: STATUS.RESOLVED,
      userId: candidate.userId,
      integrationAccountId: candidate.integrationAccountId,
    });
  });

  it('18) matching é case-sensitive (documentado) — provider com caixa diferente nunca casa', () => {
    const candidate = makeCandidate({ provider: 'whatsapp' });
    const result = resolveIntegrationAccount('WhatsApp', '1234567890', [candidate]);
    expect(result).toEqual({ status: STATUS.NOT_FOUND });
  });

  it('18b) matching é case-sensitive — externalAccountId com caixa diferente nunca casa', () => {
    const candidate = makeCandidate({ externalAccountId: 'ABC123' });
    const result = resolveIntegrationAccount('whatsapp', 'abc123', [candidate]);
    expect(result).toEqual({ status: STATUS.NOT_FOUND });
  });

  it('19) a função nunca muta nenhum input', () => {
    const candidate = makeCandidate();
    const candidates = Object.freeze([Object.freeze(candidate)]);
    const providerArg = 'whatsapp';
    const externalAccountIdArg = '1234567890';

    expect(() => resolveIntegrationAccount(providerArg, externalAccountIdArg, candidates)).not.toThrow();

    const result = resolveIntegrationAccount(providerArg, externalAccountIdArg, candidates);
    expect(result.status).toBe(STATUS.RESOLVED);
    // inputs congelados sobrevivem intactos — qualquer tentativa de
    // mutação teria lançado TypeError em modo estrito (módulos ES).
    expect(candidates).toEqual([makeCandidate()]);
    expect(providerArg).toBe('whatsapp');
    expect(externalAccountIdArg).toBe('1234567890');
  });

  it('20) candidates extras malformados nunca envenenam um match valido existente', () => {
    const validCandidate = makeCandidate();
    const garbage = [null, undefined, 42, 'string-solta', {}, [], { provider: 'whatsapp' }, { externalAccountId: '1234567890' }];
    const candidates = [...garbage, validCandidate];
    const result = resolveIntegrationAccount('whatsapp', '1234567890', candidates);
    expect(result).toEqual({
      status: STATUS.RESOLVED,
      userId: 'user-1',
      integrationAccountId: 'account-1',
    });
  });

  describe('segurança — ownership nunca entra como input externo', () => {
    it('a função não aceita nenhum parâmetro de userId (assinatura tem exatamente 3 parâmetros)', () => {
      expect(resolveIntegrationAccount.length).toBe(3);
    });

    it('userId retornado vem exclusivamente do candidate correspondente, nunca de outro lugar', () => {
      const attackerCandidate = makeCandidate({
        provider: 'outro-provider',
        externalAccountId: 'outro-id',
        userId: 'attacker-user',
        integrationAccountId: 'attacker-account',
      });
      const realCandidate = makeCandidate({ userId: 'real-user', integrationAccountId: 'real-account' });
      const result = resolveIntegrationAccount('whatsapp', '1234567890', [attackerCandidate, realCandidate]);
      expect(result.status).toBe(STATUS.RESOLVED);
      expect(result.userId).toBe('real-user');
      expect(result.userId).not.toBe('attacker-user');
    });

    it('candidate de outra conta nunca fornece ownership para a conta consultada', () => {
      const accountA = makeCandidate({ provider: 'whatsapp', externalAccountId: 'numero-a', userId: 'user-a', integrationAccountId: 'account-a' });
      const accountB = makeCandidate({ provider: 'whatsapp', externalAccountId: 'numero-b', userId: 'user-b', integrationAccountId: 'account-b' });
      const resultA = resolveIntegrationAccount('whatsapp', 'numero-a', [accountA, accountB]);
      const resultB = resolveIntegrationAccount('whatsapp', 'numero-b', [accountA, accountB]);
      expect(resultA).toEqual({ status: STATUS.RESOLVED, userId: 'user-a', integrationAccountId: 'account-a' });
      expect(resultB).toEqual({ status: STATUS.RESOLVED, userId: 'user-b', integrationAccountId: 'account-b' });
    });
  });
});
