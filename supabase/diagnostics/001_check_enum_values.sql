-- Fase 1.12 da V2 — diagnóstico ANTES de aplicar CHECK constraints.
--
-- Isto NÃO é uma migration: não altera nada, só lê. Rode no SQL Editor
-- do Supabase e me mande o resultado (ou cole aqui na conversa) — a
-- partir disso eu crio a migration de CHECK constraints para produto,
-- etapa, canal e categoria, só incluindo os valores que realmente
-- existem na sua base (evitando quebrar um registro com valor
-- inesperado).
--
-- As listas "esperadas" abaixo vêm de src/constants.js (V1):
--   produto:   Consórcio, Carta Contemplada, Home Equity, Financiamento, Imóvel
--   etapa:     Novo Lead, Ligação, Qualificação, Atendimento, Proposta,
--              Negociação, Follow-up 1, Follow-up 2, Follow-up 3, Ganho, Perdido
--   categoria (tasks.categoria): Follow-up, Conteúdo, Agenda/Ligação, Operacional

select 'leads.produto' as campo, produto as valor, count(*) as qtd
from public.leads
group by produto
order by qtd desc;

select 'leads.etapa' as campo, etapa as valor, count(*) as qtd
from public.leads
group by etapa
order by qtd desc;

select 'leads.canal' as campo, canal as valor, count(*) as qtd
from public.leads
group by canal
order by qtd desc;

select 'tasks.categoria' as campo, categoria as valor, count(*) as qtd
from public.tasks
group by categoria
order by qtd desc;

select 'tasks.origem' as campo, origem as valor, count(*) as qtd
from public.tasks
group by origem
order by qtd desc;

-- Tags são um array livre por design (não vão virar CHECK constraint,
-- só é útil para ver se há "lixo" nelas):
select 'leads.tags (valores distintos)' as campo, unnest(tags) as valor, count(*) as qtd
from public.leads
group by valor
order by qtd desc;
