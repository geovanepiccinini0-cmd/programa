import { describe, expect, test, vi } from 'vitest';
import { verifyAuthenticatedIdentity } from './whatsappSendAuth.ts';

function makeFakeAuthClient(getUserImpl: (jwt?: string) => Promise<{ data: { user: { id: unknown } | null } | null; error: unknown }>) {
  const calls: Array<string | undefined> = [];
  return {
    auth: {
      getUser: vi.fn((jwt?: string) => {
        calls.push(jwt);
        return getUserImpl(jwt);
      }),
    },
    _calls: calls,
  };
}

describe('verifyAuthenticatedIdentity', () => {
  test('JWT valido -> OK com userId, chama auth.getUser com o token exato (nunca decodifica localmente)', async () => {
    const client = makeFakeAuthClient(async () => ({ data: { user: { id: 'user-123' } }, error: null }));
    const result = await verifyAuthenticatedIdentity('Bearer abc.def.ghi', client);
    expect(result).toEqual({ status: 'OK', identity: { userId: 'user-123' } });
    expect(client._calls).toEqual(['abc.def.ghi']);
  });

  test('header ausente -> UNAUTHENTICATED, nunca chama o client', async () => {
    const client = makeFakeAuthClient(async () => ({ data: { user: { id: 'x' } }, error: null }));
    const result = await verifyAuthenticatedIdentity(undefined, client);
    expect(result).toEqual({ status: 'UNAUTHENTICATED' });
    expect(client._calls).toHaveLength(0);
  });

  test('header sem esquema Bearer -> UNAUTHENTICATED', async () => {
    const client = makeFakeAuthClient(async () => ({ data: { user: { id: 'x' } }, error: null }));
    const result = await verifyAuthenticatedIdentity('Basic abc123', client);
    expect(result).toEqual({ status: 'UNAUTHENTICATED' });
    expect(client._calls).toHaveLength(0);
  });

  test('Bearer vazio -> UNAUTHENTICATED, nunca chama o client', async () => {
    const client = makeFakeAuthClient(async () => ({ data: { user: { id: 'x' } }, error: null }));
    const result = await verifyAuthenticatedIdentity('Bearer    ', client);
    expect(result).toEqual({ status: 'UNAUTHENTICATED' });
    expect(client._calls).toHaveLength(0);
  });

  test('JWT invalido/expirado (auth.getUser retorna error) -> UNAUTHENTICATED', async () => {
    const client = makeFakeAuthClient(async () => ({ data: null, error: new Error('invalid JWT') }));
    const result = await verifyAuthenticatedIdentity('Bearer expired.token.here', client);
    expect(result).toEqual({ status: 'UNAUTHENTICATED' });
  });

  test('sessao expirada (user null, sem error explicito) -> UNAUTHENTICATED', async () => {
    const client = makeFakeAuthClient(async () => ({ data: { user: null }, error: null }));
    const result = await verifyAuthenticatedIdentity('Bearer some.token', client);
    expect(result).toEqual({ status: 'UNAUTHENTICATED' });
  });

  test('user.id nao e string nao-vazia -> UNAUTHENTICATED', async () => {
    const client = makeFakeAuthClient(async () => ({ data: { user: { id: '' } }, error: null }));
    const result = await verifyAuthenticatedIdentity('Bearer some.token', client);
    expect(result).toEqual({ status: 'UNAUTHENTICATED' });
  });

  test('falha de transporte ao chamar auth.getUser -> REPOSITORY_ERROR, nunca UNAUTHENTICATED mascarando uma falha nossa', async () => {
    const client = {
      auth: {
        getUser: vi.fn(() => { throw new Error('network down'); }),
      },
    };
    const result = await verifyAuthenticatedIdentity('Bearer some.token', client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('client invalido (sem auth.getUser) -> lanca', async () => {
    await expect(verifyAuthenticatedIdentity('Bearer x', {})).rejects.toThrow(TypeError);
  });
});
