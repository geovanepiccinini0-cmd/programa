import { describe, expect, test, vi, beforeEach } from 'vitest';

// Etapa C — valida followUpSnoozesApi com um cliente Supabase
// SIMULADO (mock da fronteira ./supabaseClient.js, nunca rede real),
// mesmo padrão já usado em db.followUpStagePolicies.test.js (Etapa B)
// e db.setStatus.test.js (PR #72) para a mesma classe de problema
// (upsert/ON CONFLICT vs. update-then-insert).
vi.mock('./supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));

const { supabase } = await import('./supabaseClient.js');
const { followUpSnoozesApi } = await import('./db.js');

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
    lead_id: 'lead-1',
    user_id: 'user-1',
    snoozed_until: '2026-06-01T18:00:00.000Z',
    created_at: '2026-06-01T12:00:00.000Z',
    updated_at: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  supabase.from.mockReset();
});

describe('followUpSnoozesApi.fetchAll', () => {
  test('carrega e mapeia as linhas para { leadId, snoozedUntil }', async () => {
    const builder = queuedBuilder([{ data: [rowFixture(), rowFixture({ lead_id: 'lead-2', snoozed_until: '2026-06-02T00:00:00.000Z' })] }]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpSnoozesApi.fetchAll('user-1');

    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(result).toEqual([
      { leadId: 'lead-1', snoozedUntil: '2026-06-01T18:00:00.000Z' },
      { leadId: 'lead-2', snoozedUntil: '2026-06-02T00:00:00.000Z' },
    ]);
  });

  test('lista vazia -> array vazio, nunca lança', async () => {
    const builder = queuedBuilder([{ data: [] }]);
    supabase.from.mockImplementation(() => builder);
    expect(await followUpSnoozesApi.fetchAll('user-1')).toEqual([]);
  });

  test('erro de rede/RLS é propagado, nunca tratado como lista vazia', async () => {
    const dbError = { code: '42501', message: 'permission denied' };
    const builder = queuedBuilder([{ error: dbError }]);
    supabase.from.mockImplementation(() => builder);
    await expect(followUpSnoozesApi.fetchAll('user-1')).rejects.toBe(dbError);
  });
});

describe('followUpSnoozesApi.save', () => {
  test('lead já com adiamento -> UPDATE direto, nunca tenta INSERT', async () => {
    const existing = rowFixture({ snoozed_until: '2026-06-01T19:00:00.000Z' });
    const builder = queuedBuilder([{ data: existing }]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpSnoozesApi.save('lead-1', '2026-06-01T19:00:00.000Z');

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.update).toHaveBeenCalledWith({ snoozed_until: '2026-06-01T19:00:00.000Z' });
    expect(builder.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ leadId: 'lead-1', snoozedUntil: '2026-06-01T19:00:00.000Z' });
  });

  test('lead ainda sem adiamento -> UPDATE (0 linhas) seguido de INSERT', async () => {
    const inserted = rowFixture();
    const builder = queuedBuilder([{ data: null }, { data: inserted }]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpSnoozesApi.save('lead-1', '2026-06-01T18:00:00.000Z');

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledWith({ lead_id: 'lead-1', snoozed_until: '2026-06-01T18:00:00.000Z' });
    expect(result.snoozedUntil).toBe('2026-06-01T18:00:00.000Z');
  });

  test('corrida (23505 no INSERT, outra aba já criou) -> retry de UPDATE sucede', async () => {
    const retried = rowFixture({ snoozed_until: '2026-06-01T20:00:00.000Z' });
    const builder = queuedBuilder([
      { data: null },
      { error: { code: '23505', message: 'duplicate key' } },
      { data: retried },
    ]);
    supabase.from.mockImplementation(() => builder);

    const result = await followUpSnoozesApi.save('lead-1', '2026-06-01T20:00:00.000Z');

    expect(builder.update).toHaveBeenCalledTimes(2);
    expect(result.snoozedUntil).toBe('2026-06-01T20:00:00.000Z');
  });

  test('erro 403/42501 (falha de gravação / RLS) propagado integralmente, nunca tenta contornar', async () => {
    const permissionError = { code: '42501', message: 'permission denied' };
    const builder = queuedBuilder([{ error: permissionError }]);
    supabase.from.mockImplementation(() => builder);

    await expect(followUpSnoozesApi.save('lead-1', '2026-06-01T18:00:00.000Z')).rejects.toBe(permissionError);
    expect(builder.insert).not.toHaveBeenCalled();
  });

  test('erro no INSERT que NÃO é 23505 é propagado, nunca mascarado como corrida', async () => {
    const otherError = { code: '23503', message: 'foreign key violation' };
    const builder = queuedBuilder([{ data: null }, { error: otherError }]);
    supabase.from.mockImplementation(() => builder);

    await expect(followUpSnoozesApi.save('lead-1', '2026-06-01T18:00:00.000Z')).rejects.toBe(otherError);
  });
});

describe('followUpSnoozesApi.remove — "Cancelar adiamento" (requisito 6)', () => {
  test('remove a linha do lead', async () => {
    const builder = queuedBuilder([{ data: null }]);
    supabase.from.mockImplementation(() => builder);

    await followUpSnoozesApi.remove('lead-1');

    expect(builder.delete).toHaveBeenCalledTimes(1);
    expect(builder.eq).toHaveBeenCalledWith('lead_id', 'lead-1');
  });

  test('idempotente: remover um lead sem adiamento nunca lança', async () => {
    const builder = queuedBuilder([{ data: null, error: null }]);
    supabase.from.mockImplementation(() => builder);
    await expect(followUpSnoozesApi.remove('lead-1')).resolves.toBeUndefined();
  });

  test('erro de rede/RLS no remove é propagado', async () => {
    const dbError = { code: '42501', message: 'permission denied' };
    const builder = queuedBuilder([{ error: dbError }]);
    supabase.from.mockImplementation(() => builder);
    await expect(followUpSnoozesApi.remove('lead-1')).rejects.toBe(dbError);
  });
});
