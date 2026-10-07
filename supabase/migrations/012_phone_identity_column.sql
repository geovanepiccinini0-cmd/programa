-- Fase 3.1.3.1 — Pure Phone Identity Foundation (schema aditivo).
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- 100% aditivo: só adiciona uma coluna nullable em public.leads, sem
-- default, sem backfill, sem index, sem trigger. Nenhum dado existente
-- é alterado ou lido para isso. Rollback: "alter table public.leads
-- drop column if exists phone_normalized;".

alter table public.leads
  add column if not exists phone_normalized text;

alter table public.leads
  add constraint leads_phone_normalized_digits_check
    check (phone_normalized is null or phone_normalized ~ '^[0-9]+$');

comment on column public.leads.phone_normalized is
  'Fase 3.1 — identidade de telefone normalizada para fins de resolução de lead (Click-to-WhatsApp e futuras integrações). Formato canônico: dígitos puros, com DDI, sem "+" (ex. 5551992322166) — o mesmo formato já produzido por src/lib/phoneIdentity.js (normalizePhoneIdentity). O banco NÃO reimplementa nenhuma regra de normalização: o CHECK acima só garante "só dígitos ou NULL", nunca valida DDD/Brasil/comprimento/ramal — essa semântica pertence exclusivamente ao módulo canônico em JS. NULL significa "identidade não calculada ou não resolvível" (telefone ausente, INVALID ou AMBIGUOUS pela regra canônica), nunca "zero". Esta coluna ainda NÃO é a fonte de verdade operacional nesta etapa (3.1.3.1): nenhum writer da aplicação a preenche ainda, nenhum backfill foi executado, e nenhuma unique constraint existe sobre ela — ver docs da Fase 3.1.3.0 (transition state) antes de tratá-la como autoritativa.';
