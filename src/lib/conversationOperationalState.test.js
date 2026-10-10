import { describe, expect, test } from 'vitest';
import {
  CONVERSATION_OPERATIONAL_STATES,
  CONVERSATION_OPERATIONAL_STATE_LABELS,
  DEFAULT_CONVERSATION_OPERATIONAL_STATUS,
  conversationOperationalStateLabel,
  conversationOperationalStateFromRow,
  conversationNeedsAttention,
  buildConversationOperationalStatesMap,
  applyConversationStateRealtimeEvent,
  shouldForceConversationStatesResync,
} from './conversationOperationalState.js';

describe('CONVERSATION_OPERATIONAL_STATES', () => {
  test('exatamente os 4 estados do requisito, nesta ordem', () => {
    expect(CONVERSATION_OPERATIONAL_STATES.map((s) => s.value)).toEqual([
      'pendente_resposta', 'em_atendimento', 'aguardando_cliente', 'concluido',
    ]);
  });
});

describe('conversationOperationalStateLabel', () => {
  test('mapeia cada valor para o rótulo correto', () => {
    expect(conversationOperationalStateLabel('pendente_resposta')).toBe('Pendente de resposta');
    expect(conversationOperationalStateLabel('em_atendimento')).toBe('Em atendimento');
    expect(conversationOperationalStateLabel('aguardando_cliente')).toBe('Aguardando cliente');
    expect(conversationOperationalStateLabel('concluido')).toBe('Concluído');
  });

  test('valor desconhecido/nulo -> fallback seguro (pendente_resposta), nunca lança', () => {
    expect(conversationOperationalStateLabel('algo_novo')).toBe('Pendente de resposta');
    expect(conversationOperationalStateLabel(null)).toBe('Pendente de resposta');
    expect(conversationOperationalStateLabel(undefined)).toBe('Pendente de resposta');
  });

  test('mapa de rotulos tem exatamente as 4 chaves', () => {
    expect(Object.keys(CONVERSATION_OPERATIONAL_STATE_LABELS).sort()).toEqual([
      'aguardando_cliente', 'concluido', 'em_atendimento', 'pendente_resposta',
    ]);
  });
});

describe('conversationOperationalStateFromRow', () => {
  test('mapeia colunas reais da migration 024 + last_read_at (025) para camelCase', () => {
    const mapped = conversationOperationalStateFromRow({
      lead_id: 'lead-1', user_id: 'user-1', status: 'em_atendimento', updated_at: '2026-01-01T00:00:00.000Z', last_read_at: '2026-01-01T00:05:00.000Z',
    });
    expect(mapped).toEqual({
      leadId: 'lead-1', userId: 'user-1', status: 'em_atendimento', updatedAt: '2026-01-01T00:00:00.000Z', lastReadAt: '2026-01-01T00:05:00.000Z',
    });
  });

  test('last_read_at ausente/nulo -> lastReadAt null (conversa nunca aberta pelo atendente)', () => {
    const mapped = conversationOperationalStateFromRow({
      lead_id: 'lead-1', user_id: 'user-1', status: 'pendente_resposta', updated_at: '2026-01-01T00:00:00.000Z', last_read_at: null,
    });
    expect(mapped.lastReadAt).toBeNull();
  });

  test('linha nula/ausente -> null, nunca lança (conversa ainda sem estado criado)', () => {
    expect(conversationOperationalStateFromRow(null)).toBeNull();
    expect(conversationOperationalStateFromRow(undefined)).toBeNull();
  });
});

describe('conversationNeedsAttention (Fase 3.6.4 — priorização visual)', () => {
  test('pendente_resposta -> true (cliente enviou, aguardando o CRM)', () => {
    expect(conversationNeedsAttention('pendente_resposta')).toBe(true);
  });

  test('demais estados -> false', () => {
    expect(conversationNeedsAttention('em_atendimento')).toBe(false);
    expect(conversationNeedsAttention('aguardando_cliente')).toBe(false);
    expect(conversationNeedsAttention('concluido')).toBe(false);
  });

  test('status ausente/nulo -> trata como default (pendente_resposta) -> true', () => {
    expect(conversationNeedsAttention(null)).toBe(true);
    expect(conversationNeedsAttention(undefined)).toBe(true);
    expect(DEFAULT_CONVERSATION_OPERATIONAL_STATUS).toBe('pendente_resposta');
  });
});

