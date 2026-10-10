import { describe, expect, test, vi, beforeEach } from 'vitest';

// HOTFIX (PR #72) — validação final do fluxo completo de
// conversationStateApi.setStatus com um cliente Supabase SIMULADO
// (mock da fronteira ./supabaseClient.js, nunca uma rede real) —
// cobre exatamente os 3 passos possíveis (UPDATE / INSERT / retry de
// UPDATE) e os desvios de erro, coisa que a validação empírica em
// Postgres (documentada no PR) não cobre por si só: aqui o alvo é o
// CÓDIGO JS que decide qual operação chamar em sequência, nunca a
// RLS/privilégios do Postgres (isso é responsabilidade do Postgres
// real, validado separadamente).
vi.mock('./supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));

const { supabase } = await import('./supabaseClient.js');
const { conversationStateApi } = await import('./db.js');

// Builder encadeável que imita exatamente a fronteira usada por
// setStatus (.update()/.insert()/.eq()/.select()/.maybeSingle()) —
// cada chamada a .maybeSingle() consome a PRÓXIMA resposta da fila,
// na mesma ordem em que o código real as dispara (update -> insert
// -> retry de update, quando aplicável). Permite inspecionar
// exatamente com quais argumentos cada operação foi chamada via
// `.mock.calls`, sem precisar de um Postgres real.
function queuedBuilder(responses) {
  let i = 0;
  const builder = {};
  builder.update = vi.fn(() => builder);
  builder.insert = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.select = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => {
    const response = responses[i];
    i += 1;
    if (!response) throw new Error(`queuedBuilder: nenhuma resposta enfileirada para a chamada #${i} a maybeSingle()`);
    if (response.throws) throw response.throws;
    return { data: response.data ?? null, error: response.error ?? null };
  });
  return builder;
}

function rowFixture(overrides = {}) {
  return {
    lead_id: 'lead-1',
    user_id: 'user-1',
    status: 'em_atendimento',
    last_event_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:10:00.000Z',
    last_read_at: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  supabase.from.mockReset();
});

describe('conversationStateApi.setStatus — 1) UPDATE bem-sucedido (conversa com registro existente)', () => {
  test('conversa já tem linha -> só chama UPDATE (nunca INSERT), devolve o estado mapeado', async () => {
    const existingRow = rowFixture({ status: 'em_atendimento' });
    const builder = queuedBuilder([{ data: existingRow }]);
    supabase.from.mockImplementation(() => builder);

    const result = await conversationStateApi.setStatus('lead-1', 'em_atendimento');

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.update).toHaveBeenCalledWith({ status: 'em_atendimento' });
    expect(builder.eq).toHaveBeenCalledWith('lead_id', 'lead-1');
    expect(builder.insert).not.toHaveBeenCalled();
    expect(result.status).toBe('em_atendimento');
    expect(result.leadId).toBe('lead-1');
  });
});

describe('conversationStateApi.setStatus — 2) UPDATE sem linhas seguido de INSERT bem-sucedido', () => {
  test('conversa ainda sem nenhuma linha -> UPDATE afeta 0, cai para INSERT, devolve o estado mapeado', async () => {
    const insertedRow = rowFixture({ status: 'pendente_resposta', last_read_at: null });
    const builder = queuedBuilder([
      { data: null }, // passo 1: UPDATE não encontra nenhuma linha
      { data: insertedRow }, // passo 2: INSERT cria a linha
    ]);
    supabase.from.mockImplementation(() => builder);

    const result = await conversationStateApi.setStatus('lead-1', 'pendente_resposta');

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledWith({ lead_id: 'lead-1', status: 'pendente_resposta' });
    expect(result.status).toBe('pendente_resposta');
  });
});

describe('conversationStateApi.setStatus — 3) INSERT com unique_violation (23505) seguido de UPDATE bem-sucedido', () => {
  test('corrida com a RPC automática (service_role) -> INSERT colide, retry de UPDATE sucede', async () => {
    const retriedRow = rowFixture({ status: 'em_atendimento' });
    const builder = queuedBuilder([
      { data: null }, // passo 1: UPDATE não encontra nenhuma linha
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }, // passo 2: INSERT colide
      { data: retriedRow }, // passo 3: retry de UPDATE sucede (a linha concorrente já existe)
    ]);
    supabase.from.mockImplementation(() => builder);

    const result = await conversationStateApi.setStatus('lead-1', 'em_atendimento');

    expect(builder.update).toHaveBeenCalledTimes(2); // passo 1 + passo 3 (retry)
    expect(builder.insert).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('em_atendimento');
  });

  test('INSERT falha com um erro QUE NÃO é 23505 -> nunca tenta o retry, propaga o erro original', async () => {
    const otherError = { code: '23503', message: 'foreign key violation' };
    const builder = queuedBuilder([
      { data: null },
      { error: otherError },
    ]);
    supabase.from.mockImplementation(() => builder);

    await expect(conversationStateApi.setStatus('lead-1', 'em_atendimento')).rejects.toBe(otherError);
    expect(builder.update).toHaveBeenCalledTimes(1); // nunca chega ao retry
  });
});

