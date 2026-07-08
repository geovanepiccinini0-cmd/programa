-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Permite que o administrador edite e mude a etapa dos leads de qualquer
-- vendedor (além de já poder ler tudo). A exclusão continua restrita ao
-- dono do lead — o admin não pode apagar leads de outra pessoa.

drop policy if exists "leads: admin pode editar tudo" on public.leads;
create policy "leads: admin pode editar tudo" on public.leads
  for update using (public.is_admin()) with check (public.is_admin());