describe('buildConversationOperationalStatesMap (Fase 3.6.4 — fetch em lote)', () => {
  test('lead com estado real encontrado -> hasRow true, dados do estado preservados', () => {
    const states = [{ leadId: 'lead-1', userId: 'user-1', status: 'em_atendimento', updatedAt: 't1', lastReadAt: 't2' }];
    const map = buildConversationOperationalStatesMap(['lead-1'], states);
    expect(map).toEqual({
      'lead-1': { leadId: 'lead-1', userId: 'user-1', status: 'em_atendimento', updatedAt: 't1', lastReadAt: 't2', hasRow: true },
    });
  });

  test('lead SEM estado (nunca houve evento) -> hasRow false, status default, nunca omitido do mapa', () => {
    const map = buildConversationOperationalStatesMap(['lead-2'], []);
    expect(map).toEqual({
      'lead-2': { leadId: 'lead-2', userId: null, status: 'pendente_resposta', updatedAt: null, lastReadAt: null, hasRow: false },
    });
  });

  test('mistura: alguns leads com estado, outros sem -> cada um corretamente classificado, nenhum omitido', () => {
    const states = [{ leadId: 'lead-1', userId: 'user-1', status: 'concluido', updatedAt: 't1', lastReadAt: null }];
    const map = buildConversationOperationalStatesMap(['lead-1', 'lead-2'], states);
    expect(map['lead-1'].hasRow).toBe(true);
    expect(map['lead-1'].status).toBe('concluido');
    expect(map['lead-2'].hasRow).toBe(false);
    expect(map['lead-2'].status).toBe('pendente_resposta');
  });

  test('leadIds vazio/nulo -> mapa vazio, nunca lança', () => {
    expect(buildConversationOperationalStatesMap([], [])).toEqual({});
    expect(buildConversationOperationalStatesMap(null, null)).toEqual({});
    expect(buildConversationOperationalStatesMap(undefined, undefined)).toEqual({});
  });

  test('leadId nulo/vazio dentro da lista -> ignorado, nunca lança', () => {
    const map = buildConversationOperationalStatesMap(['lead-1', null, ''], []);
    expect(Object.keys(map).sort()).toEqual(['lead-1']);
  });

  test('states com leadId ausente -> ignorado na indexação, nunca quebra os demais', () => {
    const states = [{ leadId: null, status: 'concluido' }, { leadId: 'lead-1', status: 'em_atendimento', userId: 'u', updatedAt: 't', lastReadAt: null }];
    const map = buildConversationOperationalStatesMap(['lead-1'], states);
    expect(map['lead-1'].status).toBe('em_atendimento');
  });

  test('nunca muta o array de states nem os objetos de entrada', () => {
    const state = { leadId: 'lead-1', status: 'concluido', userId: 'u', updatedAt: 't', lastReadAt: null };
    const states = [state];
    buildConversationOperationalStatesMap(['lead-1'], states);
    expect(state).toEqual({ leadId: 'lead-1', status: 'concluido', userId: 'u', updatedAt: 't', lastReadAt: null });
    expect(state.hasRow).toBeUndefined();
  });
});

