# CRM Piccinini V2 — Relatório da Fase 0 + Fase 1 (Fundação Técnica)

Branch: `claude/crm-piccinini-react-hdyr5d` · Baseline: tag local `CRM_PICCININI_V1_BASELINE` no commit `a1511002fca96c9cf68c82b27ae36993db82e164` · 11 commits incrementais, um por item/grupo de itens do escopo.

## ALTERAÇÕES REALIZADAS

**Fase 0** — baseline documentado, sem nenhuma alteração de código ou banco.

**Fase 1**:
- Edge Function `health` (estrutura criada, deploy manual pendente).
- Tabela `lead_interactions` (timeline do lead) com RLS.
- 8 novos campos em `leads`: `next_action_type`, `next_action_note`, `lead_temperature`, `priority` (default `normal`), `lost_reason`, `lost_reason_note`, `won_at`, `lost_at`.
- Coluna `deleted_at` em `leads` (preparação para soft delete, **não ativada**).
- Tabela `audit_log` com RLS, alimentada nas mudanças de etapa.
- 13 índices novos (8 em `leads`/`tasks`, 3 em `lead_interactions`, 2 em `audit_log`).
- Script de diagnóstico para CHECK constraints (**nenhuma constraint foi criada ainda** — ver PENDÊNCIAS).
- UI: seção "Histórico" (timeline) no modal do lead, com nota manual; campos de Temperatura, Prioridade, Próxima ação e Motivo de perda (condicional); badge "SEM PRÓXIMA AÇÃO" no card do Kanban.
- Mudança de etapa (`saveLead`/`moveStage`/`setLeadStage`) agora grava uma interação `stage_change` + uma entrada em `audit_log`, e mantém `won_at`/`lost_at` automaticamente.
- Backup/restore: `backupVersion: 2` na exportação (inclui interações); restore de backups V1 continua funcionando (`normalizeBackup`).
- 44 testes automatizados (Vitest) cobrindo as funções puras de `utils.js` e `useAppState.js`.
- `schema.sql` consolidado — instalações novas do Supabase já recebem tudo isso de uma vez.

## ARQUIVOS CRIADOS

```
docs/ARCHITECTURE_V1.md
docs/ROLLBACK_V2.md
docs/CRM_V2_PHASE_01_REPORT.md               (este arquivo)
supabase/functions/README.md
supabase/functions/health/index.ts
supabase/diagnostics/001_check_enum_values.sql
supabase/migrations/007_lead_interactions.sql
supabase/migrations/008_lead_fields_v2.sql
supabase/migrations/009_soft_delete_prep.sql
supabase/migrations/010_indexes_v2.sql
supabase/migrations/011_audit_log.sql
src/components/LeadTimeline.jsx
src/hooks/useAppState.test.js
src/utils.test.js
```

## ARQUIVOS ALTERADOS

```
package.json, package-lock.json      — devDependency vitest + script "test"
src/App.jsx                           — backupVersion:2, isValidBackup, addInteractionNote
src/components/LeadCardInfo.jsx       — badge SEM PRÓXIMA AÇÃO
src/components/LeadModal.jsx          — temperatura/prioridade/próxima ação/motivo de perda/histórico
src/constants.js                      — novas listas (NEXT_ACTION_TYPES, LEAD_TEMPERATURES, PRIORITIES, LOST_REASONS, labels de interação); BUILD_VERSION -> v2.0-foundation
src/hooks/useAppState.js              — log de mudança de etapa, won_at/lost_at, addInteractionNote, funções puras exportadas, normalizeBackup
src/lib/db.js                         — mapeamento dos novos campos de lead + interactionsApi + auditLogApi
src/utils.js                          — leadHasNoNextAction, classifyLeadPriority, isValidBackup, normalizeBackup
supabase/schema.sql                   — consolida toda a Fase 1 para instalações novas
```

