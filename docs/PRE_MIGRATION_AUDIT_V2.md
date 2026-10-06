# Auditoria Pré-Migration — Fase 1 da V2

> Documento **somente leitura/diagnóstico**. Nenhuma migration foi executada, nenhuma alteração foi feita no Supabase, nenhum código foi alterado além deste relatório. As 5 migrations analisadas aqui são exatamente as já commitadas no PR #36 (branch `claude/crm-piccinini-react-hdyr5d`) — nenhum SQL novo foi criado para esta auditoria.

## 1. As 5 migrations, na ordem exata de execução

| Ordem | Arquivo |
| --- | --- |
| 1 | `supabase/migrations/007_lead_interactions.sql` |
| 2 | `supabase/migrations/008_lead_fields_v2.sql` |
| 3 | `supabase/migrations/009_soft_delete_prep.sql` |
| 4 | `supabase/migrations/010_indexes_v2.sql` |
| 5 | `supabase/migrations/011_audit_log.sql` |

A ordem importa porque a 009 e a 010 assumem que a tabela `leads` já existe com as colunas da 008 (na prática não há dependência rígida entre elas — nenhuma referencia coluna criada por outra —, mas a ordem numérica é a testada e a recomendada).

---

## 2. Análise migration por migration

### 2.1 — `007_lead_interactions.sql`

- **Objetivo:** criar a timeline estruturada de interações do lead (notas, ligações, mudanças de etapa, etc.).
- **Tabelas afetadas:** `public.lead_interactions` (nova). Nenhuma tabela existente é alterada.
- **Colunas adicionadas:** nenhuma em tabela existente. A tabela nova tem: `id, user_id, lead_id, type, direction, channel, content, metadata, occurred_at, created_at, created_by`.
- **Índices adicionados:** `lead_interactions_lead_id_idx`, `lead_interactions_user_id_idx`, `lead_interactions_lead_id_occurred_at_idx` — todos na tabela nova.
- **Policies/RLS:** 3 policies novas, todas em `lead_interactions` (tabela nova): dono lê/cria as próprias, admin só lê tudo. **Nenhuma policy de `leads`, `tasks`, `templates` ou `profiles` é alterada ou removida.**
- **Triggers/functions:** nenhuma criada ou alterada. Usa a função `is_admin()` já existente (só leitura dela, não a modifica).
- **Impacto esperado em dados V1:** nenhum. É uma tabela nova e vazia.
- **Risco de perda de dados:** nenhum.
- **Rollback:** `drop table if exists public.lead_interactions;` (documentado no cabeçalho do arquivo).

### 2.2 — `008_lead_fields_v2.sql`

- **Objetivo:** adicionar os campos de qualificação/acompanhamento do lead (próxima ação, temperatura, prioridade, motivo de perda, datas de ganho/perda).
- **Tabelas afetadas:** `public.leads` (existente) — só `ALTER TABLE ... ADD COLUMN`.
- **Colunas adicionadas:** `next_action_type`, `next_action_note`, `lead_temperature`, `priority` (not null, **default `'normal'`**), `lost_reason`, `lost_reason_note`, `won_at`, `lost_at`. Todas novas; nenhuma coluna existente é tocada.
- **Índices adicionados:** nenhum (ficam na migration 010).
- **Policies/RLS:** nenhuma. Não cria, altera nem remove policy nenhuma.
- **Triggers/functions:** nenhuma.
- **Impacto esperado em dados V1:** todas as linhas existentes de `leads` passam a ter essas 8 colunas novas preenchidas com `NULL` (ou `'normal'` só em `priority`, por causa do default). **Nenhum valor das colunas existentes é lido, copiado ou alterado.**
- **Risco de perda de dados:** nenhum. É `ADD COLUMN`, nunca `DROP`/`ALTER ... TYPE`/renomeação.
- **Rollback:** `ALTER TABLE ... DROP COLUMN IF EXISTS` para as 8 colunas, exatamente como documentado no cabeçalho do arquivo.

### 2.3 — `009_soft_delete_prep.sql`