describe('applyConversationStateRealtimeEvent (Fase 3.6.4, correção pós-revisão do PR #71 — achado 3: "alteração de estado em outra aba")', () => {
  const baseMap = {
    'lead-1': { leadId: 'lead-1', userId: 'user-1', status: 'pendente_resposta', updatedAt: 't0', lastReadAt: null, hasRow: false },
  };

  test('UPDATE de um lead já carregado -> mapa atualizado com hasRow true e o novo status', () => {
    const payload = {
      eventType: 'UPDATE',
      new: { lead_id: 'lead-1', user_id: 'user-1', status: 'em_atendimento', updated_at: 't1', last_read_at: null },
      old: { lead_id: 'lead-1' },
    };
    const result = applyConversationStateRealtimeEvent(baseMap, payload, 'user-1');
    expect(result['lead-1']).toEqual({
      leadId: 'lead-1', userId: 'user-1', status: 'em_atendimento', updatedAt: 't1', lastReadAt: null, hasRow: true,
    });
  });

  test('INSERT de um lead já carregado (primeira linha real) -> mesmo efeito de UPDATE', () => {
    const payload = {
      eventType: 'INSERT',
      new: { lead_id: 'lead-1', user_id: 'user-1', status: 'concluido', updated_at: 't2', last_read_at: 't3' },
    };
    const result = applyConversationStateRealtimeEvent(baseMap, payload, 'user-1');
    expect(result['lead-1'].status).toBe('concluido');
    expect(result['lead-1'].hasRow).toBe(true);
  });

  test('DELETE -> volta ao default (hasRow false), nunca remove a chave do mapa', () => {
    const payload = { eventType: 'DELETE', new: null, old: { lead_id: 'lead-1', user_id: 'user-1' } };
    const result = applyConversationStateRealtimeEvent(baseMap, payload, 'user-1');
    expect(result['lead-1']).toEqual({
      leadId: 'lead-1', userId: null, status: 'pendente_resposta', updatedAt: null, lastReadAt: null, hasRow: false,
    });
  });

  test('lead_id que NÃO está no mapa carregado -> ignorado, nunca adiciona (mesma referência de retorno)', () => {
    const payload = { eventType: 'INSERT', new: { lead_id: 'lead-desconhecido', user_id: 'user-1', status: 'concluido' } };
    const result = applyConversationStateRealtimeEvent(baseMap, payload, 'user-1');
    expect(result).toBe(baseMap);
  });

  test('row de OUTRO usuário -> ignorado, mesma referência (defesa em profundidade)', () => {
    const payload = { eventType: 'UPDATE', new: { lead_id: 'lead-1', user_id: 'user-2', status: 'concluido' } };
    const result = applyConversationStateRealtimeEvent(baseMap, payload, 'user-1');
    expect(result).toBe(baseMap);
  });

  test('payload sem lead_id, mapa nulo, ou userId ausente -> nunca lança, nunca corrompe o mapa', () => {
    expect(applyConversationStateRealtimeEvent(baseMap, { new: {} }, 'user-1')).toBe(baseMap);
    expect(applyConversationStateRealtimeEvent(null, { new: { lead_id: 'lead-1' } }, 'user-1')).toBeNull();
    expect(applyConversationStateRealtimeEvent(baseMap, null, 'user-1')).toBe(baseMap);
    // userId do chamador ausente (ex. corrida de desmontagem) -> o
    // guard de posse por user_id exige os DOIS lados presentes para
    // bloquear; sem o userId do chamador, o evento é aplicado
    // normalmente para um lead_id já conhecido (nunca lança, nunca
    // expande o mapa para um lead novo).
    const payload = { eventType: 'UPDATE', new: { lead_id: 'lead-1', user_id: 'user-1', status: 'concluido', updated_at: 't', last_read_at: null } };
    const result = applyConversationStateRealtimeEvent(baseMap, payload, undefined);
    expect(result['lead-1'].status).toBe('concluido');
  });

  test('nunca muta o mapa de entrada', () => {
    const payload = { eventType: 'UPDATE', new: { lead_id: 'lead-1', user_id: 'user-1', status: 'concluido', updated_at: 't', last_read_at: null } };
    const original = { ...baseMap };
    applyConversationStateRealtimeEvent(baseMap, payload, 'user-1');
    expect(baseMap).toEqual(original);
  });
});

describe('shouldForceConversationStatesResync (Fase 3.6.4, correção pós-revisão do PR #71 — achado 2: "assinatura indisponível")', () => {
  test('CHANNEL_ERROR / TIMED_OUT / CLOSED -> true (forçar ressincronização)', () => {
    expect(shouldForceConversationStatesResync('CHANNEL_ERROR')).toBe(true);
    expect(shouldForceConversationStatesResync('TIMED_OUT')).toBe(true);
    expect(shouldForceConversationStatesResync('CLOSED')).toBe(true);
  });

  test('SUBSCRIBED (canal saudável) -> false, nunca força resync sem motivo', () => {
    expect(shouldForceConversationStatesResync('SUBSCRIBED')).toBe(false);
  });

  test('status desconhecido/ausente -> false, nunca lança', () => {
    expect(shouldForceConversationStatesResync(undefined)).toBe(false);
    expect(shouldForceConversationStatesResync(null)).toBe(false);
    expect(shouldForceConversationStatesResync('')).toBe(false);
    expect(shouldForceConversationStatesResync('algo_novo_da_lib')).toBe(false);
  });
});
