// Fase 3.5.2.2 — WhatsApp Send Edge Function — adapter Deno runtime.
//
// Responsabilidade ÚNICA: ligar o handler puro/testável (./handler.ts)
// ao runtime Deno real — Deno.serve, Deno.env, o Request/Response
// nativos, DOIS clients Supabase com privilégios distintos, e o
// adaptador HTTP real da Graph API (fetch global). ZERO lógica de
// negócio aqui.
//
// Fase 3.5.2.2 (separação de privilégios, item 3 do pedido de
// correção): getAuthClient() usa a ANON key + o Authorization do
// próprio chamador (encaminhado, nunca reconstruído) — EXCLUSIVAMENTE
// para verifyAuthenticatedIdentity. getServiceClient() usa a
// SERVICE_ROLE key — EXCLUSIVAMENTE para as operações privilegiadas
// (resolução de contexto, rate limit, RPCs de outbound), nunca para
// verificar identidade. Os dois nunca são o mesmo client.
//
// Este arquivo NUNCA é importado por Vitest/Node (specifiers `npm:`
// do runtime real não resolvem fora do Deno) — validação desta fase é
// estrutural/de regressão via handler.test.ts, não execução real
// deste adapter.
//
// Secrets lidos (Deno.env), e SOMENTE estes:
//   WHATSAPP_ACCESS_TOKEN — token da Meta, NUNCA exposto ao browser,
//     NUNCA incluído em nenhuma resposta HTTP (ver handler.ts).
//   SUPABASE_URL — compartilhada pelos dois clients.
//   SUPABASE_ANON_KEY — usada SOMENTE para getAuthClient.
//   SUPABASE_SERVICE_ROLE_KEY — usada SOMENTE para getServiceClient.
// Nunca lê qualquer VITE_*.
//
// verify_jwt desta função permanece no default do Supabase (true, ver
// supabase/config.toml — bloco de comentário explícito, sem override):
// o gateway já exige um JWT estruturalmente válido antes de invocar
// esta função, e o código abaixo ainda faz sua PRÓPRIA verificação
// real via auth.getUser (que checa revogação/expiração no servidor de
// Auth, não só a assinatura) — defesa em profundidade, nunca uma
// substitui a outra.
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
import type { AuthClientLike } from '../_shared/whatsappSendAuth.ts';
import { sendWhatsappTextMessage, type GraphSendInput, type GraphSendResult } from '../_shared/whatsappGraphSendAdapter.ts';

const GRAPH_SEND_TIMEOUT_MS = 15_000;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`whatsapp-send: ${name} ausente`);
  }
  return value;
}

// Fase 3.5.2.2 — client de BAIXO privilégio: ANON key, SEM
// persistência de sessão própria. O Authorization do chamador é
// encaminhado explicitamente a cada chamada de auth.getUser (nunca
// setado como sessão global do client) — ver whatsappSendAuth.ts.
function getAuthClient(): AuthClientLike {
  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as AuthClientLike;
}

// Client PRIVILEGIADO: SERVICE_ROLE key — exclusivo para as operações
// que precisam ignorar RLS (a própria RLS, e os triggers/RPCs,
// continuam validando ownership de forma independente). NUNCA usado
// para auth.getUser.
function getServiceClient(): WhatsappSendServiceClient {
  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
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
    getAuthClient,
    getServiceClient,
    getMetaCredentials,
    sendGraphMessage,
    now: () => new Date(),
  });

  return toResponse(response);
});