- **Objetivo:** preparar a estrutura para soft delete, **sem ativar** o comportamento.
- **Tabelas afetadas:** `public.leads` (existente) — só `ADD COLUMN`.
- **Colunas adicionadas:** `deleted_at timestamptz` (nullable, sem default).
- **Índices adicionados:** nenhum.
- **Policies/RLS:** nenhuma.
- **Triggers/functions:** nenhuma.
- **Impacto esperado em dados V1:** todas as linhas existentes recebem `deleted_at = NULL`. Nenhum lead é afetado na prática — **nenhum código da aplicação lê ou usa essa coluna ainda**, então ela não influencia em nada o comportamento atual (nenhum lead passa a "sumir" de lugar nenhum).
- **Risco de perda de dados:** nenhum.
- **Rollback:** `alter table public.leads drop column if exists deleted_at;`.

### 2.4 — `010_indexes_v2.sql`

- **Objetivo:** melhorar performance de consultas em `leads`/`tasks` para suportar crescimento da base.
- **Tabelas afetadas:** `public.leads` e `public.tasks` (existentes) — só `CREATE INDEX`, nenhuma estrutura de coluna é tocada.
- **Colunas adicionadas:** nenhuma.
- **Índices adicionados:** `leads_user_id_idx`, `leads_etapa_idx`, `leads_proximo_contato_idx`, `leads_user_id_etapa_idx`, `tasks_user_id_idx`, `tasks_lead_id_idx`, `tasks_data_idx`, `tasks_user_id_data_idx` (8 no total).
- **Policies/RLS:** nenhuma.
- **Triggers/functions:** nenhuma.
- **Impacto esperado em dados V1:** nenhum nos dados em si. Um índice novo pode levar alguns segundos/minutos para ser construído em tabelas grandes (não é o caso aqui, a base é pequena), mas **não bloqueia leitura durante a criação** no modo padrão do Postgres para tabelas deste tamanho, e não altera nenhum valor.
- **Risco de perda de dados:** nenhum.
- **Rollback:** `drop index if exists <nome>;` para qualquer um dos 8.

### 2.5 — `011_audit_log.sql`

- **Objetivo:** registrar alterações críticas (nesta fase, só mudança de etapa do lead).
- **Tabelas afetadas:** `public.audit_log` (nova). Nenhuma tabela existente é alterada.
- **Colunas adicionadas:** nenhuma em tabela existente. A tabela nova tem: `id, user_id, entity_type, entity_id, action, old_data, new_data, created_at`.
- **Índices adicionados:** `audit_log_entity_idx`, `audit_log_user_id_idx` — ambos na tabela nova.
- **Policies/RLS:** 3 policies novas, todas em `audit_log` (tabela nova): mesma regra de `lead_interactions`. **Nenhuma policy existente é alterada.**
- **Triggers/functions:** nenhuma criada ou alterada. Usa `is_admin()` já existente, só leitura.
- **Impacto esperado em dados V1:** nenhum. Tabela nova e vazia.
- **Risco de perda de dados:** nenhum.
- **Rollback:** `drop table if exists public.audit_log;`.

---

## 3. Varredura explícita por operações destrutivas

Busquei literalmente cada um dos padrões abaixo nos 5 arquivos. Resultado:

| Padrão | Encontrado em alguma das 5 migrations? |
| --- | --- |
| `DROP TABLE` | **Não** |
| `DROP COLUMN` | **Não** (só aparece dentro de comentários `--`, nas instruções de rollback — nunca em SQL executável) |
| `TRUNCATE` | **Não** |
| `DELETE` | **Não** |
| `UPDATE` em massa | **Não** |
| `ALTER COLUMN` destrutivo (mudança de tipo, remoção de default crítico) | **Não** |
| Mudança de tipo de coluna existente | **Não** |
| `NOT NULL` em coluna existente sem tratamento prévio | **Não** — o único `NOT NULL` novo é `priority`, que é uma **coluna nova** criada com `DEFAULT 'normal'` na mesma instrução, então toda linha existente é preenchida automaticamente, sem violar a constraint |
| Renomeação de coluna existente | **Não** |
| Alteração destrutiva de foreign key | **Não** — as únicas FKs novas são das 2 tabelas novas (`lead_interactions.lead_id → leads.id`, `lead_interactions.user_id/created_by → auth.users.id`, `audit_log.user_id → auth.users.id`), nenhuma FK existente é tocada |
| `CASCADE` potencialmente destrutivo | As únicas ocorrências de `on delete cascade` são nas FKs **novas** das tabelas **novas** (ex.: se um lead for excluído, as interações daquele lead são excluídas junto — comportamento desejado para uma tabela de histórico que não faz sentido existir sem o lead). **Nenhum `CASCADE` novo foi adicionado a uma FK já existente de `leads`/`tasks`/`templates`/`profiles`** |

