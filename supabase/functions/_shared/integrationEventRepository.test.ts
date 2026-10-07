import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { markIntegrationEventIgnored, markIntegrationEventFailed } from './integrationEventRepository.ts';

function makeClient({ data, error } = { data: [{ id: 'evt-1' }], error: null }) {
  const eq = vi.fn(() => ({ select: vi.fn(() => Promise.resolve({ data, error })) }));
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { from, update, eq };
}

describe('markIntegrationEventIgnored', () => {
  test('atualiza status=ignored, processed_at e error_code', async () => {
    const client = makeClient();
    const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
    expect(result).toEqual({ status: 'OK' });
    const patch = client.update.mock.calls[0][0];
    expect(patch.status).toBe('ignored');
    expect(patch.error_code).toBe('account_not_found');
    expect(typeof patch.processed_at).toBe('string');
    expect(patch.integration_account_id).toBeUndefined();
  });

  test('inclui integration_account_id somente quando fornecido (ex. account_inactive)', async () => {
    const client = makeClient();
    await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_inactive', integrationAccountId: 'ia-1' }, client);
    const patch = client.update.mock.calls[0][0];
    expect(patch.integration_account_id).toBe('ia-1');
  });

  test('nunca preenche resolved_lead_id/resolved_interaction_id', async () => {
    const client = makeClient();
    await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
    const patch = client.update.mock.calls[0][0];
    expect(patch).not.toHaveProperty('resolved_lead_id');
    expect(patch).not.toHaveProperty('resolved_interaction_id');
  });

  test('eq chamado com id=eventId', async () => {
    const client = makeClient();
    await markIntegrationEventIgnored({ eventId: 'evt-42', errorCode: 'account_not_found' }, client);
    expect(client.eq).toHaveBeenCalledWith('id', 'evt-42');
  });

  test('REPOSITORY_ERROR quando o client retorna error', async () => {
    const client = makeClient({ data: null, error: new Error('boom') });
    const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('REPOSITORY_ERROR fail-closed quando zero linhas afetadas (eventId inexistente)', async () => {
    const client = makeClient({ data: [], error: null });
    const result = await markIntegrationEventIgnored({ eventId: 'evt-inexistente', errorCode: 'account_not_found' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('REPOSITORY_ERROR quando data nao e array (sem error reportado)', async () => {
    const client = makeClient({ data: null, error: null });
    const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('propaga via REPOSITORY_ERROR quando o client lanca (throw) em vez de rejeitar', async () => {
    const client = { from: vi.fn(() => ({ update: vi.fn(() => { throw new Error('boom sincrono'); }) })) };
    const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test.each([
    ['eventId ausente', { errorCode: 'account_not_found' }],
    ['eventId vazio', { eventId: '', errorCode: 'account_not_found' }],
    ['eventId whitespace', { eventId: '   ', errorCode: 'account_not_found' }],
    ['errorCode ausente', { eventId: 'evt-1' }],
    ['errorCode vazio', { eventId: 'evt-1', errorCode: '' }],
  ])('lanca TypeError para input invalido: %s', async (_label, input) => {
    const client = makeClient();
    await expect(markIntegrationEventIgnored(input, client)).rejects.toThrow(TypeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  test('lanca TypeError quando integrationAccountId fornecido mas vazio/whitespace', async () => {
    const client = makeClient();
    await expect(markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_inactive', integrationAccountId: '  ' }, client)).rejects.toThrow(TypeError);
  });

  test('lanca TypeError quando client nao expoe from()', async () => {
    await expect(markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, {})).rejects.toThrow(TypeError);
  });
});

describe('markIntegrationEventFailed', () => {
  test('atualiza status=failed e error_code, sem processed_at/retry_count', async () => {
    const client = makeClient();
    const result = await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'account_repository_error' }, client);
    expect(result).toEqual({ status: 'OK' });
    const patch = client.update.mock.calls[0][0];
    expect(patch).toEqual({ status: 'failed', error_code: 'account_repository_error' });
  });

  test('nunca toca retry_count', async () => {
    const client = makeClient();
    await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'processing_error' }, client);
    const patch = client.update.mock.calls[0][0];
    expect(patch).not.toHaveProperty('retry_count');
  });

  test('REPOSITORY_ERROR fail-closed quando zero linhas afetadas', async () => {
    const client = makeClient({ data: [], error: null });
    const result = await markIntegrationEventFailed({ eventId: 'evt-x', errorCode: 'processing_error' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('REPOSITORY_ERROR quando o client retorna error', async () => {
    const client = makeClient({ data: null, error: new Error('boom') });
    const result = await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'processing_error' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test.each([
    ['eventId ausente', { errorCode: 'processing_error' }],
    ['eventId vazio', { eventId: '', errorCode: 'processing_error' }],
    ['errorCode ausente', { eventId: 'evt-1' }],
  ])('lanca TypeError para input invalido: %s', async (_label, input) => {
    const client = makeClient();
    await expect(markIntegrationEventFailed(input, client)).rejects.toThrow(TypeError);
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe('auditoria estatica de seguranca (integrationEventRepository.ts)', () => {
  const source = readFileSync(new URL('./integrationEventRepository.ts', import.meta.url), 'utf8');
  const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  const forbiddenPatterns = [
    ['Deno.env', /Deno\.env/],
    ['npm: specifier', /npm:/],
    ['import real de createClient', /from\s+['"]@supabase\/supabase-js/],
    ['console.log', /console\.log/],
    ['payload_minimized', /payload_minimized/],
    ['user_id', /\buser_id\b/],
  ];

  test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
    expect(codeLines).not.toMatch(pattern);
  });
});
