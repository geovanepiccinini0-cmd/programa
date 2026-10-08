import { describe, expect, test, vi } from 'vitest';

// Fase 3.5.1 — fronteira de serialização/segurança das queries de
// public.whatsapp_messages. db.js nunca cria seu próprio client nem
// reimplementa RLS — a segurança REAL vem das policies da migration
// 018 (RLS no Postgres), nunca deste filtro de frontend. O que se
// prova aqui é que a query SEMPRE inclui o escopo esperado (defesa em
// profundidade, mesmo princípio de leadsApi.fetchAll) e que a
// paginação (limit/lt) é passada corretamente ao Supabase — mesmo
// padrão de fake client encadeável já usado em
// supabase/functions/whatsapp-webhook/handler.test.ts, adaptado ao
// estilo supabase-js do frontend.
function makeFakeQuery(result) {
  const calls = [];
  const builder = {
    select(...args) { calls.push(['select', args]); return builder; },
    eq(...args) { calls.push(['eq', args]); return builder; },
    lt(...args) { calls.push(['lt', args]); return builder; },
    order(...args) { calls.push(['order', args]); return builder; },
    limit(...args) { calls.push(['limit', args]); return builder; },
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  builder._calls = calls;
  return builder;
}

function makeFakeSupabase(result) {
  const fromCalls = [];
  let lastQuery;
  const supabase = {
    from(table) {
      fromCalls.push(table);
      lastQuery = makeFakeQuery(result);
      return lastQuery;
    },
  };
  return { supabase, fromCalls, getLastQuery: () => lastQuery };
}

describe('whatsappMessagesApi.fetchRecentForUser', () => {
  test('filtra por user_id (defesa em profundidade), ordena por occurred_at desc e aplica o limit', async () => {
    vi.resetModules();
    const row = {
      id: 'm1', user_id: 'user-1', lead_id: 'lead-1', integration_account_id: 'ia-1',
      integration_event_id: 'evt-1', lead_interaction_id: 'int-1', provider: 'whatsapp',
      external_message_id: 'wamid.1', direction: 'inbound', message_type: 'text',
      content: 'oi', status: 'processed', error_code: null, occurred_at: '2026-01-01T00:00:00.000Z',
      sent_at: null, delivered_at: null, read_at: null, created_at: '2026-01-01T00:00:01.000Z',
    };
    const { supabase, fromCalls, getLastQuery } = makeFakeSupabase({ data: [row], error: null });
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');

    const result = await whatsappMessagesApi.fetchRecentForUser('user-1', 300);

    expect(fromCalls).toEqual(['whatsapp_messages']);
    const calls = getLastQuery()._calls;
    expect(calls.find((c) => c[0] === 'eq')).toEqual(['eq', ['user_id', 'user-1']]);
    expect(calls.find((c) => c[0] === 'order')).toEqual(['order', ['occurred_at', { ascending: false }]]);
    expect(calls.find((c) => c[0] === 'limit')).toEqual(['limit', [300]]);
    expect(result).toEqual([{
      id: 'm1', userId: 'user-1', leadId: 'lead-1', integrationAccountId: 'ia-1',
      integrationEventId: 'evt-1', leadInteractionId: 'int-1', provider: 'whatsapp',
      externalMessageId: 'wamid.1', direction: 'inbound', messageType: 'text', content: 'oi',
      status: 'processed', errorCode: null, occurredAt: '2026-01-01T00:00:00.000Z',
      sentAt: null, deliveredAt: null, readAt: null, createdAt: '2026-01-01T00:00:01.000Z',
    }]);
    vi.doUnmock('./supabaseClient.js');
  });

  test('erro do Supabase propaga (lança), nunca retorna dado parcial mascarado', async () => {
    vi.resetModules();
    const { supabase } = makeFakeSupabase({ data: null, error: new Error('boom') });
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');
    await expect(whatsappMessagesApi.fetchRecentForUser('user-1', 300)).rejects.toThrow('boom');
    vi.doUnmock('./supabaseClient.js');
  });
});

describe('whatsappMessagesApi.fetchPageForLead', () => {
  test('filtra por lead_id, ordena desc, aplica limit — sem beforeOccurredAt, nunca chama lt', async () => {
    vi.resetModules();
    const { supabase, getLastQuery } = makeFakeSupabase({ data: [], error: null });
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');

    await whatsappMessagesApi.fetchPageForLead('lead-1', { limit: 30 });

    const calls = getLastQuery()._calls;
    expect(calls.find((c) => c[0] === 'eq')).toEqual(['eq', ['lead_id', 'lead-1']]);
    expect(calls.find((c) => c[0] === 'order')).toEqual(['order', ['occurred_at', { ascending: false }]]);
    expect(calls.find((c) => c[0] === 'limit')).toEqual(['limit', [30]]);
    expect(calls.find((c) => c[0] === 'lt')).toBeUndefined();
    vi.doUnmock('./supabaseClient.js');
  });

  test('com beforeOccurredAt (paginação incremental) -> aplica lt(occurred_at, valor)', async () => {
    vi.resetModules();
    const { supabase, getLastQuery } = makeFakeSupabase({ data: [], error: null });
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');

    await whatsappMessagesApi.fetchPageForLead('lead-1', { beforeOccurredAt: '2026-01-05T00:00:00.000Z', limit: 30 });

    const calls = getLastQuery()._calls;
    expect(calls.find((c) => c[0] === 'lt')).toEqual(['lt', ['occurred_at', '2026-01-05T00:00:00.000Z']]);
    vi.doUnmock('./supabaseClient.js');
  });
});
