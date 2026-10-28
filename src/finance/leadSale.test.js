import { describe, it, expect } from 'vitest';
import { fillSaleFromLead } from './leadSale.js';
import { draftFromLead, emptyWorkspace, syncWonLeads } from './model.js';

const lead = { id: 'lead', nome: 'Teste', produto: 'Carta Contemplada', etapa: 'Ganho', credito: 300000, entrada: 90000.25, parcela: 1800.50 };
describe('Condições da contemplada importadas do lead', () => {
  it('usa entrada como venda e guarda parcela informativa em centavos, sem inferir custo ou recebimento', () => {
    const state = syncWonLeads(emptyWorkspace(), [lead]);
    expect(state.sales[0]).toMatchObject({ credit: 30000000, saleValue: 9000025, quotaInstallment: 180050, status: 'draft', installments: [] });
    expect(state.sales[0].costValue).toBeUndefined();
    expect(state.receipts).toEqual([]);
  });
  it('não transforma campos vazios em zero nem importa entrada de consórcio novo', () => {
    expect(draftFromLead({ ...lead, entrada: null, parcela: '' })).toMatchObject({ saleValue: null, quotaInstallment: null });
    expect(draftFromLead({ ...lead, entrada: 0 }).saleValue).toBe(0);
    expect(draftFromLead({ ...lead, produto: 'Consórcio' }).saleValue).toBeUndefined();
  });
  it('preenche ficha antiga pendente somente onde faltam valores, sem modificar o original', () => {
    const old = { id: 'sale', leadId: lead.id, product: lead.produto, status: 'draft', saleValue: null, costValue: 7000000, supplier: 'Parceiro' };
    expect(fillSaleFromLead(old, lead)).toMatchObject({ saleValue: 9000025, quotaInstallment: 180050, costValue: 7000000, supplier: 'Parceiro' });
    expect(old.saleValue).toBeNull();
    expect(fillSaleFromLead({ ...old, saleValue: 8500000 }, lead).saleValue).toBe(8500000);
    expect(fillSaleFromLead({ ...old, saleValue: 0 }, lead).saleValue).toBe(0);
  });
  it('preserva vendas confirmadas, canceladas e leads sem vínculo', () => {
    for (const status of ['confirmed', 'cancelled']) {
      const sale = { leadId: lead.id, product: lead.produto, status };
      expect(fillSaleFromLead(sale, lead)).toBe(sale);
    }
    const sale = { leadId: 'other', product: lead.produto, status: 'draft' };
    expect(fillSaleFromLead(sale, lead)).toBe(sale);
  });
});
