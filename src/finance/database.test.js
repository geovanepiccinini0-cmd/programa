import { customerPortfolio, saveCustomer, restoreSale } from './customers.js';
import { historicalRuleConfirmation } from './historicalSales.js';
import { deleteCommissionRule } from './rules.js';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { emptyWorkspace, confirmSale, ruleFromCreditRates, cancelSale } from './model.js';
let db;
const admin='00000000-0000-0000-0000-000000000001',seller='00000000-0000-0000-0000-000000000002';
const migration=readFileSync(new URL('../../supabase/migrations/20261028105435_commercial_finance_workspace.sql',import.meta.url),'utf8');
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create function public.is_admin() returns boolean language sql stable as $$ select auth.uid()='${admin}'::uuid $$;
    create table public.leads(id uuid primary key,user_id uuid,nome text,produto text,canal text,etapa text,credito numeric,valor numeric,entrada numeric,parcela numeric,won_at timestamptz,deleted_at timestamptz);
    grant select,insert,update on public.leads to authenticated;`);
  await db.exec(migration);
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261028144445_lead_sale_values.sql',import.meta.url),'utf8'));
},30000);
afterAll(async()=>{await db?.close();});
async function as(user){await db.exec(`reset role;select set_config('request.jwt.claim.sub','${user}',false);set role authenticated;`);}
describe('Persistência PostgreSQL isolada — sem produção',()=>{
  it('esconde dados financeiros do vendedor e bloqueia RPC',async()=>{await as(seller);expect((await db.query('select * from public.crm_finance_workspace')).rows).toHaveLength(0);await expect(db.query('select public.crm_save_finance_workspace(0,$1,$2)',[emptyWorkspace(),'Teste'])).rejects.toThrow('restrito');});
  it('permite admin ler, mas não atualizar tabela sem o RPC auditado',async()=>{await as(admin);expect((await db.query('select * from public.crm_finance_workspace')).rows).toHaveLength(1);await expect(db.query("update public.crm_finance_workspace set data='{}'::jsonb")).rejects.toThrow('permission');});
  it('salva com revisão, registra auditoria e rejeita sessão desatualizada',async()=>{await as(admin);await db.query('select public.crm_save_finance_workspace(0,$1,$2)',[emptyWorkspace(),'Saldo inicial']);expect((await db.query('select revision from public.crm_finance_workspace')).rows[0].revision).toBe(1);expect((await db.query('select action from public.crm_finance_history')).rows[0].action).toBe('Saldo inicial');await expect(db.query('select public.crm_save_finance_workspace(0,$1,$2)',[emptyWorkspace(),'Sessão velha'])).rejects.toThrow('outra sessão');});
  it('cria uma única ficha na mesma transação do ganho sem dar acesso financeiro ao vendedor',async()=>{await as(seller);await db.query("insert into public.leads(id,user_id,nome,produto,etapa,credito) values('10000000-0000-0000-0000-000000000001',$1,'Fictício','Consórcio','Ganho',500000)",[seller]);await db.exec("update public.leads set etapa='Ganho';");expect((await db.query('select * from public.crm_finance_workspace')).rows).toHaveLength(0);await as(admin);const row=(await db.query('select data,revision from public.crm_finance_workspace')).rows[0];expect(row.data.sales).toHaveLength(1);expect(row.data.sales[0].status).toBe('draft');expect(row.data.sales[0].soldAt).toBe('');expect(row.data.sales[0].credit).toBe(50000000);expect(row.revision).toBe(2);});
  it('não permite apagar a ficha ou inserir centavos fracionários',async()=>{await as(admin);const record=(await db.query('select * from public.crm_finance_workspace')).rows[0];await expect(db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,emptyWorkspace(),'Apagar'])).rejects.toThrow('Não apague');const next=structuredClone(record.data);next.receipts.push({id:'r',amount:0.5});await expect(db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,next,'Inválido'])).rejects.toThrow('inválido');});
  it('confere os cálculos e impede recebimento acima da parcela no servidor',async()=>{await as(admin);const record=(await db.query('select * from public.crm_finance_workspace')).rows[0];const next=structuredClone(record.data);next.sales.push(confirmSale({id:'sale-test',name:'Teste financeiro',product:'Carta Contemplada',credit:30000000,soldAt:'2026-01-01',firstDue:'2026-01-10',saleValue:9000000,costValue:7000000,officePercent:50},next));await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,next,'Confirmar']);const invalid=structuredClone(next);invalid.receipts.push({id:'r2',saleId:'sale-test',installmentId:'sale-test-0',amount:1000001,date:'2026-01-10',type:'receipt'});await expect(db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision+1,invalid,'A mais'])).rejects.toThrow('supera');const badMath=structuredClone(next);badMath.sales[1].gross=1;await expect(db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision+1,badMath,'Não concilia'])).rejects.toThrow('concilia');});
  it('persiste regra por percentual de crédito e calendário de assembleia usando o contrato atual do banco',async()=>{
    await as(admin);const record=(await db.query('select * from public.crm_finance_workspace')).rows[0],next=structuredClone(record.data);
    next.administrators.push({id:'admin-rule',name:'Exemplo',active:true});
    const rule=ruleFromCreditRates({id:'credit-rule',name:'',administratorId:'admin-rule',modality:'Imobiliário',plan:'Parcela reduzida 70%',office:'0',startsOn:'2026-01-01',active:true,calendar:{mode:'assembly',cutoffDay:10,receiptDay:15},parcels:['0.30','0.15','0.15','0.20','0.20'].map((creditRate,offset)=>({creditRate,offset}))},next.administrators);
    next.rules.push(rule);next.sales.push(confirmSale({id:'credit-sale',name:'Exemplo',product:'Consórcio',administratorId:'admin-rule',modality:rule.modality,plan:rule.plan,ruleId:rule.id,credit:50000000,soldAt:'2026-10-20',firstDue:''},next));
    await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,next,'Regra por assembleia']);
    const saved=(await db.query("select data from public.crm_finance_workspace")).rows[0].data.sales.find(s=>s.id==='credit-sale');expect(saved.installments[1].due).toBe('2027-01-15');expect(saved.installments[0].amount).toBe(150000);expect(saved.gross).toBe(500000);
  });
  it('exclui uma regra pelo RPC auditado preservando a venda confirmada e seu calendário',async()=>{
    await as(admin);const record=(await db.query('select * from public.crm_finance_workspace')).rows[0];
    const before=record.data.sales.find(s=>s.id==='credit-sale');
    const next=deleteCommissionRule(record.data,'credit-rule');
    await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,next,'Exclusão de regra de comissão']);
    const saved=(await db.query('select data from public.crm_finance_workspace')).rows[0].data;
    expect(saved.rules.some(r=>r.id==='credit-rule')).toBe(false);
    expect(saved.sales.find(s=>s.id==='credit-sale')).toEqual(before);
    const audit=(await db.query('select previous_data,next_data from public.crm_finance_history order by revision desc limit 1')).rows[0];
    expect(audit.previous_data.rules.some(r=>r.id==='credit-rule')).toBe(true);
    expect(audit.next_data.rules.some(r=>r.id==='credit-rule')).toBe(false);
  });

  it('captura entrada e parcela do lead ganho sem gerar recebimentos nem inferir custo',async()=>{
    await as(seller);
    await db.query("insert into public.leads(id,user_id,nome,produto,etapa,credito,entrada,parcela,won_at) values('10000000-0000-0000-0000-000000000003',$1,'Contemplada fictícia','Carta Contemplada','Negociação',300000,90000.25,1800.50,'2026-10-28T14:00:00Z')",[seller]);
    await db.exec("update public.leads set etapa='Ganho' where id='10000000-0000-0000-0000-000000000003';");
    await as(admin);const row=(await db.query('select data,revision from public.crm_finance_workspace')).rows[0];
    const sale=row.data.sales.find(s=>s.leadId==='10000000-0000-0000-0000-000000000003');
    expect(sale).toMatchObject({credit:30000000,saleValue:9000025,quotaInstallment:180050,status:'draft',installments:[]});
    expect(sale.costValue).toBeUndefined();expect(row.data.receipts).toEqual([]);
    const next=structuredClone(row.data);
    next.sales=next.sales.map(s=>s.id===sale.id?confirmSale({...s,costValue:7000000,supplier:'Parceiro fictício',firstDue:'2026-10-28'},next):s);
    await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[row.revision,next,'Custo e parceiro']);
    const before=(await db.query('select data from public.crm_finance_workspace')).rows[0].data;
    expect(before.sales.find(s=>s.id===sale.id)).toMatchObject({supplier:'Parceiro fictício',gross:2000025,quotaInstallment:180050});
    await as(seller);await db.exec("update public.leads set entrada=95000,etapa='Ganho' where id='10000000-0000-0000-0000-000000000003';");
    await as(admin);const after=(await db.query('select data from public.crm_finance_workspace')).rows[0].data;
    expect(after).toEqual(before);
  });

  it('persiste venda histórica confirmada sem alterar vigência da regra ou gerar caixa',async()=>{
    await as(admin);const record=(await db.query('select * from public.crm_finance_workspace')).rows[0],next=structuredClone(record.data);
    const rule=ruleFromCreditRates({id:'historical-rule',name:'Histórica',administratorId:'admin-rule',modality:'Imóveis',plan:'Parcela integral',office:'0',startsOn:'2026-10-28',active:true,parcels:[{offset:0,creditRate:'1'}]},next.administrators);
    next.rules.push(rule);
    next.sales.push(confirmSale({id:'historical-sale',name:'Exemplo histórico',product:'Consórcio',administratorId:'admin-rule',modality:rule.modality,plan:rule.plan,ruleId:rule.id,credit:30000000,soldAt:'2026-08-05',firstDue:'2026-09-15',historicalRuleConfirmation:historicalRuleConfirmation(rule,'2026-08-05')},next));
    await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,next,'Cadastro de venda histórica']);
    const saved=(await db.query('select data from public.crm_finance_workspace')).rows[0].data;
    expect(saved.sales.find(s=>s.id==='historical-sale')).toMatchObject({status:'confirmed',soldAt:'2026-08-05',historicalRuleConfirmation:{confirmed:true},ruleSnapshot:{startsOn:'2026-10-28'}});
    expect(saved.rules.find(r=>r.id===rule.id).startsOn).toBe('2026-10-28');
    expect(saved.receipts).toEqual(record.data.receipts);
  });

  it('persiste carteira e restauração pelo RPC auditado sem reescrever condições ou recebimentos',async()=>{
    await as(admin);const record=(await db.query('select * from public.crm_finance_workspace')).rows[0];
    const customer=customerPortfolio(record.data).find(c=>c.saleIds.includes('sale-test'));
    customer.cpf='00000000000';customer.contracts={'sale-test':{group:'001',quota:'002',contract:'TESTE'}};
    let next=saveCustomer(record.data,customer);next=cancelSale(next,'sale-test','Documentação pendente','Documentação');
    await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision,next,'Cancelar e completar ficha']);
    next=restoreSale(next,'sale-test',{mode:'same',note:'Documentos regularizados'});
    await db.query('select public.crm_save_finance_workspace($1,$2,$3)',[record.revision+1,next,'Recuperação de venda']);
    const saved=(await db.query('select data from public.crm_finance_workspace')).rows[0].data;
    expect(saved.sales.find(s=>s.id==='sale-test')).toEqual(record.data.sales.find(s=>s.id==='sale-test'));
    expect(saved.receipts).toEqual(record.data.receipts);
    expect(saved.customers.find(c=>c.id===customer.id).contracts['sale-test'].quota).toBe('002');
    expect(saved.saleEvents.slice(-2).map(e=>e.type)).toEqual(['cancelled','restored']);
  });

});
