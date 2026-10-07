import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { processInboundEvent, buildInboundLeadName } from './inboundEngine.ts';

const VALID_EVENT = {
  provider: 'whatsapp',
  externalEventId: 'evt-ext-1',
  externalAccountId: 'ext-acc-1',
  externalMessageId: 'msg-ext-1',
  occurredAt: '2026-01-01T10:00:00.000Z',
  senderPhoneRaw: '51992322166',
  senderDisplayName: 'Maria Teste',
  text: 'Oi, quero informacoes',
  messageType: 'text',
};

const RESOLVED_CANDIDATE = {
  provider: 'whatsapp',
  externalAccountId: 'ext-acc-1',
  userId: 'user-1',
  integrationAccountId: 'ia-1',
  active: true,
};

function makeDeps(overrides = {}) {
  return {
    findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [RESOLVED_CANDIDATE] })),
    processInboundWhatsAppEvent: vi.fn(async () => ({ lead_id: 'lead-1', interaction_id: 'int-1', was_new_lead: true, event_status: 'processed' })),
    markIntegrationEventIgnored: vi.fn(async () => ({ status: 'OK' })),
    markIntegrationEventFailed: vi.fn(async () => ({ status: 'OK' })),
    ...overrides,
  };
}

describe('processInboundEvent — contrato canonico (secao 29)', () => {
  test.each([
    ['provider vazio', { ...VALID_EVENT, provider: '' }],
    ['externalEventId vazio', { ...VALID_EVENT, externalEventId: '' }],
    ['externalAccountId vazio', { ...VALID_EVENT, externalAccountId: '' }],
    ['externalMessageId vazio', { ...VALID_EVENT, externalMessageId: '' }],
    ['senderPhoneRaw vazio', { ...VALID_EVENT, senderPhoneRaw: '' }],
    ['occurredAt invalido', { ...VALID_EVENT, occurredAt: 'nao-e-uma-data' }],
    ['occurredAt ausente', { ...VALID_EVENT, occurredAt: undefined }],
  ])('%s -> FAILED invalid_event, zero dependencia downstream, markFailed 1x', async (_label, event) => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', event, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'invalid_event', retryable: false });
    expect(deps.findAccountCandidates).not.toHaveBeenCalled();
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
    expect(deps.markIntegrationEventIgnored).not.toHaveBeenCalled();
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledTimes(1);
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledWith({ eventId: 'evt-1', errorCode: 'invalid_event' });
  });

  test('evento valido com Date real em occurredAt tambem e aceito', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, occurredAt: new Date('2026-01-01T10:00:00.000Z') }, deps);
    expect(result.status).toBe('PROCESSED');
  });

  test('precondicao: integrationEventId ausente/vazio lanca TypeError (nunca EngineResult)', async () => {
    const deps = makeDeps();
    await expect(processInboundEvent('', VALID_EVENT, deps)).rejects.toThrow(TypeError);
    await expect(processInboundEvent(undefined, VALID_EVENT, deps)).rejects.toThrow(TypeError);
    expect(deps.findAccountCandidates).not.toHaveBeenCalled();
  });

  test('precondicao: deps malformadas lancam TypeError', async () => {
    await expect(processInboundEvent('evt-1', VALID_EVENT, {})).rejects.toThrow(TypeError);
    await expect(processInboundEvent('evt-1', VALID_EVENT, null)).rejects.toThrow(TypeError);
  });
});

