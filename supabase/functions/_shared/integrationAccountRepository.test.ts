import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findIntegrationAccountCandidates } from './integrationAccountRepository.js';

type FakeClientOptions = {
  data?: unknown[] | null;
  error?: unknown;
  throwOnFrom?: boolean;
  throwOnEq?: boolean;
};

type RecordedCalls = {
  table?: string;
  select?: string;
  eqCalls: Array<[string, unknown]>;
};

function createFakeClient(options: FakeClientOptions = {}) {
  const calls: RecordedCalls = { eqCalls: [] };
  const client = {
    from(table: string) {
      calls.table = table;
      if (options.throwOnFrom) throw new Error('boom-from');
      return {
        select(columns: string) {
          calls.select = columns;
          return {
            eq(col1: string, val1: unknown) {
              calls.eqCalls.push([col1, val1]);
              return {
                eq(col2: string, val2: unknown) {
                  calls.eqCalls.push([col2, val2]);
                  if (options.throwOnEq) throw new Error('boom-eq');
                  // Distingue "data nao informado" (default []) de
                  // "data explicitamente null" (usado para simular um
                  // client estruturalmente inconsistente) — ?? trataria
                  // os dois casos como iguais, o que mascararia
                  // exatamente o cenario que o teste 29 precisa simular.
                  const data = 'data' in options ? options.data : [];
                  return Promise.resolve({ data, error: options.error ?? null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    provider: 'whatsapp',
    external_account_id: '1234567890',
    user_id: 'user-1',
    active: true,
    ...overrides,
  };
}

describe('findIntegrationAccountCandidates — Fase 3.2.2.1', () => {
  it('1) consulta a tabela correta (integration_accounts)', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(calls.table).toBe('integration_accounts');
  });

  it('2) seleciona exatamente as 5 colunas esperadas', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(calls.select).toBe('id, provider, external_account_id, user_id, active');
  });

  it('3) filtra provider exatamente pelo valor recebido', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(calls.eqCalls[0]).toEqual(['provider', 'whatsapp']);
  });

  it('4) filtra external_account_id exatamente pelo valor recebido', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(calls.eqCalls[1]).toEqual(['external_account_id', '123']);
  });

  it('5) nunca filtra active na query (exatamente 2 chamadas de eq, nunca 3)', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(calls.eqCalls).toHaveLength(2);
    expect(calls.eqCalls.some(([col]) => col === 'active')).toBe(false);
  });

  it('6) zero rows -> OK com candidates vazio', async () => {
    const { client } = createFakeClient({ data: [] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result).toEqual({ status: 'OK', candidates: [] });
  });

  it('7) uma row -> mapping correto para todos os 5 campos', async () => {
    const row = makeRow();
    const { client } = createFakeClient({ data: [row] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    expect(result).toEqual({
      status: 'OK',
      candidates: [{
        integrationAccountId: 'account-1',
        provider: 'whatsapp',
        externalAccountId: '1234567890',
        userId: 'user-1',
        active: true,
      }],
    });
  });

  it('8) active=false e preservado no candidate, nunca descartado', async () => {
    const row = makeRow({ active: false });
    const { client } = createFakeClient({ data: [row] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    expect(result.status).toBe('OK');
    expect((result as { candidates: Array<{ active: unknown }> }).candidates).toHaveLength(1);
    expect((result as { candidates: Array<{ active: unknown }> }).candidates[0].active).toBe(false);
  });

  it('9) mais de uma row -> todas preservadas (nunca deduplicadas/filtradas)', async () => {
    const rows = [makeRow({ id: 'account-a' }), makeRow({ id: 'account-b' })];
    const { client } = createFakeClient({ data: rows });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    expect(result.status).toBe('OK');
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('10) ordem das rows retornadas pelo client nunca e alterada', async () => {
    const rows = [makeRow({ id: 'z' }), makeRow({ id: 'a' }), makeRow({ id: 'm' })];
    const { client } = createFakeClient({ data: rows });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    const ids = (result as { candidates: Array<{ integrationAccountId: unknown }> }).candidates.map((c) => c.integrationAccountId);
    expect(ids).toEqual(['z', 'a', 'm']);
  });

  it('11) Supabase client retornando error -> REPOSITORY_ERROR', async () => {
    const dbError = { message: 'connection reset', code: '57P01' };
    const { client } = createFakeClient({ data: null, error: dbError });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result).toEqual({ status: 'REPOSITORY_ERROR', error: dbError });
  });

  it('11b) error tem prioridade mesmo se data tambem vier preenchido', async () => {
    const dbError = { message: 'partial failure' };
    const { client } = createFakeClient({ data: [makeRow()], error: dbError });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result).toEqual({ status: 'REPOSITORY_ERROR', error: dbError });
  });

  it('12) exception lancada em .from() -> capturada, REPOSITORY_ERROR', async () => {
    const { client } = createFakeClient({ throwOnFrom: true });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
    expect((result as { error: Error }).error).toBeInstanceOf(Error);
  });

  it('12b) exception lancada no segundo .eq() -> capturada, REPOSITORY_ERROR', async () => {
    const { client } = createFakeClient({ throwOnEq: true });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  it('13) row malformada (null, primitivo, array) nunca lanca, so mapeia campos como undefined', async () => {
    const { client } = createFakeClient({ data: [null, 42, 'string-solta', [], undefined] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result.status).toBe('OK');
    const candidates = (result as { candidates: IntegrationAccountCandidateShape[] }).candidates;
    expect(candidates).toHaveLength(5);
    for (const candidate of candidates) {
      expect(candidate.integrationAccountId).toBeUndefined();
      expect(candidate.userId).toBeUndefined();
    }
  });

  it('14) campos ausentes na row nao recebem defaults (permanecem undefined)', async () => {
    const row = { id: 'account-1', provider: 'whatsapp' }; // sem external_account_id, user_id, active
    const { client } = createFakeClient({ data: [row] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    const candidate = (result as { candidates: IntegrationAccountCandidateShape[] }).candidates[0];
    expect(candidate.externalAccountId).toBeUndefined();
    expect(candidate.userId).toBeUndefined();
    expect(candidate.active).toBeUndefined();
  });

  it('15) o mapeamento nunca muta a row original recebida do client', async () => {
    const row = Object.freeze(makeRow());
    const { client } = createFakeClient({ data: [row] });
    await expect(findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client)).resolves.toBeDefined();
    expect(row).toEqual(makeRow());
  });

  it('16) provider e passado para a query exatamente como recebido, sem canonicalizacao (case preservado)', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'WhatsApp', externalAccountId: '123' }, client);
    expect(calls.eqCalls[0]).toEqual(['provider', 'WhatsApp']);
  });

  it('17) externalAccountId e passado para a query exatamente como recebido, sem canonicalizacao (espaco interno preservado)', async () => {
    const { client, calls } = createFakeClient({ data: [] });
    await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: 'conta com espaco' }, client);
    expect(calls.eqCalls[1]).toEqual(['external_account_id', 'conta com espaco']);
  });

  it('18) o repository nunca retorna status RESOLVED (mesmo com candidate ativo valido)', async () => {
    const { client } = createFakeClient({ data: [makeRow({ active: true })] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    expect(result.status).toBe('OK');
    expect(result.status).not.toBe('RESOLVED');
  });

  it('19) o repository nunca retorna status INACTIVE (mesmo com candidate active=false)', async () => {
    const { client } = createFakeClient({ data: [makeRow({ active: false })] });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    expect(result.status).toBe('OK');
    expect(result.status).not.toBe('INACTIVE');
  });

  it('20) o repository nunca retorna status AMBIGUOUS (mesmo com 2+ rows)', async () => {
    const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })];
    const { client } = createFakeClient({ data: rows });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '1234567890' }, client);
    expect(result.status).toBe('OK');
    expect(result.status).not.toBe('AMBIGUOUS');
  });

  it('29) data=null e error=null (client estruturalmente inconsistente) -> REPOSITORY_ERROR, nunca OK/[]', async () => {
    const { client } = createFakeClient({ data: null, error: null });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  it('30) data nao-array (ex. objeto) sem error -> REPOSITORY_ERROR, nunca aceito como se fosse array', async () => {
    const { client } = createFakeClient({ data: { not: 'an array' } as unknown as unknown[], error: null });
    const result = await findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  describe('validacao de input (precondicao de contrato — lanca, nao retorna status)', () => {
    it.each(['', '   ', null, undefined, 123, {}, []])('26) provider invalido (%p) -> lanca TypeError', async (badProvider) => {
      const { client } = createFakeClient({ data: [] });
      await expect(
        findIntegrationAccountCandidates({ provider: badProvider as unknown, externalAccountId: '123' }, client),
      ).rejects.toThrow(TypeError);
    });

    it.each(['', '   ', null, undefined, 123, {}, []])('27) externalAccountId invalido (%p) -> lanca TypeError', async (bad) => {
      const { client } = createFakeClient({ data: [] });
      await expect(
        findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: bad as unknown }, client),
      ).rejects.toThrow(TypeError);
    });

    it.each([null, undefined, {}, 'string', 42, { from: 'not-a-function' }])('28) supabaseServiceClient invalido (%p) -> lanca TypeError', async (badClient) => {
      await expect(
        findIntegrationAccountCandidates({ provider: 'whatsapp', externalAccountId: '123' }, badClient as unknown as never),
      ).rejects.toThrow(TypeError);
    });

    it('precondicao e verificada ANTES de tocar o client (nenhuma chamada e feita)', async () => {
      const { client, calls } = createFakeClient({ data: [] });
      await expect(
        findIntegrationAccountCandidates({ provider: '', externalAccountId: '123' }, client),
      ).rejects.toThrow(TypeError);
      expect(calls.table).toBeUndefined();
    });
  });

  describe('server-only security (verificacao estatica do codigo-fonte)', () => {
    const rawSource = readFileSync(new URL('./integrationAccountRepository.ts', import.meta.url), 'utf8');
    // Remove linhas de comentario (// ...) antes de verificar — este
    // arquivo documenta deliberadamente, em prosa, a AUSENCIA de
    // supabaseClient/React/VITE_/Deno.env/fetch (ex. "nunca importa
    // src/lib/supabaseClient.js"); sem este filtro, essas proprias
    // frases explicativas dariam falso-positivo nos testes abaixo.
    // Os testes devem verificar codigo executavel, nao comentarios.
    const source = rawSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    it('21) nenhum import real do client do browser (src/lib/supabaseClient.js)', () => {
      expect(source).not.toMatch(/supabaseClient/);
    });

    it('21b) nenhum import real do resolver puro (composicao decidida em fase posterior)', () => {
      expect(source).not.toMatch(/integrationAccount\.js/);
    });

    it('21c) nenhum import real de React', () => {
      expect(source).not.toMatch(/\breact\b/i);
    });

    it('22) nenhuma referencia real a VITE_', () => {
      expect(source).not.toMatch(/VITE_/);
    });

    it('22b) nenhuma leitura real de import.meta.env', () => {
      expect(source).not.toMatch(/import\.meta\.env/);
    });

    it('23) nenhuma secret literal (ex. chave service_role) no codigo-fonte', () => {
      expect(source).not.toMatch(/SERVICE_ROLE_KEY\s*[:=]\s*['"]/);
      expect(source).not.toMatch(/sb_(publishable|secret)_/);
    });

    it('24) nenhum uso real de Deno.env nesta fase', () => {
      expect(source).not.toMatch(/Deno\.env/);
    });

    it('25) nenhum fetch/network direto', () => {
      expect(source).not.toMatch(/\bfetch\(/);
      expect(source).not.toMatch(/XMLHttpRequest/);
    });

    it('o client Supabase chega exclusivamente por dependency injection (parametro da funcao)', () => {
      expect(source).not.toMatch(/createClient\(/);
    });
  });
});

type IntegrationAccountCandidateShape = {
  provider: unknown;
  externalAccountId: unknown;
  userId: unknown;
  integrationAccountId: unknown;
  active: unknown;
};
