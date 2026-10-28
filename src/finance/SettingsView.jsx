import { useState } from 'react';
import { deleteCommissionRule } from './rules.js';
import { categoryOptions } from './categories.js';
import { uid, businessDate, ruleFromCreditRates, ruleToCreditForm, CONSORTIUM_PLANS, canonicalPlan, samePlan } from './model.js';
import { Field, Panel, Table, Empty } from './ui.jsx';

const emptyRule=(administratorId='')=>({id:uid(),name:'',administratorId,modality:'Imóveis',plan:'Parcela integral',office:'0',startsOn:businessDate(),endsOn:'',conditions:'',parcels:[{offset:0,creditRate:''}],calendar:{mode:'manual'},active:true});
export default function SettingsView({state,commit,run,saving}) {
  const [name,setName]=useState(''),[rule,setRule]=useState(null),[selectedAdmin,setSelectedAdmin]=useState('');
  const field=(key,value)=>setRule(r=>({...r,[key]:value}));
  const categories=categoryOptions([...state.rules.filter(r=>r.administratorId===rule?.administratorId).map(r=>r.modality),rule?.modality]);
  const totalRate=rule?.parcels.reduce((n,p)=>n+(Number(p.creditRate)||0),0)||0;
  const visibleRules=state.rules.filter(r=>!selectedAdmin||r.administratorId===selectedAdmin);
  const saveAdmin=e=>{e.preventDefault();run(async()=>{
    if(!name.trim())throw new Error('Informe a administradora.');
    if(state.administrators.some(a=>a.name.toLowerCase()===name.trim().toLowerCase()))throw new Error('Administradora já cadastrada.');
    await commit(s=>({...s,administrators:[...s.administrators,{id:uid(),name:name.trim(),active:true}]}),'Cadastro de administradora');setName('');
  },'Administradora cadastrada.');};
  const saveRule=e=>{e.preventDefault();run(async()=>{
    const next=ruleFromCreditRates(rule,state.administrators);
    if(!state.administrators.some(a=>a.id===next.administratorId&&a.active))throw new Error('Selecione uma administradora ativa.');
    delete next.commission;delete next.office;
    const overlap=state.rules.some(r=>r.active&&r.administratorId===next.administratorId&&r.modality===next.modality&&samePlan(r.plan,next.plan)&&r.startsOn<=(next.endsOn||'9999-12-31')&&(r.endsOn||'9999-12-31')>=next.startsOn);
    if(overlap)throw new Error('Já existe uma regra ativa com vigência sobreposta. Inative a anterior ou ajuste as datas. As vendas antigas preservam sua regra.');
    await commit(s=>({...s,rules:[...s.rules,next]}),'Nova versão de comissionamento');setRule(null);
  },'Regra cadastrada.');};
  const removeRule=r=>{
    if(!window.confirm(`Excluir a regra “${r.name}”? Ela sairá do cadastro. Vendas confirmadas, parcelas e recebimentos serão preservados. Vendas pendentes precisarão de outra regra.`))return;
    run(async()=>{await commit(s=>deleteCommissionRule(s,r.id),'Exclusão de regra de comissão');setRule(null);},'Regra excluída. Histórico das vendas preservado.');
  };
  return <>
    <div className="fin-title"><div><span className="eyebrow">Base de comissionamento</span><h1>Configurações</h1><p>Administradora → categoria do consórcio → plano → comissão e recebimento.</p></div><button className="btn-primary" onClick={()=>setRule(emptyRule(selectedAdmin))}>+ Nova regra</button></div>
    <div className="fin-callout">Informe os percentuais sobre o crédito: 0,30% + 0,15% + 0,15% + 0,20% + 0,20% = 1,00% de comissão total. O nome da regra é gerado automaticamente. Vendas confirmadas preservam suas condições.</div>
    <Panel title="Administradoras" note="Inativar impede novas vendas com a regra; o histórico permanece.">
      <form onSubmit={saveAdmin} className="fin-toolbar"><Field label="Nome da administradora" value={name} onChange={e=>setName(e.target.value)} required/><button className="btn-primary" disabled={saving}>Cadastrar</button></form>
      <Table headers={['Administradora','Situação','Ação']}>{state.administrators.map(a=><tr key={a.id}><th scope="row">{a.name}</th><td>{a.active?'Ativa':'Inativa'}</td><td><button onClick={()=>{setSelectedAdmin(a.id);setRule(null);}}>Categorias e planos</button> <button disabled={saving} onClick={()=>run(()=>commit(s=>({...s,administrators:s.administrators.map(v=>v.id===a.id?{...v,active:!v.active}:v)}),'Situação da administradora'),'Cadastro atualizado.')}>{a.active?'Inativar':'Ativar'}</button></td></tr>)}</Table>{!state.administrators.length&&<Empty>Cadastre a primeira administradora.</Empty>}
    </Panel>
    {rule&&<Panel title="Regra de comissão e recebimento" note="Informe a comissão de cada parcela sobre o crédito contratado. A identificação é automática; você não precisa preencher nome ou versão." actions={<button onClick={()=>setRule(null)}>Fechar</button>}>
      <form onSubmit={saveRule}><fieldset disabled={saving} className="fin-fieldset"><div className="fin-form">
        <Field label="Descrição adicional (opcional)" value={rule.name} onChange={e=>field('name',e.target.value)} placeholder="Ex.: campanha especial"/>
        <Field label="Administradora"><select value={rule.administratorId} onChange={e=>field('administratorId',e.target.value)} required><option value="">Selecione</option>{state.administrators.filter(a=>a.active).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Categoria do consórcio"><select value={rule.modality} onChange={e=>field('modality',e.target.value)} required><option value="">Selecione</option>{categories.map(v=><option key={v} value={v}>{v}</option>)}</select></Field>
        <Field label="Plano de venda"><select value={rule.plan} onChange={e=>field('plan',e.target.value)}>{[...new Set([...CONSORTIUM_PLANS,rule.plan])].map(v=><option key={v}>{v}</option>)}</select></Field>
        <Field label="Comissão total sobre crédito (%)"><input readOnly value={totalRate.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}/></Field>
        <Field label="Repasse escritório sobre comissão (%)" type="number" min="0" max="100" step="0.01" value={rule.office} onChange={e=>field('office',e.target.value)} required/>
        <Field label="Vigência inicial" type="date" value={rule.startsOn} onChange={e=>field('startsOn',e.target.value)} required/>
        <Field label="Vigência final (opcional)" type="date" value={rule.endsOn} onChange={e=>field('endsOn',e.target.value)}/>
        <Field label="Condições de liberação e estorno"><textarea value={rule.conditions} onChange={e=>field('conditions',e.target.value)} rows="3" placeholder="Descreva as condições contratuais. A conferência da liberação é manual."/></Field>
      </div><h3>Regra de assembleia e vencimento</h3><div className="fin-form"><Field label="Calendário de recebimento"><select value={rule.calendar.mode} onChange={e=>field('calendar',e.target.value==='assembly'?{mode:'assembly',cutoffDay:10,firstMonthOffset:1,receiptDay:null}:{mode:'manual'})}><option value="manual">Intervalos fixos a partir do primeiro recebimento</option><option value="assembly">Corte por vencimento do grupo; após o corte pula um mês</option></select></Field>{rule.calendar.mode==='assembly'&&<Field label="Dia de vencimento / corte do grupo" type="number" min="1" max="31" value={rule.calendar.cutoffDay} onChange={e=>field('calendar',{...rule.calendar,cutoffDay:Number(e.target.value)})} required/>}{rule.calendar.mode==='assembly'&&<><Field label="Primeiro recebimento: meses após a venda" type="number" min="0" max="12" value={rule.calendar.firstMonthOffset??1} onChange={e=>field('calendar',{...rule.calendar,firstMonthOffset:Number(e.target.value)})} required/><Field label="Dia de pagamento da comissão (opcional)" type="number" min="1" max="31" value={rule.calendar.receiptDay??''} onChange={e=>field('calendar',{...rule.calendar,receiptDay:e.target.value===''?null:Number(e.target.value)})}/></>}</div>
      {rule.calendar.mode==='assembly'&&<div className="fin-callout">Até o dia {rule.calendar.cutoffDay}, inclusive: calendário normal. Depois do corte: mantém a primeira comissão e acrescenta um mês ao calendário a partir da segunda. Para primeiro recebimento um mês após a venda e corte dia 10, a venda de 20/10 projeta novembro → janeiro → fevereiro. O dia do pagamento da comissão é separado do vencimento do grupo; se não cadastrado aqui, será confirmado na venda.</div>}
      <h3>Parcelas da comissão</h3><p className="fin-note">Mês 0 é o primeiro recebimento. Para parcelas mensais, use 0, 1, 2, 3… O intervalo adicional após o corte é aplicado automaticamente.</p>
      {rule.parcels.map((p,i)=><div className="fin-parcel-row" key={i}><span>Parcela {i+1}</span><Field label="Meses após o primeiro recebimento" type="number" min="0" max="120" value={p.offset} onChange={e=>field('parcels',rule.parcels.map((v,j)=>i===j?{...v,offset:Number(e.target.value)}:v))}/><Field label="Comissão desta parcela sobre o crédito (%)" type="number" min="0.01" max="100" step="0.01" value={p.creditRate} onChange={e=>field('parcels',rule.parcels.map((v,j)=>i===j?{...v,creditRate:e.target.value}:v))} required/><button type="button" disabled={rule.parcels.length===1} onClick={()=>field('parcels',rule.parcels.filter((_,j)=>j!==i))}>Remover</button></div>)}
      <div className="fin-actions"><button type="button" onClick={()=>field('parcels',[...rule.parcels,{offset:Math.max(...rule.parcels.map(p=>p.offset))+1,creditRate:''}])} disabled={rule.parcels.length>=60}>+ Parcela</button><strong>Total: {totalRate.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}% do crédito</strong><button className="btn-primary" type="submit">Salvar regra</button></div>
      </fieldset></form>
    </Panel>}
    <Panel title={selectedAdmin?`Categorias e planos · ${state.administrators.find(a=>a.id===selectedAdmin)?.name}`:"Regras por administradora, categoria e plano"} note="Você pode excluir uma regra cadastrada por engano. Vendas confirmadas preservam suas condições, parcelas e recebimentos." actions={selectedAdmin&&<button onClick={()=>setSelectedAdmin('')}>Ver todas</button>}>
      <Table headers={['Regra / administradora','Modalidade / plano','Comissão / repasse','Parcelas','Vigência','Ações']}>{visibleRules.map(r=><tr key={r.id}><th scope="row">{r.name}<small>{state.administrators.find(a=>a.id===r.administratorId)?.name}</small><small>{r.active?'Ativa':'Inativa'}</small></th><td>{r.modality}<small>{canonicalPlan(r.plan)}</small></td><td>{r.commissionBps/100}% / {r.officeBps/100}%</td><td>{r.parcels.length}</td><td>{r.startsOn}<small>até {r.endsOn||'nova condição'}</small></td><td><button onClick={()=>setRule({...ruleToCreditForm(r),startsOn:businessDate()})}>Cadastrar nova condição</button>{r.active&&<button disabled={saving} onClick={()=>run(()=>commit(s=>({...s,rules:s.rules.map(v=>v.id===r.id?{...v,active:false}:v)}),'Inativação de regra'),'Regra inativada. Histórico preservado.')}>Inativar</button>} <button disabled={saving} onClick={()=>removeRule(r)}>Excluir regra</button></td></tr>)}</Table>{!visibleRules.length&&<Empty>Nenhuma regra cadastrada. Vendas sem regra ficam pendentes.</Empty>}
    </Panel>
  </>;
}
