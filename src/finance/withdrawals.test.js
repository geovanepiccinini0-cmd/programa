import { it, expect } from 'vitest';
import { emptyWorkspace, cash, addExpense, payExpense } from './model.js';
it('retirada mantém recebido no mês e reduz caixa e base das novas destinações',()=>{
 let state=emptyWorkspace();state.opening={amount:0,date:'2026-01-01'};
 state.receipts=[{id:'r',amount:152500,date:'2026-10-01',type:'receipt'}];
 state=addExpense(state,{title:'Uso pessoal',category:'Retirada pessoal',amount:152500,due:'2026-10-02'});
 expect(cash(state).allocationBase).toBe(152500);
 state=payExpense(state,state.expenses[0].id,'2026-10-02');
 expect(cash(state)).toMatchObject({received:152500,spent:152500,withdrawn:152500,balance:0,available:0,allocationBase:0});
 state.receipts.push({id:'new',amount:100000,date:'2026-10-03',type:'receipt'});
 expect(cash(state)).toMatchObject({received:252500,balance:100000,allocationBase:100000});
 expect(Math.round(cash(state).allocationBase*0.2)).toBe(20000);
 expect(cash(state,'2026-10-01')).toMatchObject({received:152500,withdrawn:0,allocationBase:152500});
});
