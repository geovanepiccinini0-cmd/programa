import { emptyWorkspace, confirmSale, addMonths, businessDate, uid } from './model.js';

export function demoWorkspace() {
  const state = emptyWorkspace();
  const today = businessDate(), first = today.slice(0, 7) + '-01';
  state.opening = { date: first, amount: 100000 };
  state.administrators = [{ id: 'admin-demo', name: 'Administradora exemplo · fictícia', active: true }];
  state.rules = [{ id: 'rule-demo', name: 'Exemplo didático · não é regra comercial real', administratorId: 'admin-demo', modality: 'Imobiliário', plan: 'Parcela integral', commissionBps: 200, officeBps: 0, active: true, startsOn: '2020-01-01', endsOn: '', conditions: 'Exemplo para testar. Substituir pelas regras reais após aprovação.', parcels: [0,1,2,3,4].map(offset => ({ offset, shareBps: 2000 })) }];
  const rows = [
    { id:'sale-a',name:'Cliente exemplo A',product:'Carta Contemplada',channel:'TikTok',credit:30000000,saleValue:9000000,costValue:7000000,officePercent:50,soldAt:first,firstDue:first },
    { id:'sale-b',name:'Cliente exemplo B',product:'Consórcio',channel:'Instagram',credit:50000000,administratorId:'admin-demo',modality:'Imobiliário',plan:'Parcela integral',ruleId:'rule-demo',soldAt:first,firstDue:first },
    { id:'sale-c',name:'Cliente exemplo C',product:'Consórcio',channel:'Indicação',credit:30000000,administratorId:'admin-demo',modality:'Imobiliário',plan:'Parcela integral',ruleId:'rule-demo',soldAt:addMonths(first,-1),firstDue:first },
  ];
  state.sales = rows.map(row => confirmSale(row, state));
  state.sales.push({ id:'sale-d',name:'Cliente exemplo D',product:'Carta Contemplada',channel:'Site Próprio',credit:20000000,status:'draft',soldAt:'',installments:[],officePercent:50 });
  state.receipts = [{ id:uid(),saleId:'sale-a',installmentId:'sale-a-0',date:first,amount:500000,type:'receipt' }];
  state.pockets = [{ id:'p-reinvest',name:'Reinvestimento',target:500000,percentBps:1500 },{ id:'p-operation',name:'Operação',target:200000,percentBps:2000 },{ id:'p-reserve',name:'Reserva',target:1000000,percentBps:2000 },{ id:'p-personal',name:'Retirada pessoal',target:0,percentBps:0 }];
  return state;
}
export const demoLeads = [
  { id:'demo-new',nome:'Lead de demonstração',produto:'Carta Contemplada',canal:'TikTok',etapa:'Negociação',credito:300000,entrada:90000,parcela:1800,telefone:'',cidade:'Exemplo',tags:['PRIORIDADE'],createdAt:new Date().toISOString(),ultimaAtualizacao:businessDate() },
];