**Conclusão da varredura: nenhuma operação destrutiva em nenhuma das 5 migrations.** Todas as instruções SQL executáveis são `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `COMMENT ON` e `ALTER PUBLICATION ... ADD TABLE`.

---

## 4. Confirmação campo a campo (dados V1 existentes)

Nenhuma das 5 migrations lê, copia, transforma ou remove qualquer valor das tabelas `leads`, `tasks`, `templates` ou `profiles`. Todas as instruções são `ADD COLUMN`/`CREATE TABLE`/`CREATE INDEX`/`CREATE POLICY` novas. Por isso, após as 5 migrations:

| Campo/entidade | Preservado? |
| --- | --- |
| Todos os leads existentes (linhas) | ✅ Sim — nenhuma linha é lida, movida ou apagada |
| nome | ✅ Sim — coluna não tocada |
| telefone | ✅ Sim — coluna não tocada, nenhum valor normalizado/alterado |
| cidade | ✅ Sim |
| canal | ✅ Sim |
| produto | ✅ Sim |
| etapa atual do funil | ✅ Sim |
| crédito | ✅ Sim |
| entrada | ✅ Sim |
| parcela | ✅ Sim |
| lance | ✅ Sim |
| valor | ✅ Sim |
| valor do imóvel | ✅ Sim |
| próximo contato | ✅ Sim |
| horário do próximo contato | ✅ Sim |
| notas | ✅ Sim |
| tags | ✅ Sim |
| data de criação (`criado_em`) | ✅ Sim |
| tarefas (`tasks`) | ✅ Sim — tabela não tocada por nenhuma das 5 migrations |
| tarefas concluídas (`concluida`) | ✅ Sim |
| agenda (tarefas `Agenda/Ligação`) | ✅ Sim — é só uma visão sobre `tasks`, tabela intacta |
| rotinas/templates | ✅ Sim — tabela `templates` não tocada por nenhuma das 5 |
| usuários (`auth.users`) | ✅ Sim — nenhuma migration toca `auth.users` além de referenciá-lo em novas FKs (leitura, não escrita) |
| permissões existentes (RLS de `leads`/`tasks`/`templates`/`profiles`) | ✅ Sim — nenhuma policy existente é criada, alterada ou removida; só policies novas nas 2 tabelas novas |

---

## 5. Análise do campo telefone

**Importante:** este ambiente de desenvolvimento **não tem acesso de rede ao seu projeto Supabase de produção** (bloqueio de rede do sandbox, válido durante toda esta conversa) — não consigo rodar nenhuma consulta nos seus dados reais. Os números abaixo (quantidade de leads, telefones preenchidos, duplicados, etc.) **não podem ser fornecidos por mim** sem inventá-los, o que eu não vou fazer.

Em vez disso, preparei as consultas abaixo — **somente leitura, não alteram nenhum telefone**, e retornam só contagens agregadas (nunca o nome ou o número completo de nenhum cliente). Rode no SQL Editor do Supabase e me envie os resultados (só os números) para eu completar esta seção:

```sql
-- quantidade total de leads
select count(*) as total_leads from public.leads;

-- com telefone preenchido / sem telefone
select
  count(*) filter (where telefone is not null and trim(telefone) <> '') as com_telefone,
  count(*) filter (where telefone is null or trim(telefone) = '') as sem_telefone
from public.leads;

-- duplicados após normalizar só para dígitos (não expõe os números, só a contagem)
select count(*) as grupos_duplicados, coalesce(sum(cnt), 0) as leads_envolvidos
from (
  select regexp_replace(telefone, '\D', '', 'g') as digitos, count(*) as cnt
  from public.leads
  where telefone is not null and trim(telefone) <> ''
  group by digitos
  having count(*) > 1
) dup;

-- números que parecem não ter DDD (menos de 10 dígitos — padrão BR é DDD(2) + número(8 ou 9))
select count(*) as sem_ddd_aparente
from public.leads
where telefone is not null and trim(telefone) <> ''
  and length(regexp_replace(telefone, '\D', '', 'g')) < 10;

