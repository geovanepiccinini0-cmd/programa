-- Carry negotiated lead values into NEW pending sales only.
-- Existing financial records, manual prices and receipts remain untouched.
create or replace function crm_finance_private.capture_won_lead() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_row public.crm_finance_workspace; payload jsonb; sale jsonb; next_revision bigint;
begin
  if new.etapa <> 'Ganho' or new.deleted_at is not null then return new; end if;
  select * into current_row from public.crm_finance_workspace where id=true for update;
  if exists(select 1 from jsonb_array_elements(current_row.data->'sales') v where v->>'leadId'=new.id::text) then return new; end if;
  sale=jsonb_build_object('id','lead-'||new.id::text,'leadId',new.id::text,'name',new.nome,'product',new.produto,'channel',coalesce(nullif(new.canal,''),'Não informado'),'ownerId',new.user_id,'credit',round(coalesce(new.credito,new.valor,0)*100),'soldAt',case when new.won_at is null then '' else to_char(new.won_at at time zone 'America/Sao_Paulo','YYYY-MM-DD') end,'status','draft','officePercent',50,'installments','[]'::jsonb,'source','lead');
  if new.produto='Carta Contemplada' then
    sale=sale||jsonb_build_object('saleValue',round(new.entrada*100),'quotaInstallment',round(new.parcela*100));
  end if;
  payload=jsonb_set(current_row.data,'{sales}',current_row.data->'sales'||jsonb_build_array(sale));
  update public.crm_finance_workspace set data=payload,revision=revision+1,updated_at=now() where id=true returning revision into next_revision;
  insert into public.crm_finance_history(revision,actor,action,previous_data,next_data) values(next_revision,auth.uid(),'Lead ganho: ficha pendente automática',current_row.data,payload);
  return new;
end $$;
revoke all on function crm_finance_private.capture_won_lead() from public, anon, authenticated;
