import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOrGetIntegrationEvent } from './integrationEventIngressRepository.ts';

const VALID_INPUT = {
  provider: 'whatsapp',
  externalEventId: 'wamid.EVT1',
  externalMessageId: 'wamid.EVT1',
  externalAccountId: 'phone-number-id-1',
  eventType: 'message',
  payloadMinimized: { message_type: 'text', phone_number_id: 'phone-number-id-1', field: 'messages' },
  receivedAt: '2026-01-01T00:00:00.000Z',
};

function row(overrides = {}) {
  return {
    id: 'evt-1',
    provider: 'whatsapp',
    external_event_id: 'wamid.EVT1',
    external_message_id: 'wamid.EVT1',
    account_external_id: 'phone-number-id-1',
    integration_account_id: null,
    event_type: 'message',
    status: 'received',
    received_at: '2026-01-01T00:00:00.000Z',
    processing_started_at: null,
    processed_at: null,
    retry_count: 0,
    error_code: null,
    resolved_user_id: null,
    resolved_lead_id: null,
    resolved_interaction_id: null,
    ...overrides,
  };
}

// selectHandler(col1, val1, col2, val2) -> { data, error }
function makeClient({ insertResult, selectHandler } = {}) {
  const insertCalls: unknown[] = [];
  const selectCalls: unknown[] = [];

  const insertFn = vi.fn((insertRow: Record<string, unknown>) => {
    insertCalls.push(insertRow);
    return {
      select: vi.fn(() => Promise.resolve(insertResult ?? { data: [row()], error: null })),
    };
  });

  const selectFn = vi.fn((_columns: string) => ({
    eq: vi.fn((col1: string, val1: unknown) => ({
      eq: vi.fn((col2: string, val2: unknown) => {
        selectCalls.push({ col1, val1, col2, val2 });
        const result = selectHandler ? selectHandler(col1, val1, col2, val2) : { data: [], error: null };
        return Promise.resolve(result);
      }),
    })),
  }));

  const fromFn = vi.fn(() => ({ insert: insertFn, select: selectFn }));

  return { from: fromFn, insertFn, selectFn, insertCalls, selectCalls };
}

