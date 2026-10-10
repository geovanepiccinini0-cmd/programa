-- Fase 3.6.3 — Controle de leitura humana e mensagens não lidas.
-- Migration ADITIVA — nunca edita 018-024 (histórico intocado).
-- ZERO execução em produção nesta fase.
--
-- DISTINÇÃO EXPLÍCITA (nunca confundida, requisito explícito desta
-- fase): `last_read_at` é quando o ATENDENTE efetivamente visualizou
-- a conversa — nunca `whatsapp_messages.read_at` (status de LEITURA
-- DA META sobre uma mensagem OUTBOUND, Fase 3.5.2.3). Eixos
-- totalmente independentes, nunca escritos pelo mesmo caminho. Esta
-- migration nunca lê nem escreve `whatsapp_messages.read_at`/
-- `delivered_at`/`sent_at`, e nunca altera `whatsapp_conversation_state.status`
-- (estado operacional da Fase 3.6.2) nem `leads.etapa`/tags.
--
-- Rollback: ver comentário de cada bloco.

-------------------------------------------------------------------
-- PRECONDIÇÕES
-------------------------------------------------------------------
do $$
begin
  if to_regclass('public.whatsapp_conversation_state') is null then
    raise exception 'Precondicao falhou: public.whatsapp_conversation_state (migration 024) nao existe';
  end if;
  if to_regclass('public.whatsapp_messages') is null then
    raise exception 'Precondicao falhou: public.whatsapp_messages (migration 018) nao existe';
  end if;
end $$;

-------------------------------------------------------------------
-- A) whatsapp_conversation_state.last_read_at — reaproveita a
-- tabela 1-linha-por-lead já criada na 024 (mesmo RLS, mesmo trigger
-- de consistência de user_id/lead_id, já corretos para esta coluna
-- nova — nenhuma alteração de RLS/trigger necessária). NUNCA
-- escrita pela RPC automática (apply_whatsapp_conversation_operational_event,
-- seção D da 024) — aquela função só define status/last_event_at no
-- seu INSERT/SET; last_read_at nunca aparece nela, permanecendo
-- intocada em qualquer evento automático. Escrita exclusivamente
-- pelo cliente autenticado (UPDATE direto via RLS, mesmo padrão já
-- usado para alteração manual de status — nunca uma RPC nova aqui).
-------------------------------------------------------------------
alter table public.whatsapp_conversation_state
  add column if not exists last_read_at timestamptz;

comment on column public.whatsapp_conversation_state.last_read_at is
  'Fase 3.6.3 — timestamp em que o ATENDENTE efetivamente visualizou esta conversa (nunca a Meta). Mensagens inbound com occurred_at > last_read_at (ou last_read_at IS NULL) contam como não lidas, ver whatsapp_unread_counts(). Escrita só por UPDATE direto do cliente autenticado (RLS da 024, nunca por RPC). Nunca confundir com whatsapp_messages.read_at (leitura da Meta sobre mensagem outbound) nem com whatsapp_conversation_state.status (estado operacional da Fase 3.6.2) — eixos independentes.';

-- Rollback deste bloco: "alter table public.whatsapp_conversation_state drop column if exists last_read_at;" (aditivo, sem dado histórico dependente fora desta própria coluna).

-------------------------------------------------------------------
-- B) whatsapp_unread_counts() — agregado de não lidas por conversa,
-- para o usuário AUTENTICADO chamador (nunca um parâmetro de
-- user_id aceito do cliente — sempre auth.uid() implícito via
-- security invoker + RLS das tabelas subjacentes). Chamada
-- DIRETAMENTE pelo frontend (mesmo padrão já usado para leitura de
-- `leads`/`whatsapp_messages` via RLS, sem Edge Function — a
-- diferença é que PostgREST não expõe agregação GROUP BY por tabela
-- simples, por isso uma função é necessária para evitar N consultas,
-- uma por conversa, do lado do cliente).
--
-- SEGURANÇA: security invoker (nunca definer) — a função roda com os
-- privilégios de quem chama; a RLS de whatsapp_messages e de
-- whatsapp_conversation_state decide, como sempre, quais linhas essa
-- pessoa pode ler. O filtro `l.user_id = auth.uid()` abaixo é só
-- defesa em profundidade/otimização de índice (mesmo princípio já
-- documentado em src/lib/db.js para as consultas existentes) — nunca
-- a fronteira real de segurança.
--
-- CONSISTÊNCIA (nunca um contador materializado/incrementado): o
-- valor é SEMPRE recalculado a partir dos dados reais no momento da
-- chamada — nunca um contador armazenado que poderia divergir sob
-- concorrência. Uma mensagem nova chegando e uma leitura acontecendo
-- "ao mesmo tempo" nunca corrompem nenhum estado: na pior hipótese,
-- uma mensagem que chegou no exato instante da leitura pode contar
-- como lida (mesma ambiguidade inerente de qualquer chat real) — mas
-- NUNCA há um contador que fique permanentemente errado, porque não
-- existe contador algum para divergir.
-------------------------------------------------------------------
create or replace function public.whatsapp_unread_counts()
returns table (lead_id uuid, unread_count bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select m.lead_id, count(*)::bigint as unread_count
  from public.whatsapp_messages m
  join public.leads l on l.id = m.lead_id
  left join public.whatsapp_conversation_state s on s.lead_id = m.lead_id
  where l.user_id = auth.uid()
    and m.direction = 'inbound'
    and (s.last_read_at is null or m.occurred_at > s.last_read_at)
  group by m.lead_id;
$$;

comment on function public.whatsapp_unread_counts() is
  'Fase 3.6.3 — conta mensagens INBOUND nao lidas por conversa (lead_id) do usuario autenticado chamador, comparando occurred_at com whatsapp_conversation_state.last_read_at. security invoker — RLS das tabelas subjacentes decide o que e visivel, nunca bypassed. NUNCA conta mensagens outbound (enviadas pelo proprio CRM). NUNCA toca leads.etapa/tags nem whatsapp_messages.read_at/delivered_at/sent_at.';

revoke all on function public.whatsapp_unread_counts() from public;
revoke all on function public.whatsapp_unread_counts() from anon;
grant execute on function public.whatsapp_unread_counts() to authenticated;

-- Rollback deste bloco: "drop function if exists public.whatsapp_unread_counts();"