-- números potencialmente inválidos (nem 10 nem 11 dígitos)
select count(*) as potencialmente_invalidos
from public.leads
where telefone is not null and trim(telefone) <> ''
  and length(regexp_replace(telefone, '\D', '', 'g')) not in (10, 11);

-- formato predominante (sem expor nenhum número — só se bate ou não com a máscara do app)
select
  count(*) filter (where telefone ~ '^\(\d{2}\) \d \d{4}-\d{4}$') as formato_padrao_app,
  count(*) filter (where telefone !~ '^\(\d{2}\) \d \d{4}-\d{4}$' and telefone is not null and trim(telefone) <> '') as formato_diferente
from public.leads;
```

Essas consultas são só `SELECT` — zero risco, não precisam de autorização especial para rodar (diferente das migrations).

---

## 6. Normalização futura para E.164 (WhatsApp) sem perder o valor original

**Sim, a estrutura permite.** A coluna `telefone` não é tocada por nenhuma das 5 migrations — continua exatamente como está, no formato livre que o app grava hoje (ex.: `(54) 9 9999-9999`). Duas formas de chegar a E.164 (`+55...`) no futuro, nenhuma delas modifica o valor original:

1. **Calcular em tempo real, sem gravar nada novo:** a aplicação (ou a futura Edge Function de WhatsApp) deriva o E.164 a partir de `telefone` só no momento de chamar a API do WhatsApp, usando a mesma lógica de normalização que o front já usa hoje para comparar telefones na busca (`replace(/\D/g, '')`) + prefixo `+55`. Risco: zero, nenhuma migration necessária.
2. **Gravar normalizado numa coluna nova, se precisar por performance:** uma migration futura e aditiva (`add column telefone_e164 text`) calculada a partir do `telefone` existente, mantendo o original intacto ao lado. O mesmo padrão já usado nesta fase (nunca sobrescrever, só adicionar).

Em ambos os casos, **o valor cadastrado pelo vendedor nunca é alterado ou perdido** — a normalização é sempre uma derivação, não uma substituição.

---

## 7. Sequência BANCO V1 → migrations V2 → FRONTEND V1 continua funcionando → merge do frontend V2

**Confirmado: essa sequência é segura.** Analisei especificamente se o frontend **atualmente em produção** (o código hoje em `main`, antes do PR #36) continua funcionando sem nenhuma alteração se as 5 migrations forem aplicadas primeiro:

- O frontend V1 atual, ao salvar um lead, envia só um conjunto fixo de campos nomeados (`nome`, `telefone`, `cidade`, `canal`, `produto`, `etapa`, `tipo`, `credito`, `entrada`, `parcela`, `lance`, `valor`, `valor_imovel`, `proximo_contato`, `proximo_contato_horario`, `notas`, `tags`, datas) — ele **não sabe que as 8 colunas novas existem** e nunca as envia.
- Colunas novas em `leads` são todas `NULL`-áveis, exceto `priority`, que tem `DEFAULT 'normal'`. Como o Postgres preenche automaticamente colunas omitidas num `INSERT`/`UPDATE` com seu default (ou `NULL`), **um insert/update do frontend V1 continua funcionando normalmente** mesmo depois das 8 colunas novas existirem — nenhuma dessas colunas é `NOT NULL` sem default.
- O frontend V1 lê leads com `select('*')`. Depois das migrations, essa consulta passa a trazer as colunas novas junto — mas o código V1 só lê os campos específicos que já conhecia (`r.nome`, `r.telefone`, etc.) e **ignora silenciosamente** qualquer coluna extra que não reconhece. Não há erro nem comportamento diferente.
- As tabelas novas (`lead_interactions`, `audit_log`) são invisíveis para o frontend V1 — ele nunca as consulta.
- Os índices novos só aceleram consultas, não mudam nenhum resultado.
- Nenhuma policy de RLS das tabelas que o frontend V1 usa (`leads`, `tasks`, `templates`, `profiles`) é alterada — login, leitura e escrita continuam exatamente com as mesmas permissões de hoje.
- A publicação de Realtime ganha uma tabela nova (`lead_interactions`), o que não afeta as assinaturas que o frontend V1 já tem para `leads`/`tasks`/`templates`.

**Conclusão: rodar as 5 migrations antes do merge do PR #36 não derruba nem muda o comportamento do frontend V1 atualmente em produção.** A V1 continua 100% funcional com o banco já na "forma" da V2, até vocês decidirem mesclar e publicar o frontend novo.

---

## 8. SQL exato das 5 migrations (reprodução para leitura — nada foi executado)

### 007_lead_interactions.sql
```sql
-- Fase 1.2/1.3 da V2 — Timeline de interações do lead.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em leads/tasks/templates
-- existentes. Rollback: "drop table if exists public.lead_interactions;"
-- (não há dado de outra tabela que dependa dela).

