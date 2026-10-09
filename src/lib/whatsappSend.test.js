import { describe, expect, test, vi } from 'vitest';
import {
  generateClientToken,
  computeSendGateStatus,
  buildOptimisticMessage,
  mergeOptimisticWithAuthoritative,
  statusForOutcomeKind,
  classifySendOutcome,
  invokeWhatsappSend,
  SEND_ERROR_MESSAGES,
  OUTBOUND_MESSAGING_WINDOW_MS,
} from './whatsappSend.js';

function msg(overrides = {}) {
  return {
    id: 'm-1',
    direction: 'inbound',
    occurredAt: '2026-01-01T10:00:00.000Z',
    clientToken: null,
    ...overrides,
  };
}

describe('generateClientToken', () => {
  test('gera uuids distintos a cada chamada', () => {
    const a = generateClientToken();
    const b = generateClientToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe('computeSendGateStatus', () => {
  test('sem nenhuma mensagem inbound -> no_identity (nunca permite enviar)', () => {
    const result = computeSendGateStatus([msg({ direction: 'outbound' })], new Date('2026-01-01T12:00:00.000Z'));
    expect(result).toEqual({ canSend: false, reason: 'no_identity', windowExpiresAt: null });
  });

  test('sem nenhuma mensagem -> no_identity', () => {
    const result = computeSendGateStatus([], new Date('2026-01-01T12:00:00.000Z'));
    expect(result.canSend).toBe(false);
    expect(result.reason).toBe('no_identity');
  });

  test('inbound recente (dentro de 24h) -> canSend true', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const result = computeSendGateStatus([msg({ occurredAt: now.toISOString() })], now);
    expect(result.canSend).toBe(true);
    expect(result.reason).toBeNull();
  });

  test('inbound ha mais de 24h -> window_closed', () => {
    const lastInboundAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(lastInboundAt.getTime() + OUTBOUND_MESSAGING_WINDOW_MS + 1000);
    const result = computeSendGateStatus([msg({ occurredAt: lastInboundAt.toISOString() })], now);
    expect(result.canSend).toBe(false);
    expect(result.reason).toBe('window_closed');
    expect(result.windowExpiresAt.toISOString()).toBe(new Date(lastInboundAt.getTime() + OUTBOUND_MESSAGING_WINDOW_MS).toISOString());
  });

  test('usa a mensagem inbound MAIS RECENTE entre varias (nunca a mais antiga)', () => {
    const now = new Date('2026-01-10T00:00:00.000Z');
    const result = computeSendGateStatus([
      msg({ id: 'old', occurredAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'recent', occurredAt: '2026-01-09T12:00:00.000Z' }),
      msg({ id: 'out', direction: 'outbound', occurredAt: '2026-01-09T13:00:00.000Z' }),
    ], now);
    expect(result.canSend).toBe(true);
  });

  test('ignora mensagens outbound ao calcular a janela (so inbound estabelece identidade)', () => {
    const now = new Date('2026-01-10T00:00:00.000Z');
    const result = computeSendGateStatus([
      msg({ direction: 'outbound', occurredAt: '2026-01-09T23:00:00.000Z' }),
    ], now);
    expect(result.canSend).toBe(false);
    expect(result.reason).toBe('no_identity');
  });
});

describe('buildOptimisticMessage', () => {
  test('monta uma mensagem outbound com status sending e id derivado do clientToken', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const m = buildOptimisticMessage({ leadId: 'lead-1', userId: 'user-1', content: 'Oi', clientToken: 'tok-1', now });
    expect(m).toMatchObject({
      id: 'pending-tok-1',
      leadId: 'lead-1',
      userId: 'user-1',
      direction: 'outbound',
      content: 'Oi',
      status: 'sending',
      clientToken: 'tok-1',
      pending: true,
    });
    expect(m.occurredAt).toBe(now.toISOString());
  });
});

describe('mergeOptimisticWithAuthoritative', () => {
  test('sem pendentes, retorna a lista autoritativa inalterada', () => {
    const authoritative = [msg({ id: 'a1' })];
    expect(mergeOptimisticWithAuthoritative(authoritative, [])).toBe(authoritative);
  });

  test('mantem pendente cujo clientToken ainda nao apareceu na lista autoritativa', () => {
    const authoritative = [msg({ id: 'a1', clientToken: null })];
    const pending = [buildOptimisticMessage({ leadId: 'l', userId: 'u', content: 'x', clientToken: 'tok-1' })];
    const result = mergeOptimisticWithAuthoritative(authoritative, pending);
    expect(result.map((m) => m.id)).toEqual(['a1', 'pending-tok-1']);
  });

  test('remove o pendente quando a linha autoritativa com o MESMO clientToken ja chegou (nunca duplica)', () => {
    const authoritative = [msg({ id: 'real-id', clientToken: 'tok-1', direction: 'outbound' })];
    const pending = [buildOptimisticMessage({ leadId: 'l', userId: 'u', content: 'x', clientToken: 'tok-1' })];
    const result = mergeOptimisticWithAuthoritative(authoritative, pending);
    expect(result.map((m) => m.id)).toEqual(['real-id']);
  });

  test('nunca remove um pendente de OUTRO clientToken so porque alguma autoritativa chegou', () => {
    const authoritative = [msg({ id: 'real-id', clientToken: 'tok-1', direction: 'outbound' })];
    const pending = [buildOptimisticMessage({ leadId: 'l', userId: 'u', content: 'y', clientToken: 'tok-2' })];
    const result = mergeOptimisticWithAuthoritative(authoritative, pending);
    expect(result.map((m) => m.id)).toEqual(['real-id', 'pending-tok-2']);
  });
});

describe('statusForOutcomeKind', () => {
  test('accepted -> sent (NUNCA delivered: aceite da Meta != entrega)', () => {
    expect(statusForOutcomeKind('accepted')).toBe('sent');
  });
  test('uncertain e network_uncertain -> uncertain', () => {
    expect(statusForOutcomeKind('uncertain')).toBe('uncertain');
    expect(statusForOutcomeKind('network_uncertain')).toBe('uncertain');
  });
  test('rejected e already_failed -> failed', () => {
    expect(statusForOutcomeKind('rejected')).toBe('failed');
    expect(statusForOutcomeKind('already_failed')).toBe('failed');
  });
  test('in_progress -> sending', () => {
    expect(statusForOutcomeKind('in_progress')).toBe('sending');
  });
  test('kinds sem messageId (ex. window_closed) -> null (sinal para remover a otimista)', () => {
    expect(statusForOutcomeKind('window_closed')).toBeNull();
    expect(statusForOutcomeKind('identity_unavailable')).toBeNull();
    expect(statusForOutcomeKind('internal_error')).toBeNull();
  });
});

describe('classifySendOutcome', () => {
  test('ACCEPTED -> accepted com messageId', () => {
    const result = classifySendOutcome({ ok: true, body: { outcome: 'ACCEPTED', messageId: 'm1', externalMessageId: 'wamid.1' } });
    expect(result).toEqual({ kind: 'accepted', messageId: 'm1' });
  });

  test('DUPLICATE_ALREADY_SENT -> accepted (mesma intencao ja resolvida)', () => {
    const result = classifySendOutcome({ ok: true, body: { outcome: 'DUPLICATE_ALREADY_SENT', messageId: 'm1' } });
    expect(result.kind).toBe('accepted');
  });

  test('UNCERTAIN -> uncertain, nunca presumido como falha ou sucesso', () => {
    const result = classifySendOutcome({ ok: true, body: { outcome: 'UNCERTAIN', messageId: 'm1' } });
    expect(result.kind).toBe('uncertain');
  });

  test('WINDOW_CLOSED -> window_closed, sem messageId (nenhuma linha criada)', () => {
    const result = classifySendOutcome({ ok: true, body: { outcome: 'WINDOW_CLOSED', windowExpiresAt: '2026-01-02T00:00:00Z' } });
    expect(result).toEqual({ kind: 'window_closed', messageId: null, windowExpiresAt: '2026-01-02T00:00:00Z' });
  });

  test('IDENTITY_UNAVAILABLE/AMBIGUOUS/MISMATCH e NO_INBOUND_CONVERSATION -> identity_unavailable', () => {
    for (const outcome of ['IDENTITY_UNAVAILABLE', 'IDENTITY_AMBIGUOUS', 'IDENTITY_MISMATCH', 'NO_INBOUND_CONVERSATION']) {
      expect(classifySendOutcome({ ok: true, body: { outcome } }).kind).toBe('identity_unavailable');
    }
  });

  test('REJECTED preserva errorCode', () => {
    const result = classifySendOutcome({ ok: true, body: { outcome: 'REJECTED', messageId: 'm1', errorCode: '131026' } });
    expect(result).toEqual({ kind: 'rejected', messageId: 'm1', errorCode: '131026' });
  });

  test('RATE_LIMITED -> rate_limited, sem messageId', () => {
    expect(classifySendOutcome({ ok: true, body: { outcome: 'RATE_LIMITED' } })).toEqual({ kind: 'rate_limited', messageId: null });
  });

  test('outcome desconhecido -> internal_error (falha fechada)', () => {
    expect(classifySendOutcome({ ok: true, body: { outcome: 'ALGO_NOVO_NAO_MAPEADO' } }).kind).toBe('internal_error');
  });

  test('falha de transporte (ok:false) -> network_uncertain, nunca falha definitiva', () => {
    expect(classifySendOutcome({ ok: false, body: null })).toEqual({ kind: 'network_uncertain', messageId: null });
  });

  test('corpo ausente/malformado mesmo com ok:true -> network_uncertain', () => {
    expect(classifySendOutcome({ ok: true, body: null }).kind).toBe('network_uncertain');
    expect(classifySendOutcome({ ok: true, body: 'nao e objeto' }).kind).toBe('network_uncertain');
  });

  test('todo kind sem messageId tem uma mensagem de erro definida em SEND_ERROR_MESSAGES (exceto network_uncertain/uncertain, que nao removem a otimista)', () => {
    const kindsSemMessageId = ['window_closed', 'identity_unavailable', 'account_inactive', 'rate_limited', 'lead_unavailable', 'auth_error', 'invalid_request', 'internal_error'];
    for (const kind of kindsSemMessageId) {
      expect(SEND_ERROR_MESSAGES[kind]).toBeTypeOf('string');
    }
  });
});

describe('invokeWhatsappSend', () => {
  test('chama supabase.functions.invoke com o payload minimo (leadId/content/clientToken) e retorna ok:true', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { outcome: 'ACCEPTED', messageId: 'm1' }, error: null });
    const client = { functions: { invoke } };
    const result = await invokeWhatsappSend(client, { leadId: 'lead-1', content: 'Oi', clientToken: 'tok-1' });
    expect(invoke).toHaveBeenCalledWith('whatsapp-send', { body: { leadId: 'lead-1', content: 'Oi', clientToken: 'tok-1' } });
    expect(result).toEqual({ ok: true, body: { outcome: 'ACCEPTED', messageId: 'm1' } });
  });

  test('nunca inclui telefone, integrationAccountId ou userId no payload', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { outcome: 'ACCEPTED', messageId: 'm1' }, error: null });
    const client = { functions: { invoke } };
    await invokeWhatsappSend(client, { leadId: 'lead-1', content: 'Oi', clientToken: 'tok-1' });
    const sentBody = invoke.mock.calls[0][1].body;
    expect(Object.keys(sentBody).sort()).toEqual(['clientToken', 'content', 'leadId']);
  });

  test('FunctionsHttpError com corpo JSON legivel -> ok:true com o outcome do corpo (ex. WINDOW_CLOSED)', async () => {
    const response = { status: 422, json: vi.fn().mockResolvedValue({ outcome: 'WINDOW_CLOSED', windowExpiresAt: '2026-01-02T00:00:00Z' }) };
    const error = { name: 'FunctionsHttpError', context: response };
    const invoke = vi.fn().mockResolvedValue({ data: null, error });
    const client = { functions: { invoke } };
    const result = await invokeWhatsappSend(client, { leadId: 'lead-1', content: 'Oi', clientToken: 'tok-1' });
    expect(result).toEqual({ ok: true, body: { outcome: 'WINDOW_CLOSED', windowExpiresAt: '2026-01-02T00:00:00Z' } });
  });

  test('FunctionsFetchError (falha de rede real) -> ok:false, nunca presume sucesso', async () => {
    const error = { name: 'FunctionsFetchError', context: new Error('network down') };
    const invoke = vi.fn().mockResolvedValue({ data: null, error });
    const client = { functions: { invoke } };
    const result = await invokeWhatsappSend(client, { leadId: 'lead-1', content: 'Oi', clientToken: 'tok-1' });
    expect(result).toEqual({ ok: false, body: null });
  });

  test('FunctionsHttpError cujo corpo nao pode ser parseado -> ok:false (nunca finge sucesso)', async () => {
    const response = { status: 500, json: vi.fn().mockRejectedValue(new Error('corpo invalido')) };
    const error = { name: 'FunctionsHttpError', context: response };
    const invoke = vi.fn().mockResolvedValue({ data: null, error });
    const client = { functions: { invoke } };
    const result = await invokeWhatsappSend(client, { leadId: 'lead-1', content: 'Oi', clientToken: 'tok-1' });
    expect(result).toEqual({ ok: false, body: null });
  });
});
