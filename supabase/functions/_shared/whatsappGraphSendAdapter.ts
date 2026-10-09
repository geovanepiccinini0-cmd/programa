// Fase 3.5.2.2 — Adaptador HTTP ISOLADO para o envio via WhatsApp
// Cloud API (Graph API da Meta).
//
// Responsabilidade ÚNICA: fazer UMA chamada HTTP de envio e
// classificar a resposta em um de três resultados honestos — NUNCA
// presume que timeout, 5xx ou resposta ambígua significa que a Meta
// não recebeu a mensagem (exigência de segurança da Fase 3.5.2.2).
// Este módulo NUNCA decide o que fazer com o resultado (isso é do
// handler/RPCs) — só classifica.
//
// `fetchFn` é SEMPRE injetado — nunca importa/usa o `fetch` global
// diretamente, nunca lê Deno.env, nunca conhece o access token além
// de repassá-lo no header (nunca o loga, nunca o inclui no resultado
// retornado). 100% testável em Vitest/Node com mocks HTTP, zero rede
// real necessária.
//
// CLASSIFICAÇÃO (deliberadamente conservadora — "ACCEPTED" só quando
// há prova inequívoca):
//   ACCEPTED            — HTTP 2xx E um wamid válido no corpo.
//   REJECTED_DEFINITIVE — HTTP 400/404/410/422 COM um corpo de erro
//                          estruturado da própria Meta (error.code +
//                          error.message) — prova de que a Meta
//                          processou e rejeitou ESTA mensagem
//                          especificamente.
//   UNCERTAIN           — qualquer outra coisa: timeout/abort, erro
//                          de rede, 401/403 (pode ser problema do
//                          NOSSO token, não prova que a mensagem foi
//                          rejeitada), 429 (rate limit da Meta — não
//                          é rejeição de conteúdo), 5xx, 2xx sem wamid
//                          válido, corpo não-parseável. NUNCA
//                          reclassificado como ACCEPTED ou REJECTED
//                          por nenhum destes casos.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export interface GraphSendInput {
  accessToken: string;
  phoneNumberId: string;
  toE164: string;
  body: string;
}

export type GraphSendResult =
  | { outcome: 'ACCEPTED'; externalMessageId: string }
  | { outcome: 'REJECTED_DEFINITIVE'; errorCode: string; httpStatus: number }
  | { outcome: 'UNCERTAIN'; reason: string; httpStatus: number | null };

export interface FetchLikeResponse {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<FetchLikeResponse>;

export interface GraphSendAdapterDeps {
  fetchFn: FetchLike;
  timeoutMs: number;
  createAbortController: () => AbortController;
}

const GRAPH_API_VERSION = 'v21.0';
const DEFINITIVE_REJECTION_HTTP_STATUSES = new Set([400, 404, 410, 422]);

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidInput(input: GraphSendInput, deps: GraphSendAdapterDeps): void {
  if (!isNonBlankString(input?.accessToken)) {
    throw new TypeError('sendWhatsappTextMessage: accessToken deve ser uma string nao vazia');
  }
  if (!isNonBlankString(input?.phoneNumberId)) {
    throw new TypeError('sendWhatsappTextMessage: phoneNumberId deve ser uma string nao vazia');
  }
  if (!isNonBlankString(input?.toE164)) {
    throw new TypeError('sendWhatsappTextMessage: toE164 deve ser uma string nao vazia');
  }
  if (!isNonBlankString(input?.body)) {
    throw new TypeError('sendWhatsappTextMessage: body deve ser uma string nao vazia');
  }
  if (typeof deps?.fetchFn !== 'function') {
    throw new TypeError('sendWhatsappTextMessage: deps.fetchFn deve ser uma function');
  }
  if (typeof deps?.timeoutMs !== 'number' || deps.timeoutMs <= 0) {
    throw new TypeError('sendWhatsappTextMessage: deps.timeoutMs deve ser um numero positivo');
  }
  if (typeof deps?.createAbortController !== 'function') {
    throw new TypeError('sendWhatsappTextMessage: deps.createAbortController deve ser uma function');
  }
}

// Extrai um wamid válido do corpo de uma resposta 2xx. Nunca inventa
// um valor — qualquer forma inesperada (campo ausente, tipo errado,
// JSON inválido, array vazio) resulta em `null`, que o chamador
// SEMPRE trata como UNCERTAIN (nunca ACCEPTED).
function extractWamid(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const messages = (parsed as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const first = messages[0];
    if (first === null || typeof first !== 'object') return null;
    const id = (first as { id?: unknown }).id;
    return isNonBlankString(id) ? id : null;
  } catch {
    return null;
  }
}

// Extrai um erro estruturado DA PRÓPRIA META do corpo de uma resposta
// de erro. Nunca inventa um código — corpo não-parseável ou sem a
// forma exata esperada resulta em `null`, que o chamador trata como
// UNCERTAIN (nunca REJECTED_DEFINITIVE sem prova).
function extractMetaErrorCode(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const error = (parsed as { error?: unknown }).error;
    if (error === null || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (!isNonBlankString(message)) return null;
    if (typeof code === 'number' || isNonBlankString(code)) {
      return String(code);
    }
    return null;
  } catch {
    return null;
  }
}

export async function sendWhatsappTextMessage(
  input: GraphSendInput,
  deps: GraphSendAdapterDeps,
): Promise<GraphSendResult> {
  assertValidInput(input, deps);

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(input.phoneNumberId)}/messages`;
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: input.toE164,
    type: 'text',
    text: { body: input.body },
  });

  const controller = deps.createAbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), deps.timeoutMs);

  try {
    let response: FetchLikeResponse;
    try {
      response = await deps.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (thrown) {
      // Timeout (abort) ou falha de rede — NUNCA presumido como
      // rejeição ou aceite. A Meta pode já ter recebido e processado
      // a requisição mesmo que a NOSSA conexão tenha falhado depois.
      const reason = (thrown instanceof Error && thrown.name === 'AbortError') ? 'timeout' : 'network_error';
      return { outcome: 'UNCERTAIN', reason, httpStatus: null };
    }

    const rawBody = await response.text();
    const httpStatus = response.status;

    if (httpStatus >= 200 && httpStatus < 300) {
      const wamid = extractWamid(rawBody);
      if (wamid === null) {
        // 2xx sem wamid válido — resposta ambígua, nunca presumida
        // como aceite real.
        return { outcome: 'UNCERTAIN', reason: 'accepted_without_valid_wamid', httpStatus };
      }
      return { outcome: 'ACCEPTED', externalMessageId: wamid };
    }

    if (DEFINITIVE_REJECTION_HTTP_STATUSES.has(httpStatus)) {
      const errorCode = extractMetaErrorCode(rawBody);
      if (errorCode !== null) {
        return { outcome: 'REJECTED_DEFINITIVE', errorCode, httpStatus };
      }
      // Status de rejeição mas corpo não comprova a forma de erro da
      // Meta — nunca classificado como definitivo sem essa prova.
      return { outcome: 'UNCERTAIN', reason: 'rejection_status_without_meta_error_body', httpStatus };
    }

    // 401/403 (pode ser problema do NOSSO token, nao da mensagem),
    // 429 (rate limit, nao rejeicao de conteudo), 5xx (erro do lado da
    // Meta, resultado desconhecido) — todos UNCERTAIN, nunca
    // presumidos como falha definitiva da MENSAGEM.
    return { outcome: 'UNCERTAIN', reason: `unclassified_http_status_${httpStatus}`, httpStatus };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