create table if not exists public.lead_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  type text not null,
  direction text,
  channel text,
  content text,
  metadata jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

comment on table public.lead_interactions is
  'Timeline estruturada de interações com o lead (Fase 1 da V2). Tipos previstos: note, call, follow_up, meeting, proposal, stage_change, system. Canais previstos: manual, phone, crm, whatsapp, instagram, email. Direction: inbound, outbound, internal. Nenhum desses valores tem CHECK constraint ainda (ver docs/CRM_V2_PHASE_01_REPORT.md).';

alter table public.lead_interactions enable row level security;

create policy "lead_interactions: dono pode ler e criar"
  on public.lead_interactions
  for select using (user_id = auth.uid());

create policy "lead_interactions: dono pode inserir"
  on public.lead_interactions
  for insert with check (user_id = auth.uid());

create policy "lead_interactions: admin pode ler tudo"
  on public.lead_interactions
  for select using (public.is_admin());

create index if not exists lead_interactions_lead_id_idx on public.lead_interactions (lead_id);
create index if not exists lead_interactions_user_id_idx on public.lead_interactions (user_id);
create index if not exists lead_interactions_lead_id_occurred_at_idx on public.lead_interactions (lead_id, occurred_at desc);

alter publication supabase_realtime add table public.lead_interactions;
```

### 008_lead_fields_v2.sql
```sql
-- Fase 1.6 a 1.10 da V2 — novos campos de qualificação/acompanhamento do lead.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- 100% aditivo: só adiciona colunas nullable (ou com default inofensivo)
-- em public.leads. Nenhum dado existente é alterado ou lido para isso.
-- Rollback (nessa ordem, se precisar remover tudo desta migration):
--   alter table public.leads
--     drop column if exists next_action_type,
--     drop column if exists next_action_note,
--     drop column if exists lead_temperature,
--     drop column if exists priority,
--     drop column if exists lost_reason,
--     drop column if exists lost_reason_note,
--     drop column if exists won_at,
--     drop column if exists lost_at;

alter table public.leads
  add column if not exists next_action_type text,
  add column if not exists next_action_note text,
  add column if not exists lead_temperature text,
  add column if not exists priority text not null default 'normal',
  add column if not exists lost_reason text,
  add column if not exists lost_reason_note text,
  add column if not exists won_at timestamptz,
  add column if not exists lost_at timestamptz;

comment on column public.leads.next_action_type is 'Fase 1 V2: tipo da próxima ação planejada (call, whatsapp, meeting, proposal, follow_up, other). Sem CHECK constraint ainda.';
comment on column public.leads.lead_temperature is 'Fase 1 V2: classificação manual (cold, warm, hot). Sem CHECK constraint ainda, sem scoring automático nesta fase.';
comment on column public.leads.priority is 'Fase 1 V2: prioridade manual (low, normal, high, urgent). Default normal.';
comment on column public.leads.lost_reason is 'Fase 1 V2: motivo de perda, preenchido quando etapa = Perdido. Não obrigatório.';
comment on column public.leads.won_at is 'Fase 1 V2: timestamp em que o lead entrou na etapa Ganho, mantido automaticamente pela aplicação.';
comment on column public.leads.lost_at is 'Fase 1 V2: timestamp em que o lead entrou na etapa Perdido, mantido automaticamente pela aplicação.';
```

### 009_soft_delete_prep.sql
```sql
-- Fase 1.13 da V2 — preparação para soft delete (NÃO ativado nesta fase).
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Esta migration só cria a coluna. O comportamento de exclusão continua
-- sendo o mesmo de hoje (delete físico) — nada no app foi alterado para
-- usar esta coluna ainda. Rollback: "alter table public.leads drop column
-- if exists deleted_at;".

alter table public.leads add column if not exists deleted_at timestamptz;

