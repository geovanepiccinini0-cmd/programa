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
-- intocada em qualquer evento automático.
--
-- Correção pós-revisão do PR #70 (achado CONFIRMED: `last_read_at`
-- nunca deve ser definido pelo relógio do NAVEGADOR — divergência de
-- horário do cliente, mensagens/respostas atrasadas em voo e duas
-- abas/dispositivos do mesmo atendente concorrendo poderiam gravar um
-- timestamp incorreto ou, pior, um valor mais ANTIGO sobrescrevendo
-- uma leitura mais recente já persistida). Escrita exclusivamente via
-- `mark_whatsapp_conversation_read()` (seção C abaixo), que usa
-- SEMPRE `now()` do SERVIDOR — nunca um timestamp vindo do cliente —
-- e nunca regride `last_read_at` (guarda WHERE no ON CONFLICT, mesmo
-- princípio já usado para `last_event_at` na 024). Nenhum caminho do
-- cliente escreve esta coluna por UPDATE/upsert direto.
-------------------------------------------------------------------
alter table public.whatsapp_conversation_state
  add column if not exists last_read_at timestamptz;

comment on column public.whatsapp_conversation_state.last_read_at is
  'Fase 3.6.3 — timestamp em que o ATENDENTE efetivamente visualizou esta conversa (nunca a Meta). Mensagens inbound com occurred_at > last_read_at (ou last_read_at IS NULL) contam como não lidas, ver whatsapp_unread_counts(). Escrita exclusivamente via mark_whatsapp_conversation_read() (seção C), sempre com now() do SERVIDOR — nunca por UPDATE direto do cliente, nunca com timestamp vindo do navegador. Nunca confundir com whatsapp_messages.read_at (leitura da Meta sobre mensagem outbound) nem com whatsapp_conversation_state.status (estado operacional da Fase 3.6.2) — eixos independentes.';

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

-------------------------------------------------------------------
-- C) mark_whatsapp_conversation_read() — único caminho de escrita de
-- `last_read_at`. Correção pós-revisão do PR #70 (achado CONFIRMED):
-- usa SEMPRE now() do SERVIDOR (nunca um timestamp recebido do
-- cliente/navegador, que pode estar com o relógio divergente). A
-- cláusula WHERE do ON CONFLICT é a mesma guarda já usada para
-- `last_event_at` na 024: uma chamada ATRASADA (ex. duas abas do
-- mesmo atendente, ou uma requisição que ficou em voo por retry de
-- rede) nunca REGRIDE `last_read_at` — só avança. Quando a guarda
-- impede a atualização (porque um `last_read_at` mais recente já foi
-- persistido por outra chamada), o INSERT...ON CONFLICT DO UPDATE não
-- afeta nenhuma linha e portanto não há linha para o RETURNING — a
-- função devolve 0 linhas (nunca um erro), e o cliente trata isso
-- como "nada a fazer, o servidor já está mais atualizado" (ver
-- db.js:markRead), nunca como falha.
--
-- SEGURANÇA: security invoker — roda com os privilégios de quem
-- chama; o INSERT/UPDATE em si só é aceito pela RLS da 024 (dono do
-- lead). Mesma proteção de sempre: RLS das tabelas subjacentes é a
-- fronteira real, nunca esta função.
-------------------------------------------------------------------
create or replace function public.mark_whatsapp_conversation_read(p_lead_id uuid)
returns timestamptz
language sql
security invoker
set search_path = public, pg_temp
as $$
  insert into public.whatsapp_conversation_state as wcs (lead_id, last_read_at)
  values (p_lead_id, now())
  on conflict (lead_id) do update
    set last_read_at = excluded.last_read_at
  where wcs.last_read_at is null or excluded.last_read_at >= wcs.last_read_at
  returning wcs.last_read_at;
$$;

comment on function public.mark_whatsapp_conversation_read(uuid) is
  'Fase 3.6.3 — marca a conversa do lead informado como lida AGORA (now() do servidor, nunca do cliente). Nunca regride last_read_at (guarda no ON CONFLICT, mesmo princípio de last_event_at na 024) — uma chamada atrasada que perdeu a corrida para uma leitura mais recente simplesmente não afeta nenhuma linha (0 linhas devolvidas, nunca um erro). Nunca toca status/last_event_at (coluna fora do INSERT/SET desta função). security invoker — RLS da 024 decide quem pode inserir/atualizar.';

revoke all on function public.mark_whatsapp_conversation_read(uuid) from public;
revoke all on function public.mark_whatsapp_conversation_read(uuid) from anon;
grant execute on function public.mark_whatsapp_conversation_read(uuid) to authenticated;

-- Rollback deste bloco: "drop function if exists public.mark_whatsapp_conversation_read(uuid);"
