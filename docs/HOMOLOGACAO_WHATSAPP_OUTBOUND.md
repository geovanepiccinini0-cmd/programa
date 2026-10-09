# Preparação para homologação — WhatsApp Outbound

Branch: `claude/whatsapp-outbound-3-5-2-1`
Commit avaliado: `91151c26ba1faed0f465e81ebdba1c19c5d713af`
Gerado em modo **somente leitura** — nenhuma migration, deploy, push, PR, merge, secret ou chamada à Meta foi executada para produzir este documento.

---

## 1. Ordem exata das migrations pendentes

Produção (branch `main`) tem, hoje, até `019_whatsapp_messages_rpc_integration.sql` aplicada (confirmado: `018`/`019` são **byte-a-byte idênticas** entre `main` e esta branch — zero risco de drift nelas). Nada de `020` em diante existe em `main`.

Pendentes, **nesta ordem exata** (cada uma depende da anterior via precondição `raise exception` no próprio arquivo — não é opcional, é falha fechada):

| # | Arquivo | Depende de | Risco se aplicada fora de ordem |
|---|---|---|---|
| 1 | `020_whatsapp_outbound_foundation.sql` | 018, 019 (RPC `process_inbound_whatsapp_event` e tabela `whatsapp_messages`) | Precondição explícita no início do arquivo aborta com `raise exception` se 018/019 não existirem — seguro, nunca aplica pela metade |
| 2 | `021_whatsapp_outbound_uncertain_state.sql` | 020 | Idem — precondição verifica função/coluna da 020 |
| 3 | `022_whatsapp_outbound_recipient_identity.sql` | 021 | Idem |
| 4 | `023_whatsapp_outbound_status_webhook.sql` (**versão corrigida**, pós-commit `39071f6`) | 022 | Idem — precondição verifica `apply_whatsapp_outbound_status_event` (020) antes de rodar |

**Risco maior, fora do escopo SQL:** a `023` faz `drop function if exists apply_whatsapp_outbound_status_event(text,text,timestamptz)` (assinatura antiga de 3 parâmetros) e cria a versão nova de 5 parâmetros. O **código novo do webhook** (`whatsapp-webhook/handler.ts`) já chama só a versão de 5 parâmetros. Logo:
> **Nunca publicar o novo código do `whatsapp-webhook` antes de aplicar a `023`** — se isso ocorrer, toda chamada a `apply_whatsapp_outbound_status_event` falha (função/assinatura inexistente) até a migration rodar. O processamento de mensagens *inbound* (RPC separada) não seria afetado, só o processamento de *status* (sent/delivered/read/failed) ficaria quebrado nesse intervalo.

Execução: cada arquivo é rodado manualmente no **SQL Editor do Supabase** (não há link de projeto nem `supabase/migrations` rastreado pela CLI neste repositório — mesmo padrão já usado desde a V1/V2, documentado em `docs/ROLLBACK_V2.md`).

## 2. Migration 023 — confirmação do conteúdo do commit `39071f6`

Confirmado por grep no arquivo atual (`git diff HEAD` vazio — working tree == HEAD, nada pendente de commit):
- `whatsapp_outbound_status_anomalies` (tabela de auditoria, RLS sem policies, grant só `service_role`) — presente.
- `log_whatsapp_outbound_status_anomaly` (função) — presente, chamada nos dois pontos (`ACCOUNT_MISMATCH` e `LATE_FAILURE_AFTER_DELIVERY`).
- `whatsapp_outbound_status_events_dedup_idx` (índice único de deduplicação) — presente.
- Outcome `'IGNORED_LATE_FAILURE_PROTECTED_DELIVERY'` (bloqueio da regressão `failed` sobre `delivered`/`read`) — presente, linha 297.
- Histórico do arquivo: só 2 commits o tocam (`a574c82` criação, `39071f6` correção) — nenhuma edição posterior não revisada.

## 3. Edge Functions a publicar/atualizar

| Função | Estado em `main` (produção) | Ação necessária |
|---|---|---|
| `health` | Idêntica a esta branch (diff vazio) | **Nenhuma** — não precisa redeploy |
| `whatsapp-webhook` | Existe, mas **difere** (handler.ts: +148/−12 linhas — suporte a `sent`/`delivered`/`read`/`failed`, não só inbound) | **Redeploy obrigatório**, só DEPOIS da migration 023 (ver risco de ordem acima) |
| `whatsapp-send` | **Não existe em produção** | **Deploy inicial** (função nova) |

