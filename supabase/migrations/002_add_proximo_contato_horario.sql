-- Rode este arquivo no SQL Editor do seu projeto Supabase (o projeto que
-- já existia antes desta atualização — instalações novas já recebem esta
-- coluna direto pelo supabase/schema.sql).

alter table public.leads add column if not exists proximo_contato_horario text;
