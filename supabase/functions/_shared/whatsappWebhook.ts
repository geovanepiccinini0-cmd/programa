// Fase 3.3.3.1 — Pure WhatsApp Webhook Contracts.
//
// Três helpers puros e independentes para a futura Edge Function de
// webhook (Fase 3.3.3.3, fora desta fase): verificação do handshake
// GET, verificação de assinatura HMAC do POST, e parsing do payload
// WhatsApp Cloud API já autenticado. Nenhum deles toca rede, DB,
// Supabase, Deno.env, ou qualquer side effect — 100% testável em
// Vitest/Node (Web Crypto API é padrão global tanto em Deno quanto em
// Node 18+, nenhuma dependência nova necessária).
//
// Zero HTTP server, zero Request handler, zero webhook real criado
// nesta fase — isso é responsabilidade exclusiva da Fase 3.3.3.3.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

import type { CanonicalInboundEvent } from './inboundEngine.ts';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ===========================================================================
// A) GET VERIFICATION HELPER
// ===========================================================================
//
// Handshake de verificação da Meta (GET com hub.mode/hub.verify_token/
// hub.challenge). Zero DB, zero env access, zero HTTP Response — essa
// função só decide valid/invalid, a Edge Function futura decide como
// responder. Nunca loga o verify token (nem no result, nem implicitamente).

export interface VerifyWebhookChallengeInput {
  mode: unknown;
  verifyToken: unknown;
  challenge: unknown;
}

export type WebhookChallengeResult =
  | { valid: true; challenge: string }
  | { valid: false };

// Challenge vazio é tratado como invalid (decisão consciente, Fase
// 3.3.3.1): não há nada significativo para ecoar de volta, e a Meta
// nunca envia um challenge vazio em uso legítimo — tratar como invalid
// é a escolha fail-closed, nunca limita um uso real.
export function verifyWhatsAppWebhookChallenge(
  input: VerifyWebhookChallengeInput,
  configuredVerifyToken: unknown,
): WebhookChallengeResult {
  if (input === null || typeof input !== 'object') {
    return { valid: false };
  }

  const { mode, verifyToken, challenge } = input;

  if (mode !== 'subscribe') {
    return { valid: false };
  }
  if (!isNonBlankString(configuredVerifyToken)) {
    return { valid: false };
  }
  if (typeof verifyToken !== 'string' || verifyToken !== configuredVerifyToken) {
    return { valid: false };
  }
  if (typeof challenge !== 'string' || challenge.length === 0) {
    return { valid: false };
  }

  return { valid: true, challenge };
}

// ===========================================================================
// B) SIGNATURE HELPER
// ===========================================================================
//
// Valida X-Hub-Signature-256: sha256=<hex>, HMAC-SHA256 sobre os bytes
// EXATOS do raw body, usando o App Secret. Nunca recebe Request — só
// os bytes já lidos (string ou Uint8Array), o header, e o secret.
// crypto.subtle.verify já é constant-time internamente (não precisamos
// implementar comparação timing-safe manual). Web Crypto API nativa,
// zero dependência nova.
//
// Fail-closed para QUALQUER forma estruturalmente inválida da entrada
// (header ausente, prefixo errado, hex malformado, secret vazio) —
// essas checagens nunca chamam crypto, retornam {valid:false}
// diretamente. Uma falha INESPERADA da própria Web Crypto API (ex.
// ambiente sem suporte) nunca é escondida como {valid:false} — ela
// propaga (throw), para nunca mascarar um bug real como "assinatura
// inválida".

export type SignatureVerificationResult =
  | { valid: true }
  | { valid: false };

const SIGNATURE_PREFIX = 'sha256=';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyWhatsAppWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: unknown,
  appSecret: unknown,
): Promise<SignatureVerificationResult> {
  if (!isNonBlankString(appSecret)) {
    return { valid: false };
  }
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { valid: false };
  }

  const hex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return { valid: false };
  }

  // Conversão única e explícita de string -> bytes, nunca reserializada
  // (o raw body já deve ter sido lido como texto/bytes exatos pelo
  // chamador, antes de qualquer JSON.parse).
  const bodyBytes = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
  const signatureBytes = hexToBytes(hex);
  const secretBytes = new TextEncoder().encode(appSecret);

  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, bodyBytes);

  return { valid: isValid };
}

// ===========================================================================
// C) PAYLOAD PARSER
// ===========================================================================
//
// Recebe um payload JSON JÁ AUTENTICADO (assinatura validada antes,
// fora deste módulo) e decompõe em 0..N CanonicalInboundEvent. Zero
// DB, zero Engine, zero side effect. Nunca lança para shape
// estruturalmente inesperado — um payload top-level incompatível vira
// UNSUPPORTED_PAYLOAD; um item individual malformado (dentro de
// entry/change/message) vira uma `issue` isolada, sem descartar as
// demais mensagens válidas do mesmo payload.

