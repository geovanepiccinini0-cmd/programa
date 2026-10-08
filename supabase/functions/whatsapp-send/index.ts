// Fase 3.5.2.2 — WhatsApp Send Edge Function — adapter Deno runtime.
//
// Responsabilidade ÚNICA: ligar o handler puro/testável (./handler.ts)
// ao runtime Deno real — Deno.serve, Deno.env, o Request/Response
// nativos, o client service-role real, e o adaptador HTTP real da
// Graph API (fetch global). ZERO lógica de negócio aqui.
//
// Este arquivo NUNCA é importado por Vitest/Node (specifiers `npm:`
// do runtime real não resolvem fora do Deno) — validação desta fase é
// estrutural/de regressão via handler.test.ts, não execução real
// deste adapter.
//
// Secrets lidos (Deno.env), e SOMENTE estes:
//   WHATSAPP_ACCESS_TOKEN — token da Meta, NUNCA exposto ao browser,
//     NUNCA incluído em nenhuma resposta HTTP (ver handler.ts).
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY —
//     SERVICE_ROLE_KEY para as RPCs/queries de leitura (já validam
//     ownership internamente); ANON_KEY para a verificação de
//     identidade via auth.getUser (nunca decodificação local).
// Nunca lê qualquer VITE_*.
//
// Deploy (manual, feito pelo usuário — este ambiente não tem acesso de
// rede ao projeto Supabase para fazer isso):
//   supabase functions deploy whatsapp-send

import { createClient } from 'npm:@supabase/supabase-js@2.110.0';
import {
  handleWhatsappSendRequest,
  type SendHttpRequest,
  type SendHttpResponse,
  type WhatsappSendServiceClient,
  type MetaCredentials,
} from './handler.ts';
import { sendWhatsappTextMessage, type GraphSendInput, type GraphSendResult } from '../_shared/whatsappGraphSendAdapter.ts';

const GRAPH_SEND_TIMEOUT_MS = 15_000;

function getServiceClient(): WhatsappSendServiceClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('whatsapp-send: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes');
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as WhatsappSendServiceClient;
}

function getMetaCredentials(): MetaCredentials | null {
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN');
  if (!accessToken || accessToken.trim().length === 0) {
    return null;
  }
  // phoneNumberId é só um placeholder estrutural aqui — o valor
  // REAL usado na chamada é sempre o resolvido pelo handler a partir
  // do contexto (integration_accounts.external_account_id), nunca
  // este. Mantido só para satisfazer a forma do tipo MetaCredentials.
  return { accessToken, phoneNumberId: '' };
}

async function sendGraphMessage(input: GraphSendInput): Promise<GraphSendResult> {
  return sendWhatsappTextMessage(input, {
    fetchFn: (url, init) => fetch(url, init),
    timeoutMs: GRAPH_SEND_TIMEOUT_MS,
    createAbortController: () => new AbortController(),
  });
}

async function toHandlerRequest(req: Request): Promise<SendHttpRequest> {
  const rawBody = await req.text();
  return {
    method: req.method,
    authorizationHeader: req.headers.get('Authorization'),
    rawBody,
  };
}

function toResponse(result: SendHttpResponse): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { 'Content-Type': result.contentType },
  });
}

Deno.serve(async (req: Request) => {
  const handlerRequest = await toHandlerRequest(req);

  const response = await handleWhatsappSendRequest(handlerRequest, {
    getServiceClient,
    getMetaCredentials,
    sendGraphMessage,
    now: () => new Date(),
  });

  return toResponse(response);
});
