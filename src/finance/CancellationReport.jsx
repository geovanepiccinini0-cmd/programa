import { saleTimeline } from './customers.js';
import { money, monthOf } from './model.js';
import { Panel, Table, Empty } from './ui.jsx';
export default function CancellationReport({state,month}){
 const events=state.sales.flatMap(s=>saleTimeline(state,s).map(e=>({...e,sale:s}))).filter(e=>monthOf(e.date)===month);
 const cancelled=events.filter(e=>e.type==='cancelled'),restored=events.filter(e=>e.type==='restored');
 const reasons=[...new Set(cancelled.map(e=>e.category||'Motivo em texto / histórico'))];
 return <Panel title="Cancelamentos e recuperações" note="Eventos ocorridos no mês selecionado. Uma recuperação preserva o cancelamento anterior; reaberturas pendentes só retornam à projeção após confirmação."><p>{cancelled.length} cancelamento(s) · {restored.length} recuperação(ões) · Comissão atualmente cancelada: {money(state.sales.filter(s=>s.status==='cancelled').reduce((n,s)=>n+(s.own||0),0))}</p><Table headers={['Motivo','Eventos de cancelamento','Vendas ainda canceladas']}>{reasons.map(reason=><tr key={reason}><th>{reason}</th><td>{cancelled.filter(e=>(e.category||'Motivo em texto / histórico')===reason).length}</td><td>{new Set(cancelled.filter(e=>(e.category||'Motivo em texto / histórico')===reason&&e.sale.status==='cancelled').map(e=>e.sale.id)).size}</td></tr>)}</Table>{!events.length&&<Empty>Nenhum evento registrado neste mês.</Empty>}</Panel>;
}
