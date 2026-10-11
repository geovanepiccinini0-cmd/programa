import { describe, expect, test, vi, beforeEach } from 'vitest';

// Etapa B (correção pós-revisão do PR #74, item 5 — "validar
// novamente o fluxo completo de configurações") — valida
// followUpStagePoliciesApi com um cliente Supabase SIMULADO (mock da
// fronteira ./supabaseClient.js, nunca rede real), mesmo padrão já
// usado em db.setStatus.test.js (PR #72) para a mesma classe de
// problema (upsert/ON CONFLICT vs. update-then-insert).
vi.mock('./supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));

const { supabase } = await import('./supabaseClient.js');
const { followUpStagePoliciesApi } = await import('./db.js');

function queuedBuilder(responses) {
  let i = 0;
  const builder = {};
  builder.select = vi.fn(() => builder);
  builder.update = vi.fn(() => builder);
  builder.insert = vi.fn(() => builder);
  builder.delete = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => {
    const response = responses[i];
    i += 1;
    if (!response) throw new Error(`queuedBuilder: nenhuma resposta enfileirada para a chamada #${i}`);
    if (response.throws) throw response.throws;
    return { data: response.data ?? null, error: response.error ?? null };
  });
  // fetchAll/remove não terminam em maybeSingle() — resolvem a
  // própria Promise do builder (await direto no objeto encadeável).
  builder.then = (resolve, reject) => {
    const response = responses[i];
    i += 1;
    if (!response) return Promise.reject(new Error('queuedBuilder: nenhuma resposta enfileirada')).then(resolve, reject);
    if (response.throws) return Promise.reject(response.throws).then(resolve, reject);
    return Promise.resolve({ data: response.data ?? null, error: response.error ?? null }).then(resolve, reject);
  };
  return builder;
}

function rowFixture(overrides = {}) {
  return {
    id: 'row-1',
    etapa: 'Proposta',
    user_id: 'user-1',
    attempt_hours_until_due: null,
    proposal_hours_until_due: null,
    no_new_attempt_hours_until_due: null,
    max_attempts: null,
    reactivation_days_until_due: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  supabase.from.mockReset();
});

describe('followUpStagePoliciesApi.fetchAll — carregamento (ponto 5 da correção)', () => {
  test('carrega e mapeia as linhas para a forma aninhada (override)', async () => {
    const builder = queuedBuilder([{ data: [rowFixture({ max_attempts: 2 }), rowFixture({ etapa: 'Negociação', attempt_hours_until_due: 10 })] }]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpStagePoliciesApi.fetchAll('user-1');

    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(result).toEqual([
      { id: 'row-1', etapa: 'Proposta', maxAttempts: 2 },
      { id: 'row-1', etapa: 'Negociação', attempt: { hoursUntilDue: 10 } },
    ]);
  });

  test('lista vazia -> array vazio, nunca lança', async () => {
    const builder = queuedBuilder([{ data: [] }]);
    supabase.from.mockImplementation(() => builder);
    expect(await followUpStagePoliciesApi.fetchAll('user-1')).toEqual([]);
  });

  test('erro de rede/RLS é propagado, nunca tratado como lista vazia', async () => {
    const dbError = { code: '42501', message: 'permission denied' };
    const builder = queuedBuilder([{ error: dbError }]);
    supabase.from.mockImplementation(() => builder);
    await expect(followUpStagePoliciesApi.fetchAll('user-1')).rejects.toBe(dbError);
  });
});

describe('followUpStagePoliciesApi.save — persistência (ponto 5)', () => {
  test('etapa já configurada -> UPDATE direto, nunca tenta INSERT', async () => {
    const existing = rowFixture({ max_attempts: 5 });
    const builder = queuedBuilder([{ data: existing }]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpStagePoliciesApi.save('Proposta', { maxAttempts: 5 });

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'row-1', etapa: 'Proposta', maxAttempts: 5 });
  });

  test('etapa ainda sem linha -> UPDATE (0 linhas) seguido de INSERT', async () => {
    const inserted = rowFixture({ attempt_hours_until_due: 10 });
    const builder = queuedBuilder([{ data: null }, { data: inserted }]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpStagePoliciesApi.save('Proposta', { attempt: { hoursUntilDue: 10 } });

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ etapa: 'Proposta', attempt_hours_until_due: 10 }));
    expect(result.attempt).toEqual({ hoursUntilDue: 10 });
  });

  test('corrida (23505 no INSERT) -> retry de UPDATE sucede', async () => {
    const retried = rowFixture({ max_attempts: 3 });
    const builder = queuedBuilder([
      { data: null },
      { error: { code: '23505', message: 'duplicate key' } },
      { data: retried },
    ]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpStagePoliciesApi.save('Proposta', { maxAttempts: 3 });

    expect(builder.update).toHaveBeenCalledTimes(2);
    expect(result.maxAttempts).toBe(3);
  });

  test('payload nunca inclui campos fora dos 5 conhecidos, mesmo com override parcial', async () => {
    const builder = queuedBuilder([{ data: rowFixture() }]);
    supabase.from.mockImplementation(() => builder);

    await followUpStagePoliciesApi.save('Proposta', { maxAttempts: 2 });

    const payload = builder.update.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      'attempt_hours_until_due', 'max_attempts', 'no_new_attempt_hours_until_due', 'proposal_hours_until_due', 'reactivation_days_until_due',
    ]);
    expect(payload.max_attempts).toBe(2);
    expect(payload.attempt_hours_until_due).toBeNull();
  });

  test('erro 403/42501 propagado integralmente, nunca tenta contornar (mesmo princípio do hotfix PR #72)', async () => {
    const permissionError = { code: '42501', message: 'permission denied' };
    const builder = queuedBuilder([{ error: permissionError }]);
    supabase.from.mockImplementation(() => builder);

    await expect(followUpStagePoliciesApi.save('Proposta', { maxAttempts: 2 })).rejects.toBe(permissionError);
    expect(builder.insert).not.toHaveBeenCalled();
  });
});

describe('followUpStagePoliciesApi.remove — restauração ao padrão (ponto 5)', () => {
  test('remove a linha da etapa', async () => {
    const builder = queuedBuilder([{ data: null }]);
    supabase.from.mockImplementation(() => builder);

    await followUpStagePoliciesApi.remove('Proposta');

    expect(builder.delete).toHaveBeenCalledTimes(1);
    expect(builder.eq).toHaveBeenCalledWith('etapa', 'Proposta');
  });

  test('idempotente: remover uma etapa sem linha nunca lança', async () => {
    const builder = queuedBuilder([{ data: null, error: null }]);
    supabase.from.mockImplementation(() => builder);
    await expect(followUpStagePoliciesApi.remove('Proposta')).resolves.toBeUndefined();
  });

  test('erro de rede/RLS no remove é propagado', async () => {
    const dbError = { code: '42501', message: 'permission denied' };
    const builder = queuedBuilder([{ error: dbError }]);
    supabase.from.mockImplementation(() => builder);
    await expect(followUpStagePoliciesApi.remove('Proposta')).rejects.toBe(dbError);
  });
});
