import { describe, expect, test } from 'vitest';
import {
  EMPTY_CONVERSATION_FILTERS,
  hasActiveConversationFilters,
  buildLeadsById,
  filterConversations,
} from './whatsappConversationFilters.js';
import { applyConversationStateRealtimeEvent } from './conversationOperationalState.js';

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

  test('unreadOnly true -> ativo (Fase 3.6.4)', () => {
    expect(hasActiveConversationFilters({ ...EMPTY_CONVERSATION_FILTERS, unreadOnly: true })).toBe(true);
  });

  test('status preenchido -> ativo (Fase 3.6.4)', () => {
    expect(hasActiveConversationFilters({ ...EMPTY_CONVERSATION_FILTERS, status: 'em_atendimento' })).toBe(true);
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

describe('filterConversations — busca por telefone (Fase 3.6.4)', () => {
  test('busca com dígitos bate no telefone do lead, mesmo com formatação diferente', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', telefone: '(51) 99232-2166' })]);
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, searchText: '992322166' });
    expect(result).toHaveLength(1);
  });

  test('busca por telefone formatada igual ao texto digitado pelo usuário', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', telefone: '51992322166' })]);
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, searchText: '(51) 99232-2166' });
    expect(result).toHaveLength(1);
  });

  test('telefone que nao bate -> excluido', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', telefone: '51999999999' })]);
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, searchText: '000000' });
    expect(result).toHaveLength(0);
  });

  test('busca puramente textual (sem digitos) continua funcionando só por nome, nunca tenta telefone', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', telefone: '51999999999', nome: 'Maria' })]);
    const list = [conversation({ leadId: 'a', leadNome: 'Maria' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, searchText: 'maria' });
    expect(result).toHaveLength(1);
  });

  test('lead sem telefone -> busca por digitos nunca lanca, apenas nao casa', () => {
    const leadsById = buildLeadsById([lead({ id: 'a', telefone: '' })]);
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, leadsById, { ...EMPTY_CONVERSATION_FILTERS, searchText: '12345' });
    expect(result).toHaveLength(0);
  });
});

describe('filterConversations — não lidas (Fase 3.6.4)', () => {
  test('unreadOnly filtra só conversas com unreadCount > 0', () => {
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const unreadCounts = { a: 2, b: 0 };
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, unreadOnly: true }, { unreadCounts });
    expect(result.map((c) => c.leadId)).toEqual(['a']);
  });

  test('unreadOnly false -> nao filtra por não lidas, comportamento igual a antes da 3.6.4', () => {
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const unreadCounts = { a: 2, b: 0 };
    const result = filterConversations(list, {}, EMPTY_CONVERSATION_FILTERS, { unreadCounts });
    expect(result.map((c) => c.leadId)).toEqual(['a', 'b']);
  });

  test('unreadOnly sem unreadCounts (ainda carregando) -> trata como 0, nunca lanca, exclui tudo', () => {
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, unreadOnly: true });
    expect(result).toEqual([]);
  });

  test('nunca usa whatsapp_messages.read_at — critério é inteiramente derivado de unreadCounts (leitura humana)', () => {
    // Garantia estrutural: este módulo não importa nada de
    // whatsappMessages.js que exponha read_at/delivered_at/sent_at —
    // só unreadCountForLead (whatsappUnreadTracking.js).
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, unreadOnly: true }, { unreadCounts: { a: 1 } });
    expect(result).toHaveLength(1);
  });
});

