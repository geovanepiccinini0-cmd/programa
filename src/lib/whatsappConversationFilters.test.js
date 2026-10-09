import { describe, expect, test } from 'vitest';
import {
  EMPTY_CONVERSATION_FILTERS,
  hasActiveConversationFilters,
  buildLeadsById,
  filterConversations,
} from './whatsappConversationFilters.js';

function conversation(overrides = {}) {
  return {
    leadId: 'lead-1',
    leadNome: 'Maria Silva',
    lastMessage: { id: 'm1' },
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    preview: 'Oi, tudo bem?',
    ...overrides,
  };
}

function lead(overrides = {}) {
  return {
    id: 'lead-1',
    nome: 'Maria Silva',
    etapa: 'Qualificação',
    tags: ['PRIORIDADE'],
    ...overrides,
  };
}

describe('EMPTY_CONVERSATION_FILTERS / hasActiveConversationFilters', () => {
  test('filtros vazios -> nenhum filtro ativo', () => {
    expect(hasActiveConversationFilters(EMPTY_CONVERSATION_FILTERS)).toBe(false);
  });

  test('null/undefined -> nenhum filtro ativo (nunca lanca)', () => {
    expect(hasActiveConversationFilters(null)).toBe(false);
    expect(hasActiveConversationFilters(undefined)).toBe(false);
  });

  test('searchText só com espaços -> nao conta como ativo', () => {
    expect(hasActiveConversationFilters({ ...EMPTY_CONVERSATION_FILTERS, searchText: '   ' })).toBe(false);
  });

  test('searchText preenchido -> ativo', () => {
    expect(hasActiveConversationFilters({ ...EMPTY_CONVERSATION_FILTERS, searchText: 'Maria' })).toBe(true);
  });

  test('etapa preenchida -> ativo', () => {
    expect(hasActiveConversationFilters({ ...EMPTY_CONVERSATION_FILTERS, etapa: 'Proposta' })).toBe(true);
  });

  test('tags preenchidas -> ativo', () => {
    expect(hasActiveConversationFilters({ ...EMPTY_CONVERSATION_FILTERS, tags: ['PRIORIDADE'] })).toBe(true);
  });
});

describe('buildLeadsById', () => {
  test('monta mapa id -> lead', () => {
    const map = buildLeadsById([lead(), lead({ id: 'lead-2', nome: 'João' })]);
    expect(Object.keys(map)).toEqual(['lead-1', 'lead-2']);
    expect(map['lead-2'].nome).toBe('João');
  });

  test('lista vazia/ausente -> mapa vazio, nunca lanca', () => {
    expect(buildLeadsById([])).toEqual({});
    expect(buildLeadsById(undefined)).toEqual({});
  });

  test('ignora entradas sem id', () => {
    const map = buildLeadsById([{ nome: 'sem id' }, lead()]);
    expect(Object.keys(map)).toEqual(['lead-1']);
  });
});

describe('filterConversations — busca por nome', () => {
  test('sem filtro -> retorna tudo, na MESMA ordem de entrada (requisito 6)', () => {
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const result = filterConversations(list, {}, EMPTY_CONVERSATION_FILTERS);
    expect(result.map((c) => c.leadId)).toEqual(['a', 'b']);
  });

  test('busca case-insensitive e sem acento', () => {
    const list = [conversation({ leadNome: 'José da Silva' })];
    expect(filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'jose' })).toHaveLength(1);
    expect(filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'JOSÉ' })).toHaveLength(1);
    expect(filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'silva' })).toHaveLength(1);
  });

  test('busca por substring no meio do nome', () => {
    const list = [conversation({ leadNome: 'Carlos Eduardo' })];
    expect(filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'duardo' })).toHaveLength(1);
  });

  test('nome que nao bate -> excluido', () => {
    const list = [conversation({ leadNome: 'Ana' })];
    expect(filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'bruno' })).toHaveLength(0);
  });
});

describe('filterConversations — etapa', () => {
  test('filtra pela etapa exata do lead', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', etapa: 'Proposta' }), lead({ id: 'b', etapa: 'Ganho' })]);
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, etapa: 'Proposta' });
    expect(result.map((c) => c.leadId)).toEqual(['a']);
  });

  test('lead nao encontrado no mapa -> nunca casa com etapa ativa (defensivo)', () => {
    const list = [conversation({ leadId: 'desconhecido' })];
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, etapa: 'Proposta' });
    expect(result).toHaveLength(0);
  });
});

describe('filterConversations — tags', () => {
  test('conversa cujo lead tem UMA das tags selecionadas -> incluida (OR)', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', tags: ['PRIORIDADE'] }), lead({ id: 'b', tags: ['ATENÇÃO'] })]);
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, tags: ['PRIORIDADE', 'RESTRIÇÃO'] });
    expect(result.map((c) => c.leadId)).toEqual(['a']);
  });

  test('lead sem tags -> excluido quando filtro de tags ativo', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', tags: [] })]);
    const list = [conversation({ leadId: 'a' })];
    expect(filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, tags: ['PRIORIDADE'] })).toHaveLength(0);
  });
});

describe('filterConversations — combinação de filtros (requisito 4)', () => {
  test('busca + etapa + tags combinados com AND entre criterios', () => {
    const leadsById = buildLeadsById([
      lead({ id: 'a', nome: 'Maria', etapa: 'Proposta', tags: ['PRIORIDADE'] }),
      lead({ id: 'b', nome: 'Maria', etapa: 'Ganho', tags: ['PRIORIDADE'] }),
      lead({ id: 'c', nome: 'Maria', etapa: 'Proposta', tags: ['ATENÇÃO'] }),
    ]);
    const list = [
      conversation({ leadId: 'a', leadNome: 'Maria' }),
      conversation({ leadId: 'b', leadNome: 'Maria' }),
      conversation({ leadId: 'c', leadNome: 'Maria' }),
    ];
    const result = filterConversations(list, leadsById, {
      searchText: 'maria', etapa: 'Proposta', tags: ['PRIORIDADE'],
    });
    expect(result.map((c) => c.leadId)).toEqual(['a']);
  });

  test('nenhum resultado quando a combinacao nao bate com nada (requisito 7 — tratado pela UI como estado vazio)', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', etapa: 'Ganho', tags: ['ATENÇÃO'] })]);
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, leadsById, { searchText: '', etapa: 'Perdido', tags: ['PRIORIDADE'] });
    expect(result).toEqual([]);
  });
});

describe('filterConversations — preservação de ordem e dados de entrada (requisito 6 e 8 da restrição de paginação)', () => {
  test('nunca reordena, nunca muta o array/objetos de entrada', () => {
    const list = [conversation({ leadId: 'z', lastMessageAt: '2026-01-03T00:00:00.000Z' }), conversation({ leadId: 'a', lastMessageAt: '2026-01-01T00:00:00.000Z' })];
    const snapshot = JSON.parse(JSON.stringify(list));
    const result = filterConversations(list, {}, EMPTY_CONVERSATION_FILTERS);
    expect(result.map((c) => c.leadId)).toEqual(['z', 'a']); // ordem de entrada preservada, nunca re-sortada
    expect(list).toEqual(snapshot); // input original intacto
  });

  test('opera só sobre o array recebido — nunca busca mais dados (funções puras, zero I/O)', () => {
    // Garantia estrutural: o módulo não importa supabaseClient nem
    // qualquer *Api — qualquer tentativa de "abranger não carregadas"
    // exigiria um import de rede, que não existe neste arquivo.
    const list = [conversation()];
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'maria' });
    expect(result).toHaveLength(1);
  });
});
