# Supabase Edge Functions

Funções server-side do CRM Piccinini, rodando no runtime Deno do Supabase. Este ambiente de desenvolvimento não tem acesso de rede ao seu projeto Supabase, então o deploy precisa ser feito manualmente por você.

## `health` — Fase 1 (fundação técnica)

Health check simples, sem acesso a dados. Existe para confirmar que a camada server-side está disponível, preparando terreno para webhooks/jobs futuros (nenhum é configurado ainda).

### Como instalar o Supabase CLI (uma vez)

```bash
npm install -g supabase
supabase login
```

### Deploy

Na raiz do projeto:

```bash
supabase link --project-ref SEU-PROJECT-REF
supabase functions deploy health
```

### Testar

```bash
curl https://SEU-PROJETO.supabase.co/functions/v1/health
```

Resposta esperada:

```json
{"ok": true, "service": "crm-piccinini", "version": "2.0-foundation"}
```

Nenhuma outra função/integração (WhatsApp, Meta, IA) é criada nesta fase.
