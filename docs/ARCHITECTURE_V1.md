# CRM Piccinini — Arquitetura V1 (baseline)

> Snapshot técnico do sistema no commit `a1511002fca96c9cf68c82b27ae36993db82e164`
> (tag local `CRM_PICCININI_V1_BASELINE`, branch `main`, 2026-09-22) — o estado
> imediatamente anterior ao início da V2. Ver `docs/ROLLBACK_V2.md` para como
> voltar a este ponto se necessário.

## Stack

- **Frontend:** React 18 + Vite 5, JavaScript puro (sem TypeScript), CSS global único (`src/styles.css`).
- **Backend:** nenhum backend próprio — SPA client-only falando direto com o Supabase via `@supabase/supabase-js`.
- **Banco:** PostgreSQL gerenciado pelo Supabase.
- **Autenticação:** Supabase Auth (e-mail + senha), usuários criados manualmente no painel do Supabase.
- **Autorização:** Row Level Security (RLS) no Postgres — é a única camada real de segurança de dados.
- **Realtime:** Supabase Realtime (`postgres_changes`) nas tabelas `leads`, `tasks`, `templates`.
- **Hospedagem:** Netlify, build automático a partir do branch `main`, SPA fallback (`/* -> /index.html`).
- **Variáveis de ambiente:** opcionais — `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` têm fallback embutido em `src/lib/supabaseClient.js` (a anon key é pública por design).

## Tabelas atuais (`public`)

| Tabela | Finalidade | Dono dos dados |
| --- | --- | --- |
| `leads` | Um registro por lead/contato | `user_id` (vendedor) |
| `tasks` | Tarefas manuais e geradas automaticamente | `user_id` |
| `templates` | Rotinas recorrentes ("Planner") | `user_id` |
| `profiles` | Extensão de `auth.users` com o papel `is_admin` | 1:1 com `auth.users` |

Nenhuma tem índice além da PK, nenhuma tem CHECK constraint (enums como `etapa`/`produto`/`canal` são só texto livre, validados somente no frontend em `src/constants.js`), nenhuma tem soft-delete.

## Relacionamento lead / tasks / templates

```
auth.users ──1:N──> leads      (user_id, on delete cascade)
auth.users ──1:N──> tasks      (user_id, on delete cascade)
auth.users ──1:N──> templates  (user_id, on delete cascade)
auth.users ──1:1──> profiles   (id, on delete cascade)
leads      ──1:N──> tasks      (lead_id, on delete SET NULL)
templates  ──1:N──> tasks      (template_id, on delete SET NULL)
```

A aplicação não deixa tarefas órfãs na prática: `deleteLead` (em `useAppState.js`) apaga manualmente as tarefas do lead antes de excluí-lo — o `on delete set null` do banco é só uma rede de segurança.

## RLS — resumo

- **leads:** dono faz tudo; admin (`is_admin()`, função `security definer`) pode SELECT de todos e UPDATE de todos, mas não DELETE nem INSERT em nome de outro.
- **tasks:** só o dono acessa — nem o admin vê tarefas de outro usuário.
- **templates:** só o dono acessa.
- **profiles:** cada um vê o próprio; admin vê todos (só leitura).

## Funcionamento atual da Agenda

Não existe tabela própria de agenda — é uma visão computada sobre `tasks` filtrada por `categoria = 'Agenda/Ligação'`. Duas superfícies na aba Hoje: (a) Hoje/Amanhã (`TaskGroupedList.jsx`), tarefas das 4 categorias agrupadas; (b) Agenda da semana (`WeekAgenda.jsx`), só Agenda/Ligação, uma seção por dia da semana corrente.

Ao definir `proximo_contato` (data+horário) num lead, o sistema cria/mantém automaticamente 1 tarefa "Contato: {nome}" (`origem='lead-agenda'`) sincronizada 1:1 com o lead — removida/atualizada sozinha se o lead mudar de data, for Ganho/Perdido, ou tiver o próximo contato limpo. Concluir essa tarefa zera o próximo contato do lead (`toggleTask` em `useAppState.js`).

Alerta de atendimento (`useAppointmentAlerts.js` + `AppointmentAlertBanner.jsx`): a cada 30s verifica tarefas Agenda/Ligação de hoje a ≤30min, mostra banner + notificação nativa do navegador (Notification API, sem push/service worker — só funciona com o navegador aberto).

## Funcionamento atual do Planner (Rotina)

Entidade `templates`, exposta como aba "Rotina". Cadastro com título, categoria, horário opcional e dias da semana (chips). A cada carregamento do app (uma vez por sessão) e ao criar/reativar uma rotina, o sistema verifica se hoje é um dos dias configurados e, se ainda não existir uma tarefa daquela rotina para hoje, cria automaticamente. Desativar para a geração de tarefas novas, mas as já geradas permanecem.

## Automações client-side existentes

Toda a lógica roda nos hooks React do navegador (sem cron/scheduler server-side):

- `pendingAutoTasksForLeads` — cria/mantém a tarefa "Follow-up: {nome}" quando o lead tem `proximo_contato` vencido/hoje.
- `autoTaskHorarioUpdates` — sincroniza o horário dessa tarefa com o horário atual do lead.
- `pendingRotinaTasks` — gera a tarefa do dia para rotinas ativas.
- `computeLeadAgendaTaskData` / `reconcileLeadAgendaActions` / `applyLeadAgendaActions` — mantêm a tarefa "Contato: {nome}" (Agenda/Ligação) 1:1 com o lead.
- `toggleTask` — ao concluir uma tarefa de Follow-up ou Agenda vinculada a um lead, zera o `proximo_contato` desse lead.

Essas funções rodam no `useEffect` de carregamento do `useAppState` (uma vez por sessão, via `useRef`) e dentro de `saveLead`/`moveStage`/`setLeadStage`. Não há garantia de execução se nenhum navegador estiver aberto.

## O que NÃO existe (relevante para a V2)

Sem backend/API própria, sem histórico/timeline de interações (só um campo `notas` livre), sem lead scoring, sem integração com WhatsApp/e-mail/SMS, sem automação condicional, sem auditoria de alterações, sem testes automatizados, sem TypeScript, sem CI.

Para o inventário completo (todos os campos de todas as tabelas, CRM/Planner/Agenda detalhados, débito técnico) ver a auditoria técnica completa realizada antes desta fase.
