import { describe, it, expect } from 'vitest';
import { deleteCommissionRule } from './rules.js';
import { emptyWorkspace, ruleFromCreditRates, confirmSale } from './model.js';

describe('Exclusão de regras de comissão', () => {
  function workspace() {
    const state = emptyWorkspace();
    state.administrators = [{ id: 'a', name: 'Administradora', active: true }];
    state.rules = [ruleFromCreditRates({ id: 'r', administratorId: 'a', modality: 'Imóveis', plan: 'Parcela integral', office: '0', startsOn: '2026-01-01', active: true, parcels: [{ offset: 0, creditRate: '1' }] }, state.administrators)];
    return state;
  }
  it('remove regras ativas ou inativas sem alterar o documento original', () => {
    for (const active of [true, false]) {
      const state = workspace(); state.rules[0].active = active;
      expect(deleteCommissionRule(state, 'r').rules).toEqual([]);
      expect(state.rules).toHaveLength(1);
    }
  });
  it('preserva condições, parcelas e recebimentos de vendas confirmadas e canceladas', () => {
    const state = workspace();
    const sale = confirmSale({ id: 's', name: 'Teste', product: 'Consórcio', administratorId: 'a', modality: 'Imóveis', plan: 'Parcela integral', ruleId: 'r', credit: 10000000, soldAt: '2026-01-05', firstDue: '2026-02-15' }, state);
    state.sales = [sale, { ...structuredClone(sale), id: 'cancelled', status: 'cancelled' }];
    state.receipts = [{ id: 'receipt', saleId: 's', installmentId: 's-0', amount: 100000, type: 'receipt', date: '2026-02-15' }];
    const next = deleteCommissionRule(state, 'r');
    expect(next.sales).toEqual(state.sales);
    expect(next.receipts).toEqual(state.receipts);
    expect(next.sales[0].ruleSnapshot.commissionBps).toBe(100);
  });
  it('limpa somente a seleção da regra excluída em vendas pendentes', () => {
    const state = workspace();
    state.sales = [{ id: 'draft', status: 'draft', ruleId: 'r', credit: 10000000 }, { id: 'other', status: 'draft', ruleId: 'other' }];
    const next = deleteCommissionRule(state, 'r');
    expect(next.sales[0]).toEqual({ ...state.sales[0], ruleId: '' });
    expect(next.sales[1]).toEqual(state.sales[1]);
    expect(state.sales[0].ruleId).toBe('r');
  });
  it('rejeita uma regra que já foi excluída', () => {
    expect(() => deleteCommissionRule(workspace(), 'missing')).toThrow('não encontrada');
  });
});