Nenhum componente/tela existente foi removido ou teve o visual alterado além do estritamente necessário para os campos novos.

## MIGRATIONS CRIADAS

| # | Arquivo | O que faz | Destrutivo? |
| --- | --- | --- | --- |
| 007 | `lead_interactions.sql` | Cria tabela + RLS + índices | Não (tabela nova) |
| 008 | `lead_fields_v2.sql` | 8 colunas novas em `leads` | Não (colunas nullable/default) |
| 009 | `soft_delete_prep.sql` | Coluna `deleted_at` em `leads` | Não |
| 010 | `indexes_v2.sql` | 8 índices em `leads`/`tasks` | Não |
| 011 | `audit_log.sql` | Cria tabela + RLS + índices | Não (tabela nova) |

Todas testadas localmente num Postgres isolado (RLS simulada com múltiplos usuários + admin, schema completo criado do zero). Nenhuma usa `DROP`/`ALTER ... DROP COLUMN` em dado existente.

## ALTERAÇÕES NO BANCO

**Nenhuma foi aplicada no seu Supabase de produção** — elas só existem como arquivos `.sql` no repositório, no mesmo padrão já usado neste projeto desde a V1. **Isso é uma ação manual sua, descrita em AÇÕES MANUAIS NECESSÁRIAS.**

## NOVAS FUNCIONALIDADES

- Timeline/histórico do lead com nota manual.
- Registro automático de mudança de etapa (histórico + auditoria).
- Temperatura, prioridade, próxima ação (tipo + o que fazer) e motivo de perda por lead.
- Indicador visual de lead sem próxima ação definida.
- Health check server-side (estrutura pronta para deploy).
- Backup/restore versionado e compatível com V1.

## TESTES EXECUTADOS

`npm run build` e `npx vitest run`, após cada grupo de alterações (checkpoints incrementais) e novamente ao final. Também testado manualmente com Playwright: renderização dos campos novos no modal, condicional do Motivo de perda, badge SEM PRÓXIMA AÇÃO no card certo, e regressão completa das 3 abas (Hoje, Funil, Rotina) + StatsBar + HealthBar + Export modal sem nenhum erro de console.

## RESULTADOS DOS TESTES

- **Build:** ✅ PASS (`vite build`, sem warnings/erros).
- **Testes automatizados:** ✅ 44/44 PASS (Vitest).
- **Regressão manual (Playwright):** ✅ Hoje, Funil (busca, filtros, drag, tags), Rotina, StatsBar, HealthBar, Export modal, LeadModal — todos funcionando, **zero erros de página**.
- **RLS (Postgres local):** ✅ `lead_interactions` e `audit_log` — vendedor só vê o próprio, admin só lê (não escreve em nome de outro).

## RISCOS ENCONTRADOS

1. **Migrations pendentes = app quebra ao salvar/mover lead.** As novas colunas de `leads` (`priority` etc.) são usadas no `update`/`insert` assim que esta branch for publicada. Se as migrations 007-011 não forem rodadas no Supabase **antes** de usar o cadastro/edição de lead em produção, salvar ou mudar a etapa de um lead vai falhar (coluna inexistente). Isso é o mesmo padrão já usado em toda a V1 (ex.: tags, horário), mas o impacto aqui é maior porque toca o fluxo central de edição de lead — por isso está destacado separadamente, não só nas migrations.
2. **Log de interação/auditoria é resiliente, mas silencioso.** Se só a migration 007 ou 011 não tiver sido rodada (`lead_interactions`/`audit_log` ausentes), a troca de etapa em si continua funcionando — só o registro de histórico falha (com aviso no console do navegador, sem alertar o usuário na tela).
3. **Admin não gera histórico ao editar leads de outro vendedor pela aba Métricas.** `MetricasView.jsx` tem seu próprio código de troca de etapa, que não foi alterado nesta fase (a RLS de `lead_interactions`/`audit_log` não permite ao admin inserir em nome de outro usuário — mesma lógica que já impede o admin de excluir leads de outros hoje). Fica registrado como lacuna conhecida, não como bug.
4. **CHECK constraints não aplicadas.** Ver PENDÊNCIAS — decisão consciente de não aplicar sem antes ver os dados reais.