describe('createOrGetIntegrationEvent — input validation (fail-closed, zero query)', () => {
  test.each([
    ['provider ausente', { ...VALID_INPUT, provider: undefined }],
    ['provider vazio', { ...VALID_INPUT, provider: '' }],
    ['provider so-whitespace', { ...VALID_INPUT, provider: '   ' }],
    ['externalEventId ausente', { ...VALID_INPUT, externalEventId: undefined }],
    ['externalEventId vazio', { ...VALID_INPUT, externalEventId: '' }],
    ['externalMessageId ausente', { ...VALID_INPUT, externalMessageId: undefined }],
    ['externalMessageId vazio', { ...VALID_INPUT, externalMessageId: '' }],
    ['externalAccountId ausente', { ...VALID_INPUT, externalAccountId: undefined }],
    ['externalAccountId vazio', { ...VALID_INPUT, externalAccountId: '' }],
    ['eventType ausente', { ...VALID_INPUT, eventType: undefined }],
    ['eventType vazio', { ...VALID_INPUT, eventType: '' }],
    ['receivedAt ausente', { ...VALID_INPUT, receivedAt: undefined }],
    ['receivedAt invalido (string nao-data)', { ...VALID_INPUT, receivedAt: 'not-a-date' }],
    ['receivedAt invalido (numero)', { ...VALID_INPUT, receivedAt: 123 }],
    ['payloadMinimized invalido (string)', { ...VALID_INPUT, payloadMinimized: 'oops' }],
    ['payloadMinimized invalido (array)', { ...VALID_INPUT, payloadMinimized: [] }],
  ])('lanca TypeError e nao executa query: %s', async (_label, input) => {
    const client = makeClient();
    await expect(createOrGetIntegrationEvent(input, client)).rejects.toThrow(TypeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  test('lanca TypeError para client invalido (sem from)', async () => {
    await expect(createOrGetIntegrationEvent(VALID_INPUT, {})).rejects.toThrow(TypeError);
  });

  test('aceita payloadMinimized null', async () => {
    const client = makeClient();
    const result = await createOrGetIntegrationEvent({ ...VALID_INPUT, payloadMinimized: null }, client);
    expect(result.status).toBe('CREATED');
  });
});

describe('createOrGetIntegrationEvent — CREATED', () => {
  test('INSERT bem sucedido retorna CREATED com mapping snake_case -> camelCase', async () => {
    const client = makeClient({ insertResult: { data: [row()], error: null } });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);

    expect(result.status).toBe('CREATED');
    if (result.status !== 'CREATED') throw new Error('unreachable');
    expect(result.event).toEqual({
      id: 'evt-1',
      provider: 'whatsapp',
      externalEventId: 'wamid.EVT1',
      externalMessageId: 'wamid.EVT1',
      accountExternalId: 'phone-number-id-1',
      integrationAccountId: null,
      eventType: 'message',
      status: 'received',
      receivedAt: '2026-01-01T00:00:00.000Z',
      processingStartedAt: null,
      processedAt: null,
      retryCount: 0,
      errorCode: null,
      resolvedUserId: null,
      resolvedLeadId: null,
      resolvedInteractionId: null,
    });
  });

  test('status inicial sempre received, mesmo se caller tentar passar status extra', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({ ...VALID_INPUT, status: 'processed' } as never, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(insertRow.status).toBe('received');
  });

  test('INSERT nunca escreve integration_account_id/processing_started_at/processed_at/retry_count/error_code/resolved_*', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent(VALID_INPUT, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    for (const forbiddenKey of [
      'integration_account_id',
      'processing_started_at',
      'processed_at',
      'retry_count',
      'error_code',
      'resolved_user_id',
      'resolved_lead_id',
      'resolved_interaction_id',
      'user_id',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(insertRow, forbiddenKey)).toBe(false);
    }
  });

  test('cross-tenant: userId extra no input e ignorado, nunca alcanca o insert', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({ ...VALID_INPUT, userId: 'user-attacker' } as never, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(insertRow, 'user_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(insertRow, 'userId')).toBe(false);
  });

  test('receivedAt usado e exatamente o fornecido pelo caller (nunca Date.now escondido)', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({ ...VALID_INPUT, receivedAt: '2020-05-05T05:05:05.000Z' }, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(insertRow.received_at).toBe('2020-05-05T05:05:05.000Z');
  });

  test('receivedAt aceita instancia de Date e converte para ISO string', async () => {
    const client = makeClient();
    const date = new Date('2021-03-03T03:03:03.000Z');
    await createOrGetIntegrationEvent({ ...VALID_INPUT, receivedAt: date }, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(insertRow.received_at).toBe('2021-03-03T03:03:03.000Z');
  });
});

describe('createOrGetIntegrationEvent — payload minimization (whitelist estrita)', () => {
  test('mantem somente as chaves permitidas, com valores string/null', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({
      ...VALID_INPUT,
      payloadMinimized: {
        message_type: 'text',
        phone_number_id: 'pn-1',
        display_phone_number: '+5511999999999',
        field: 'messages',
      },
    }, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(insertRow.payload_minimized).toEqual({
      message_type: 'text',
      phone_number_id: 'pn-1',
      display_phone_number: '+5511999999999',
      field: 'messages',
    });
  });

  test('descarta chaves fora da whitelist, incluindo possiveis vazamentos sensiveis', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({
      ...VALID_INPUT,
      payloadMinimized: {
        message_type: 'text',
        content: 'segredo do lead',
        text: 'corpo da mensagem',
        body: 'outro corpo',
        raw_payload: { anything: true },
        headers: { 'x-hub-signature-256': 'sha256=...' },
        signature: 'sha256=abc',
        token: 'verify-token-real',
        secret: 'app-secret-real',
      },
    }, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    const persisted = insertRow.payload_minimized as Record<string, unknown>;
    expect(persisted).toEqual({ message_type: 'text' });
    for (const forbiddenKey of ['content', 'text', 'body', 'raw_payload', 'headers', 'signature', 'token', 'secret']) {
      expect(Object.prototype.hasOwnProperty.call(persisted, forbiddenKey)).toBe(false);
    }
  });

  test('ignora valores de tipo nao-string/null mesmo para chaves permitidas', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({
      ...VALID_INPUT,
      payloadMinimized: { message_type: 123, field: { nested: true } },
    }, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(insertRow.payload_minimized).toEqual({});
  });

  test('payloadMinimized null persiste null', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent({ ...VALID_INPUT, payloadMinimized: null }, client);
    const insertRow = client.insertCalls[0] as Record<string, unknown>;
    expect(insertRow.payload_minimized).toBeNull();
  });
});

describe('createOrGetIntegrationEvent — DUPLICATE (conflito por external_event_id)', () => {
  test('23505 + lookup por event_id resolve a mesma linha para ambas identidades -> DUPLICATE', async () => {
    const existing = row();
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505', message: 'duplicate key' } },
      selectHandler: () => ({ data: [existing], error: null }),
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('DUPLICATE');
    if (result.status !== 'DUPLICATE') throw new Error('unreachable');
    expect(result.event.id).toBe('evt-1');
  });

  test('DUPLICATE retorna o status atual real do evento (ex. processed), sem modifica-lo', async () => {
    const existing = row({ status: 'processed', processed_at: '2026-01-02T00:00:00.000Z', resolved_lead_id: 'lead-1' });
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: () => ({ data: [existing], error: null }),
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('DUPLICATE');
    if (result.status !== 'DUPLICATE') throw new Error('unreachable');
    expect(result.event.status).toBe('processed');
    expect(result.event.resolvedLeadId).toBe('lead-1');
    // Nenhuma chamada de update/insert alem da tentativa original.
    expect(client.insertFn).toHaveBeenCalledTimes(1);
  });
});

describe('createOrGetIntegrationEvent — DUPLICATE (conflito por external_message_id)', () => {
  test('23505 causado pelo indice parcial de message_id, com external_event_id diferente -> DUPLICATE, event_id original preservado', async () => {
    const existing = row({ id: 'evt-original', external_event_id: 'wamid.ORIGINAL-DELIVERY' });
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: (col1, val1, col2) => {
        if (col2 === 'external_event_id') return { data: [], error: null };
        if (col2 === 'external_message_id') return { data: [existing], error: null };
        return { data: [], error: null };
      },
    });
    const result = await createOrGetIntegrationEvent({
      ...VALID_INPUT,
      externalEventId: 'wamid.NEW-DELIVERY-ATTEMPT',
    }, client);

    expect(result.status).toBe('DUPLICATE');
    if (result.status !== 'DUPLICATE') throw new Error('unreachable');
    expect(result.event.id).toBe('evt-original');
    // O external_event_id persistido e o ORIGINAL, nunca sobrescrito pela tentativa nova.
    expect(result.event.externalEventId).toBe('wamid.ORIGINAL-DELIVERY');
  });
});

describe('createOrGetIntegrationEvent — IDENTITY_CONFLICT', () => {
  test('lookup por event_id e por message_id apontam para linhas DIFERENTES -> IDENTITY_CONFLICT, nenhuma escolhida', async () => {
    const rowA = row({ id: 'evt-A' });
    const rowB = row({ id: 'evt-B', external_event_id: 'wamid.OTHER' });
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: (col1, val1, col2) => {
        if (col2 === 'external_event_id') return { data: [rowA], error: null };
        if (col2 === 'external_message_id') return { data: [rowB], error: null };
        return { data: [], error: null };
      },
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('IDENTITY_CONFLICT');
    if (result.status !== 'IDENTITY_CONFLICT') throw new Error('unreachable');
    expect(result.eventIdByEventId).toBe('evt-A');
    expect(result.eventIdByMessageId).toBe('evt-B');
  });
});

describe('createOrGetIntegrationEvent — erros / fail-closed', () => {
  test('erro de insert nao-23505 -> REPOSITORY_ERROR, sem lookup', async () => {
    const client = makeClient({ insertResult: { data: null, error: { code: '42501', message: 'permission denied' } } });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
    expect(client.selectFn).not.toHaveBeenCalled();
  });

  test('23505 + lookup por event_id falha -> REPOSITORY_ERROR', async () => {
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: (col1, val1, col2) => {
        if (col2 === 'external_event_id') return { data: null, error: new Error('lookup boom') };
        return { data: [], error: null };
      },
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('23505 + lookup por message_id falha -> REPOSITORY_ERROR', async () => {
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: (col1, val1, col2) => {
        if (col2 === 'external_message_id') return { data: null, error: new Error('lookup boom') };
        return { data: [], error: null };
      },
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('23505 + zero linhas encontradas por qualquer identidade -> REPOSITORY_ERROR (nao foi possivel provar duplicata)', async () => {
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: () => ({ data: [], error: null }),
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('linha inserida malformada (sem id) -> REPOSITORY_ERROR, nunca falso CREATED', async () => {
    const client = makeClient({ insertResult: { data: [row({ id: undefined })], error: null } });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('linha inserida malformada (status fora do dominio) -> REPOSITORY_ERROR', async () => {
    const client = makeClient({ insertResult: { data: [row({ status: 'bogus' })], error: null } });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('INSERT retorna array vazio (zero linhas) -> REPOSITORY_ERROR', async () => {
    const client = makeClient({ insertResult: { data: [], error: null } });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('INSERT retorna data nao-array sem error -> REPOSITORY_ERROR', async () => {
    const client = makeClient({ insertResult: { data: null, error: null } });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('linha duplicada malformada (status fora do dominio) -> REPOSITORY_ERROR', async () => {
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: () => ({ data: [row({ status: 'bogus' })], error: null }),
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('excecao sincrona lancada pelo client no insert -> REPOSITORY_ERROR (nunca propaga como throw nao tratado)', async () => {
    const client = makeClient();
    client.insertFn.mockImplementation(() => {
      throw new Error('client thrown');
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('mais de uma linha encontrada no lookup por event_id -> REPOSITORY_ERROR (nunca escolhe uma)', async () => {
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: (col1, val1, col2) => {
        if (col2 === 'external_event_id') return { data: [row({ id: 'a' }), row({ id: 'b' })], error: null };
        return { data: [], error: null };
      },
    });
    const result = await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });
});

describe('createOrGetIntegrationEvent — call counts', () => {
  test('CREATED: exatamente 1 insert, zero lookup de duplicata', async () => {
    const client = makeClient();
    await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(client.insertFn).toHaveBeenCalledTimes(1);
    expect(client.selectFn).not.toHaveBeenCalled();
  });

  test('input invalido: zero chamada a from()', async () => {
    const client = makeClient();
    await expect(createOrGetIntegrationEvent({ ...VALID_INPUT, provider: '' }, client)).rejects.toThrow(TypeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  test('23505: exatamente 1 insert + lookups minimos (as duas identidades, em paralelo)', async () => {
    const client = makeClient({
      insertResult: { data: null, error: { code: '23505' } },
      selectHandler: () => ({ data: [row()], error: null }),
    });
    await createOrGetIntegrationEvent(VALID_INPUT, client);
    expect(client.insertFn).toHaveBeenCalledTimes(1);
    expect(client.selectFn).toHaveBeenCalledTimes(2);
  });
});

describe('auditoria estatica de seguranca (integrationEventIngressRepository.ts)', () => {
  const source = readFileSync(new URL('./integrationEventIngressRepository.ts', import.meta.url), 'utf8');
  const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  const forbiddenPatterns: Array<[string, RegExp]> = [
    ['Deno.env', /Deno\.env/],
    ['npm: specifier', /npm:/],
    ['import real de createClient', /from\s+['"]@supabase\/supabase-js/],
    ['console.log', /console\.log/],
    ['import do inboundEngine (Engine nunca invocado nesta fase)', /inboundEngine/],
    ['Date.now oculto', /Date\.now\(\)/],
    ['new Date() sem argumento (data atual oculta)', /new Date\(\)(?!\.)/],
    ['Request/Response/Deno.serve (HTTP pertence a 3.3.3.3)', /\b(Request|Response|Deno\.serve)\b/],
    ['escrita de user_id como coluna', /\buser_id\s*:/],
    ['escrita de integration_account_id no insert', /insertRow[\s\S]{0,400}integration_account_id/],
  ];

  test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
    expect(codeLines).not.toMatch(pattern);
  });

  test('STATUS_DOMAIN contem exatamente os 5 status conhecidos, nenhum extra', () => {
    const match = source.match(/const STATUS_DOMAIN: readonly IntegrationEventStatus\[\] = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const values = (match as RegExpMatchArray)[1].match(/'([a-z]+)'/g)?.map((s) => s.replace(/'/g, ''));
    expect(values).toEqual(['received', 'processing', 'processed', 'ignored', 'failed']);
  });

  test('PAYLOAD_MINIMIZED_ALLOWED_KEYS contem exatamente as 4 chaves congeladas', () => {
    const match = source.match(/PAYLOAD_MINIMIZED_ALLOWED_KEYS = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const values = (match as RegExpMatchArray)[1].match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, ''));
    expect(values).toEqual(['message_type', 'phone_number_id', 'display_phone_number', 'field']);
  });
});
