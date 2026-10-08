import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  markIntegrationEventIgnored,
  markIntegrationEventFailed,
  getIntegrationEventById,
} from './integrationEventRepository.ts';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    status: 'received',
    error_code: null,
    resolved_user_id: null,
    resolved_lead_id: null,
    resolved_interaction_id: null,
    integration_account_id: null,
    processed_at: null,
    ...overrides,
  };
}

// updateResult: { data, error } retornado pelo UPDATE condicional.
// selectResult: { data, error } retornado pelo SELECT de read-after-zero
// (ou pela leitura direta via getIntegrationEventById).
function makeClient({ updateResult, selectResult }: { updateResult?: unknown; selectResult?: unknown } = {}) {
  const defaultUpdateResult = updateResult ?? { data: [{ id: 'evt-1' }], error: null };
  const defaultSelectResult = selectResult ?? { data: [row()], error: null };

  const updateIn = vi.fn(() => ({ select: vi.fn(() => Promise.resolve(defaultUpdateResult)) }));
  const updateEq = vi.fn(() => ({ in: updateIn }));
  const update = vi.fn(() => ({ eq: updateEq }));

  const selectEq = vi.fn(() => Promise.resolve(defaultSelectResult));
  const select = vi.fn(() => ({ eq: selectEq }));

  const from = vi.fn(() => ({ update, select }));
  return { from, update, updateEq, updateIn, select, selectEq };
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

  test('UPDATE usa eq(id) seguido de in(status, [received,processing,failed])', async () => {
    const client = makeClient();
    await markIntegrationEventIgnored({ eventId: 'evt-42', errorCode: 'account_not_found' }, client);
    expect(client.updateEq).toHaveBeenCalledWith('id', 'evt-42');
    expect(client.updateIn).toHaveBeenCalledWith('status', ['received', 'processing', 'failed']);
  });

  test('REPOSITORY_ERROR quando o client retorna error no UPDATE', async () => {
    const client = makeClient({ updateResult: { data: null, error: new Error('boom') } });
    const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('REPOSITORY_ERROR quando data do UPDATE nao e array (sem error reportado)', async () => {
    const client = makeClient({ updateResult: { data: null, error: null } });
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

  describe('hardening — transicoes terminais (Fase 3.3.3.3.1)', () => {
    test('zero linhas afetadas + read-after-zero mostra processed -> ALREADY_PROCESSED, nunca sobrescreve', async () => {
      const processedRow = row({ status: 'processed', resolved_lead_id: 'lead-1', resolved_interaction_id: 'int-1' });
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [processedRow], error: null } });
      const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
      expect(result.status).toBe('ALREADY_PROCESSED');
      if (result.status !== 'ALREADY_PROCESSED') throw new Error('unreachable');
      expect(result.event.resolvedLeadId).toBe('lead-1');
      expect(result.event.resolvedInteractionId).toBe('int-1');
    });

    test('zero linhas afetadas + read-after-zero mostra ignored -> ALREADY_IGNORED (idempotente, sem novo UPDATE)', async () => {
      const ignoredRow = row({ status: 'ignored', error_code: 'account_inactive' });
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [ignoredRow], error: null } });
      const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
      expect(result.status).toBe('ALREADY_IGNORED');
      expect(client.update).toHaveBeenCalledTimes(1); // so a tentativa original, nenhum retry
    });

    test('zero linhas afetadas + read-after-zero nao encontra a linha -> EVENT_NOT_FOUND', async () => {
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [], error: null } });
      const result = await markIntegrationEventIgnored({ eventId: 'evt-inexistente', errorCode: 'account_not_found' }, client);
      expect(result).toEqual({ status: 'EVENT_NOT_FOUND' });
    });

    test('zero linhas afetadas + read-after-zero mostra status ainda finalizavel -> STATE_CONFLICT (fail-closed defensivo)', async () => {
      const conflictRow = row({ status: 'processing' });
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [conflictRow], error: null } });
      const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
      expect(result.status).toBe('STATE_CONFLICT');
    });

    test('read-after-zero falha (erro de repository) -> REPOSITORY_ERROR, nunca falso sucesso', async () => {
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: null, error: new Error('read boom') } });
      const result = await markIntegrationEventIgnored({ eventId: 'evt-1', errorCode: 'account_not_found' }, client);
      expect(result.status).toBe('REPOSITORY_ERROR');
    });
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

  test('UPDATE usa eq(id) seguido de in(status, [received,processing,failed])', async () => {
    const client = makeClient();
    await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'processing_error' }, client);
    expect(client.updateIn).toHaveBeenCalledWith('status', ['received', 'processing', 'failed']);
  });

  test('REPOSITORY_ERROR quando o client retorna error', async () => {
    const client = makeClient({ updateResult: { data: null, error: new Error('boom') } });
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

  describe('hardening — transicoes terminais e TOCTOU (Fase 3.3.3.3.1)', () => {
    test('CRITICO: processed nao pode regredir para failed — UPDATE condicional afeta zero linhas, read-after-zero confirma processed', async () => {
      const processedRow = row({ status: 'processed', resolved_lead_id: 'lead-1', resolved_interaction_id: 'int-1', processed_at: '2026-01-01T00:00:00.000Z' });
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [processedRow], error: null } });
      const result = await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'processing_error' }, client);
      expect(result.status).toBe('ALREADY_PROCESSED');
      if (result.status !== 'ALREADY_PROCESSED') throw new Error('unreachable');
      expect(result.event.status).toBe('processed');
      expect(result.event.resolvedInteractionId).toBe('int-1');
    });

    test('CRITICO: ignored nao pode regredir para failed', async () => {
      const ignoredRow = row({ status: 'ignored', error_code: 'account_not_found' });
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [ignoredRow], error: null } });
      const result = await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'processing_error' }, client);
      expect(result.status).toBe('ALREADY_IGNORED');
    });

    test('failed -> failed e idempotente (status permanece finalizavel, UPDATE normal)', async () => {
      const client = makeClient({ updateResult: { data: [{ id: 'evt-1' }], error: null } });
      const result = await markIntegrationEventFailed({ eventId: 'evt-1', errorCode: 'processing_error' }, client);
      expect(result).toEqual({ status: 'OK' });
    });

    test('EVENT_NOT_FOUND quando zero linhas e leitura nao encontra a linha', async () => {
      const client = makeClient({ updateResult: { data: [], error: null }, selectResult: { data: [], error: null } });
      const result = await markIntegrationEventFailed({ eventId: 'evt-x', errorCode: 'processing_error' }, client);
      expect(result).toEqual({ status: 'EVENT_NOT_FOUND' });
    });
  });
});