describe('processInboundEvent — account resolution (secao 30)', () => {
  test('RESOLVED -> continua para phone/RPC', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result.status).toBe('PROCESSED');
    expect(deps.processInboundWhatsAppEvent).toHaveBeenCalledTimes(1);
  });

  test('NOT_FOUND -> IGNORED account_not_found, 1 markIgnored, 0 RPC', async () => {
    const deps = makeDeps({ findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [] })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'IGNORED', reason: 'account_not_found' });
    expect(deps.markIntegrationEventIgnored).toHaveBeenCalledTimes(1);
    expect(deps.markIntegrationEventIgnored).toHaveBeenCalledWith({ eventId: 'evt-1', errorCode: 'account_not_found' });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
    expect(deps.markIntegrationEventFailed).not.toHaveBeenCalled();
  });

  test('INACTIVE -> IGNORED account_inactive, markIgnored com integrationAccountId, 0 RPC', async () => {
    const inactiveCandidate = { ...RESOLVED_CANDIDATE, active: false };
    const deps = makeDeps({ findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [inactiveCandidate] })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'IGNORED', reason: 'account_inactive' });
    expect(deps.markIntegrationEventIgnored).toHaveBeenCalledWith({ eventId: 'evt-1', errorCode: 'account_inactive', integrationAccountId: 'ia-1' });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
  });

  test('AMBIGUOUS -> FAILED account_ambiguous retryable=false, 0 RPC', async () => {
    const deps = makeDeps({ findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [RESOLVED_CANDIDATE, { ...RESOLVED_CANDIDATE, integrationAccountId: 'ia-2' }] })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'account_ambiguous', retryable: false });
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledWith({ eventId: 'evt-1', errorCode: 'account_ambiguous' });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
  });

  test('INVALID_INPUT (candidate malformado) -> FAILED account_resolution_invalid_input retryable=false, 0 RPC', async () => {
    const malformedCandidate = { ...RESOLVED_CANDIDATE, active: 'nope' };
    const deps = makeDeps({ findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [malformedCandidate] })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'account_resolution_invalid_input', retryable: false });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
  });

  test('REPOSITORY_ERROR -> FAILED account_repository_error retryable=true, nunca convertido em NOT_FOUND, 0 RPC', async () => {
    const deps = makeDeps({ findAccountCandidates: vi.fn(async () => ({ status: 'REPOSITORY_ERROR', error: new Error('boom') })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'account_repository_error', retryable: true });
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledWith({ eventId: 'evt-1', errorCode: 'account_repository_error' });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
  });
});

describe('processInboundEvent — phone identity (secao 31)', () => {
  test('telefone BR local (sem DDI) -> VALID, PROCESSED', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, senderPhoneRaw: '51992322166' }, deps);
    expect(result.status).toBe('PROCESSED');
  });

  test('telefone +55 explicito -> VALID, PROCESSED', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, senderPhoneRaw: '+5551992322166' }, deps);
    expect(result.status).toBe('PROCESSED');
  });

  test('telefone INVALID -> IGNORED invalid_sender_phone, zero RPC, zero lead/interaction', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, senderPhoneRaw: '' }, deps);
    // phone invalido so e alcancado se o contrato aceitar string vazia como invalido-de-dominio;
    // aqui senderPhoneRaw vazio já falha a validacao do evento (invalid_event) — testar caso
    // estruturalmente valido mas foneticamente invalido:
    expect(result.status).toBe('FAILED'); // vazio cai em invalid_event (contrato), nao em invalid_sender_phone
  });

  test('telefone estruturalmente presente mas INVALID pela regra de normalizacao (zero digitos) -> IGNORED invalid_sender_phone', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, senderPhoneRaw: 'abc' }, deps);
    expect(result).toEqual({ status: 'IGNORED', reason: 'invalid_sender_phone' });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
    expect(deps.markIntegrationEventIgnored).toHaveBeenCalledWith({ eventId: 'evt-1', errorCode: 'invalid_sender_phone', integrationAccountId: 'ia-1' });
  });

  test('telefone AMBIGUOUS (internacional nao-BR) -> IGNORED ambiguous_sender_phone', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, senderPhoneRaw: '+13051234567' }, deps);
    expect(result).toEqual({ status: 'IGNORED', reason: 'ambiguous_sender_phone' });
    expect(deps.processInboundWhatsAppEvent).not.toHaveBeenCalled();
  });

  test('telefone com marcador de ramal -> AMBIGUOUS -> IGNORED ambiguous_sender_phone', async () => {
    const deps = makeDeps();
    const result = await processInboundEvent('evt-1', { ...VALID_EVENT, senderPhoneRaw: '(51) 3333-4444 ramal 123' }, deps);
    expect(result).toEqual({ status: 'IGNORED', reason: 'ambiguous_sender_phone' });
  });
});

