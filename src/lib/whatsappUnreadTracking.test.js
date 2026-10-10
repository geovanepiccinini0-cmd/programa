import { describe, expect, test } from 'vitest';
import {
  buildUnreadCountsMap,
  unreadCountForLead,
  applyIncomingMessageToUnreadCounts,
  clearUnreadCountForLead,
  isConversationActivelyOpen,
} from './whatsappUnreadTracking.js';

function message(overrides = {}) {
  return { id: 'm1', leadId: 'lead-1', direction: 'inbound', occurredAt: '2026-01-01T10:00:00.000Z', ...overrides };
}

describe('buildUnreadCountsMap', () => {
  test('monta mapa leadId -> unreadCount a partir das linhas da RPC', () => {
    const map = buildUnreadCountsMap([
      { leadId: 'a', unreadCount: 3 },
      { leadId: 'b', unreadCount: 1 },
    ]);
    expect(map).toEqual({ a: 3, b: 1 });
  });

  test('lista vazia/ausente -> mapa vazio, nunca lanca', () => {
    expect(buildUnreadCountsMap([])).toEqual({});
    expect(buildUnreadCountsMap(undefined)).toEqual({});
    expect(buildUnreadCountsMap(null)).toEqual({});
  });

  test('linha sem leadId ou com unreadCount invalido -> ignorada/normalizada, nunca NaN', () => {
    const map = buildUnreadCountsMap([
      { leadId: null, unreadCount: 5 },
      { leadId: 'c', unreadCount: 'nao-numero' },
      { leadId: 'd', unreadCount: -2 },
    ]);
    expect(map).toEqual({ c: 0, d: 0 });
  });

  test('unreadCount vem como bigint/string numerica da RPC (Postgres bigint) -> convertido corretamente', () => {
    const map = buildUnreadCountsMap([{ leadId: 'a', unreadCount: '7' }]);
    expect(map).toEqual({ a: 7 });
  });
});

describe('unreadCountForLead', () => {
  test('retorna o valor do mapa quando presente', () => {
    expect(unreadCountForLead({ a: 3 }, 'a')).toBe(3);
  });

  test('ausente no mapa, mapa nulo, ou leadId nulo -> 0, nunca lanca', () => {
    expect(unreadCountForLead({ a: 3 }, 'b')).toBe(0);
    expect(unreadCountForLead(null, 'a')).toBe(0);
    expect(unreadCountForLead({ a: 3 }, null)).toBe(0);
  });
});

describe('applyIncomingMessageToUnreadCounts', () => {
  test('mensagem inbound de conversa DIFERENTE da aberta -> incrementa', () => {
    const result = applyIncomingMessageToUnreadCounts({ 'lead-1': 1 }, message(), 'outro-lead');
    expect(result).toEqual({ 'lead-1': 2 });
  });

  test('lead ainda sem entrada no mapa -> comeca em 1', () => {
    const result = applyIncomingMessageToUnreadCounts({}, message(), 'outro-lead');
    expect(result).toEqual({ 'lead-1': 1 });
  });

  test('mensagem OUTBOUND -> nunca incrementa (requisito: nunca contar o que o CRM enviou)', () => {
    const result = applyIncomingMessageToUnreadCounts({}, message({ direction: 'outbound' }), 'outro-lead');
    expect(result).toEqual({});
  });

  test('mensagem da conversa ATUALMENTE ABERTA -> nunca incrementa', () => {
    const result = applyIncomingMessageToUnreadCounts({ 'lead-1': 0 }, message(), 'lead-1');
    expect(result).toEqual({ 'lead-1': 0 });
  });

  test('mensagem sem leadId -> ignorada, nunca lanca', () => {
    const result = applyIncomingMessageToUnreadCounts({}, message({ leadId: null }), 'outro-lead');
    expect(result).toEqual({});
  });

  test('nunca muta o mapa de entrada (imutabilidade)', () => {
    const original = { 'lead-1': 1 };
    const result = applyIncomingMessageToUnreadCounts(original, message(), 'outro-lead');
    expect(original).toEqual({ 'lead-1': 1 }); // original intacto
    expect(result).not.toBe(original); // novo objeto
  });

  test('mensagem/null nunca lanca, retorna o mapa original', () => {
    const original = { 'lead-1': 1 };
    expect(applyIncomingMessageToUnreadCounts(original, null, 'x')).toBe(original);
  });
});

describe('clearUnreadCountForLead', () => {
  test('zera o contador do lead informado, preserva os demais', () => {
    const result = clearUnreadCountForLead({ a: 3, b: 5 }, 'a');
    expect(result).toEqual({ a: 0, b: 5 });
  });

  test('lead nao presente no mapa -> retorna o mesmo mapa (nunca cria entrada nova por engano)', () => {
    const original = { a: 3 };
    expect(clearUnreadCountForLead(original, 'b')).toBe(original);
  });

  test('mapa nulo/leadId nulo -> retorna o mapa original, nunca lanca', () => {
    expect(clearUnreadCountForLead(null, 'a')).toBeNull();
    expect(clearUnreadCountForLead({ a: 1 }, null)).toEqual({ a: 1 });
  });

  test('nunca muta o mapa de entrada', () => {
    const original = { a: 3 };
    const result = clearUnreadCountForLead(original, 'a');
    expect(original).toEqual({ a: 3 });
    expect(result).not.toBe(original);
  });
});

describe('isConversationActivelyOpen (correção pós-revisão PR #70 — achado 3)', () => {
  test('conversa selecionada, thread carregada, documento visível -> true', () => {
    expect(isConversationActivelyOpen('lead-1', 'lead-1', { threadLoading: false, documentVisible: true })).toBe(true);
  });

  test('conversa NAO selecionada (outro lead) -> false, mesmo com thread carregada e documento visível', () => {
    expect(isConversationActivelyOpen('lead-1', 'lead-2', { threadLoading: false, documentVisible: true })).toBe(false);
  });

  test('nenhuma conversa selecionada (selectedLeadId null) -> false', () => {
    expect(isConversationActivelyOpen(null, 'lead-1', { threadLoading: false, documentVisible: true })).toBe(false);
  });

  test('thread ainda carregando (troca de conversa em andamento) -> false, mesmo com lead certo selecionado', () => {
    expect(isConversationActivelyOpen('lead-1', 'lead-1', { threadLoading: true, documentVisible: true })).toBe(false);
  });

  test('aba em segundo plano (documentVisible false) -> false, mesmo com lead certo e thread carregada', () => {
    expect(isConversationActivelyOpen('lead-1', 'lead-1', { threadLoading: false, documentVisible: false })).toBe(false);
  });

  test('documentVisible ausente (undefined) -> tratado como visível (nunca bloqueia por omissão)', () => {
    expect(isConversationActivelyOpen('lead-1', 'lead-1', { threadLoading: false })).toBe(true);
  });

  test('leadId da mensagem ausente/nulo -> false, nunca lança', () => {
    expect(isConversationActivelyOpen('lead-1', null, { threadLoading: false, documentVisible: true })).toBe(false);
  });

  test('opcoes ausentes -> nunca lança (threadLoading/documentVisible undefined tratados como "não bloqueiam")', () => {
    expect(isConversationActivelyOpen('lead-1', 'lead-1')).toBe(true);
  });
});
