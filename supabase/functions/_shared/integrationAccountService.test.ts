import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { findIntegrationAccountCandidatesWithServiceRole } from './integrationAccountService.ts';

const FAKE_INPUT = { provider: 'whatsapp', externalAccountId: 'ext-123' };

function makeDeps({ client, repositoryResult, getServiceClientImpl, findCandidatesImpl } = {}) {
  const resolvedClient = client ?? { marker: 'fake-client' };
  const getServiceClient = vi.fn(getServiceClientImpl ?? (() => resolvedClient));
  const findCandidates = vi.fn(findCandidatesImpl ?? (async () => repositoryResult ?? { status: 'OK', candidates: [] }));
  return { getServiceClient, findCandidates, resolvedClient };
}

describe('findIntegrationAccountCandidatesWithServiceRole', () => {
  // 1. provider/externalAccountId encaminhados exatamente
  test('encaminha input (provider/externalAccountId) exatamente para findCandidates', async () => {
    const { getServiceClient, findCandidates } = makeDeps();
    await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates });
    expect(findCandidates).toHaveBeenCalledWith(FAKE_INPUT, expect.anything());
  });

  // 2. client produzido pelo factory e exatamente o passado ao repository
  test('o client retornado por getServiceClient e exatamente o passado para findCandidates', async () => {
    const { getServiceClient, findCandidates, resolvedClient } = makeDeps();
    await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates });
    const [, clientArg] = findCandidates.mock.calls[0];
    expect(clientArg).toBe(resolvedClient);
  });

  // 3. factory chamado exatamente uma vez
  test('getServiceClient e chamado exatamente uma vez', async () => {
    const { getServiceClient, findCandidates } = makeDeps();
    await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates });
    expect(getServiceClient).toHaveBeenCalledTimes(1);
  });

  // 4. repository chamado exatamente uma vez
  test('findCandidates e chamado exatamente uma vez', async () => {
    const { getServiceClient, findCandidates } = makeDeps();
    await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates });
    expect(findCandidates).toHaveBeenCalledTimes(1);
  });

  // 5. repository OK propagado sem adulteracao
  test('propaga o resultado OK do repository sem alteracao', async () => {
    const okResult = { status: 'OK', candidates: [{ provider: 'whatsapp', externalAccountId: 'ext-123', userId: 'u1', integrationAccountId: 'ia1', active: true }] };
    const { getServiceClient, findCandidates } = makeDeps({ repositoryResult: okResult });
    const result = await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates });
    expect(result).toBe(okResult);
  });

  // 6. REPOSITORY_ERROR propagado sem conversao para dominio
  test('propaga REPOSITORY_ERROR sem converter para status de dominio', async () => {
    const errorResult = { status: 'REPOSITORY_ERROR', error: new Error('falha simulada de query') };
    const { getServiceClient, findCandidates } = makeDeps({ repositoryResult: errorResult });
    const result = await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates });
    expect(result).toBe(errorResult);
  });

  // 7. factory exception propaga original (nao convertida em REPOSITORY_ERROR)
  test('propaga a exception original de getServiceClient, sem converter em REPOSITORY_ERROR', async () => {
    const boom = new Error('falha de configuracao do service client');
    const findCandidates = vi.fn(async () => ({ status: 'OK', candidates: [] }));
    const getServiceClient = vi.fn(() => { throw boom; });
    await expect(findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates }))
      .rejects.toThrow(boom);
    expect(findCandidates).not.toHaveBeenCalled();
  });

  // 8. repository thrown/rejected exception propaga (contrato real: precondicao do
  // repository vira rejection, pois a implementacao real e async function) — a
  // composicao nunca engole/converte isso.
  test('propaga rejection de findCandidates sem conversao (ex.: precondicao do repository real)', async () => {
    const precondition = new TypeError('findIntegrationAccountCandidates: provider deve ser uma string nao vazia e nao so-whitespace');
    const { getServiceClient, findCandidates } = makeDeps({ findCandidatesImpl: async () => { throw precondition; } });
    await expect(findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates }))
      .rejects.toThrow(precondition);
  });

  // 9. zero mutation do input
  test('nao muta o objeto input recebido', async () => {
    const frozenInput = Object.freeze({ provider: 'whatsapp', externalAccountId: 'ext-123' });
    const { getServiceClient, findCandidates } = makeDeps();
    await expect(findIntegrationAccountCandidatesWithServiceRole(frozenInput, { getServiceClient, findCandidates })).resolves.toBeDefined();
  });

  // 10. chamadas independentes nao compartilham client
  test('chamadas independentes usam clients distintos, sem compartilhamento/cache', async () => {
    const clientA = { id: 'a' };
    const clientB = { id: 'b' };
    const findCandidatesA = vi.fn(async () => ({ status: 'OK', candidates: [] }));
    const findCandidatesB = vi.fn(async () => ({ status: 'OK', candidates: [] }));

    await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient: () => clientA, findCandidates: findCandidatesA });
    await findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient: () => clientB, findCandidates: findCandidatesB });

    expect(findCandidatesA.mock.calls[0][1]).toBe(clientA);
    expect(findCandidatesB.mock.calls[0][1]).toBe(clientB);
    expect(findCandidatesA.mock.calls[0][1]).not.toBe(findCandidatesB.mock.calls[0][1]);
  });

  // 11. nenhum userId externo e aceito/usado para ownership
  test('input com userId/ownerId extra e repassado opacamente, nunca lido/usado pela composicao', async () => {
    const inputWithOwnershipJunk = { provider: 'whatsapp', externalAccountId: 'ext-123', userId: 'attacker-controlled', ownerId: 'attacker-controlled' };
    const { getServiceClient, findCandidates } = makeDeps();
    await findIntegrationAccountCandidatesWithServiceRole(inputWithOwnershipJunk, { getServiceClient, findCandidates });
    // a composicao apenas repassa o objeto verbatim -- nunca extrai/decide nada a partir de userId/ownerId
    expect(findCandidates).toHaveBeenCalledWith(inputWithOwnershipJunk, expect.anything());
  });

  // precondicoes de deps
  test('lanca quando deps.getServiceClient nao e uma function', async () => {
    const findCandidates = vi.fn(async () => ({ status: 'OK', candidates: [] }));
    // @ts-expect-error -- teste deliberado de input invalido
    await expect(findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient: 'nope', findCandidates })).rejects.toThrow(TypeError);
    expect(findCandidates).not.toHaveBeenCalled();
  });

  test('lanca quando deps.findCandidates nao e uma function', async () => {
    const getServiceClient = vi.fn(() => ({}));
    // @ts-expect-error -- teste deliberado de input invalido
    await expect(findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, { getServiceClient, findCandidates: 'nope' })).rejects.toThrow(TypeError);
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  test('lanca quando deps esta ausente/nao e objeto', async () => {
    // @ts-expect-error -- teste deliberado de input invalido
    await expect(findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, undefined)).rejects.toThrow(TypeError);
    // @ts-expect-error -- teste deliberado de input invalido
    await expect(findIntegrationAccountCandidatesWithServiceRole(FAKE_INPUT, null)).rejects.toThrow(TypeError);
  });

  describe('auditoria estatica de seguranca (integrationAccountService.ts)', () => {
    const source = readFileSync(new URL('./integrationAccountService.ts', import.meta.url), 'utf8');
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const forbiddenPatterns = [
      ['Deno.env', /Deno\.env/],
      ['npm: specifier', /npm:/],
      ['import.meta.env', /import\.meta\.env/],
      ['VITE_', /VITE_/],
      ['SUPABASE_ANON_KEY', /SUPABASE_ANON_KEY/],
      ['import real de createClient', /from\s+['"]@supabase\/supabase-js/],
      ['src/lib/supabaseClient', /src\/lib\/supabaseClient/],
      ['console.log', /console\.log/],
      ['console.error', /console\.error/],
      ['fetch(', /fetch\(/],
      ['XMLHttpRequest', /XMLHttpRequest/],
      ['localStorage', /localStorage/],
      ['Authorization manual', /['"]Authorization['"]/],
      ['apikey manual', /['"]apikey['"]/],
    ];

    test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
      expect(codeLines).not.toMatch(pattern);
    });

    test('assinatura nunca declara parametro userId/ownerId/createdBy', () => {
      expect(codeLines).not.toMatch(/\b(userId|ownerId|createdBy)\s*:/);
    });
  });
});