Nenhum desses riscos envolve perda de dados, quebra de RLS existente ou necessidade de credenciais externas — por isso a execução não foi interrompida, mas estão listados para sua decisão informada.

## PENDÊNCIAS

- **CHECK constraints em `produto`/`etapa`/`canal`/`categoria`/`origem`** — aguardando você rodar `supabase/diagnostics/001_check_enum_values.sql` e compartilhar o resultado.
- **Soft delete não ativado** — só a coluna `deleted_at` existe; o comportamento de exclusão continua físico.
- **Deploy da Edge Function `health`** — código pronto, deploy é manual (`supabase/functions/README.md`).
- **Admin + timeline/auditoria na aba Métricas** — não implementado nesta fase (risco 3 acima).
- **Tela Hoje não foi reconstruída** com os indicadores ATRASADO/HOJE/QUENTE/URGENTE/PARADO — a lógica (`classifyLeadPriority`) está pronta e testada, mas não há UI nova usando-a ainda (conforme pedido: só preparar).

## AÇÕES MANUAIS NECESSÁRIAS

1. **Antes de usar o CRM depois do merge desta branch:** rode, nesta ordem, no SQL Editor do Supabase:
   `007_lead_interactions.sql` → `008_lead_fields_v2.sql` → `009_soft_delete_prep.sql` → `010_indexes_v2.sql` → `011_audit_log.sql`.
   (Instalação nova? Basta rodar o `schema.sql` atualizado, que já inclui tudo.)
2. Rode `supabase/diagnostics/001_check_enum_values.sql` e me mande o resultado, para eu preparar a migration de CHECK constraints com segurança.
3. Quando quiser a Edge Function de health check ativa, siga `supabase/functions/README.md` (precisa do Supabase CLI logado — não posso fazer esse deploy por aqui).

Nenhuma outra ação manual é necessária — não há credenciais, tokens ou integrações externas pendentes nesta fase.

## COMO FAZER ROLLBACK

Detalhado em `docs/ROLLBACK_V2.md`. Resumo: reverter o código é um `git revert` normal dos commits desta fase; reverter o banco é rodar o `DROP`/`ALTER ... DROP COLUMN` correspondente de cada migration (documentado no cabeçalho de cada arquivo) — nenhuma delas toca em dado existente de `leads`/`tasks`/`templates`/`profiles`, então não há risco de perda ao reverter.

## PRÓXIMA FASE RECOMENDADA

Com a fundação no lugar, sugiro como Fase 2: (a) aplicar as CHECK constraints assim que o diagnóstico vier; (b) reconstruir a tela Hoje usando `classifyLeadPriority`/`leadHasNoNextAction` para os indicadores visuais; (c) só então avançar para a integração oficial do WhatsApp (que passa a ter onde "morder" — `lead_interactions` já modela o histórico, e a Edge Function `health` já prova que a camada server-side funciona).

---

## RESUMO EXECUTIVO

```
STATUS:     APROVADO COM RESSALVAS
BUILD:      PASS
TESTES:     44/44 PASS
BANCO:      MIGRATION PENDENTE (007 a 011 — rodar antes de usar o CRM em produção)
PRODUÇÃO:   NÃO ALTERADA (nada foi aplicado no Supabase; só esta branch/repositório)
WHATSAPP:   NÃO IMPLEMENTADO
```

**Ação manual necessária antes de continuar:** sim — rodar as 5 migrations novas no SQL Editor do Supabase (ordem acima) antes de usar o cadastro/edição de leads nesta versão, e depois rodar o script de diagnóstico de enums e compartilhar o resultado.