Arquivos `_shared/` novos (usados só por `whatsapp-send`, empacotados automaticamente no deploy dela): `whatsappGraphSendAdapter.ts`, `whatsappOutboundRateLimiter.ts`, `whatsappOutboundRepository.ts`, `whatsappSendAuth.ts`, `whatsappSendContextRepository.ts`.
Arquivo `_shared/` alterado (usado por `whatsapp-webhook`, redeploy já cobre): `whatsappWebhook.ts`.

`supabase/config.toml` já versiona `verify_jwt` corretamente para as duas (`whatsapp-webhook=false`, explicado pelo próprio comentário do arquivo; `whatsapp-send=true`, default explícito) — nenhuma configuração manual adicional de JWT necessária além de rodar o deploy respeitando este arquivo.

## 4. Configurações Supabase/Netlify — existentes vs. novas (sem valores)

**Supabase — secrets de Edge Function:**
| Secret | Status | Usado por |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Já existe (webhook já em produção) | `whatsapp-webhook` |
| `META_APP_SECRET` | Já existe | `whatsapp-webhook` |
| `SUPABASE_URL` | Automático (injetado pela plataforma em toda função, nunca configurado manualmente) | ambas |
| `SUPABASE_ANON_KEY` | Automático | `whatsapp-send` |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático | `whatsapp-send` |
| `WHATSAPP_ACCESS_TOKEN` | **NOVO — precisa ser criado** antes do deploy de `whatsapp-send` | `whatsapp-send` |

Sem o `WHATSAPP_ACCESS_TOKEN` configurado, `whatsapp-send` responde sempre `CONFIG_ERROR` (500) de forma segura (nunca tenta enviar com token vazio) — é uma falha segura, não um risco, mas bloqueia o teste real até ser definido.

**Netlify:** nenhuma variável de ambiente nova. `src/lib/supabaseClient.js` já tem `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` com fallback público hardcoded (chave anon, segura para expor — a RLS é a proteção real). Nenhum `import.meta.env` novo foi introduzido nesta fase.

## 5. Preview isolado na Netlify sem afetar produção

Duas opções, nenhuma tocando `main`:
- **Via GitHub (preferível):** `git push origin claude/whatsapp-outbound-3-5-2-1` + abrir PR para `main`. Se "Deploy Previews" estiver habilitado no site Netlify (padrão quando conectado via GitHub App), um preview isolado é gerado automaticamente a cada push na branch/PR, com URL própria (`deploy-preview-<n>--<site>.netlify.app`), nunca publicado em `/` de produção.
- **Via CLI, sem GitHub:** `netlify deploy --build` (sem `--prod`) a partir da raiz do projeto — gera um *draft deploy* com URL própria, local ao seu terminal, sem precisar de push/PR. Nunca usar `--prod` nesta etapa.

Nenhuma das duas altera o deploy de produção atual do Netlify.

## 6. Backup e rollback (Supabase plano gratuito)

O plano gratuito **não tem Point-in-Time Recovery** (recurso só dos planos Pro+) e a retenção de backups automáticos é limitada/não garantida contratualmente. Por isso, **backup manual é obrigatório antes de qualquer migration**:

1. Antes de abrir o SQL Editor: rode um `pg_dump` da connection string do projeto (Project Settings → Database → Connection string), **a partir da sua própria máquina** (este ambiente não tem acesso de rede ao seu Supabase). Guarde o arquivo fora do repositório.
2. Alternativa rápida sem `pg_dump`: no Supabase Studio, `Database → Backups`, confirme se há um snapshot recente antes de prosseguir (mesmo no free tier costuma haver *algum* snapshot diário, mas nunca garantido/ilimitado — não dependa só disso).

**Rollback de banco:** cada bloco de cada migration (020-023) já documenta seu próprio comentário `-- Rollback deste bloco: ...` com o SQL inverso exato. Em caso de problema, aplicar os rollbacks na ordem **inversa**: primeiro os blocos da 023, depois 022, depois 021, depois 020. Nunca `DROP TABLE`/`DROP COLUMN` direto sem usar o rollback documentado.

**Rollback de Edge Functions:**
- `whatsapp-send` (função nova): rollback = `supabase functions delete whatsapp-send` (remoção limpa — nada mais depende dela até o frontend novo ser publicado).
- `whatsapp-webhook`: rollback = re-executar `supabase functions deploy whatsapp-webhook` a partir do checkout do commit anterior (`a1511002...`/estado de `main`) — Supabase não mantém um botão de "versão anterior" no free tier; o rollback é sempre um novo deploy do código antigo.

**Rollback de frontend:** `git revert` do(s) commit(s) do PR em `main` (nunca `reset --hard`/force-push), conforme já documentado em `docs/ROLLBACK_V2.md` — o Netlify redeploya automaticamente a partir do novo HEAD.

## 7. Roteiro mínimo de homologação (número pessoal)

