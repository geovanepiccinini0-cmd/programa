import { describe, it, expect } from 'vitest';
import { confirmSale, emptyWorkspace, mapSaleMonths } from './model.js';
import { historicalRuleConfirmation } from './historicalSales.js';

function example() {
  const state = emptyWorkspace();
  state.administrators = [{ id: 'a', active: true }];
  const rule = { id: 'r', name: 'Regra cadastrada em outubro', administratorId: 'a', modality: 'Imóveis', plan: 'Parcela integral', active: true, startsOn: '2026-10-28', endsOn: '', commissionBps: 100, officeBps: 0, parcels: [{ offset: 0, shareBps: 5000 }, { offset: 1, shareBps: 5000 }], calendar: { mode: 'assembly', cutoffDay: 10, firstMonthOffset: 1, receiptDay: 15 } };
  state.rules = [rule];
  const sale = { id: 's', name: 'Venda histórica', product: 'Consórcio', administratorId: 'a', modality: 'Imóveis', plan: 'Parcela integral', ruleId: 'r', credit: 30000000, soldAt: '2026-08-05', firstDue: '' };
  return { state, rule, sale };
}
describe('Venda histórica anterior ao cadastro da regra', () => {
  it('exige confirmação explícita das condições históricas', () => {
    const { state, sale } = example();
    expect(() => confirmSale(sale, state)).toThrow('confirme');
  });
  it('confirma a venda antiga e projeta desde a venda, sem gerar recebimentos ou reescrever a regra', () => {
    const { state, sale, rule } = example();
    sale.historicalRuleConfirmation = historicalRuleConfirmation(rule, sale.soldAt);
    const result = confirmSale(sale, state);
    expect(result).toMatchObject({ status: 'confirmed', soldAt: '2026-08-05', gross: 300000, own: 300000 });
    expect(result.installments.map(p => p.due)).toEqual(['2026-09-15', '2026-10-15']);
    expect(result.ruleSnapshot.startsOn).toBe('2026-10-28');
    expect(result.historicalRuleConfirmation).toEqual(sale.historicalRuleConfirmation);
    expect(state.rules[0].startsOn).toBe('2026-10-28');
    expect(state.receipts).toEqual([]);
    state.sales = [result];
    expect(mapSaleMonths(state, '2026-01').rows.find(r => r.saleMonth === '2026-08').cells[8].expected).toBe(150000);
  });
  it('mantém o intervalo adicional do corte no calendário histórico', () => {
    const { state, sale, rule } = example(); sale.soldAt = '2026-08-20';
    sale.historicalRuleConfirmation = historicalRuleConfirmation(rule, sale.soldAt);
    expect(confirmSale(sale, state).installments.map(p => p.due)).toEqual(['2026-09-15', '2026-11-15']);
  });
  it('não reutiliza uma confirmação de outra data, regra ou vigência', () => {
    for (const change of [{ soldAt: '2026-07-05' }, { ruleId: 'other' }, { startsOn: '2026-10-27' }]) {
      const { state, sale, rule } = example();
      sale.historicalRuleConfirmation = { ...historicalRuleConfirmation(rule, sale.soldAt), ...change };
      expect(() => confirmSale(sale, state)).toThrow('confirme');
    }
  });
  it('não permite usar regras futuras, inativas ou vencidas com a confirmação histórica', () => {
    for (const change of [{ startsOn: '2099-01-01' }, { active: false }, { startsOn: '2026-01-01', endsOn: '2026-07-31' }]) {
      const { state, sale, rule } = example(); Object.assign(rule, change);
      sale.historicalRuleConfirmation = historicalRuleConfirmation(rule, sale.soldAt);
      expect(() => confirmSale(sale, state)).toThrow();
    }
  });
  it('preserva a confirmação normal dentro da vigência e a trava após recebimentos', () => {
    const { state, sale, rule } = example(); rule.startsOn = '2026-01-01';
    expect(confirmSale(sale, state).status).toBe('confirmed');
    state.receipts.push({ saleId: sale.id });
    expect(() => confirmSale(sale, state)).toThrow('movimentos');
  });
});
