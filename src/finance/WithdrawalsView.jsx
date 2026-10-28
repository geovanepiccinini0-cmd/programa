import { useState } from 'react';
import { addExpense, payExpense, cash, cents, money, businessDate, monthOf, dateLabel } from './model.js';
import { Panel, Field, Amount, Kpis, Table, Empty } from './ui.jsx';

export default function WithdrawalsView({state,commit,run,saving,month}) {
  const today=businessDate(), position=cash(state);
  const [form,setForm]=useState(null);
  const rows=state.expenses.filter(e=>e.category==='Retirada pessoal');
  const monthly=rows.filter(e=>e.paidAt&&monthOf(e.paidAt)===month).reduce((n,e)=>n+e.amount,0);
  async function save(event) {
    event.preventDefault();
    await run(async()=>{
      await commit(current=>{
        const amount=cents(form.amount);
        if(amount>Math.max(0,cash(current).available))throw new Error('Saldo livre insuficiente. Confira as caixinhas e obrigações antes de retirar.');
        const next=addExpense(current,{title:form.title,category:'Retirada pessoal',amount,due:form.date,channel:'',pocketId:''});
        return payExpense(next,next.expenses[next.expenses.length-1].id,form.date);
      },'Retirada pessoal realizada');
      setForm(null);
    },'Retirada registrada. Recebimentos históricos preservados; caixa e sugestões atualizados.');
  }
  return <>
    <Kpis items={[["Retirado no mês",money(monthly),'Uso pessoal realizado'],['Livre para retirar',money(position.available),'Após caixinhas e obrigações'],['Base das destinações',money(position.allocationBase),'Recebimentos acumulados menos retiradas realizadas']]}/>
    <Panel title="Retiradas pessoais" note="Registre o dinheiro que já saiu do negócio para seu uso pessoal. A retirada reduz o caixa e a base das sugestões das caixinhas; mantém a comissão recebida no histórico. Nenhuma transferência bancária é executada." actions={<button className="btn-primary" onClick={()=>setForm({title:'Retirada pessoal',amount:'',date:today})}>+ Registrar retirada</button>}>
      {!state.opening&&<p className="fin-callout">Informe o saldo inicial em Caixinhas antes de registrar saídas. Para começar com os recebimentos já cadastrados, use a data de início desse controle e o saldo que existia antes deles, evitando contar o mesmo valor duas vezes.</p>}
      <Table headers={['Descrição','Valor','Data efetiva','Situação']}>{rows.map(e=><tr key={e.id}><th scope="row">{e.title}</th><td>{money(e.amount)}</td><td>{dateLabel(e.paidAt||e.due)}</td><td>{e.paidAt?'Realizada':'Pendente — confirme o pagamento em Despesas'}</td></tr>)}</Table>{!rows.length&&<Empty>Nenhuma retirada registrada.</Empty>}
    </Panel>
    {form&&<Panel title="Registrar retirada realizada" actions={<button onClick={()=>setForm(null)}>Fechar</button>}><form onSubmit={save}><div className="fin-form"><Field label="Descrição" value={form.title} onChange={e=>setForm(v=>({...v,title:e.target.value}))} required/><Amount label="Valor retirado (R$)" value={form.amount} onChange={amount=>setForm(v=>({...v,amount}))} required/><Field label="Data efetiva da retirada" type="date" max={today} value={form.date} onChange={e=>setForm(v=>({...v,date:e.target.value}))} required/></div><p className="fin-note">Registre cada retirada uma única vez. Retiradas já pagas na categoria Retirada pessoal aparecem aqui automaticamente.</p><button className="btn-primary" disabled={saving}>Confirmar retirada</button></form></Panel>}
  </>;
}
