import { describe, expect, test } from 'vitest';
import { CANAIS, PRODUTOS, STAGES } from './constants.js';

describe('constants — Fase 3.3.1 (inbound: produto/etapa)', () => {
  test('PRODUTOS contem "A identificar" (estado oficial para produto desconhecido)', () => {
    expect(PRODUTOS).toContain('A identificar');
  });

  test('PRODUTOS[0] permanece "Consórcio" — default da criação manual inalterado', () => {
    expect(PRODUTOS[0]).toBe('Consórcio');
  });

  test('"A identificar" fica ao final da lista, nunca substitui/reordena os produtos existentes', () => {
    expect(PRODUTOS).toEqual(['Consórcio', 'Carta Contemplada', 'Home Equity', 'Financiamento', 'Imóvel', 'A identificar']);
  });

  test('STAGES[0] e "Novo Lead" — literal usado pela RPC process_inbound_whatsapp_event (migration 016) para lead novo inbound', () => {
    expect(STAGES[0]).toBe('Novo Lead');
  });
});

describe('canais de origem', () => {
  test('CRM Conseg está disponível sem duplicar ou alterar os canais anteriores', () => {
    expect(CANAIS).toContain('CRM Conseg');
    expect(CANAIS.filter((canal) => canal === 'CRM Conseg')).toHaveLength(1);
    expect(CANAIS[0]).toBe('Facebook Marketplace');
  });
});
