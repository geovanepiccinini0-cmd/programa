// Fase 3.3.3.3 — WhatsApp Webhook Edge Function — adapter Deno runtime.
//
// Responsabilidade ÚNICA: ligar o handler puro/testável (./handler.ts)
// ao runtime Deno real — Deno.serve, Deno.env, o Request/Response
// nativos, e o client service-role real (via
// ../_shared/supabaseServiceRuntime.ts). ZERO lógica de negócio aqui —
// tudo isso já vive em handler.ts e nos módulos _shared já aprovados,
// nunca duplicado.
//
// Este arquivo NUNCA é importado por Vitest/Node (specifiers `npm:`
// do runtime real, via supabaseServiceRuntime.ts, não resolvem fora
// do Deno) — validação desta fase é estrutural/de regressão via
// handler.test.ts, não execução real deste adapter.
//
// Secrets lidos (Deno.env), e SOMENTE estes:
//   WHATSAPP_VERIFY_TOKEN — handshake GET da Meta.
//   META_APP_SECRET — HMAC do POST.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — lidos indiretamente por
//     supabaseServiceRuntime.ts (nunca lidos diretamente aqui).
// Nunca lê WhatsApp access token / Graph API token / qualquer VITE_*.
//
// Deploy (manual, feito pelo usuário — este ambiente não tem acesso de
// rede ao projeto Supabase para fazer isso):
//   supabase functions deploy whatsapp-webhook

import { handleWhatsappWebhookRequest, type WebhookHttpRequest, type WebhookHttpResponse } from './handler.ts';
import { getSupabaseServiceClient } from '../_shared/supabaseServiceRuntime.ts';

async function toHandlerRequest(req: Request): Promise<WebhookHttpRequest> {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    return {
      method: req.method,
      getVerification: {
        mode: url.searchParams.get('hub.mode'),
        verifyToken: url.searchParams.get('hub.verify_token'),
        challenge: url.searchParams.get('hub.challenge'),
      },
    };
  }

  if (req.method === 'POST') {
    // Lido como texto UMA ÚNICA VEZ — bytes exatos preservados para a
    // verificação de assinatura, nunca reserializado antes dela.
    const rawBody = await req.text();
    return {
      method: req.method,
      rawBody,
      signatureHeader: req.headers.get('X-Hub-Signature-256'),
    };
  }

  return { method: req.method };
}

function toResponse(result: WebhookHttpResponse): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { 'Content-Type': result.contentType },
  });
}

Deno.serve(async (req: Request) => {
  const handlerRequest = await toHandlerRequest(req);

  const response = await handleWhatsappWebhookRequest(handlerRequest, {
    verifyToken: Deno.env.get('WHATSAPP_VERIFY_TOKEN'),
    appSecret: Deno.env.get('META_APP_SECRET'),
    // Lazy: só é efetivamente chamada dentro do handler quando já se
    // sabe que existe ao menos um evento canônico a persistir (ver
    // handler.ts, seção 9 do comentário de topo).
    getServiceClient: () => getSupabaseServiceClient(),
    now: () => new Date(),
  });

  return toResponse(response);
});