1. **Pré-requisito:** `WHATSAPP_ACCESS_TOKEN` configurado, `whatsapp-send` publicada, migrations 020-023 aplicadas, frontend publicado (preview ou produção).
2. No seu celular, envie uma mensagem do seu número pessoal para o número Business já conectado — isso cria/renova a janela de 24h e a identidade inbound.
3. Confirme no CRM que a mensagem aparece na caixa de entrada (fluxo já existente, inalterado).
4. Abra essa conversa no CRM, digite uma resposta curta e clique **Enviar**.
5. Confira: bolha aparece imediatamente como "🕐 Enviando...", depois muda para "✓ Enviado" em poucos segundos (nunca "Entregue"/"Lido" neste passo).
6. No celular, confirme que a mensagem chegou de fato no WhatsApp.
7. Abra a mensagem no celular (marque como lida) — confirme que a bolha no CRM atualiza **sozinha**, via Realtime, para "✓✓ Entregue" e depois "✓✓ Lido" (azul), sem recarregar a página.
8. Clique **Enviar** duas vezes rápido no mesmo texto — confirme que só uma mensagem chega ao WhatsApp (nunca duas).
9. Repita os passos 4-5 pelo navegador do celular (responsivo) — confirme que o composer é usável em tela pequena.
10. **Opcional/avançado** (exige esperar ou simular): depois de >24h sem nova mensagem inbound, confirme que o composer mostra o aviso de janela encerrada e bloqueia o envio.

## 8. Comandos exatos de implantação (NÃO executados nesta sessão)

```bash
# 0) uma vez, se ainda não estiver linkado
supabase link --project-ref SEU-PROJECT-REF

# 1) migrations — rodar cada arquivo no SQL Editor do Supabase, nesta ordem:
#    020_whatsapp_outbound_foundation.sql
#    021_whatsapp_outbound_uncertain_state.sql
#    022_whatsapp_outbound_recipient_identity.sql
#    023_whatsapp_outbound_status_webhook.sql   (versão atual do HEAD, já corrigida)

# 2) secret novo (valor real nunca aqui, nunca neste documento)
supabase secrets set WHATSAPP_ACCESS_TOKEN=<definido manualmente por você>

# 3) deploy das Edge Functions (SOMENTE depois do passo 1)
supabase functions deploy whatsapp-webhook
supabase functions deploy whatsapp-send

# 4) frontend — preview isolado primeiro
git push origin claude/whatsapp-outbound-3-5-2-1
# abrir PR claude/whatsapp-outbound-3-5-2-1 -> main no GitHub
# (gera Netlify Deploy Preview automático, se habilitado)

# 5) só após homologação aprovada no preview:
# merge do PR -> Netlify publica produção automaticamente a partir de main
```

## 9. Dependências que impedem publicação segura agora

- `WHATSAPP_ACCESS_TOKEN` ainda não definido (bloqueia só o envio real, falha segura).
- Nenhum teste de renderização visual/DOM foi executado nesta implementação (projeto não tem RTL/jsdom) — só lógica pura + integração contra o handler real. **Verificação visual manual (passos 2-9 acima) é obrigatória antes do merge para produção.**
- Ordem de deploy entre migration 023 e `whatsapp-webhook` (ver seção 1) — se invertida, processamento de status fica temporariamente quebrado (nunca o de mensagens inbound).
- Backup manual (`pg_dump`) ainda não foi feito (não pode ser feito desta sessão — sem acesso de rede ao seu Supabase).

---

## Checklist de execução (aguardando sua autorização explícita para cada bloco)

**Preparação**
- [ ] Fazer backup manual (`pg_dump`) do banco de produção
- [ ] Definir o secret `WHATSAPP_ACCESS_TOKEN` no Supabase

**Preview visual**
- [ ] `git push` da branch + abrir PR (gera Netlify Deploy Preview)
- [ ] Abrir o preview e confirmar visualmente a interface (composer, bolhas, responsivo)

**Migrações e backend**
- [ ] Aplicar 020 → 021 → 022 → 023 no SQL Editor, nesta ordem, cada uma só após a anterior confirmar sucesso
- [ ] Deploy de `whatsapp-webhook` (só depois das migrations)
- [ ] Deploy de `whatsapp-send`

**Teste real restrito**
- [ ] Roteiro da seção 7, passos 1-9, com seu número pessoal
- [ ] Confirmar Realtime (entregue/lido) e duplo clique sem duplicar

**Liberação final**
- [ ] Merge do PR em `main` (produção)
- [ ] Confirmar deploy automático do Netlify a partir de `main`
- [ ] Monitorar as primeiras mensagens reais de usuários finais