export interface ParseIssue {
  code:
    | 'invalid_entry'
    | 'invalid_change'
    | 'invalid_value'
    | 'invalid_message'
    | 'missing_phone_number_id'
    | 'missing_message_id'
    | 'missing_sender_phone'
    | 'missing_message_type'
    | 'missing_or_invalid_timestamp'
    // Fase 3.5.2.3 — eventos de status outbound (statuses[]).
    | 'invalid_status_entry'
    | 'missing_status_message_id'
    | 'missing_status_value'
    | 'unsupported_status_value'
    | 'missing_or_invalid_status_timestamp';
  entryIndex: number;
  changeIndex?: number;
  messageIndex?: number;
}

// Fase 3.5.2.3 — evento de status outbound (sent/delivered/read/failed)
// de uma mensagem que NÓS enviamos. Canônico e mínimo, mesmo princípio
// de CanonicalInboundEvent — nunca carrega payload bruto, nunca texto
// de mensagem (não existe nesses eventos).
export interface CanonicalOutboundStatusEvent {
  provider: unknown;
  externalAccountId: unknown; // phone_number_id — NUNCA confiado sem resolução de conta.
  externalMessageId: unknown; // wamid da mensagem outbound.
  status: unknown; // 'sent' | 'delivered' | 'read' | 'failed'.
  occurredAt: unknown;
  // Só presente para status='failed' — código de erro da Meta, nunca
  // mensagem de erro livre (pode conter dados do destinatário).
  errorCode?: unknown;
}

