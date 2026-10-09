import { describe, expect, test, vi } from 'vitest';
import { applyConversationOperationalEvent } from './whatsappConversationStateRepository.ts';

function makeFakeClient(impl) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    rpc: (fn: string, params: Record<string, unknown>) => {
      calls.push([fn, params]);
      return impl(fn, params);
    },
    _calls: calls,
  };
}

describe('applyConversationOperationalEvent', () => {
  test('chama a RPC com p_lead_id/p_event_type exatos', async () => {
    const client = makeFakeClient(async () => ({ data: [{ status: 'pendente_resposta' }], error: null }));
    await applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'inbound_received' }, client);
    expect(client._calls).toEqual([
      ['apply_whatsapp_conversation_operational_event', { p_lead_id: 'lead-1', p_event_type: 'inbound_received' }],
    ]);
  });

  test('APPLIED -> mapeia status', async () => {
    const client = makeFakeClient(async () => ({ data: [{ status: 'aguardando_cliente' }], error: null }));
    const result = await applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'outbound_sent' }, client);
    expect(result).toEqual({ outcome: 'APPLIED', status: 'aguardando_cliente' });
  });

  test('erro do client -> REPOSITORY_ERROR, nunca lança', async () => {
    const client = makeFakeClient(async () => ({ data: null, error: new Error('db down') }));
    const result = await applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'inbound_received' }, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('resposta malformada (sem status) -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(async () => ({ data: [{}], error: null }));
    const result = await applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'inbound_received' }, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('resposta vazia -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    const result = await applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'inbound_received' }, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('exceção síncrona do client (ex. rede) -> REPOSITORY_ERROR, nunca lança para o chamador', async () => {
    const client = makeFakeClient(() => { throw new Error('boom'); });
    const result = await applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'inbound_received' }, client);
    expect(result.outcome).toBe('REPOSITORY_ERROR');
  });

  test('leadId vazio -> lança antes de chamar o client (precondição de contrato)', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    await expect(applyConversationOperationalEvent({ leadId: '', eventType: 'inbound_received' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('eventType inválido -> lança antes de chamar o client', async () => {
    const client = makeFakeClient(async () => ({ data: [], error: null }));
    // @ts-expect-error — testando entrada inválida deliberadamente
    await expect(applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'outra_coisa' }, client)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });

  test('client sem .rpc -> lança TypeError', async () => {
    await expect(applyConversationOperationalEvent({ leadId: 'lead-1', eventType: 'inbound_received' }, {})).rejects.toThrow(TypeError);
  });
});
