-- NOT APPLIED TO PRODUCTION. Shared administrator workspace with optimistic
-- concurrency, atomic lead->sale synchronization and an immutable audit trail.
-- JSONB is an intentionally small-CRM aggregate; individual cash events remain
-- append-only. Revision conflicts must be reloaded, never automatically retried.
create schema if not exists crm_finance_private;
revoke all on schema crm_finance_private from public, anon;
grant usage on schema crm_finance_private to authenticated;

create table public.crm_finance_workspace (
  id boolean primary key default true check (id),
  revision bigint not null default 0,
  data jsonb not null default '{"schema":1,"administrators":[],"rules":[],"sales":[],"receipts":[],"expenses":[],"pockets":[],"transfers":[],"budgets":[],"opening":null}'::jsonb,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(data) = 'object' and data->>'schema' = '1')
);
create table public.crm_finance_history (
  id bigint generated always as identity primary key,
  revision bigint not null unique,
  actor uuid,
  action text not null,
  previous_data jsonb not null,
  next_data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.crm_finance_workspace enable row level security;
alter table public.crm_finance_history enable row level security;
revoke all on public.crm_finance_workspace, public.crm_finance_history from anon, authenticated;
grant select on public.crm_finance_workspace, public.crm_finance_history to authenticated;
create policy finance_admin_read on public.crm_finance_workspace for select to authenticated using ((select public.is_admin()));
create policy finance_history_admin_read on public.crm_finance_history for select to authenticated using ((select public.is_admin()));
insert into public.crm_finance_workspace (id) values (true);

create function crm_finance_private.validate_document(doc jsonb) returns void
language plpgsql set search_path = '' as $$
declare k text; item jsonb; s jsonb; p jsonb; r jsonb; base_receipt jsonb; paid numeric; gross numeric; own_value numeric; office_value numeric;
begin
  if jsonb_typeof(doc) <> 'object' or doc->>'schema' is distinct from '1' or pg_column_size(doc) > 10000000 then raise exception 'Documento financeiro inválido'; end if;
  foreach k in array array['administrators','rules','sales','receipts','expenses','pockets','transfers','budgets'] loop
    if jsonb_typeof(doc->k) is distinct from 'array' then raise exception 'Coleção financeira inválida: %', k; end if;
    if exists(select 1 from jsonb_array_elements(doc->k) v group by v->>'id' having count(*)>1) then raise exception 'IDs duplicados: %',k; end if;
    if exists(select 1 from jsonb_array_elements(doc->k) v where coalesce(v->>'id','')='') then raise exception 'ID ausente: %',k; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(doc->'sales') v where v->>'leadId' is not null group by v->>'leadId' having count(*)>1) then raise exception 'Venda duplicada para o lead'; end if;
  foreach k in array array['receipts','expenses','transfers'] loop
    for item in select * from jsonb_array_elements(doc->k) loop
      if coalesce(item->>'amount','') !~ '^[0-9]+$' or (item->>'amount')::numeric > 1000000000000 or (item->>'amount')::numeric <= 0 then raise exception 'Valor financeiro inválido'; end if;
    end loop;
  end loop;
  for s in select * from jsonb_array_elements(doc->'sales') loop
    if s->>'status' not in ('draft','confirmed','cancelled') then raise exception 'Situação de venda inválida'; end if;
    if s->>'status' in ('confirmed','cancelled') and s ? 'gross' then
      if coalesce(s->>'gross','') !~ '^[0-9]+$' or coalesce(s->>'own','') !~ '^[0-9]+$' or coalesce(s->>'office','') !~ '^[0-9]+$' then raise exception 'Comissão inválida'; end if;
      gross=(s->>'gross')::numeric; own_value=(s->>'own')::numeric; office_value=(s->>'office')::numeric;
      if own_value+office_value<>gross then raise exception 'Divisão da comissão não concilia'; end if;
      if s->>'product'='Carta Contemplada' then
        if coalesce(s->>'saleValue','') !~ '^[0-9]+$' or coalesce(s->>'costValue','') !~ '^[0-9]+$' or coalesce(s->>'officePercent','') not in ('50','60') then raise exception 'Condições de contemplada inválidas'; end if;
        if gross<>(s->>'saleValue')::numeric-(s->>'costValue')::numeric or office_value<>round(gross*(s->>'officePercent')::numeric/100) then raise exception 'Cálculo de contemplada não concilia'; end if;
      elsif s->>'product'='Consórcio' then
        if s->'ruleSnapshot' is null or jsonb_typeof(s->'ruleSnapshot')<>'object' then raise exception 'Regra histórica ausente'; end if;
        if gross<>round((s->>'credit')::numeric*(s->'ruleSnapshot'->>'commissionBps')::numeric/10000) or office_value<>round(gross*(s->'ruleSnapshot'->>'officeBps')::numeric/10000) then raise exception 'Cálculo de consórcio não concilia'; end if;
      end if;
      if jsonb_typeof(s->'installments') is distinct from 'array' or coalesce((select sum((v->>'amount')::numeric) from jsonb_array_elements(s->'installments') v),-1)<>own_value then raise exception 'Parcelas não conciliam com a comissão própria'; end if;
      for p in select * from jsonb_array_elements(s->'installments') loop
        if coalesce(p->>'amount','') !~ '^[0-9]+$' or coalesce(p->>'due','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Parcela inválida'; end if;
        perform (p->>'due')::date;
        select coalesce(sum(case when v->>'type'='refund' then -(v->>'amount')::numeric else (v->>'amount')::numeric end),0) into paid from jsonb_array_elements(doc->'receipts') v where v->>'saleId'=s->>'id' and v->>'installmentId'=p->>'id';
        if paid<0 or paid>(p->>'amount')::numeric then raise exception 'Recebimento supera saldo da parcela'; end if;
        if s->>'status'='cancelled' and paid<>0 then raise exception 'Devolva recebimentos antes de cancelar'; end if;
      end loop;
    end if;
  end loop;
  for r in select * from jsonb_array_elements(doc->'receipts') loop
    if coalesce(r->>'type','') not in ('receipt','refund') or coalesce(r->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Movimento inválido'; end if;
    if (r->>'date')::date>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Recebimento futuro não é realizado'; end if;
    if not exists(select 1 from jsonb_array_elements(doc->'sales') sale cross join lateral jsonb_array_elements(sale->'installments') parcel where sale->>'id'=r->>'saleId' and parcel->>'id'=r->>'installmentId') then raise exception 'Recebimento sem parcela válida'; end if;
    if r->>'type'='refund' then
      select v into base_receipt from jsonb_array_elements(doc->'receipts') v where v->>'id'=r->>'receiptId' and v->>'type'='receipt' and v->>'saleId'=r->>'saleId' and v->>'installmentId'=r->>'installmentId';
      if base_receipt is null or r->>'date'<base_receipt->>'date' then raise exception 'Devolução sem recebimento de origem'; end if;
      if (select sum((v->>'amount')::numeric) from jsonb_array_elements(doc->'receipts') v where v->>'receiptId'=r->>'receiptId')>(base_receipt->>'amount')::numeric then raise exception 'Devolução supera recebimento'; end if;
    end if;
  end loop;
  for item in select * from jsonb_array_elements(doc->'transfers') loop
    if item->>'type' not in ('in','out') or not exists(select 1 from jsonb_array_elements(doc->'pockets') p where p->>'id'=item->>'pocketId') then raise exception 'Destinação inválida'; end if;
  end loop;
end $$;
revoke all on function crm_finance_private.validate_document(jsonb) from public, anon, authenticated;

create function crm_finance_private.save_workspace(expected_revision bigint, payload jsonb, action_label text)
returns public.crm_finance_workspace language plpgsql security definer set search_path = '' as $$
declare current_row public.crm_finance_workspace; result public.crm_finance_workspace; k text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Acesso financeiro restrito ao administrador' using errcode='42501'; end if;
  select * into current_row from public.crm_finance_workspace where id=true for update;
  if current_row.revision <> expected_revision then raise exception 'Dados alterados em outra sessão. Recarregue antes de salvar.' using errcode='40001'; end if;
  perform crm_finance_private.validate_document(payload);
  -- Existing receipts, refunds and pocket transfers cannot be erased or rewritten.
  foreach k in array array['receipts','transfers'] loop
    if exists(select 1 from jsonb_array_elements(current_row.data->k) old_item where not exists(select 1 from jsonb_array_elements(payload->k) new_item where old_item=new_item)) then raise exception 'Movimentos financeiros são imutáveis; use uma compensação'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(current_row.data->'sales') old_item where not exists(select 1 from jsonb_array_elements(payload->'sales') new_item where old_item->>'id'=new_item->>'id')) then raise exception 'Não apague vendas; use cancelamento'; end if;
  if exists(select 1 from jsonb_array_elements(current_row.data->'expenses') old_item where not exists(select 1 from jsonb_array_elements(payload->'expenses') new_item where old_item->>'id'=new_item->>'id' and (old_item=new_item or (old_item->>'paidAt' is null and old_item-'paidAt'=new_item-'paidAt')))) then raise exception 'Despesa preservada: registre apenas o pagamento'; end if;
  if exists(select 1 from jsonb_array_elements(current_row.data->'sales') old_item where exists(select 1 from jsonb_array_elements(current_row.data->'receipts') r where r->>'saleId'=old_item->>'id') and not exists(select 1 from jsonb_array_elements(payload->'sales') new_item where old_item->>'id'=new_item->>'id' and old_item-array['status','cancelReason','cancelledAt']=new_item-array['status','cancelReason','cancelledAt'])) then raise exception 'Condições históricas da venda são imutáveis após movimentos'; end if;
  if current_row.data->'opening'<>'null'::jsonb and (jsonb_array_length(current_row.data->'receipts')>0 or jsonb_array_length(current_row.data->'transfers')>0) and current_row.data->'opening' is distinct from payload->'opening' then raise exception 'Saldo inicial preservado após movimentos'; end if;
  update public.crm_finance_workspace set data=payload, revision=revision+1, updated_at=now() where id=true returning * into result;
  insert into public.crm_finance_history(revision,actor,action,previous_data,next_data) values(result.revision,auth.uid(),left(coalesce(action_label,'Atualização financeira'),180),current_row.data,payload);
  return result;
end $$;
revoke all on function crm_finance_private.save_workspace(bigint,jsonb,text) from public, anon;
grant execute on function crm_finance_private.save_workspace(bigint,jsonb,text) to authenticated;
create function public.crm_save_finance_workspace(expected_revision bigint,payload jsonb,action_label text)
returns public.crm_finance_workspace language sql security invoker set search_path = '' as $$
  select crm_finance_private.save_workspace(expected_revision,payload,action_label);
$$;
revoke all on function public.crm_save_finance_workspace(bigint,jsonb,text) from public, anon;
grant execute on function public.crm_save_finance_workspace(bigint,jsonb,text) to authenticated;

-- Internal trigger is SECURITY DEFINER solely because a non-admin seller must
-- create a pending sale without gaining access to financial data. No callable
-- public privileged function or user-supplied JSON enters this path.
create function crm_finance_private.capture_won_lead() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_row public.crm_finance_workspace; payload jsonb; sale jsonb; next_revision bigint;
begin
  if new.etapa <> 'Ganho' or new.deleted_at is not null then return new; end if;
  select * into current_row from public.crm_finance_workspace where id=true for update;
  if exists(select 1 from jsonb_array_elements(current_row.data->'sales') v where v->>'leadId'=new.id::text) then return new; end if;
  sale=jsonb_build_object('id','lead-'||new.id::text,'leadId',new.id::text,'name',new.nome,'product',new.produto,'channel',coalesce(nullif(new.canal,''),'Não informado'),'ownerId',new.user_id,'credit',round(coalesce(new.credito,new.valor,0)*100),'soldAt',case when new.won_at is null then '' else to_char(new.won_at at time zone 'America/Sao_Paulo','YYYY-MM-DD') end,'status','draft','officePercent',50,'installments','[]'::jsonb,'source','lead');
  payload=jsonb_set(current_row.data,'{sales}',current_row.data->'sales'||jsonb_build_array(sale));
  update public.crm_finance_workspace set data=payload,revision=revision+1,updated_at=now() where id=true returning revision into next_revision;
  insert into public.crm_finance_history(revision,actor,action,previous_data,next_data) values(next_revision,auth.uid(),'Lead ganho: ficha pendente automática',current_row.data,payload);
  return new;
end $$;
revoke all on function crm_finance_private.capture_won_lead() from public, anon, authenticated;
create trigger crm_finance_won_lead after insert or update of etapa on public.leads for each row execute function crm_finance_private.capture_won_lead();
-- Historical wins become pending records only. No financial values/dates invented.
do $$ declare l public.leads; begin
  for l in select * from public.leads where etapa='Ganho' and deleted_at is null loop
    update public.leads set etapa=etapa where id=l.id;
  end loop;
end $$;
