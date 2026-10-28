import { useState } from 'react';
import Header from '../components/Header.jsx';
import FunilView from '../components/FunilView.jsx';
import FinanceSuite from './FinanceSuite.jsx';
import { useFinance } from './useFinance.js';
import { demoLeads } from './demo.js';
import { syncWonLeads, uid, businessDate } from './model.js';
import { STAGES } from '../constants.js';

export default function FinancePreview() {
  const finance=useFinance({preview:true});
  const [activeTab,setActiveTab]=useState('financeiro'),[filterProduto,setFilterProduto]=useState('Todos'),[filterStale,setFilterStale]=useState(false),[sortOrder,setSortOrder]=useState('novo'),[searchQuery,setSearchQuery]=useState(''),[editing,setEditing]=useState(null),[modal,setModal]=useState(false),[error,setError]=useState('');
  const leads=finance.state?.demoLeads||demoLeads;
  async function changeLeads(next){setError('');try{await finance.commit(s=>syncWonLeads({...s,demoLeads:next},next),'Operação em lead fictício');}catch(e){setError(e.message);}}
  function changeStage(id,etapa){changeLeads(leads.map(l=>l.id===id?{...l,etapa,wonAt:etapa==='Ganho'?new Date().toISOString():null}:l));}
  return <div className="app crm-shell">
    <Header activeTab={activeTab} onTabChange={tab=>{setActiveTab(['hoje','rotina','conversas'].includes(tab)?'funil':tab);setModal(false);}} isAdmin preview onNewLead={()=>{setEditing({nome:'',produto:'Carta Contemplada',canal:'TikTok',credito:0,etapa:'Novo Lead'});setModal(true);}}/>
    <main className="crm-workspace">
      <div className="fin-preview-banner"><div><strong>PREVIEW · ambiente de demonstração</strong><span>Dados fictícios salvos somente neste navegador. Não acessa leads, banco de dados ou caixa real.</span></div><button onClick={()=>{if(confirm('Restaurar os exemplos? Isso apaga somente os testes desta preview.'))finance.reset();}}>Restaurar exemplos</button></div>
      {error&&<p role="alert" className="fin-error">{error}</p>}
      {modal&&<section className="fin-app fin-panel"><div className="fin-panel-head"><h2>Lead fictício de teste</h2><button onClick={()=>setModal(false)}>Fechar</button></div><form onSubmit={async e=>{e.preventDefault();const next=editing.id?leads.map(l=>l.id===editing.id?editing:l):[...leads,{...editing,id:uid(),createdAt:new Date().toISOString(),ultimaAtualizacao:businessDate()}];await changeLeads(next.map(l=>l.etapa==='Ganho'&&!l.wonAt?{...l,wonAt:new Date().toISOString()}:l));setModal(false);setActiveTab('funil');}}><div className="fin-form"><label className="fin-field">Nome<input value={editing.nome} onChange={e=>setEditing(s=>({...s,nome:e.target.value}))} required/></label><label className="fin-field">Produto<select value={editing.produto} onChange={e=>setEditing(s=>({...s,produto:e.target.value}))}><option>Carta Contemplada</option><option>Consórcio</option></select></label><label className="fin-field">Canal<input value={editing.canal} onChange={e=>setEditing(s=>({...s,canal:e.target.value}))}/></label><label className="fin-field">Crédito (R$)<input type="number" min="0" value={editing.credito} onChange={e=>setEditing(s=>({...s,credito:Number(e.target.value)}))}/></label><label className="fin-field">Etapa<select value={editing.etapa} onChange={e=>setEditing(s=>({...s,etapa:e.target.value}))}>{STAGES.map(stage=><option key={stage}>{stage}</option>)}</select></label></div><button className="btn-primary">Salvar lead de teste</button></form></section>}
      {activeTab==='funil'?<><div className="fin-title"><div><h1>Teste o fluxo de lead ganho</h1><p>Mova o lead fictício para Ganho e confira a ficha criada em Vendas.</p></div></div><FunilView leads={leads} filterProduto={filterProduto} setFilterProduto={setFilterProduto} filterStale={filterStale} setFilterStale={setFilterStale} sortOrder={sortOrder} setSortOrder={setSortOrder} searchQuery={searchQuery} setSearchQuery={setSearchQuery} onEdit={l=>{setEditing(l);setModal(true);}} onDelete={id=>changeLeads(leads.filter(l=>l.id!==id))} onMoveStage={(id,dir)=>{const lead=leads.find(l=>l.id===id);const idx=STAGES.indexOf(lead.etapa);changeStage(id,STAGES[Math.max(0,Math.min(STAGES.length-1,idx+dir))]);}} onDropStage={changeStage}/></>:<FinanceSuite finance={finance} activeTab={activeTab} leads={leads}/>}
    </main>
  </div>;
}
