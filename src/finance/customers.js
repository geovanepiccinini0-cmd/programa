import { businessDate, uid, netPaid, validDate } from './model.js';
export const CANCELLATION_REASONS=['Análise de crédito','Documentação','Fiador / garantia','Troca de cota','Condição financeira','Desistência do cliente','Cancelamento por engano','Outro'];
export function customerPortfolio(state,leads=[]){
 const records=structuredClone(state.customers||[]),assigned=new Set(records.flatMap(c=>c.saleIds||[]));
 for(const sale of state.sales.filter(s=>s.status==='confirmed'||s.confirmedAt||(s.source==='lead'&&s.status==='draft'&&leads.some(l=>l.id===s.leadId&&l.etapa==='Ganho')))){
  if(assigned.has(sale.id))continue;
  const id=`customer-${sale.leadId||sale.id}`;
  let c=records.find(c=>c.id===id);const lead=leads.find(l=>l.id===sale.leadId);
  if(!c){c={id,saleIds:[],name:lead?.nome||sale.name,phone:lead?.telefone||'',email:'',city:lead?.cidade||'',origin:lead?.canal||sale.channel||'',birth:'',cpf:'',interests:'',notes:'',nextContact:'',contracts:{}};records.push(c);}
  c.saleIds.push(sale.id);assigned.add(sale.id);
 }
 return records;
}
export function saveCustomer(state,input,leads=[]){
 if(!input.name?.trim())throw new Error('Informe o nome do cliente.');
 if(input.birth&&(!validDate(input.birth)||input.birth>businessDate()))throw new Error('Confira a data de nascimento.');
 return {...state,customers:customerPortfolio(state,leads).map(c=>c.id===input.id?structuredClone(input):c)};
}
export function restoreSale(state,id,{mode,note}){
 const sale=state.sales.find(s=>s.id===id);
 if(!sale||sale.status!=='cancelled')throw new Error('A venda não está cancelada. Recarregue os dados.');
 if(!note?.trim()||!['same','review'].includes(mode))throw new Error('Informe como a venda foi recuperada.');
 if(netPaid(state,id)!==0)throw new Error('Concilie os recebimentos antes de restaurar.');
 if(mode==='same'&&(!sale.confirmedAt||!sale.installments?.length))throw new Error('Esta venda precisa de revisão antes de ser confirmada.');
 if(mode==='review'&&state.receipts.some(r=>r.saleId===id))throw new Error('Há movimentos históricos nesta venda. Preserve as condições ou registre uma nova negociação.');
 const event={id:uid(),saleId:id,type:'restored',date:new Date().toISOString(),note:note.trim(),mode,previousReason:sale.cancelReason||'',previousCancelledAt:sale.cancelledAt||''};
 const previous=(state.saleEvents||[]);
 const missingCancellation=sale.cancelledAt&&!previous.some(e=>e.saleId===id&&e.type==='cancelled'&&e.date===sale.cancelledAt)?[{id:uid(),saleId:id,type:'cancelled',date:sale.cancelledAt,note:sale.cancelReason||'',category:'Histórico'}]:[];
 return {...state,saleEvents:[...previous,...missingCancellation,event],sales:state.sales.map(s=>{if(s.id!==id)return s;const next={...s,status:mode==='same'?'confirmed':'draft'};delete next.cancelReason;delete next.cancelledAt;if(mode==='review')next.installments=[];return next;})};
}
export function saleTimeline(state,sale){
 const events=(state.saleEvents||[]).filter(e=>e.saleId===sale.id);
 if(sale.cancelledAt&&!events.some(e=>e.type==='cancelled'&&e.date===sale.cancelledAt))events.push({id:`legacy-${sale.id}`,type:'cancelled',date:sale.cancelledAt,note:sale.cancelReason});
 return events.sort((a,b)=>a.date.localeCompare(b.date));
}

export function linkCustomer(state,sourceId,targetId,leads=[]){
 const records=customerPortfolio(state,leads),source=records.find(c=>c.id===sourceId),target=records.find(c=>c.id===targetId);
 if(!source||!target||sourceId===targetId)throw new Error('Escolha outra ficha válida.');
 const merged={...target,saleIds:[...new Set([...target.saleIds,...source.saleIds])],contracts:{...source.contracts,...target.contracts}};
 for(const key of ['cpf','birth','phone','email','city','notes','interests','nextContact'])if(!merged[key]&&source[key])merged[key]=source[key];
 return {...state,customers:records.filter(c=>c.id!==sourceId).map(c=>c.id===targetId?merged:c)};
}
