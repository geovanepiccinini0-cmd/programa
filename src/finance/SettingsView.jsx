import { useState } from 'react';
import { uid, businessDate, validateRule } from './model.js';
import { Field, Panel, Table, Empty } from './ui.jsx';

const emptyRule=()=>({id:uid(),name:'',administratorId:'',modality:'Imobiliário',plan:'Parcela integral',commission:'',office:'0',startsOn:businessDate(),endsOn:'',conditions:'',parcels:[{offset:0,shareBps:10000}],active:true});
export default function SettingsView({state,commit,run,saving}) {
  const [name,setName]=useState(''),[rule,setRule]=useState(null);
  const field=(key,value)=>setRule(r=>({...r,[key]:value}));
  const saveAdmin=e=>{e.preventDefault();run(async()=>{
    if(!name.trim())throw new Error('Informe a administradora.');
    if(state.administrators.some(a=>a.name.toLowerCase()===name.trim().toLowerCase()))throw new Error('Administradora já cadastrada.');
    await commit(s=>({...s,administrators:[...s.administrators,{id:uid(),name:name.trim(),active:true}]}),'Cadastro de administradora');setName('');
  },'Administradora cadastrada.');};
  const saveRule=e=>{e.preventDefault();run(async()=>{
    const next={...rule,commissionBps:Math.round(Number(rule.commission)*100),officeBps:Math.round(Number(rule.office)*100)};
    validateRule(next);
    if(!state.administrators.some(a=>a.id===next.administratorId&&a.active))throw new Error('Selecione uma administradora ativa.');
    delete next.commission;delete next.office;
    const overlap=state.rules.some(r=>r.active&&r.administratorId===next.administratorId&&r.modality===next.modality&&r.plan===next.plan&&r.startsOn<=(next.endsOn||'9999-12-31')&&(r.endsOn||'9999-12-31')>=next.startsOn);
    if(overlap)throw new Error('Já existe uma regra ativa com vigência sobreposta. Inative a anterior ou ajuste as datas. As vendas antigas preservam sua regra.');
    await commit(s=>({...s,rules:[...s.rules,next]}),'Nova versão de comissionamento');setRule(null);
  },'Regra cadastrada.');};
  return <>
    <div className="fin-title"><div><span className="eyebrow">Base de comissionamento</span><h1>Configurações</h1><p>Administradora, modalidade e plano definem cada regra.</p></div><button className="btn-primary" onClick={()=>setRule(emptyRule())}>+ Nova regra</button></div>
    <div className="fin-callout">As regras reais serão cadastradas com você. Não há comissão padrão universal. Alterações não recalculam vendas já confirmadas.</div>
    <Panel title="Administradoras" note="Inativar impede novas vendas com a regra; o histórico permanece.">
      <form onSubmit={saveAdmin} className="fin-toolbar"><Field label="Nome da administradora" value={name} onChange={e=>setName(e.target.value)} required/><button className="btn-primary" disabled={saving}>Cadastrar</button></form>
      <Table headers={['Administradora','Situação','Ação']}>{state.administrators.map(a=><tr key={a.id}><th scope="row">{a.name}</th><td>{a.active?'Ativa':'Inativa'}</td><td><button disabled={saving} onClick={()=>run(()=>commit(s=>({...s,administrators:s.administrators.map(v=>v.id===a.id?{...v,active:!v.active}:v)}),'Situação da administradora'),'Cadastro atualizado.')}>{a.active?'Inativar':'Ativar'}</button></td></tr>)}</Table>{!state.administrators.length&&<Empty>Cadastre a primeira administradora.</Empty>}
    </Panel>
    {rule&&<Panel title="Nova versão da regra" note="Base: crédito contratado. Distribua 100% da sua comissão líquida entre as parcelas. Mês 0 é a data do primeiro recebimento da venda." actions={<button onClick={()=>setRule(null)}>Fechar</button>}>
      <form onSubmit={saveRule}><fieldset disabled={saving} className="fin-fieldset"><div className="fin-form">
        <Field label="Nome / versão" value={rule.name} onChange={e=>field('name',e.target.value)} required/>
        <Field label="Administradora"><select value={rule.administratorId} onChange={e=>field('administratorId',e.target.value)} required><option value="">Selecione</option>{state.administrators.filter(a=>a.active).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Modalidade"><select value={rule.modality} onChange={e=>field('modality',e.target.value)}>{['Imobiliário','Veículos','Outros'].map(v=><option key={v}>{v}</option>)}</select></Field>
        <Field label="Tipo de plano"><select value={rule.plan} onChange={e=>field('plan',e.target.value)}>{['Meia parcela','Parcela reduzida','Parcela integral'].map(v=><option key={v}>{v}</option>)}</select></Field>
        <Field label="Comissão sobre crédito (%)" type="number" min="0.01" max="100" step="0.01" value={rule.commission} onChange={e=>field('commission',e.target.value)} required/>
        <Field label="Repasse escritório sobre comissão (%)" type="number" min="0" max="100" step="0.01" value={rule.office} onChange={e=>field('office',e.target.value)} required/>
        <Field label="Vigência inicial" type="date" value={rule.startsOn} onChange={e=>field('startsOn',e.target.value)} required/>
        <Field label="Vigência final (opcional)" type="date" value={rule.endsOn} onChange={e=>field('endsOn',e.target.value)}/>
        <Field label="Condições de liberação e estorno"><textarea value={rule.conditions} onChange={e=>field('conditions',e.target.value)} rows="3" placeholder="Descreva as condições contratuais. A conferência da liberação é manual."/></Field>
      </div><h3>Calendário de pagamento</h3><p className="fin-note">Quantidade e distribuição podem variar por plano. Condições contratuais ficam registradas para conferência manual.</p>
      {rule.parcels.map((p,i)=><div className="fin-parcel-row" key={i}><span>Parcela {i+1}</span><Field label="Meses após o primeiro recebimento" type="number" min="0" max="120" value={p.offset} onChange={e=>field('parcels',rule.parcels.map((v,j)=>i===j?{...v,offset:Number(e.target.value)}:v))}/><Field label="Participação na comissão (%)" type="number" min="0.01" max="100" step="0.01" value={p.shareBps/100} onChange={e=>field('parcels',rule.parcels.map((v,j)=>i===j?{...v,shareBps:Math.round(Number(e.target.value)*100)}:v))}/><button type="button" disabled={rule.parcels.length===1} onClick={()=>field('parcels',rule.parcels.filter((_,j)=>j!==i))}>Remover</button></div>)}
      <div className="fin-actions"><button type="button" onClick={()=>field('parcels',[...rule.parcels,{offset:Math.max(...rule.parcels.map(p=>p.offset))+1,shareBps:0}])} disabled={rule.parcels.length>=60}>+ Parcela</button><span>Total: {rule.parcels.reduce((n,p)=>n+p.shareBps,0)/100}%</span><button type="button" onClick={()=>{let n=0;field('parcels',rule.parcels.map((p,i)=>{const shareBps=i===rule.parcels.length-1?10000-n:Math.floor(10000/rule.parcels.length);n+=shareBps;return{...p,shareBps};}));}}>Distribuir igualmente</button><button className="btn-primary" type="submit">Salvar regra</button></div>
      </fieldset></form>
    </Panel>}
    <Panel title="Regras cadastradas" note="Uma nova condição é uma nova versão. Vendas guardam a regra e o calendário usados na confirmação.">
      <Table headers={['Regra / administradora','Modalidade / plano','Comissão / repasse','Parcelas','Vigência','Ações']}>{state.rules.map(r=><tr key={r.id}><th scope="row">{r.name}<small>{state.administrators.find(a=>a.id===r.administratorId)?.name}</small><small>{r.active?'Ativa':'Inativa'}</small></th><td>{r.modality}<small>{r.plan}</small></td><td>{r.commissionBps/100}% / {r.officeBps/100}%</td><td>{r.parcels.length}</td><td>{r.startsOn}<small>até {r.endsOn||'nova condição'}</small></td><td><button onClick={()=>setRule({...structuredClone(r),id:uid(),name:r.name+' · nova versão',commission:String(r.commissionBps/100),office:String(r.officeBps/100),startsOn:businessDate(),active:true})}>Nova versão</button>{r.active&&<button disabled={saving} onClick={()=>run(()=>commit(s=>({...s,rules:s.rules.map(v=>v.id===r.id?{...v,active:false}:v)}),'Inativação de regra'),'Regra inativada. Histórico preservado.')}>Inativar</button>}</td></tr>)}</Table>{!state.rules.length&&<Empty>Nenhuma regra cadastrada. Vendas sem regra ficam pendentes.</Empty>}
    </Panel>
  </>;
}