describe('conversationStateApi.setStatus — 4) erro 403/42501 propagado SEM tentar contornar permissões', () => {
  test('UPDATE falha com 42501 -> propaga o erro imediatamente, NUNCA tenta INSERT como fallback', async () => {
    const permissionError = { code: '42501', message: 'permission denied for table whatsapp_conversation_state' };
    const builder = queuedBuilder([{ error: permissionError }]);
    supabase.from.mockImplementation(() => builder);

    await expect(conversationStateApi.setStatus('lead-1', 'em_atendimento')).rejects.toBe(permissionError);
    expect(builder.insert).not.toHaveBeenCalled(); // nunca tenta outro caminho para burlar a permissão negada
  });

  test('INSERT (passo 2) falha com 42501 -> propaga o erro, nunca tenta o retry de UPDATE', async () => {
    const permissionError = { code: '42501', message: 'permission denied for table whatsapp_conversation_state' };
    const builder = queuedBuilder([
      { data: null },
      { error: permissionError },
    ]);
    supabase.from.mockImplementation(() => builder);

    await expect(conversationStateApi.setStatus('lead-1', 'em_atendimento')).rejects.toBe(permissionError);
    expect(builder.update).toHaveBeenCalledTimes(1); // nunca chega ao retry, porque 42501 != 23505
  });
});

describe('conversationStateApi.setStatus — 5) erro de RLS/rede NUNCA tratado como "linha ausente"', () => {
  test('UPDATE retorna um erro de RLS (ex. policy negou) junto com data null -> propaga o erro, nunca interpreta como "conversa sem linha" e nunca tenta INSERT', async () => {
    // Cenário crítico: se o código checasse só `if (!updated)` para
    // decidir se cai no INSERT, um erro de RLS (que também vem com
    // data:null) seria confundido com "0 linhas, pode inserir" —
    // este teste trava esse comportamento.
    const rlsError = { code: '42501', message: 'new row violates row-level security policy' };
    const builder = queuedBuilder([{ data: null, error: rlsError }]);
    supabase.from.mockImplementation(() => builder);

    await expect(conversationStateApi.setStatus('lead-1', 'em_atendimento')).rejects.toBe(rlsError);
    expect(builder.insert).not.toHaveBeenCalled();
  });

  test('falha de REDE (maybeSingle rejeita em vez de resolver {data,error}) -> propaga a rejeição, nunca engole como ausência de registro', async () => {
    const networkError = new Error('fetch failed: network error');
    const builder = queuedBuilder([{ throws: networkError }]);
    supabase.from.mockImplementation(() => builder);

    await expect(conversationStateApi.setStatus('lead-1', 'em_atendimento')).rejects.toBe(networkError);
    expect(builder.insert).not.toHaveBeenCalled();
  });

  test('falha de rede no passo 2 (INSERT) -> propaga a rejeição, nunca tenta o retry de UPDATE', async () => {
    const networkError = new Error('fetch failed: network error');
    const builder = queuedBuilder([
      { data: null },
      { throws: networkError },
    ]);
    supabase.from.mockImplementation(() => builder);

    await expect(conversationStateApi.setStatus('lead-1', 'em_atendimento')).rejects.toBe(networkError);
    expect(builder.update).toHaveBeenCalledTimes(1);
  });
});

describe('conversationStateApi.setStatus — 6) nunca envia last_read_at/last_event_at em nenhum payload', () => {
  test('payload do UPDATE contém SÓ status (nunca last_read_at/last_event_at/user_id)', async () => {
    const builder = queuedBuilder([{ data: rowFixture() }]);
    supabase.from.mockImplementation(() => builder);

    await conversationStateApi.setStatus('lead-1', 'em_atendimento');

    expect(builder.update).toHaveBeenCalledWith({ status: 'em_atendimento' });
    const payload = builder.update.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['status']);
  });

  test('payload do INSERT contém SÓ lead_id/status (nunca last_read_at/last_event_at/user_id)', async () => {
    const builder = queuedBuilder([
      { data: null },
      { data: rowFixture({ last_read_at: null }) },
    ]);
    supabase.from.mockImplementation(() => builder);

    await conversationStateApi.setStatus('lead-1', 'pendente_resposta');

    const payload = builder.insert.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['lead_id', 'status']);
  });

  test('last_read_at devolvido pelo servidor é preservado no resultado mapeado (nunca sobrescrito/zerado pelo cliente)', async () => {
    const existingRow = rowFixture({ status: 'em_atendimento', last_read_at: '2026-03-05T12:00:00.000Z' });
    const builder = queuedBuilder([{ data: existingRow }]);
    supabase.from.mockImplementation(() => builder);

    const result = await conversationStateApi.setStatus('lead-1', 'em_atendimento');

    expect(result.lastReadAt).toBe('2026-03-05T12:00:00.000Z');
  });

  test('last_event_at do servidor nunca é lido/alterado por setStatus (coluna fora do payload e fora do mapeamento de retorno)', async () => {
    // conversationOperationalStateFromRow nunca expõe last_event_at
    // (é uso interno da RPC automática da 024) — confirma que
    // setStatus não introduz nenhuma leitura/gravação dessa coluna.
    const existingRow = rowFixture({ status: 'em_atendimento', last_event_at: '2026-02-01T00:00:00.000Z' });
    const builder = queuedBuilder([{ data: existingRow }]);
    supabase.from.mockImplementation(() => builder);

    const result = await conversationStateApi.setStatus('lead-1', 'em_atendimento');

    expect(result).not.toHaveProperty('lastEventAt');
    expect(result).not.toHaveProperty('last_event_at');
  });
});
