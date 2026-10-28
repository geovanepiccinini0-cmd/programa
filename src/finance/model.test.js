import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emptyWorkspace, confirmSale, receive, refundReceipt, cash, pocketBalance, transferPocket, addExpense, payExpense, cancelSale, mapMonths, mapSaleMonths, syncWonLeads, forecast, cents, addMonths, validDate, validateRule } from './model.js';
const sale=(extra={})=>({id:'s1',name:'Cliente',product:'Carta Contemplada',channel:'TikTok',credit:30000000,soldAt:'2026-10-01',firstDue:'2026-10-05',saleValue:9000000,costValue:7000000,officePercent:50,...extra});
function workspace(){const s=emptyWorkspace();s.opening={amount:0,date:'2026-10-01'};s.sales=[confirmSale(sale(),s)];return s;}
const receipt=(extra={})=>({saleId:'s1',installmentId:'s1-0',amount:500000,date:'2026-10-10',...extra});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));});afterEach(()=>vi.useRealTimers());
describe('Comissões e calendário',()=>{
  it('calcula venda menos custo e divide sem descontar o custo de novo',()=>{const s=confirmSale(sale(),emptyWorkspace());expect(s.gross).toBe(2000000);expect(s.office).toBe(1000000);expect(s.own).toBe(1000000);expect(s.installments[0].amount).toBe(1000000);const v=confirmSale(sale({officePercent:60}),emptyWorkspace());expect(v.own).toBe(800000);});
  it('não interpreta custo vazio como zero e rejeita venda abaixo do custo',()=>{expect(()=>cents('')).toThrow();expect(cents('0')).toBe(0);expect(()=>confirmSale(sale({costValue:null}),emptyWorkspace())).toThrow();expect(()=>confirmSale(sale({costValue:9500000}),emptyWorkspace())).toThrow('abaixo');});
  it('preserva regra por snapshot e soma parcelas não uniformes até o centavo',()=>{const s=emptyWorkspace();s.administrators=[{id:'a',active:true}];const r={id:'r',name:'Plano',administratorId:'a',modality:'Imobiliário',plan:'Meia parcela',active:true,startsOn:'2026-01-01',commissionBps:201,officeBps:0,parcels:[{offset:0,shareBps:3333},{offset:2,shareBps:6667}]};s.rules=[r];const v=confirmSale(sale({product:'Consórcio',credit:10000001,administratorId:'a',ruleId:'r',modality:r.modality,plan:r.plan,firstDue:'2026-01-31'}),s);expect(v.installments.map(p=>p.due)).toEqual(['2026-01-31','2026-03-31']);expect(v.installments.reduce((n,p)=>n+p.amount,0)).toBe(v.own);r.commissionBps=500;expect(v.ruleSnapshot.commissionBps).toBe(201);});
  it('não confirma consórcio sem regra e valida distribuição',()=>{expect(()=>confirmSale(sale({product:'Consórcio'}),emptyWorkspace())).toThrow('regra');expect(()=>validateRule({})).toThrow();});
  it('trata fim de mês sem deslocar o vencimento para o mês seguinte',()=>{expect(addMonths('2026-01-31',1)).toBe('2026-02-28');expect(validDate('2026-02-30')).toBe(false);});
  it('não duplica fichas ao ganhar de novo nem inventa a data do ganho antigo',()=>{const leads=[{id:'l',nome:'Nome',produto:'Consórcio',etapa:'Ganho'}];const a=syncWonLeads(emptyWorkspace(),leads);expect(a.sales[0].soldAt).toBe('');expect(syncWonLeads(a,leads).sales).toHaveLength(1);expect(syncWonLeads(a,[{...leads[0],etapa:'Negociação'}]).sales).toHaveLength(1);});
});
describe('Recebimentos e projeção',()=>{
  it('mantém parcial, saldo e mês do caixa distintos do vencimento',()=>{let s=workspace();s=receive(s,receipt());expect(mapMonths(s,'2026-10')[0]).toBeUndefined();const map=mapMonths(s,'2026-10');expect(map.totals[0]).toEqual({expected:1000000,paid:500000,balance:500000});expect(cash(s).received).toBe(500000);expect(()=>receive(s,receipt({amount:600000}))).toThrow('supera');expect(()=>receive(s,receipt({date:'2026-12-01'}))).toThrow();});
  it('devolução preserva o movimento original e bloqueia cancelamento com saldo recebido',()=>{let s=receive(workspace(),receipt());expect(()=>cancelSale(s,'s1','Cancelou')).toThrow('devolução');s=refundReceipt(s,{receiptId:s.receipts[0].id,amount:500000,date:'2026-10-20',reason:'Cancelamento'});expect(s.receipts).toHaveLength(2);expect(cash(s).balance).toBe(0);s=cancelSale(s,'s1','Cancelamento');expect(s.sales[0].status).toBe('cancelled');expect(()=>confirmSale(sale(),s)).toThrow('cancelada');});
  it('não altera condições de venda que já recebeu e mantém valores vencidos fora das novas entradas',()=>{const s=receive(workspace(),receipt());expect(()=>confirmSale(sale(),s)).toThrow('movimentos');expect(forecast(s,'2026-10').overdueIn).toBe(500000);expect(forecast(s,'2026-10').rows[0].expected).toBe(0);});
});
describe('Caixinhas sem duplicação de despesas',()=>{
  it('separar não reduz caixa; pagar pela caixinha não desconta a reserva duas vezes',()=>{let s=receive(workspace(),receipt());s.pockets=[{id:'p',name:'Operação',target:100000,percentBps:2000}];s=transferPocket(s,{pocketId:'p',amount:100000,type:'in',date:'2026-10-20'});expect(cash(s).balance).toBe(500000);expect(cash(s).available).toBe(400000);s=addExpense(s,{title:'Ferramenta',category:'CRM',amount:40000,pocketId:'p',due:'2026-10-25'});expect(cash(s).available).toBe(400000);s=payExpense(s,s.expenses[0].id,'2026-10-25');expect(pocketBalance(s,'p')).toBe(60000);expect(cash(s).balance).toBe(460000);expect(cash(s).available).toBe(400000);});
  it('não destina dinheiro previsto nem permite saldo negativo',()=>{const s=workspace();s.pockets=[{id:'p'}];expect(()=>transferPocket(s,{pocketId:'p',amount:10000,type:'in',date:'2026-10-20'})).toThrow('insuficiente');});
});
describe('Mapa por mês da venda × mês do recebimento',()=>{
  it('agrupa clientes do mesmo mês sem perder o total mensal',()=>{
    const s=workspace();s.sales.push(confirmSale(sale({id:'s2',name:'Outro cliente',soldAt:'2026-10-20',firstDue:'2026-11-05'}),s));
    const map=mapSaleMonths(s,'2026-01');const row=map.rows.find(r=>r.saleMonth==='2026-10');
    expect(map.rows).toHaveLength(12);expect(row.saleCount).toBe(2);expect(row.cells[9].expected).toBe(1000000);expect(row.cells[10].expected).toBe(1000000);
    map.totals.forEach((total,i)=>expect(map.rows.reduce((n,r)=>n+r.cells[i].expected,0)).toBe(total.expected));
  });
  it('sobrepõe safras diferentes na mesma coluna e preserva recebimentos parciais',()=>{
    let s=workspace();s.sales.push(confirmSale(sale({id:'s2',soldAt:'2026-09-10',firstDue:'2026-10-05',officePercent:60}),s));s=receive(s,receipt());
    const map=mapSaleMonths(s,'2026-01');expect(map.totals[9]).toEqual({expected:1800000,paid:500000,balance:1300000});expect(map.rows.find(r=>r.saleMonth==='2026-09').cells[9].expected).toBe(800000);expect(map.rows.find(r=>r.saleMonth==='2026-10').cells[9].paid).toBe(500000);
  });
  it('inclui vendas do ano anterior que ainda geram comissões e permite mudar o ano',()=>{
    const s=workspace();s.sales.push(confirmSale(sale({id:'old',soldAt:'2025-12-12',firstDue:'2026-02-05'}),s));s.sales.push(confirmSale(sale({id:'future',soldAt:'2026-12-12',firstDue:'2027-01-05'}),s));
    expect(mapSaleMonths(s,'2026-01').rows.find(r=>r.saleMonth==='2025-12').cells[1].expected).toBe(1000000);const next=mapSaleMonths(s,'2027-01');expect(next.rows.find(r=>r.saleMonth==='2026-12').cells[0].expected).toBe(1000000);
  });
  it('mantém filtros, cancelamentos e ausências de data consistentes',()=>{
    const s=workspace();s.sales.push({...s.sales[0],id:'cancelled',status:'cancelled'});s.sales[0].soldAt='';expect(mapSaleMonths(s,'2026-01').rows.find(r=>r.saleMonth==='Sem mês informado').cells[9].expected).toBe(1000000);expect(mapSaleMonths(s,'2026-01',12,'Consórcio').totals[9].expected).toBe(0);
  });
});
