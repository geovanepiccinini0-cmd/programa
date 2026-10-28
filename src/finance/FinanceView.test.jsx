import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import FinanceView from './FinanceView.jsx';
import { emptyWorkspace, confirmSale } from './model.js';

it('mostra meses de venda, doze meses de vencimento e clientes apenas no detalhamento',()=>{
  const state=emptyWorkspace();state.sales=[confirmSale({id:'s',name:'Cliente que só deve aparecer no detalhe',product:'Carta Contemplada',credit:30000000,saleValue:9000000,costValue:7000000,officePercent:50,soldAt:'2026-09-12',firstDue:'2026-10-01'},state)];
  const html=renderToStaticMarkup(<FinanceView state={state} month="2026-10" setMonth={()=>{}} commit={()=>{}} run={()=>{}} saving={false}/>);
  expect(html).toContain('setembro de 2026');expect(html).toContain('Mês da venda');expect(html).toContain('01/2026');expect(html).toContain('12/2026');expect(html).not.toContain('Cliente que só deve aparecer no detalhe');expect(html).toContain('Abrir detalhamento');
});