export type ParseWhatsAppWebhookPayloadResult =
  | {
      outcome: 'OK';
      messages: CanonicalInboundEvent[];
      statusEvents: CanonicalOutboundStatusEvent[];
      issues: ParseIssue[];
      statusOnly: boolean;
    }
  | { outcome: 'UNSUPPORTED_PAYLOAD' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Unix seconds (nunca milissegundos silenciosamente) — confirmado como
// CONHECIMENTO NÃO VERIFICADO oficialmente na Fase 3.3.3.0; o primeiro
// payload real de homologação deve confirmar esta semântica.
function parseUnixSecondsTimestamp(value: unknown): string | null {
  let seconds: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    seconds = value;
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    seconds = Number(value);
  } else {
    return null;
  }
  if (seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isValidDateInput(value: unknown): value is string | Date {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'string' && value.trim().length > 0) return !Number.isNaN(new Date(value).getTime());
  return false;
}

// receivedAt é dependency/input explícito do chamador — este módulo
// NUNCA chama Date.now()/new Date() sem argumento internamente.
function resolveOccurredAt(rawTimestamp: unknown, receivedAt: unknown): string | null {
  const fromTimestamp = parseUnixSecondsTimestamp(rawTimestamp);
  if (fromTimestamp) return fromTimestamp;
  if (isValidDateInput(receivedAt)) {
    return receivedAt instanceof Date ? receivedAt.toISOString() : new Date(receivedAt).toISOString();
  }
  return null;
}

export function parseWhatsAppWebhookPayload(
  payload: unknown,
  receivedAt: unknown,
): ParseWhatsAppWebhookPayloadResult {
  if (!isPlainObject(payload) || payload.object !== 'whatsapp_business_account') {
    return { outcome: 'UNSUPPORTED_PAYLOAD' };
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const messages: CanonicalInboundEvent[] = [];
  const statusEvents: CanonicalOutboundStatusEvent[] = [];
  const issues: ParseIssue[] = [];
  let sawStatuses = false;
  const SUPPORTED_STATUS_VALUES = new Set(['sent', 'delivered', 'read', 'failed']);

  entries.forEach((entry: unknown, entryIndex: number) => {
    if (!isPlainObject(entry)) {
      issues.push({ code: 'invalid_entry', entryIndex });
      return;
    }

    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    changes.forEach((change: unknown, changeIndex: number) => {
      if (!isPlainObject(change)) {
        issues.push({ code: 'invalid_change', entryIndex, changeIndex });
        return;
      }

      // Changes de outro field (ex. account_update) são ignorados
      // deterministicamente — nunca geram issue, nunca geram mensagem.
      if (change.field !== 'messages') {
        return;
      }

      if (!isPlainObject(change.value)) {
        issues.push({ code: 'invalid_value', entryIndex, changeIndex });
        return;
      }
      const value = change.value;

      const metadata = isPlainObject(value.metadata) ? value.metadata : {};
      const phoneNumberId = metadata.phone_number_id;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const rawMessages = Array.isArray(value.messages) ? value.messages : [];
      const rawStatuses = Array.isArray(value.statuses) ? value.statuses : [];

      if (rawStatuses.length > 0) {
        sawStatuses = true;
      }

      // Fase 3.5.2.3 — eventos de status outbound (statuses[]), MESMO
      // "field: messages" da Meta (nunca um field separado) — nunca
      // confiados sem resolução de conta, feita depois, pela
      // composição (nunca aqui). phoneNumberId é o MESMO já extraído
      // acima para mensagens inbound — a Meta sempre o repete em
      // value.metadata, inbound ou outbound.
      rawStatuses.forEach((rawStatus: unknown, statusIndex: number) => {
        if (!isPlainObject(rawStatus)) {
          issues.push({ code: 'invalid_status_entry', entryIndex, changeIndex, messageIndex: statusIndex });
          return;
        }
        if (!isNonBlankString(phoneNumberId)) {
          issues.push({ code: 'missing_phone_number_id', entryIndex, changeIndex, messageIndex: statusIndex });
          return;
        }
        if (!isNonBlankString(rawStatus.id)) {
          issues.push({ code: 'missing_status_message_id', entryIndex, changeIndex, messageIndex: statusIndex });
          return;
        }
        if (!isNonBlankString(rawStatus.status)) {
          issues.push({ code: 'missing_status_value', entryIndex, changeIndex, messageIndex: statusIndex });
          return;
        }
        if (!SUPPORTED_STATUS_VALUES.has(rawStatus.status)) {
          // Meta pode enviar outros valores (ex. 'deleted') — nunca
          // suportados nesta fase, ignorados deterministicamente
          // (issue registrada, nunca propagada como mensagem/erro).
          issues.push({ code: 'unsupported_status_value', entryIndex, changeIndex, messageIndex: statusIndex });
          return;
        }

        const occurredAt = resolveOccurredAt(rawStatus.timestamp, receivedAt);
        if (!occurredAt) {
          issues.push({ code: 'missing_or_invalid_status_timestamp', entryIndex, changeIndex, messageIndex: statusIndex });
          return;
        }

        const errors = Array.isArray(rawStatus.errors) ? rawStatus.errors : [];
        const firstError = errors.find((e: unknown) => isPlainObject(e));
        const errorCode = firstError && isPlainObject(firstError) && (typeof firstError.code === 'number' || typeof firstError.code === 'string')
          ? String(firstError.code)
          : undefined;

        statusEvents.push({
          provider: 'whatsapp',
          externalAccountId: phoneNumberId,
          externalMessageId: rawStatus.id,
          status: rawStatus.status,
          occurredAt,
          errorCode,
        });
      });

      rawMessages.forEach((rawMessage: unknown, messageIndex: number) => {
        if (!isPlainObject(rawMessage)) {
          issues.push({ code: 'invalid_message', entryIndex, changeIndex, messageIndex });
          return;
        }

        if (!isNonBlankString(phoneNumberId)) {
          issues.push({ code: 'missing_phone_number_id', entryIndex, changeIndex, messageIndex });
          return;
        }
        if (!isNonBlankString(rawMessage.id)) {
          issues.push({ code: 'missing_message_id', entryIndex, changeIndex, messageIndex });
          return;
        }
        if (!isNonBlankString(rawMessage.from)) {
          issues.push({ code: 'missing_sender_phone', entryIndex, changeIndex, messageIndex });
          return;
        }
        if (!isNonBlankString(rawMessage.type)) {
          issues.push({ code: 'missing_message_type', entryIndex, changeIndex, messageIndex });
          return;
        }

        const occurredAt = resolveOccurredAt(rawMessage.timestamp, receivedAt);
        if (!occurredAt) {
          issues.push({ code: 'missing_or_invalid_timestamp', entryIndex, changeIndex, messageIndex });
          return;
        }

        // Correlação por wa_id === from — nunca contacts[0].
        const contact = contacts.find(
          (c: unknown) => isPlainObject(c) && c.wa_id === rawMessage.from,
        );
        const profile = contact && isPlainObject(contact) && isPlainObject(contact.profile) ? contact.profile : undefined;
        const senderDisplayName = profile && typeof profile.name === 'string' ? profile.name : undefined;

        const text = rawMessage.type === 'text' && isPlainObject(rawMessage.text) && typeof rawMessage.text.body === 'string'
          ? rawMessage.text.body
          : null;

        messages.push({
          provider: 'whatsapp',
          externalEventId: rawMessage.id,
          externalAccountId: phoneNumberId,
          externalMessageId: rawMessage.id,
          occurredAt,
          senderPhoneRaw: rawMessage.from,
          senderDisplayName,
          text,
          messageType: rawMessage.type,
        });
      });
    });
  });

  return {
    outcome: 'OK',
    messages,
    statusEvents,
    issues,
    statusOnly: messages.length === 0 && sawStatuses,
  };
}
