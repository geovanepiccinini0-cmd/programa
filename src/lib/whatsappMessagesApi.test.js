import { describe, expect, test, vi } from 'vitest';

// Fase 3.5.1 — fronteira de serialização/segurança das queries de
// public.whatsapp_messages. db.js nunca cria seu próprio client nem
// reimplementa RLS — a segurança REAL vem das policies da migration
// 018 (RLS no Postgres), nunca deste filtro de frontend. O que se
// prova aqui é que a query SEMPRE inclui o escopo esperado (defesa em
// profundidade, mesmo princípio de leadsApi.fetchAll), que a ordenação
// é determinística (occurred_at, id) e que o cursor composto de
// paginação (correção do finding HIGH da auditoria) é construído
// corretamente — mesmo padrão de fake client encadeável já usado em
// supabase/functions/whatsapp-webhook/handler.test.ts, adaptado ao
// estilo supabase-js do frontend.
function makeFakeQuery(result) {
  const calls = [];
  const builder = {
    select(...args) { calls.push(['select', args]); return builder; },
    eq(...args) { calls.push(['eq', args]); return builder; },
    lt(...args) { calls.push(['lt', args]); return builder; },
    or(...args) { calls.push(['or', args]); return builder; },
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
  test('filtra por user_id (defesa em profundidade), ordena por (occurred_at desc, id desc) e aplica o limit', async () => {
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
    const orderCalls = calls.filter((c) => c[0] === 'order');
    expect(orderCalls).toEqual([
      ['order', ['occurred_at', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
    ]);
    expect(calls.find((c) => c[0] === 'eq')).toEqual(['eq', ['user_id', 'user-1']]);
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

describe('whatsappMessagesApi.fetchPageForLead — cursor composto (correção do finding HIGH)', () => {
  test('filtra por lead_id, ordena (occurred_at desc, id desc), aplica limit — sem cursor, nunca chama or/lt', async () => {
    vi.resetModules();
    const { supabase, getLastQuery } = makeFakeSupabase({ data: [], error: null });
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');

    await whatsappMessagesApi.fetchPageForLead('lead-1', { limit: 30 });

    const calls = getLastQuery()._calls;
    expect(calls.find((c) => c[0] === 'eq')).toEqual(['eq', ['lead_id', 'lead-1']]);
    const orderCalls = calls.filter((c) => c[0] === 'order');
    expect(orderCalls).toEqual([
      ['order', ['occurred_at', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
    ]);
    expect(calls.find((c) => c[0] === 'limit')).toEqual(['limit', [30]]);
    expect(calls.find((c) => c[0] === 'or')).toBeUndefined();
    expect(calls.find((c) => c[0] === 'lt')).toBeUndefined();
    vi.doUnmock('./supabaseClient.js');
  });

  test('com beforeOccurredAt + beforeId -> aplica filtro composto .or() (occurred_at < X) OR (occurred_at = X AND id < Y), nunca so .lt()', async () => {
    vi.resetModules();
    const { supabase, getLastQuery } = makeFakeSupabase({ data: [], error: null });
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');

    await whatsappMessagesApi.fetchPageForLead('lead-1', {
      beforeOccurredAt: '2026-01-05T00:00:00.000Z',
      beforeId: 'cursor-id-1',
      limit: 30,
    });

    const calls = getLastQuery()._calls;
    expect(calls.find((c) => c[0] === 'lt')).toBeUndefined();
    const orCall = calls.find((c) => c[0] === 'or');
    expect(orCall).toBeTruthy();
    expect(orCall[1][0]).toBe(
      'occurred_at.lt.2026-01-05T00:00:00.000Z,and(occurred_at.eq.2026-01-05T00:00:00.000Z,id.lt.cursor-id-1)',
    );
    vi.doUnmock('./supabaseClient.js');
  });
});

// ===========================================================================
// FAKE DB COM FILTRO REAL — prova end-to-end de que a paginação por
// cursor composto nunca perde nem duplica mensagens quando varias
// compartilham o MESMO occurred_at (correção do finding HIGH). Este
// fake não apenas REGISTRA chamadas (como acima): ele de fato aplica
// eq/or/order/limit sobre um array em memória, interpretando a MESMA
// string de filtro que db.js produz — provando que a semântica do
// cursor está correta, não apenas que a chamada "parece certa".
// ===========================================================================
function splitTopLevel(expr) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1; }
  }
  parts.push(expr.slice(start));
  return parts;
}

function compareFieldValue(field, rowValue, rawValue) {
  if (field === 'occurred_at') return new Date(rowValue).getTime() - new Date(rawValue).getTime();
  return rowValue < rawValue ? -1 : rowValue > rawValue ? 1 : 0;
}

function evaluateCondition(row, cond) {
  const firstDot = cond.indexOf('.');
  const secondDot = cond.indexOf('.', firstDot + 1);
  const field = cond.slice(0, firstDot);
  const op = cond.slice(firstDot + 1, secondDot);
  const value = cond.slice(secondDot + 1);
  const cmp = compareFieldValue(field, row[field], value);
  if (op === 'lt') return cmp < 0;
  if (op === 'eq') return cmp === 0;
  throw new Error(`fake: operador nao suportado "${op}"`);
}

function evaluateOrExpr(row, expr) {
  return splitTopLevel(expr).some((branch) => {
    if (branch.startsWith('and(')) {
      const inner = branch.slice(4, -1);
      return splitTopLevel(inner).every((c) => evaluateCondition(row, c));
    }
    return evaluateCondition(row, branch);
  });
}

function compareRowsForOrder(a, b, orderCols) {
  for (const [col, ascending] of orderCols) {
    const cmp = col === 'occurred_at'
      ? new Date(a[col]).getTime() - new Date(b[col]).getTime()
      : (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0);
    if (cmp !== 0) return ascending ? cmp : -cmp;
  }
  return 0;
}

function makeRealFilterFakeSupabase(rows) {
  const supabase = {
    from() {
      const filters = [];
      let orExpr = null;
      const orderCols = [];
      let limitN = Infinity;
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push([col, val]); return builder; },
        or(expr) { orExpr = expr; return builder; },
        order(col, { ascending }) { orderCols.push([col, ascending]); return builder; },
        limit(n) { limitN = n; return builder; },
        then(resolve) {
          let result = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
          if (orExpr) result = result.filter((r) => evaluateOrExpr(r, orExpr));
          result = result.slice().sort((a, b) => compareRowsForOrder(a, b, orderCols));
          result = result.slice(0, limitN);
          return Promise.resolve({ data: result, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return supabase;
}

describe('fetchPageForLead — paginação real com timestamps duplicados atravessando páginas', () => {
  test('nenhuma mensagem e perdida ou duplicada quando 3 mensagens compartilham o mesmo occurred_at na fronteira da pagina', async () => {
    vi.resetModules();
    const SAME_TS = '2026-01-01T12:00:00.000Z';
    // 5 mensagens no MESMO lead: 2 com timestamp distinto, 3 com o
    // MESMO occurred_at (simulando 3 mensagens no mesmo segundo) —
    // distribuídas de forma que uma paginação baseada só em
    // occurred_at (sem id) perderia pelo menos uma delas.
    const rows = [
      { id: 'id-5', lead_id: 'lead-1', occurred_at: '2026-01-01T12:00:05.000Z' },
      { id: 'id-4', lead_id: 'lead-1', occurred_at: SAME_TS },
      { id: 'id-3', lead_id: 'lead-1', occurred_at: SAME_TS },
      { id: 'id-2', lead_id: 'lead-1', occurred_at: SAME_TS },
      { id: 'id-1', lead_id: 'lead-1', occurred_at: '2026-01-01T11:00:00.000Z' },
    ].map((r) => ({
      user_id: 'user-1', integration_account_id: 'ia-1', integration_event_id: null,
      lead_interaction_id: null, provider: 'whatsapp', external_message_id: `wamid.${r.id}`,
      direction: 'inbound', message_type: 'text', content: 'x', status: 'received', error_code: null,
      sent_at: null, delivered_at: null, read_at: null, created_at: r.occurred_at,
      ...r,
    }));

    const supabase = makeRealFilterFakeSupabase(rows);
    vi.doMock('./supabaseClient.js', () => ({ supabase }));
    const { whatsappMessagesApi } = await import('./db.js');

    // Pagina 1: as 3 mais recentes -> id-5, e DUAS das tres com SAME_TS
    // (a ordem entre elas e determinada pelo tiebreak id DESC: id-4, id-3).
    const page1 = await whatsappMessagesApi.fetchPageForLead('lead-1', { limit: 3 });
    expect(page1.map((m) => m.id)).toEqual(['id-5', 'id-4', 'id-3']);

    // Pagina 2: cursor = ultima mensagem da pagina 1 (id-3, SAME_TS).
    // Uma paginacao so por occurred_at (.lt estrito) pularia id-2 (MESMO
    // timestamp que o cursor) — o cursor composto NUNCA perde id-2.
    const oldest = page1[page1.length - 1];
    const page2 = await whatsappMessagesApi.fetchPageForLead('lead-1', {
      beforeOccurredAt: oldest.occurredAt,
      beforeId: oldest.id,
      limit: 3,
    });
    expect(page2.map((m) => m.id)).toEqual(['id-2', 'id-1']);

    // Uniao das duas paginas: todas as 5 mensagens, cada uma exatamente
    // uma vez — nenhuma perdida, nenhuma duplicada.
    const allIds = [...page1, ...page2].map((m) => m.id);
    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5);
    expect(allIds.sort()).toEqual(['id-1', 'id-2', 'id-3', 'id-4', 'id-5']);

    vi.doUnmock('./supabaseClient.js');
  });
});