describe('getIntegrationEventById', () => {
  test('retorna FOUND com snapshot mapeado camelCase', async () => {
    const client = makeClient({ selectResult: { data: [row({ status: 'processing' })], error: null } });
    const result = await getIntegrationEventById('evt-1', client);
    expect(result).toEqual({
      status: 'FOUND',
      event: {
        id: 'evt-1',
        status: 'processing',
        errorCode: null,
        resolvedUserId: null,
        resolvedLeadId: null,
        resolvedInteractionId: null,
        integrationAccountId: null,
        processedAt: null,
      },
    });
  });

  test('NOT_FOUND quando zero linhas', async () => {
    const client = makeClient({ selectResult: { data: [], error: null } });
    const result = await getIntegrationEventById('evt-x', client);
    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  test('REPOSITORY_ERROR quando o client retorna error', async () => {
    const client = makeClient({ selectResult: { data: null, error: new Error('boom') } });
    const result = await getIntegrationEventById('evt-1', client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('REPOSITORY_ERROR quando mais de uma linha e encontrada', async () => {
    const client = makeClient({ selectResult: { data: [row({ id: 'a' }), row({ id: 'b' })], error: null } });
    const result = await getIntegrationEventById('evt-1', client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('REPOSITORY_ERROR quando a linha retornada tem status fora do dominio', async () => {
    const client = makeClient({ selectResult: { data: [row({ status: 'bogus' })], error: null } });
    const result = await getIntegrationEventById('evt-1', client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test.each([
    ['eventId ausente', undefined],
    ['eventId vazio', ''],
    ['eventId whitespace', '   '],
  ])('lanca TypeError para eventId invalido: %s', async (_label, eventId) => {
    const client = makeClient();
    await expect(getIntegrationEventById(eventId, client)).rejects.toThrow(TypeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  test('lanca TypeError quando client nao expoe from()', async () => {
    await expect(getIntegrationEventById('evt-1', {})).rejects.toThrow(TypeError);
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
    ['user_id como identificador aceito em input', /\buser_id\s*:/],
  ];

  test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
    expect(codeLines).not.toMatch(pattern);
  });

  test('FINALIZABLE_FROM_STATUSES contem exatamente received/processing/failed, nunca processed/ignored', () => {
    const match = source.match(/const FINALIZABLE_FROM_STATUSES:[^=]*=\s*\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const values = (match as RegExpMatchArray)[1].match(/'([a-z]+)'/g)?.map((s) => s.replace(/'/g, ''));
    expect(values).toEqual(['received', 'processing', 'failed']);
  });
});