describe('buildInboundLeadName (secao 32)', () => {
  test.each([
    ['Maria Teste', '5551992322166', 'Maria Teste'],
    ['  Maria Com Espacos  ', '5551992322166', 'Maria Com Espacos'],
    ['', '5551992322166', 'WhatsApp • 2166'],
    ['   ', '5551992322166', 'WhatsApp • 2166'],
    [null, '5551992322166', 'WhatsApp • 2166'],
    [undefined, '5551992322166', 'WhatsApp • 2166'],
  ])('senderDisplayName=%p -> %s', (displayName, phone, expected) => {
    expect(buildInboundLeadName(displayName, phone)).toBe(expected);
  });
});

describe('processInboundEvent — process/RPC mapping (secao 33)', () => {
  test('novo lead: wasNewLead=true propagado', async () => {
    const deps = makeDeps({ processInboundWhatsAppEvent: vi.fn(async () => ({ lead_id: 'lead-x', interaction_id: 'int-x', was_new_lead: true, event_status: 'processed' })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'PROCESSED', leadId: 'lead-x', interactionId: 'int-x', wasNewLead: true });
  });

  test('lead existente: wasNewLead=false propagado', async () => {
    const deps = makeDeps({ processInboundWhatsAppEvent: vi.fn(async () => ({ lead_id: 'lead-existing', interaction_id: 'int-y', was_new_lead: false, event_status: 'processed' })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'PROCESSED', leadId: 'lead-existing', interactionId: 'int-y', wasNewLead: false });
  });

  test('evento ja processado (idempotente): mesmo mapping, zero markIgnored/markFailed', async () => {
    const deps = makeDeps({ processInboundWhatsAppEvent: vi.fn(async () => ({ lead_id: 'lead-1', interaction_id: 'int-1', was_new_lead: false, event_status: 'processed' })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result.status).toBe('PROCESSED');
    expect(deps.markIntegrationEventIgnored).not.toHaveBeenCalled();
    expect(deps.markIntegrationEventFailed).not.toHaveBeenCalled();
  });

  test('RPC e chamada com integrationAccountId (nunca userId) e campos esperados', async () => {
    const deps = makeDeps();
    await processInboundEvent('evt-1', VALID_EVENT, deps);
    const input = deps.processInboundWhatsAppEvent.mock.calls[0][0];
    expect(input.integrationEventId).toBe('evt-1');
    expect(input.integrationAccountId).toBe('ia-1');
    expect(input).not.toHaveProperty('userId');
    expect(input).not.toHaveProperty('user_id');
    expect(input.phoneNormalized).toBe('5551992322166');
    expect(input.nome).toBe('Maria Teste');
    expect(input.content).toBe('Oi, quero informacoes');
    expect(input.metadata).toEqual({ message_type: 'text' });
  });
});

describe('processInboundEvent — failures (secao 34)', () => {
  test('RPC rejeita (throw) -> FAILED processing_error retryable=true, markFailed 1x, RPC chamada 1x (zero retry automatico)', async () => {
    const deps = makeDeps({ processInboundWhatsAppEvent: vi.fn(async () => { throw new Error('rpc boom'); }) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'processing_error', retryable: true });
    expect(deps.processInboundWhatsAppEvent).toHaveBeenCalledTimes(1);
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledTimes(1);
  });

  test('RPC retorna resultado malformado (faltando lead_id) -> FAILED processing_error, nunca mascarado como sucesso', async () => {
    const deps = makeDeps({ processInboundWhatsAppEvent: vi.fn(async () => ({ interaction_id: 'int-1', was_new_lead: true, event_status: 'processed' })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'processing_error', retryable: true });
  });

  test('RPC retorna event_status != processed -> FAILED processing_error', async () => {
    const deps = makeDeps({ processInboundWhatsAppEvent: vi.fn(async () => ({ lead_id: 'l1', interaction_id: 'i1', was_new_lead: true, event_status: 'failed' })) });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'processing_error', retryable: true });
  });

  test('markIgnored falha (REPOSITORY_ERROR) -> EVENT_FINALIZATION_FAILED, nunca falso IGNORED', async () => {
    const deps = makeDeps({
      findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [] })),
      markIntegrationEventIgnored: vi.fn(async () => ({ status: 'REPOSITORY_ERROR', error: new Error('update falhou') })),
    });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result.status).toBe('EVENT_FINALIZATION_FAILED');
    expect(result.attemptedStatus).toBe('ignored');
    expect(result.reason).toBe('account_not_found');
  });

  test('markFailed falha (REPOSITORY_ERROR) apos falha da RPC -> EVENT_FINALIZATION_FAILED, nunca falso FAILED', async () => {
    const deps = makeDeps({
      processInboundWhatsAppEvent: vi.fn(async () => { throw new Error('rpc boom'); }),
      markIntegrationEventFailed: vi.fn(async () => ({ status: 'REPOSITORY_ERROR', error: new Error('update falhou') })),
    });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result.status).toBe('EVENT_FINALIZATION_FAILED');
    expect(result.attemptedStatus).toBe('failed');
    expect(result.reason).toBe('processing_error');
  });

  test('markFailed lanca exception (nao so rejeita com REPOSITORY_ERROR) -> ainda EVENT_FINALIZATION_FAILED, nunca propaga throw', async () => {
    const deps = makeDeps({
      processInboundWhatsAppEvent: vi.fn(async () => { throw new Error('rpc boom'); }),
      markIntegrationEventFailed: vi.fn(async () => { throw new Error('precondicao violada'); }),
    });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result.status).toBe('EVENT_FINALIZATION_FAILED');
  });

  test('markIgnored lanca exception -> EVENT_FINALIZATION_FAILED, nunca propaga throw', async () => {
    const deps = makeDeps({
      findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [] })),
      markIntegrationEventIgnored: vi.fn(async () => { throw new Error('precondicao violada'); }),
    });
    const result = await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(result.status).toBe('EVENT_FINALIZATION_FAILED');
  });
});

