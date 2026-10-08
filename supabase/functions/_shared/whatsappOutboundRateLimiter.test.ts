import { describe, expect, test } from 'vitest';
import { checkOutboundRateLimit, OUTBOUND_RATE_LIMIT_MAX_ATTEMPTS_PER_WINDOW } from './whatsappOutboundRateLimiter.ts';

const fixedNow = () => new Date('2026-01-10T12:00:00.000Z');

function makeFakeClient(count: number | null, error: unknown = null) {
  const calls: Array<{ filters: Record<string, unknown> }> = [];
  return {
    from() {
      const filters: Record<string, unknown> = {};
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return {
                gte(column2: string, value2: unknown) {
                  filters[column2] = value2;
                  calls.push({ filters });
                  return Promise.resolve({ count, error });
                },
              };
            },
          };
        },
      };
    },
    _calls: calls,
  };
}

describe('checkOutboundRateLimit', () => {
  test('contagem abaixo do limiar -> RATE_OK', async () => {
    const client = makeFakeClient(3);
    const result = await checkOutboundRateLimit({ userId: 'user-1' }, client, fixedNow);
    expect(result).toEqual({ status: 'RATE_OK' });
  });

  test('contagem igual ao limiar -> RATE_LIMITED (fail-closed na borda)', async () => {
    const client = makeFakeClient(OUTBOUND_RATE_LIMIT_MAX_ATTEMPTS_PER_WINDOW);
    const result = await checkOutboundRateLimit({ userId: 'user-1' }, client, fixedNow);
    expect(result).toEqual({ status: 'RATE_LIMITED' });
  });

  test('contagem acima do limiar -> RATE_LIMITED', async () => {
    const client = makeFakeClient(OUTBOUND_RATE_LIMIT_MAX_ATTEMPTS_PER_WINDOW + 5);
    const result = await checkOutboundRateLimit({ userId: 'user-1' }, client, fixedNow);
    expect(result).toEqual({ status: 'RATE_LIMITED' });
  });

  test('limiar customizado -> respeitado', async () => {
    const client = makeFakeClient(2);
    const result = await checkOutboundRateLimit({ userId: 'user-1' }, client, fixedNow, 2);
    expect(result).toEqual({ status: 'RATE_LIMITED' });
  });

  test('erro do client -> REPOSITORY_ERROR, nunca RATE_OK por omissao', async () => {
    const client = makeFakeClient(null, new Error('boom'));
    const result = await checkOutboundRateLimit({ userId: 'user-1' }, client, fixedNow);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('count ausente/invalido sem error -> REPOSITORY_ERROR, nunca presumido como zero', async () => {
    const client = makeFakeClient(null, null);
    const result = await checkOutboundRateLimit({ userId: 'user-1' }, client, fixedNow);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('filtra por user_id e pela janela de tempo (last_attempted_at >= now - janela)', async () => {
    const client = makeFakeClient(0);
    await checkOutboundRateLimit({ userId: 'user-xyz' }, client, fixedNow);
    expect(client._calls[0].filters).toEqual({
      user_id: 'user-xyz',
      last_attempted_at: new Date(fixedNow().getTime() - 60_000).toISOString(),
    });
  });

  test('userId vazio -> lanca antes de qualquer query', async () => {
    const client = makeFakeClient(0);
    await expect(checkOutboundRateLimit({ userId: '' }, client, fixedNow)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });
});
