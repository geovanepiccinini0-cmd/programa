# Plano de rollback — V2 → V1

Este documento explica como voltar ao estado V1 caso alguma mudança da V2 (migration ou alteração de código) cause um problema em produção.

## Referência do baseline

- **Commit de baseline (branch `main`):** `a1511002fca96c9cf68c82b27ae36993db82e164` — "Adiciona 'Pesados' como tipo de bem em Carta Contemplada (#35)".
- **Tag local:** `CRM_PICCININI_V1_BASELINE` (criada no ambiente de desenvolvimento; como é local, se precisar dela em outra máquina, recrie com `git tag CRM_PICCININI_V1_BASELINE a1511002fca96c9cf68c82b27ae36993db82e164`).
- Esse commit já está permanentemente preservado no histórico do branch `main` no GitHub — não é necessário nenhum backup adicional de código para recuperá-lo.

## Rollback do código (frontend)

Todas as mudanças da V2 entram via Pull Requests normais, um de cada vez, com build e testes passando antes do merge (mesmo fluxo usado até aqui). Se uma mudança já mesclada causar problema:

1. No GitHub, identifique o(s) commit(s) da mudança problemática em `main`.
2. Reverta com um **revert commit** (`git revert <sha>`), nunca com `git reset --hard` + force-push em `main` — preserva o histórico e evita perder trabalho de outros PRs feitos depois.
3. Abra PR do revert, confirme e mescle como qualquer outra mudança.
4. O Netlify faz redeploy automático a partir do novo HEAD de `main`.

Se for necessário voltar tudo de uma vez ao baseline exato: `git revert <commit-mais-antigo-da-v2>..<commit-mais-recente-da-v2>` (um intervalo), ou, em último caso, criar um branch novo a partir do commit `a1511002fca96c9cf68c82b27ae36993db82e164` e abrir PR substituindo `main` — isso deve ser decisão explícita do usuário, nunca automático.

## Rollback do banco (Supabase)

Diferente do código, **mudanças de banco não revertem sozinhas com o Git** — as migrations da V2 são aplicadas manualmente no SQL Editor do Supabase (mesmo processo já usado para as migrations da V1). Por isso, cada migration da V2:

- É **aditiva** sempre que possível (`add column if not exists`, `create table if not exists`, `create index if not exists`) — nunca remove ou renomeia colunas/tabelas existentes.
- Vem acompanhada do **script inverso** (`DOWN`) quando a operação não for trivialmente segura de ignorar — ex.: para uma migration que adiciona uma coluna, o rollback é `alter table ... drop column if exists ...`.
- Nunca aplica `DROP TABLE`/`DROP COLUMN` destrutivo em dado existente sem aviso explícito e confirmação separada do usuário.

**Regra prática:** se uma migration da V2 causar problema, o rollback é rodar o script inverso correspondente no SQL Editor do Supabase (documentado no cabeçalho de cada migration em `supabase/migrations/`) — os dados das tabelas V1 (`leads`, `tasks`, `templates`, `profiles`) nunca são tocados de forma destrutiva pelas migrations da V2, então não há risco de perda dos dados já existentes só por reverter uma coluna nova.

## Rollback de funcionalidade sem rollback de banco

Como a V2 é construída para ser aditiva, a forma mais simples de "desligar" uma funcionalidade nova sem mexer no banco é reverter só o código do frontend que a expõe (ex.: ocultar a seção de Histórico) — as colunas/tabelas novas ficam no banco sem uso, inofensivas, até serem removidas numa limpeza posterior deliberada.

## O que NUNCA é feito automaticamente

- `DROP TABLE`/`DROP COLUMN` em dado de produção.
- `git push --force` em `main`.
- Alterar/excluir backup ou dado de usuário sem confirmação explícita.
- Ativar soft-delete "de verdade" (mudar o comportamento de exclusão) sem aprovação explícita — ver seção 1.13 da Fase 1.
