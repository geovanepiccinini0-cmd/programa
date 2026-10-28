import { useState } from 'react';
import SalesView from './SalesView.jsx';
import FinanceView from './FinanceView.jsx';
import SettingsView from './SettingsView.jsx';
import { monthOf, businessDate, money, channelResults } from './model.js';
import { Kpis, Panel, Table } from './ui.jsx';
import './finance.css';

export default function FinanceSuite({finance,activeTab,leads=[]}) {
  const [month,setMonth]=useState(monthOf(businessDate())),[message,setMessage]=useState(''),[actionError,setActionError]=useState('');
  const {state,commit,loading,saving,error,reload}=finance;
  async function run(task,success='Alteração salva.') {setActionError('');setMessage('');try{await task();setMessage(success);return true;}catch(e){setActionError(e.message);return false;}}
  if(loading)return <div className="fin-app"><p role="status">Carregando vendas e financeiro...</p></div>;
  if(!state)return <div className="fin-app"><div role="alert" className="fin-callout">{error||'Financeiro indisponível.'}</div><button onClick={reload}>Recarregar</button></div>;
  const props={state,commit,run,saving,month,setMonth,leads};
  const closed=state.sales.filter(s=>s.status==='confirmed'&&monthOf(s.soldAt)===month);
  const channels=channelResults(state,month);
  return <div className="fin-app" aria-busy={saving}>
    {(error||actionError)&&<div role="alert" className="fin-error">{actionError||error} <button onClick={reload}>Recarregar dados</button></div>}
    {message&&<p role="status" className="fin-success">{message}</p>}{saving&&<p role="status">Salvando...</p>}
    {activeTab==='vendas'&&<SalesView {...props}/>}
    {activeTab==='financeiro'&&<FinanceView {...props}/>}
    {activeTab==='configuracoes'&&<SettingsView {...props}/>}
    {activeTab==='metricas'&&<>
      <div className="fin-title"><div><span className="eyebrow">Fechamentos e remuneração</span><h1>Resultado comercial</h1><p>Vendas pela data de fechamento; recebimentos pela data efetiva.</p></div><label className="fin-field"><span>Mês</span><input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label></div>
      <Kpis items={[["Vendas confirmadas",closed.length,'Fechamentos no mês'],['Consórcio novo',money(closed.filter(s=>s.product==='Consórcio').reduce((n,s)=>n+s.credit,0)),'Crédito contratado, não receita'],['Sua comissão gerada',money(closed.reduce((n,s)=>n+s.own,0)),'Após divisão com o escritório'],['Ganhos pendentes',state.sales.filter(s=>s.status==='draft').length,'Fora da previsão financeira']]}/>
      <Panel title="Quais canais estão gerando negócios?" note="Resultado por fechamento e caixa por data de movimento. Não representa ROI da safra; o canal orgânico não implica custo zero.">
        <Table headers={['Origem','Vendas','Crédito de consórcio','Sua comissão contratada','Recebido no mês','Despesas pagas atribuídas']}>{channels.map(r=><tr key={r.channel}><th scope="row">{r.channel}</th><td>{r.count}</td><td>{money(r.credit)}</td><td>{money(r.own)}</td><td>{money(r.received)}</td><td>{r.spent?money(r.spent):'Sem gasto informado'}</td></tr>)}</Table>
      </Panel>
    </>}
  </div>;
}
