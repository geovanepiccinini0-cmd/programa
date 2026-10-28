import { describe, it, expect } from 'vitest';
import { channelResults, emptyWorkspace } from './model.js';

describe('Resultado mensal por canal', () => {
  it('soma volume e comissão de todos os produtos confirmados no mês do fechamento', () => {
    const state = emptyWorkspace();
    state.sales = [
      { id: 'consortium', status: 'confirmed', product: 'Consórcio', channel: 'Indicação', soldAt: '2026-10-01', credit: 30000000, own: 300000 },
      { id: 'quota', status: 'confirmed', product: 'Carta Contemplada', channel: 'Indicação', soldAt: '2026-10-02', credit: 20000000, saleValue: 8000000, own: 1000000 },
      { id: 'financing', status: 'confirmed', product: 'Financiamento', channel: 'Indicação', soldAt: '2026-10-03', credit: 15000000, own: 150000 },
      { id: 'other', status: 'confirmed', product: 'Outro produto', channel: 'Indicação', soldAt: '2026-10-04', credit: 5000000, own: 50000 },
      { id: 'draft', status: 'draft', channel: 'Indicação', soldAt: '2026-10-05', credit: 99999999, own: 99999999 },
      { id: 'cancelled', status: 'cancelled', channel: 'Indicação', soldAt: '2026-10-06', credit: 99999999, own: 99999999 },
      { id: 'old', status: 'confirmed', channel: 'Indicação', soldAt: '2026-09-01', credit: 99999999, own: 99999999 },
    ];
    expect(channelResults(state, '2026-10')[0]).toMatchObject({ count: 4, credit: 70000000, own: 1500000, received: 0, spent: 0 });
  });
  it('apura recebimentos por data efetiva, incluindo vendas antigas, parciais e devoluções', () => {
    const state = emptyWorkspace();
    state.sales = [{ id: 'old', status: 'confirmed', channel: 'Orgânico', soldAt: '2026-09-01', credit: 30000000, own: 300000 }];
    state.receipts = [
      { saleId: 'old', date: '2026-10-05', type: 'receipt', amount: 100000 },
      { saleId: 'old', date: '2026-10-10', type: 'receipt', amount: 50000 },
      { saleId: 'old', date: '2026-10-15', type: 'refund', amount: 20000 },
      { saleId: 'old', date: '2026-09-15', type: 'receipt', amount: 100000 },
    ];
    state.expenses = [
      { channel: 'Orgânico', amount: 30000, paidAt: '2026-10-20' },
      { channel: 'Orgânico', amount: 90000, due: '2026-10-20' },
      { channel: 'Orgânico', amount: 80000, paidAt: '2026-09-20' },
    ];
    expect(channelResults(state, '2026-10')[0]).toMatchObject({ count: 0, credit: 0, own: 0, received: 130000, spent: 30000 });
  });
  it('mantém canais separados e trata vendas sem canal ou valor informado', () => {
    const state = emptyWorkspace();
    state.sales = [
      { id: 'empty', status: 'confirmed', channel: '', soldAt: '2026-10-01' },
      { id: 'paid', status: 'confirmed', channel: 'Instagram', soldAt: '2026-10-02', credit: 10000000, own: 100000 },
    ];
    state.receipts = [{ saleId: 'empty', date: '2026-10-05', type: 'receipt', amount: 1000 }];
    expect(channelResults(state, '2026-10')).toEqual([
      { channel: 'Não informado', count: 1, credit: 0, own: 0, received: 1000, spent: 0 },
      { channel: 'Instagram', count: 1, credit: 10000000, own: 100000, received: 0, spent: 0 },
    ]);
  });
});
