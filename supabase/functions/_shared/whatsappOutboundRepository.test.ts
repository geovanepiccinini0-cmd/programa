// Fase 3.5.2.1 — Testes da fronteira de mapeamento entre os contratos
// TypeScript e as RPCs reais (migrations 020 + 021 — máquina de
// estados corrigida após a auditoria adversarial). Client fake
// mínimo — prova a FORMA da chamada (nomes de parâmetro p_*,
// mapeamento de outcome) e o tratamento de erro/resposta malformada,
// NUNCA a garantia transacional real (claim/CAS/rollback/concorrência)
// — essa é provada empiricamente contra Postgres local descartável
// (ver relatório da fase, nunca neste arquivo).
import { describe, expect, test, vi } from 'vitest';
import {
  reserveWhatsappOutboundAttempt,
  startWhatsappOutboundAttemptCall,
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

const VALID_RESERVE_INPUT = { clientToken: 'tok-1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1', content: 'oi', contactPhoneNormalized: '5551900000001' };

describe('reserveWhatsappOutboundAttempt', () => {
  test.each(['CLAIMED', 'CLAIMED_WITH_PRIOR_UNCERTAIN'])('%s -> mapeia outcome/messageId/attemptNumber, nomes de parametro p_* corretos (incluindo p_contact_phone_normalized)', async (outcome) => {
    const client = makeFakeClient(async () => ({
      data: [{ outcome, message_id: 'msg-1', attempt_number: 1, current_status: 'queued' }],
      error: null,
    }));
    const result = await reserveWhatsappOutboundAttempt(VALID_RESERVE_INPUT, client);
    expect(result).toEqual({ outcome, messageId: 'msg-1', attemptNumber: 1 });
    expect(client._calls[0]).toEqual({
      fn: 'reserve_whatsapp_outbound_attempt',
      params: {
        p_client_token: 'tok-1',
        p_user_id: 'user-1',
        p_lead_id: 'lead-1',
        p_integration_account_id: 'ia-1',
        p_content: 'oi',
        p_contact_phone_normalized: '5551900000001',
      },
    });
  });

  test.each(['ALREADY_IN_FLIGHT', 'ALREADY_CALLING', 'UNCERTAIN_BLOCKED', 'ALREADY_RESOLVED', 'IDENTITY_CONFLICT'])('%s -> mapeia messageId/currentStatus', async (outcome) => {
    const client = makeFakeClient(async () => ({
      data: [{ outcome, message_id: 'msg-1', attempt_number: null, current_status: 'sending' }],
      error: null,
    }));
    const result = await reserveWhatsappOutboundAttempt(VALID_RESERVE_INPUT, client);
    expect(result).toEqual({ outcome, messageId: 'msg-1', currentStatus: 'sending' });
  });

  test.each(['IDENTITY_UNAVAILABLE', 'IDENTITY_AMBIGUOUS', 'IDENTITY_MISMATCH'])('%s -> mapeia somente outcome, nunca houve reserva', async (outcome) => {
    const client = makeFakeClient(async () => ({ data: [{ outcome, message_id: null, attempt_number: null, current_status: null }], error: null }));
    const result = await reserveWhatsappOutboundAttempt(VALID_RESERVE_INPUT, client);
    expect(result).toEqual({ outcome });
  });

  test('erro do client -> REPOSITORY_ERROR, nunca mascarado', async () => {
    const client = makeFakeClient(async () => ({ data: null, error: new Error('boom') }));
    const result = await reserveWhatsappOutboundAttempt(VALID_RESERVE_INPUT, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('resposta malformada (nao exatamente 1 linha) -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    const result = await reserveWhatsappOutboundAttempt(VALID_RESERVE_INPUT, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('clientToken vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(reserveWhatsappOutboundAttempt({ ...VALID_RESERVE_INPUT, clientToken: '' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('content vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(reserveWhatsappOutboundAttempt({ ...VALID_RESERVE_INPUT, content: '   ' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('contactPhoneNormalized vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(reserveWhatsappOutboundAttempt({ ...VALID_RESERVE_INPUT, contactPhoneNormalized: '' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('client invalido (sem rpc()) -> lanca', async () => {
    await expect(reserveWhatsappOutboundAttempt(VALID_RESERVE_INPUT, {})).rejects.toThrow(TypeError);
  });
});

describe('startWhatsappOutboundAttemptCall', () => {
  test('STARTED -> mapeia currentStatus=sending, nomes de parametro p_* corretos', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'STARTED', current_status: 'sending' }], error: null }));
    const result = await startWhatsappOutboundAttemptCall({ messageId: 'msg-1' }, client);
    expect(result).toEqual({ outcome: 'STARTED', currentStatus: 'sending' });
    expect(client._calls[0]).toEqual({
      fn: 'start_whatsapp_outbound_attempt_call',
      params: { p_message_id: 'msg-1' },
    });
  });

  test('ALREADY_STARTED_OR_RESOLVED -> mapeia currentStatus real (caller NUNCA deve chamar a Meta neste caso)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'ALREADY_STARTED_OR_RESOLVED', current_status: 'uncertain' }], error: null }));
    const result = await startWhatsappOutboundAttemptCall({ messageId: 'msg-1' }, client);
    expect(result).toEqual({ outcome: 'ALREADY_STARTED_OR_RESOLVED', currentStatus: 'uncertain' });
  });

  test('messageId vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(startWhatsappOutboundAttemptCall({ messageId: '' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('erro do client -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(async () => ({ data: null, error: new Error('boom') }));
    const result = await startWhatsappOutboundAttemptCall({ messageId: 'msg-1' }, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
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

  test('ALREADY_CONFIRMED -> mapeia leadInteractionId (idempotente, replay exato)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'ALREADY_CONFIRMED', lead_interaction_id: 'int-1' }], error: null }));
    const result = await confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: 'wamid.X' }, client);
    expect(result).toEqual({ outcome: 'ALREADY_CONFIRMED', leadInteractionId: 'int-1' });
  });

  test('CONFLICT_DIFFERENT_WAMID -> mapeia leadInteractionId do wamid JA confirmado (nunca o novo)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'CONFLICT_DIFFERENT_WAMID', lead_interaction_id: 'int-1' }], error: null }));
    const result = await confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: 'wamid.SEGUNDO' }, client);
    expect(result).toEqual({ outcome: 'CONFLICT_DIFFERENT_WAMID', leadInteractionId: 'int-1' });
  });

  test('CONFLICT_UNEXPECTED_STATE -> leadInteractionId null', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'CONFLICT_UNEXPECTED_STATE', lead_interaction_id: null }], error: null }));
    const result = await confirmWhatsappOutboundSent({ messageId: 'msg-1', externalMessageId: 'wamid.X' }, client);
    expect(result).toEqual({ outcome: 'CONFLICT_UNEXPECTED_STATE', leadInteractionId: null });
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
  test('failed_before_call -> mapeia currentStatus queued (seguro reclamar de imediato)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'failed_before_call', current_status: 'queued' }], error: null }));
    const result = await markWhatsappOutboundAttemptResult(
      { messageId: 'msg-1', outcome: 'failed_before_call', errorCode: 'validation_error', httpStatus: null },
      client,
    );
    expect(result).toEqual({ outcome: 'failed_before_call', currentStatus: 'queued' });
    expect(client._calls[0]).toEqual({
      fn: 'mark_whatsapp_outbound_attempt_result',
      params: { p_message_id: 'msg-1', p_outcome: 'failed_before_call', p_error_code: 'validation_error', p_http_status: null },
    });
  });

  test('uncertain -> mapeia currentStatus uncertain (bloqueio permanente)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'uncertain', current_status: 'uncertain' }], error: null }));
    const result = await markWhatsappOutboundAttemptResult(
      { messageId: 'msg-1', outcome: 'uncertain', errorCode: 'network_timeout', httpStatus: null },
      client,
    );
    expect(result).toEqual({ outcome: 'uncertain', currentStatus: 'uncertain' });
  });

  test('rejected_by_provider -> mapeia currentStatus failed', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'rejected_by_provider', current_status: 'failed' }], error: null }));
    const result = await markWhatsappOutboundAttemptResult(
      { messageId: 'msg-1', outcome: 'rejected_by_provider', errorCode: 'invalid_recipient', httpStatus: 400 },
      client,
    );
    expect(result).toEqual({ outcome: 'rejected_by_provider', currentStatus: 'failed' });
  });

  test.each(['IGNORED_ALREADY_RESOLVED', 'IGNORED_INVALID_TRANSITION'])('%s -> mapeia currentStatus', async (outcome) => {
    const client = makeFakeClient(async () => ({ data: [{ outcome, current_status: 'sent' }], error: null }));
    const result = await markWhatsappOutboundAttemptResult(
      { messageId: 'msg-1', outcome: 'uncertain', errorCode: 'late', httpStatus: null },
      client,
    );
    expect(result).toEqual({ outcome, currentStatus: 'sent' });
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

const VALID_STATUS_EVENT_INPUT = { externalMessageId: 'wamid.X', newStatus: 'delivered' as const, eventTimestamp: '2026-01-01T00:00:00.000Z', integrationAccountId: 'acc-1' };

describe('applyWhatsappOutboundStatusEvent', () => {
  test('APPLIED -> mapeia messageId, nomes de parametro p_* corretos (incluindo p_integration_account_id/p_error_code)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'APPLIED', message_id: 'msg-1' }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent(VALID_STATUS_EVENT_INPUT, client);
    expect(result).toEqual({ outcome: 'APPLIED', messageId: 'msg-1' });
    expect(client._calls[0]).toEqual({
      fn: 'apply_whatsapp_outbound_status_event',
      params: {
        p_external_message_id: 'wamid.X',
        p_new_status: 'delivered',
        p_event_timestamp: '2026-01-01T00:00:00.000Z',
        p_integration_account_id: 'acc-1',
        p_error_code: null,
      },
    });
  });

  test('newStatus=sent -> aceito e repassado corretamente', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', message_id: 'msg-1' }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent({ ...VALID_STATUS_EVENT_INPUT, newStatus: 'sent' }, client);
    expect(result).toEqual({ outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', messageId: 'msg-1' });
    expect(client._calls[0].params.p_new_status).toBe('sent');
  });

  test('errorCode informado (newStatus=failed) -> repassado como p_error_code', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'APPLIED', message_id: 'msg-1' }], error: null }));
    await applyWhatsappOutboundStatusEvent({ ...VALID_STATUS_EVENT_INPUT, newStatus: 'failed', errorCode: '131026' }, client);
    expect(client._calls[0].params.p_error_code).toBe('131026');
  });

  test('PENDING_WAMID -> messageId null', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'PENDING_WAMID', message_id: null }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent(VALID_STATUS_EVENT_INPUT, client);
    expect(result).toEqual({ outcome: 'PENDING_WAMID', messageId: null });
  });

  test('ACCOUNT_MISMATCH -> messageId null, nunca aplicado a mensagem de outra conta', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'ACCOUNT_MISMATCH', message_id: null }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent(VALID_STATUS_EVENT_INPUT, client);
    expect(result).toEqual({ outcome: 'ACCOUNT_MISMATCH', messageId: null });
  });

  test('IGNORED_OUT_OF_ORDER_OR_DUPLICATE -> mapeia messageId', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', message_id: 'msg-1' }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent({ ...VALID_STATUS_EVENT_INPUT, newStatus: 'read' }, client);
    expect(result).toEqual({ outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', messageId: 'msg-1' });
  });

  test('IGNORED_LATE_FAILURE_PROTECTED_DELIVERY -> mapeia messageId (correção pós-auditoria, Finding #1)', async () => {
    const client = makeFakeClient(async () => ({ data: [{ outcome: 'IGNORED_LATE_FAILURE_PROTECTED_DELIVERY', message_id: 'msg-1' }], error: null }));
    const result = await applyWhatsappOutboundStatusEvent({ ...VALID_STATUS_EVENT_INPUT, newStatus: 'failed', errorCode: '131052' }, client);
    expect(result).toEqual({ outcome: 'IGNORED_LATE_FAILURE_PROTECTED_DELIVERY', messageId: 'msg-1' });
  });

  test('integrationAccountId vazio -> lanca antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(applyWhatsappOutboundStatusEvent({ ...VALID_STATUS_EVENT_INPUT, integrationAccountId: '' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });
});
