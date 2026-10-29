import { useState } from 'react';
import SaleRecovery from './SaleRecovery.jsx';
import { canConfirmHistoricalRule, historicalRuleConfirmation, hasHistoricalRuleConfirmation } from './historicalSales.js';
import { fillSaleFromLead } from './leadSale.js';
import { categoryOptions as consortiumCategories } from './categories.js';
import { uid, cents, money, dateLabel, businessDate, monthOf, confirmSale, cancelSale, exportCSV, samePlan, canonicalPlan, CONSORTIUM_PLANS, ruleFirstDue, consortiumSchedule, validDate } from './model.js';
import { Field, Amount, Panel, Table, Empty, Status, Kpis } from './ui.jsx';

const blankSale=()=>({id:uid(),name:'',product:'Carta Contemplada',channel:'Não informado',soldAt:businessDate(),firstDue:'',credit:'',saleValue:'',costValue:'',officePercent:50,administratorId:'',modality:'Imóveis',plan:'Parcela integral',ruleId:'',status:'draft',installments:[]});
const toForm=s=>({...s,credit:s.credit==null||s.credit===''?'':s.credit/100,saleValue:s.saleValue==null||s.saleValue===''?'':s.saleValue/100,costValue:s.costValue==null||s.costValue===''?'':s.costValue/100,firstDue:s.firstDue || ''});
export default function SalesView({state,commit,run,saving,month,setMonth,leads=[]}) {
  const [editing,setEditing]=useState(null),[query,setQuery]=useState(''),[scope,setScope]=useState('all'),[report,setReport]=useState(false);
  const all=state.sales.filter(s=>s.name.toLowerCase().includes(query.toLowerCase()) && (scope==='all'||s.status===scope));
  const closed=state.sales.filter(s=>s.status==='confirmed'&&monthOf(s.soldAt)===month);
  const contemplated=closed.filter(s=>s.product==='Carta Contemplada');
  const sum=(rows,key)=>rows.reduce((n,s)=>n+(s[key]||0),0);
  const field=(key,value)=>setEditing(s=>{
    const next={...s,[key]:value};
    if(['soldAt','ruleId'].includes(key))delete next.historicalRuleConfirmation;
    if(next.product==='Consórcio'&&['soldAt','ruleId','firstDue'].includes(key))next.firstDue=ruleFirstDue(state.rules.find(r=>r.id===next.ruleId),next.soldAt,next.firstDue);
    return next;
  });
  const adminRules=state.rules.filter(r=>r.active&&r.administratorId===editing?.administratorId);
  const categoryOptions=consortiumCategories([...adminRules.map(r=>r.modality),editing?.modality]);
  const planOptions=[...new Set([...adminRules.filter(r=>r.modality===editing?.modality).map(r=>canonicalPlan(r.plan)),...CONSORTIUM_PLANS,canonicalPlan(editing?.plan)].filter(Boolean))];
  const rules=adminRules.filter(r=>r.modality===editing?.modality&&samePlan(r.plan,editing?.plan));
  const selectedRule=editing?.product==='Consórcio'&&state.rules.find(r=>r.id===editing.ruleId);
  const historicalRule=selectedRule&&canConfirmHistoricalRule(selectedRule,editing.soldAt,businessDate());
  const projectedFirst=selectedRule?ruleFirstDue(selectedRule,editing.soldAt,editing.firstDue):editing?.firstDue;
  let calendarPreview=[];
  if(selectedRule&&validDate(projectedFirst)&&validDate(editing?.soldAt)){try{calendarPreview=consortiumSchedule(selectedRule,editing.soldAt,projectedFirst);}catch{/* Validation appears when confirming. */}}
  const customer=editing&&(state.customers||[]).find(c=>c.saleIds?.includes(editing.id));
  const references=customer?.contracts?.[editing?.id];
  const locked=editing&&(editing.status==='cancelled'||state.receipts.some(r=>r.saleId===editing.id));
  async function save(event,status) {
    event.preventDefault();
    await run(async()=>{
      const input={...editing,credit:editing.credit===''&&status==='draft'?null:cents(editing.credit),officePercent:Number(editing.officePercent),saleValue:editing.saleValue===''?null:cents(editing.saleValue),costValue:editing.costValue===''?null:cents(editing.costValue)};
      if(!input.name.trim())throw new Error('Informe o cliente.');
      await commit(s=>{
        const previous=s.sales.find(v=>v.id===input.id);
        if(previous?.status==='confirmed'&&status==='draft')throw new Error('Venda confirmada não pode voltar a rascunho.');
        const next=status==='confirmed'?confirmSale(input,s):{...input,status:'draft',installments:[]};
        return {...s,sales:previous?s.sales.map(v=>v.id===next.id?next:v):[...s.sales,next]};
      },status==='confirmed'?'Confirmação de venda e calendário':'Dados da venda');
      setEditing(null);
    },'Venda salva.');
  }
  const download=()=>exportCSV([['Demonstrativo comercial — fechamentos',month],['Cliente','Produto','Data','Canal','Crédito','Venda da cota','Custo da cota','Parceiro de origem da cota','Comissão total','Escritório','Geovane'],...closed.map(s=>[s.name,s.product,s.soldAt,s.channel,money(s.credit),s.product==='Carta Contemplada'?money(s.saleValue):'',s.product==='Carta Contemplada'?money(s.costValue):'',s.product==='Carta Contemplada'?(s.supplier||''):'',money(s.gross),money(s.office),money(s.own)])],`vendas-${month}.csv`);
  return <>
    <div className="fin-title"><div><span className="eyebrow">Produção comercial</span><h1>Vendas</h1><p>Do fechamento à comissão, com cada condição registrada.</p></div><button className="btn-primary" onClick={()=>setEditing(toForm(blankSale()))}>+ Registrar venda</button></div>
    <Kpis items={[["Vendas no mês",closed.length,'Por data de fechamento'],['Consórcio novo',money(sum(closed.filter(s=>s.product==='Consórcio'),'credit')),'Volume de crédito contratado'],['Sua comissão gerada',money(sum(closed,'own')),'Recebimentos ficam no Financeiro'],['Aguardando informações',state.sales.filter(s=>s.status==='draft').length,'Não entram na comissão confirmada']]}/>
    <div className="fin-toolbar"><Field label="Mês de fechamento"><input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></Field><button onClick={()=>setReport(!report)} aria-pressed={report}>Demonstrativo do escritório</button><button onClick={download}>Exportar vendas CSV</button></div>
    {report&&<Panel title="Demonstrativo mensal · Contempladas" note="Divisão comercial antes de despesas próprias. Repasse apurado não significa repasse pago.">
      <Table headers={['Cliente / fechamento','Venda da cota','Custo','Comissão','Escritório / você','Escritório','Geovane']} foot={<tr><th>Total</th><td>{money(sum(contemplated,'saleValue'))}</td><td>{money(sum(contemplated,'costValue'))}</td><td>{money(sum(contemplated,'gross'))}</td><td>Por venda</td><td>{money(sum(contemplated,'office'))}</td><td>{money(sum(contemplated,'own'))}</td></tr>}>
        {contemplated.map(s=><tr key={s.id}><th scope="row">{s.name}<small>{dateLabel(s.soldAt)}</small>{s.supplier&&<small>Parceiro: {s.supplier}</small>}</th><td>{money(s.saleValue)}</td><td>{money(s.costValue)}</td><td>{money(s.gross)}</td><td>{s.officePercent}% / {100-s.officePercent}%</td><td>{money(s.office)}</td><td>{money(s.own)}</td></tr>)}
      </Table>{!contemplated.length&&<Empty/>}
    </Panel>}
    {editing&&<Panel title={locked?'Condições históricas da venda':'Condições da venda'} note={locked?'Existem movimentos financeiros. Condições preservadas; devoluções e cancelamentos ficam no Financeiro.':editing.product==='Carta Contemplada'?'O valor de venda é a entrada informada no lead. Confira os dados, preencha o custo e identifique o parceiro. A parcela do consórcio é apenas informativa.':'Crédito, valor comercial e sua remuneração são informações distintas.'} actions={<button onClick={()=>setEditing(null)}>Fechar</button>}>
      <form onSubmit={e=>save(e,'confirmed')}><fieldset disabled={saving||locked} className="fin-fieldset"><div className="fin-form">
        <Field label="Cliente" value={editing.name} onChange={e=>field('name',e.target.value)} required/>
        <Field label="Produto"><select value={editing.product} onChange={e=>field('product',e.target.value)}><option>Carta Contemplada</option><option>Consórcio</option>{!['Consórcio','Carta Contemplada'].includes(editing.product)&&<option>{editing.product}</option>}</select></Field>
        <Field label="Canal de origem" value={editing.channel} onChange={e=>field('channel',e.target.value)} required/>
        <Amount label="Crédito contratado (R$)" value={editing.credit} onChange={v=>field('credit',v)} required/>
        <Field label="Data de fechamento" type="date" value={editing.soldAt} onChange={e=>field('soldAt',e.target.value)} required/>
        <Field label="Primeiro recebimento previsto" type="date" value={projectedFirst||''} onChange={e=>field('firstDue',e.target.value)} readOnly={!!selectedRule?.calendar?.receiptDay} required/>
        <Field label="Referência de contrato / cota" value={editing.contract||''} onChange={e=>field('contract',e.target.value)}/>
        {editing.product==='Carta Contemplada'?<>
          <Amount label="Valor de venda da cota / entrada (R$)" value={editing.saleValue} onChange={v=>field('saleValue',v)} required/>
          <Field label="Parcela do consórcio (informativa)" value={editing.quotaInstallment==null?'Não informada':money(editing.quotaInstallment)} readOnly/>
          <Field label="Parceiro de origem da cota (opcional)" value={editing.supplier||''} onChange={e=>field('supplier',e.target.value)} placeholder="Nome do parceiro ou fornecedor"/>
          <Amount label="Valor de custo da cota (R$)" value={editing.costValue} onChange={v=>field('costValue',v)} required/>
          <Field label="Divisão da comissão"><select value={editing.officePercent} onChange={e=>field('officePercent',Number(e.target.value))}><option value={50}>50% escritório / 50% Geovane</option><option value={60}>60% escritório / 40% Geovane</option></select></Field>
        </>:<>
          <Field label="Administradora"><select value={editing.administratorId||''} onChange={e=>setEditing(s=>({...s,administratorId:e.target.value,ruleId:''}))} required><option value="">Selecione</option>{state.administrators.filter(a=>a.active).map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></Field>
          <Field label="Categoria do consórcio"><select value={editing.modality||''} onChange={e=>setEditing(s=>({...s,modality:e.target.value,ruleId:''}))} required><option value="">Selecione</option>{categoryOptions.map(v=><option key={v}>{v}</option>)}</select></Field>
          <Field label="Plano"><select value={canonicalPlan(editing.plan)||''} onChange={e=>setEditing(s=>({...s,plan:e.target.value,ruleId:''}))} required><option value="">Selecione</option>{planOptions.map(v=><option key={v}>{v}</option>)}</select></Field>
          <Field label="Regra de comissionamento"><select value={editing.ruleId||''} onChange={e=>field('ruleId',e.target.value)} required><option value="">Selecione a regra vigente</option>{rules.map(r=><option value={r.id} key={r.id}>{r.name} · {r.commissionBps/100}% · desde {dateLabel(r.startsOn)}</option>)}</select></Field>
        </>}
        <Field label="Observações"><textarea value={editing.notes||''} onChange={e=>field('notes',e.target.value)} rows="2"/></Field>
      </div>
      {historicalRule&&<div className="fin-callout"><p>Venda histórica de {dateLabel(editing.soldAt)}. A regra selecionada começa em {dateLabel(selectedRule.startsOn)}. Confirme abaixo somente se ela corresponde às condições dessa venda.</p><label><input type="checkbox" checked={hasHistoricalRuleConfirmation(editing,selectedRule)} onChange={e=>field('historicalRuleConfirmation',e.target.checked?historicalRuleConfirmation(selectedRule,editing.soldAt):null)}/> Confirmo que estas condições de comissão também valiam na data desta venda.</label><p className="fin-note">As parcelas serão projetadas a partir da venda antiga. Recebimentos já realizados devem ser registrados separadamente no Financeiro.</p></div>}
      {selectedRule?.calendar?.mode==='assembly'&&<div className="fin-callout">Vencimento/corte do grupo: dia {selectedRule.calendar.cutoffDay}. {Number(editing.soldAt?.slice(8,10))>selectedRule.calendar.cutoffDay?'Venda após o corte: um mês de intervalo adicional a partir da segunda comissão.':'Venda até o corte: calendário normal.'} {!selectedRule.calendar.receiptDay&&'Confirme o dia previsto de pagamento da comissão; ele não é o vencimento do grupo.'}</div>}
      {calendarPreview.length>0&&<div className="fin-calculation"><span>Calendário projetado<strong style={{fontSize:14}}>{calendarPreview.map((p,i)=>`${i+1}ª: ${dateLabel(p.due)}`).join(' · ')}</strong></span></div>}
      {editing.product==='Carta Contemplada'&&<div className="fin-calculation"><span>Comissão total<strong>{editing.saleValue!==''&&editing.costValue!==''?money(Math.round((Number(editing.saleValue)-Number(editing.costValue))*100)):'Pendente'}</strong></span><span>Sua parte antes de despesas<strong>{editing.saleValue!==''&&editing.costValue!==''?money(Math.round((Number(editing.saleValue)-Number(editing.costValue))*100)-Math.round(Math.round((Number(editing.saleValue)-Number(editing.costValue))*100)*editing.officePercent/100)):'Pendente'}</strong></span></div>}
      <div className="fin-actions"><button className="btn-primary" type="submit">Confirmar venda e previsão</button>{editing.status!=='confirmed'&&<button type="button" onClick={e=>save(e,'draft')}>Salvar pendente</button>}</div></fieldset></form>
      {state.sales.some(s=>s.id===editing.id)&&<SaleRecovery key={editing.id} sale={state.sales.find(s=>s.id===editing.id)||editing} state={state} commit={commit} run={run} saving={saving} onChanged={()=>setEditing(null)}/>}
      {references&&<p className="fin-callout">Administradora: {references.administrator||'—'} · Grupo: {references.group||'—'} · Cota: {references.quota||'—'} · Contrato: {references.contract||editing.contract||'—'}{customer.cpf&&` · CPF: ${customer.cpf}`}</p>}
      {locked&&editing.ruleSnapshot&&<p className="fin-note">Regra preservada: {editing.ruleSnapshot.name} · {editing.ruleSnapshot.commissionBps/100}% · {editing.installments.length} parcelas.</p>}
    </Panel>}
    <Panel title="Seus negócios" note="Ganhos geram fichas pendentes automaticamente. Comissões só entram na projeção após confirmação.">
      <div className="fin-toolbar"><Field label="Buscar cliente" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Nome do cliente"/><Field label="Situação"><select value={scope} onChange={e=>setScope(e.target.value)}><option value="all">Todas</option><option value="draft">Pendentes</option><option value="confirmed">Confirmadas</option><option value="cancelled">Canceladas</option></select></Field></div>
      <Table headers={['Cliente / produto','Origem','Fechamento','Sua comissão','Situação','Ações']}>
        {all.map(s=><tr key={s.id}><th scope="row">{s.name}<small>{s.product}{s.contract?` · ${s.contract}`:''}</small>{s.leadId&&leads.some(l=>l.id===s.leadId&&l.etapa!=='Ganho')&&<small className="fin-warning">Lead reaberto: revisar venda</small>}</th><td>{s.channel}</td><td>{dateLabel(s.soldAt)}</td><td>{money(s.status==='confirmed'?s.own:null)}</td><td><Status value={s.status}/></td><td><button onClick={()=>setEditing(toForm(fillSaleFromLead(s,leads.find(l=>l.id===s.leadId))))}>Detalhes</button></td></tr>)}
      </Table>{!all.length&&<Empty/>}
    </Panel>
  </>;
}
