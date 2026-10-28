import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { emptyWorkspace, confirmSale, ruleFromCreditRates } from './model.js';
let db;
const admin='00000000-0000-0000-0000-000000000001',seller='00000000-0000-0000-0000-000000000002';
const migration=readFileSync(new URL('../../supabase/migrations/20261028105435_commercial_finance_workspace.sql',import.meta.url),'utf8');
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create function public.is_admin() returns boolean language sql stable as $$ select auth.uid()='${admin}'::uuid $$;
    create table public.leads(id uuid primary key,user_id uuid,nome text,produto text,canal text,etapa text,credito numeric,valor numeric,won_at timestamptz,deleted_at timestamptz);
    grant select,insert,update on public.leads to authenticated;`);
  await db.exec(migration);
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
});
