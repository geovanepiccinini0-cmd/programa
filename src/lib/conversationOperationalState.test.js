import { describe, expect, test } from 'vitest';
import {
  CONVERSATION_OPERATIONAL_STATES,
  CONVERSATION_OPERATIONAL_STATE_LABELS,
  conversationOperationalStateLabel,
  conversationOperationalStateFromRow,
  isConversationStateUniqueViolation,
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

describe('isConversationStateUniqueViolation (HOTFIX — fallback de corrida no setStatus de duas etapas)', () => {
  test('erro com code 23505 (unique_violation) -> true', () => {
    expect(isConversationStateUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(true);
  });

  test('erro com outro code -> false (nunca trata outros erros como corrida esperada)', () => {
    expect(isConversationStateUniqueViolation({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isConversationStateUniqueViolation({ code: '23503', message: 'foreign key violation' })).toBe(false);
  });

  test('erro nulo/ausente/sem code -> false, nunca lança', () => {
    expect(isConversationStateUniqueViolation(null)).toBe(false);
    expect(isConversationStateUniqueViolation(undefined)).toBe(false);
    expect(isConversationStateUniqueViolation({})).toBe(false);
  });
});
