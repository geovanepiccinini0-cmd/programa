// Fase 3.5.2.1 — Testes da fronteira de mapeamento entre os contratos
// TypeScript e as RPCs reais (migration 020). Client fake mínimo —
// prova a FORMA da chamada (nomes de parâmetro p_*, mapeamento de
// outcome) e o tratamento de erro/resposta malformada, NUNCA a
// garantia transacional real (claim/rollback/concorrência) — essa é
// provada empiricamente contra Postgres local descartável (ver
// relatório da fase, nunca neste arquivo).
import { describe, expect, test, vi } from 'vitest';
import {
  reserveWhatsappOutboundAttempt,
  confirmWhatsappOutboundSent,
  markWhatsappOutboundAttemptResult,
  applyWhatsappOutboundStatusEvent,
} from './whatsappOutboundRepository.ts';

function makeFakeClient(rpcImpl: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  return {
    rpc: vi.fn((fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      return rpcImpl(fn, params);
    }),
    _calls: calls,
  };
}

describe('reserveWhatsappOutboundAttempt', () => {
  test('CLAIMED -> mapeia outcome/messageId/attemptNumber, nomes de parametro p_* corretos', async () => {
    const client = makeFakeClient(async () => ({
      data: [{ outcome: 'CLAIMED', message_id: 'msg-1', attempt_number: 1, current_status: 'queued' }],
      error: null,
    }));
    const result = await reserveWhatsappOutboundAttempt(
      { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi' },
      client,
    );
    expect(result).toEqual({ outcome: 'CLAIMED', messageId: 'msg-1', attemptNumber: 1 });
    expect(client._calls[0]).toEqual({
      fn: 'reserve_whatsapp_outbound_attempt',
      params: { p_client_token: 'tok-1', p_user_id: 'user-1', p_lead_id: 'lead-1', p_integration_account_id: 'ia-1', p_content: 'oi' },
    });
  });

  test.each(['ALREADY_IN_FLIGHT', 'ALREADY_RESOLVED', 'IDENTITY_CONFLICT'])('%s -> mapeia messageId/currentStatus', async (outcome) => {
    const client = makeFakeClient(async () => ({
      data: [{ outcome, message_id: 'msg-1', attempt_number: null, current_status: 'queued' }],
      error: null,
    }));
    const result = await reserveWhatsappOutboundAttempt(
      { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi' },
      client,
    );
    expect(result).toEqual({ outcome, messageId: 'msg-1', currentStatus: 'queued' });
  });

  test('erro do client -> REPOSITORY_ERROR, nunca mascarado', async () => {
    const client = makeFakeClient(async () => ({ data: null, error: new Error('boom') }));
    const result = await reserveWhatsappOutboundAttempt(
      { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi' },
      client,
    );
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('resposta malformada (nao exatamente 1 linha) -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    const result = await reserveWhatsappOutboundAttempt(
      { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi' },
      client,
    );
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('clientToken vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(reserveWhatsappOutboundAttempt(
      { clientToken: '', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi' },
      client,
    )).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('content vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(reserveWhatsappOutboundAttempt(
      { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: '   ' },
      client,
    )).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('client invalido (sem rpc()) -> lanca', async () => {
    await expect(reserveWhatsappOutboundAttempt(
      { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi' },
      {},
    )).rejects.toThrow(TypeError);
  });
});

describe('confirmWhatsappOutboundSent', () => {
  test('CONFIRMED -> mapeia leadInteractionId', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'CONFIRMED', lead_interaction_id: 'int-1' }], error: null }));
    const result = await confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: 'wamid.X' }, client);
    expect(result).toEqual({ outcome: 'CONFIRMED', leadInteractionId: 'int-1' });
    expect(client._calls[0]).toEqual({
      fn: 'confirm_whatsapp_outbound_sent',
      params: { p_message_id: 'msg-1', p_external_message_id: 'wamid.X' },
    });
  });

  test('ALREADY_CONFIRMED -> mapeia leadInteractionId (idempotente)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'ALREADY_CONFIRMED', lead_interaction_id: 'int-1' }], error: null }));
    const result = await confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: 'wamid.X' }, client);
    expect(result).toEqual({ outcome: 'ALREADY_CONFIRMED', leadInteractionId: 'int-1' });
  });

  test('externalMessageId vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: '' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('erro do client -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(async () => ({ data: null, error: new Error('boom') }));
    const result = await confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: 'wamid.X' }, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });
});

describe('markWhatsappOutboundAttemptResult', () => {
  test('failed_transient -> mapeia currentStatus', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'failed_transient', current_status: 'queued' }], error: null }));
    const result = await markWhatsappOutboundAttemptResult(
      { messageId: 'msg-1', outcome: 'failed_transient', errorCode: 'network_timeout', httpStatus: null },
      client,
    );
    expect(result).toEqual({ outcome: 'failed_transient', currentStatus: 'queued' });
    expect(client._calls[0]).toEqual({
      fn: 'mark_whatsapp_outbound_attempt_result',
      params: { p_message_id: 'msg-1', p_outcome: 'failed_transient', p_error_code: 'network_timeout', p_http_status: null },
    });
  });

  test('failed_terminal -> mapeia currentStatus failed', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'failed_terminal', current_status: 'failed' }], error: null }));
    const result = await markWhatsappOutboundAttemptResult(
      { messageId: 'msg-1', outcome: 'failed_terminal', errorCode: 'invalid_recipient', httpStatus: 400 },
      client,
    );
    expect(result).toEqual({ outcome: 'failed_terminal', currentStatus: 'failed' });
  });

  test('outcome invalido -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(markWhatsappOutboundAttemptResult(
      // @ts-expect-error - outcome invalido de proposito para o teste
      { messageId: 'msg-1', outcome: 'bogus', errorCode: 'x', httpStatus: null },
      client,
    )).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });
});

describe('applyWhatsappOutboundStatusEvent', () => {
  test('APPLIED -> mapeia messageId', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'APPLIED', message_id: 'msg-1' }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent(
      { externalMessageId: 'wamid.X', newStatus: 'delivered', eventTimestamp: '2026-01-01T00:00:00.000Z' },
      client,
    );
    expect(result).toEqual({ outcome: 'APPLIED', messageId: 'msg-1' });
    expect(client._calls[0]).toEqual({
      fn: 'apply_whatsapp_outbound_status_event',
      params: { p_external_message_id: 'wamid.X', p_new_status: 'delivered', p_event_timestamp: '2026-01-01T00:00:00.000Z' },
    });
  });

  test('PENDING_WAMID -> messageId null', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'PENDING_WAMID', message_id: null }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent(
      { externalMessageId: 'wamid.X', newStatus: 'delivered', eventTimestamp: '2026-01-01T00:00:00.000Z' },
      client,
    );
    expect(result).toEqual({ outcome: 'PENDING_WAMID', messageId: null });
  });

  test('IGNORED_OUT_OF_ORDER_OR_DUPLICATE -> mapeia messageId', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', message_id: 'msg-1' }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent(
      { externalMessageId: 'wamid.X', newStatus: 'read', eventTimestamp: '2026-01-01T00:00:00.000Z' },
      client,
    );
    expect(result).toEqual({ outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', messageId: 'msg-1' });
  });
});