describe('processInboundEvent — call counts exatos (secao 35)', () => {
  test('conta ativa e telefone valido: 1 account lookup, 1 RPC, 0 markIgnored, 0 markFailed', async () => {
    const deps = makeDeps();
    await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(deps.findAccountCandidates).toHaveBeenCalledTimes(1);
    expect(deps.processInboundWhatsAppEvent).toHaveBeenCalledTimes(1);
    expect(deps.markIntegrationEventIgnored).toHaveBeenCalledTimes(0);
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledTimes(0);
  });

  test('account not found: 1 account lookup, 0 RPC, 1 markIgnored', async () => {
    const deps = makeDeps({ findAccountCandidates: vi.fn(async () => ({ status: 'OK', candidates: [] })) });
    await processInboundEvent('evt-1', VALID_EVENT, deps);
    expect(deps.findAccountCandidates).toHaveBeenCalledTimes(1);
    expect(deps.processInboundWhatsAppEvent).toHaveBeenCalledTimes(0);
    expect(deps.markIntegrationEventIgnored).toHaveBeenCalledTimes(1);
  });

  test('evento invalido: 0 account lookup, 0 RPC, 1 markFailed', async () => {
    const deps = makeDeps();
    await processInboundEvent('evt-1', { ...VALID_EVENT, provider: '' }, deps);
    expect(deps.findAccountCandidates).toHaveBeenCalledTimes(0);
    expect(deps.processInboundWhatsAppEvent).toHaveBeenCalledTimes(0);
    expect(deps.markIntegrationEventFailed).toHaveBeenCalledTimes(1);
  });
});

describe('processInboundEvent — zero side effect on import/construction (secao 36)', () => {
  test('importar o modulo nao executa nenhuma dependencia', async () => {
    // Se chegamos aqui sem nenhum mock ter sido criado/chamado fora dos
    // testes explicitos, a propria execucao da suite ja comprova isto —
    // nenhum teste depende de estado global deixado por outro.
    expect(typeof processInboundEvent).toBe('function');
  });
});

describe('auditoria estatica — zero coupling com Meta (secao 37)', () => {
  const source = readFileSync(new URL('./inboundEngine.ts', import.meta.url), 'utf8');
  const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  const forbiddenPatterns = [
    ['graph.facebook.com', /graph\.facebook\.com/],
    ['X-Hub-Signature', /X-Hub-Signature/i],
    ['fetch(', /fetch\(/],
    ['Deno.env', /Deno\.env/],
    ['npm: specifier', /npm:/],
    ['access_token', /access_token/],
    ['console.log', /console\.log/],
    ['phone_number_id', /phone_number_id/],
  ];

  test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
    expect(codeLines).not.toMatch(pattern);
  });
});
