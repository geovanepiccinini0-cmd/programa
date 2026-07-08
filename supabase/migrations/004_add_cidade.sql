-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem esta coluna direto pelo supabase/schema.sql).

alter table public.leads add column if not exists cidade text;