comment on column public.leads.deleted_at is
  'Fase 1 V2 (preparação, não ativado): quando preenchido, marcaria o lead como excluído sem apagar a linha. Hoje a exclusão de lead continua sendo física (delete real) — ver estratégia em docs/CRM_V2_PHASE_01_REPORT.md antes de ativar o uso desta coluna.';
```

### 010_indexes_v2.sql
```sql
-- Fase 1.11 da V2 — índices para suportar o crescimento da base de leads.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Só cria índices (CREATE INDEX IF NOT EXISTS) — não altera dado nenhum,
-- é seguro rodar a qualquer momento, inclusive com o app em produção.
-- Rollback: "drop index if exists <nome>;" para qualquer um deles.

create index if not exists leads_user_id_idx on public.leads (user_id);
create index if not exists leads_etapa_idx on public.leads (etapa);
create index if not exists leads_proximo_contato_idx on public.leads (proximo_contato);
create index if not exists leads_user_id_etapa_idx on public.leads (user_id, etapa);

create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_lead_id_idx on public.tasks (lead_id);
create index if not exists tasks_data_idx on public.tasks (data);
create index if not exists tasks_user_id_data_idx on public.tasks (user_id, data);
```

### 011_audit_log.sql
```sql
-- Fase 1.14 da V2 — tabela de auditoria para alterações críticas.
-- Rode este arquivo no SQL Editor do seu projeto Supabase (instalações
-- novas já recebem isso direto pelo supabase/schema.sql).
--
-- Aditivo e seguro: cria uma tabela nova, não toca em nenhuma existente.
-- Nesta fase o app só grava aqui mudança de etapa (incluindo Ganho/Perdido)
-- — não há trigger automática em cada update de cada tabela, para manter
-- o impacto mínimo. Rollback: "drop table if exists public.audit_log;".

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Fase 1 da V2: log de alterações críticas (nesta fase, só mudança de etapa do lead, incluindo Ganho/Perdido). Nunca deve conter secrets/tokens/credenciais — old_data/new_data carregam só os campos de negócio relevantes à mudança.';

alter table public.audit_log enable row level security;

create policy "audit_log: dono pode ler e criar"
  on public.audit_log
  for select using (user_id = auth.uid());

create policy "audit_log: dono pode inserir"
  on public.audit_log
  for insert with check (user_id = auth.uid());

create policy "audit_log: admin pode ler tudo"
  on public.audit_log
  for select using (public.is_admin());

create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_user_id_idx on public.audit_log (user_id);
```

---

## 9. Bloqueio?

Nenhum risco identificado de a V1 parar de funcionar por executar as migrations antes do merge. **Não há BLOQUEIO.**

A única ressalva não-bloqueante: a seção 5 (telefone) depende de você rodar as consultas de diagnóstico e me enviar os números, já que não tenho acesso aos seus dados reais.

---

## PRE-MIGRATION AUDIT:

```
MIGRATIONS ANALISADAS: 5/5
DADOS V1 PRESERVADOS: SIM
LEADS PRESERVADOS: SIM
TELEFONES PRESERVADOS: SIM
TAREFAS PRESERVADAS: SIM
AGENDA PRESERVADA: SIM
ROTINAS PRESERVADAS: SIM
USUÁRIOS PRESERVADOS: SIM
RLS SEGURO: SIM
FRONTEND V1 COMPATÍVEL APÓS MIGRATIONS: SIM
OPERAÇÕES DESTRUTIVAS: NÃO
RISCO DE PERDA DE DADOS: BAIXO
SEGURO EXECUTAR MIGRATIONS: SIM
RECOMENDAÇÃO:
As 5 migrations são 100% aditivas (CREATE TABLE IF NOT EXISTS, ADD COLUMN
IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE POLICY só em tabelas
novas) — nenhuma toca, remove ou transforma dado existente de leads,
tasks, templates, profiles ou auth.users, e nenhuma política de acesso
já existente é alterada. É seguro rodar as 5 migrations agora, antes do
merge do PR #36, exatamente na sequência Banco V1 → migrations V2 →
frontend V1 continua funcionando → merge/deploy do frontend V2. A única
pendência é informativa, não bloqueante: rodar o diagnóstico de telefone
(seção 5) e me enviar os números, para eu avaliar o plano de normalização
E.164 com dados reais antes de implementá-lo numa fase futura.
```

**AGUARDANDO AUTORIZAÇÃO.**