describe('filterConversations — estado operacional (Fase 3.6.4)', () => {
  test('filtra pelo status exato da conversa', () => {
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const conversationStatesByLead = {
      a: { leadId: 'a', status: 'em_atendimento', hasRow: true },
      b: { leadId: 'b', status: 'concluido', hasRow: true },
    };
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, status: 'em_atendimento' }, { conversationStatesByLead });
    expect(result.map((c) => c.leadId)).toEqual(['a']);
  });

  test('conversa sem linha (hasRow false) usa o status default (pendente_resposta) para fins de filtro', () => {
    const list = [conversation({ leadId: 'a' })];
    const conversationStatesByLead = {
      a: { leadId: 'a', status: 'pendente_resposta', hasRow: false },
    };
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, status: 'pendente_resposta' }, { conversationStatesByLead });
    expect(result).toHaveLength(1);
  });

  test('mapa de estados ainda nao carregado (undefined) + filtro de status ativo -> nunca finge corresponder, exclui tudo', () => {
    const list = [conversation({ leadId: 'a' })];
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, status: 'em_atendimento' });
    expect(result).toEqual([]);
  });

  test('Fase 3.6.4 (correção pós-revisão do PR #71, achado 1) — mapa existe mas NÃO tem a chave deste leadId (carregamento parcial/em andamento) -> exclui, nunca cai no fallback default', () => {
    // Antes da correção, uma chave ausente caía no fallback
    // DEFAULT_CONVERSATION_OPERATIONAL_STATUS e podia corresponder
    // erradamente a um filtro por "Pendente de resposta" mesmo sem o
    // servidor ter confirmado nada para este lead.
    const list = [conversation({ leadId: 'a' })];
    const conversationStatesByLead = {}; // mapa truthy, mas vazio (fetch em lote ainda em andamento)
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, status: 'pendente_resposta' }, { conversationStatesByLead });
    expect(result).toEqual([]);
  });

  test('Fase 3.6.4 — carregamento parcial: lead resolvido casa, lead NÃO resolvido (ainda) nunca casa, mesmo com o mesmo status-alvo', () => {
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const conversationStatesByLead = {
      a: { leadId: 'a', status: 'pendente_resposta', hasRow: true }, // resolvido
      // 'b' ausente -> ainda não resolvido
    };
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, status: 'pendente_resposta' }, { conversationStatesByLead });
    expect(result.map((c) => c.leadId)).toEqual(['a']);
  });

  test('status null (nenhum filtro) -> nao filtra, comportamento igual a antes da 3.6.4', () => {
    const list = [conversation({ leadId: 'a' }), conversation({ leadId: 'b' })];
    const result = filterConversations(list, {}, EMPTY_CONVERSATION_FILTERS);
    expect(result.map((c) => c.leadId)).toEqual(['a', 'b']);
  });

  test('Fase 3.6.4 (correção pós-revisão do PR #71, achado 3) — filtro de status ativo DURANTE uma atualização Realtime: a conversa some/aparece do resultado filtrado, sem nunca reordenar a lista', () => {
    const list = [
      conversation({ leadId: 'a', lastMessageAt: '2026-01-03T00:00:00.000Z' }),
      conversation({ leadId: 'b', lastMessageAt: '2026-01-02T00:00:00.000Z' }),
      conversation({ leadId: 'c', lastMessageAt: '2026-01-01T00:00:00.000Z' }),
    ];
    let conversationStatesByLead = {
      a: { leadId: 'a', status: 'pendente_resposta', hasRow: true },
      b: { leadId: 'b', status: 'em_atendimento', hasRow: true },
      c: { leadId: 'c', status: 'pendente_resposta', hasRow: true },
    };
    const filters = { ...EMPTY_CONVERSATION_FILTERS, status: 'pendente_resposta' };

    // Antes da atualização: a e c batem (b não).
    let result = filterConversations(list, {}, filters, { conversationStatesByLead });
    expect(result.map((c) => c.leadId)).toEqual(['a', 'c']);

    // Chega um evento Realtime (outra aba mudou o estado de 'b' para pendente_resposta).
    const payload = { eventType: 'UPDATE', new: { lead_id: 'b', user_id: 'u1', status: 'pendente_resposta', updated_at: 't', last_read_at: null } };
    conversationStatesByLead = applyConversationStateRealtimeEvent(conversationStatesByLead, payload, 'u1');

    // Depois da atualização: b passa a bater também, mas a ORDEM original (a, b, c) é preservada -- nunca re-sortado por status.
    result = filterConversations(list, {}, filters, { conversationStatesByLead });
    expect(result.map((c) => c.leadId)).toEqual(['a', 'b', 'c']);
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

  test('Fase 3.6.4 — todos os 5 criterios combinados com AND (nome+telefone, etapa, tags, não lidas, estado)', () => {
    const leadsById = buildLeadsById([
      lead({ id: 'a', nome: 'Maria', telefone: '51999990001', etapa: 'Proposta', tags: ['PRIORIDADE'] }),
      lead({ id: 'b', nome: 'Maria', telefone: '51999990002', etapa: 'Proposta', tags: ['PRIORIDADE'] }),
    ]);
    const list = [conversation({ leadId: 'a', leadNome: 'Maria' }), conversation({ leadId: 'b', leadNome: 'Maria' })];
    const unreadCounts = { a: 1, b: 1 };
    const conversationStatesByLead = {
      a: { leadId: 'a', status: 'pendente_resposta', hasRow: true },
      b: { leadId: 'b', status: 'concluido', hasRow: true },
    };
    const result = filterConversations(
      list, leadsById,
      { searchText: 'maria', etapa: 'Proposta', tags: ['PRIORIDADE'], unreadOnly: true, status: 'pendente_resposta' },
      { unreadCounts, conversationStatesByLead },
    );
    expect(result.map((c) => c.leadId)).toEqual(['a']);
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

  test('Fase 3.6.4 — filtros novos (não lidas/estado) também nunca reordenam, só removem itens', () => {
    const list = [
      conversation({ leadId: 'z', lastMessageAt: '2026-01-03T00:00:00.000Z' }),
      conversation({ leadId: 'y', lastMessageAt: '2026-01-02T00:00:00.000Z' }),
      conversation({ leadId: 'a', lastMessageAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const unreadCounts = { z: 1, y: 0, a: 1 };
    const result = filterConversations(list, {}, { ...EMPTY_CONVERSATION_FILTERS, unreadOnly: true }, { unreadCounts });
    expect(result.map((c) => c.leadId)).toEqual(['z', 'a']); // ordem de entrada preservada (z antes de a), nunca re-sortada
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
