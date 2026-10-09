import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  parseWhatsAppWebhookPayload,
} from './whatsappWebhook.ts';

const SECRET = 'test-app-secret-do-not-leak';

async function computeSignature(body: string | Uint8Array, secret: string): Promise<string> {
  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, bodyBytes);
  const hex = Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('verifyWhatsAppWebhookChallenge', () => {
  test('valido: mode=subscribe, token correto, challenge presente', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'tok', challenge: 'xyz' }, 'tok');
    expect(result).toEqual({ valid: true, challenge: 'xyz' });
  });

  test('token errado -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'errado', challenge: 'xyz' }, 'tok');
    expect(result).toEqual({ valid: false });
  });

  test('mode errado -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'unsubscribe', verifyToken: 'tok', challenge: 'xyz' }, 'tok');
    expect(result).toEqual({ valid: false });
  });

  test('challenge ausente -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'tok', challenge: undefined }, 'tok');
    expect(result).toEqual({ valid: false });
  });

  test('verify token ausente -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: undefined, challenge: 'xyz' }, 'tok');
    expect(result).toEqual({ valid: false });
  });

  test('configured token ausente -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'tok', challenge: 'xyz' }, undefined);
    expect(result).toEqual({ valid: false });
  });

  test('configured token vazio -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: '', challenge: 'xyz' }, '');
    expect(result).toEqual({ valid: false });
  });

  test('configured token whitespace-only -> invalid', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: '   ', challenge: 'xyz' }, '   ');
    expect(result).toEqual({ valid: false });
  });

  test('challenge vazio -> invalid (decisao consciente, Fase 3.3.3.1)', () => {
    const result = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'tok', challenge: '' }, 'tok');
    expect(result).toEqual({ valid: false });
  });

  test('input nao e objeto -> invalid', () => {
    expect(verifyWhatsAppWebhookChallenge(null, 'tok')).toEqual({ valid: false });
    expect(verifyWhatsAppWebhookChallenge(undefined, 'tok')).toEqual({ valid: false });
  });

  test('token nunca aparece no result (nem valido nem invalido)', () => {
    const validResult = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'secret-token-123', challenge: 'xyz' }, 'secret-token-123');
    expect(JSON.stringify(validResult)).not.toContain('secret-token-123');
    const invalidResult = verifyWhatsAppWebhookChallenge({ mode: 'subscribe', verifyToken: 'wrong', challenge: 'xyz' }, 'secret-token-123');
    expect(JSON.stringify(invalidResult)).not.toContain('secret-token-123');
  });
});

describe('verifyWhatsAppWebhookSignature', () => {
  test('assinatura valida sobre body conhecido', async () => {
    const body = '{"a":1}';
    const sig = await computeSignature(body, SECRET);
    const result = await verifyWhatsAppWebhookSignature(body, sig, SECRET);
    expect(result).toEqual({ valid: true });
  });

  test('body alterado por 1 byte invalida a assinatura', async () => {
    const body = '{"a":1}';
    const sig = await computeSignature(body, SECRET);
    const tamperedBody = '{"a":2}';
    const result = await verifyWhatsAppWebhookSignature(tamperedBody, sig, SECRET);
    expect(result).toEqual({ valid: false });
  });

  test('signature ausente -> invalid', async () => {
    const result = await verifyWhatsAppWebhookSignature('{"a":1}', undefined, SECRET);
    expect(result).toEqual({ valid: false });
  });

  test('prefixo errado -> invalid', async () => {
    const body = '{"a":1}';
    const sig = await computeSignature(body, SECRET);
    const wrongPrefix = sig.replace('sha256=', 'sha1=');
    const result = await verifyWhatsAppWebhookSignature(body, wrongPrefix, SECRET);
    expect(result).toEqual({ valid: false });
  });

  test('hex invalido (nao-hex) -> invalid', async () => {
    const result = await verifyWhatsAppWebhookSignature('{"a":1}', 'sha256=not-hex-zzzz', SECRET);
    expect(result).toEqual({ valid: false });
  });

  test('hex tamanho impar -> invalid', async () => {
    const result = await verifyWhatsAppWebhookSignature('{"a":1}', 'sha256=abc', SECRET);
    expect(result).toEqual({ valid: false });
  });

  test('hex vazio (so prefixo) -> invalid', async () => {
    const result = await verifyWhatsAppWebhookSignature('{"a":1}', 'sha256=', SECRET);
    expect(result).toEqual({ valid: false });
  });

  test('secret vazio -> invalid, nunca chama crypto', async () => {
    const result = await verifyWhatsAppWebhookSignature('{"a":1}', 'sha256=aabbcc', '');
    expect(result).toEqual({ valid: false });
  });

  test('secret ausente -> invalid', async () => {
    const result = await verifyWhatsAppWebhookSignature('{"a":1}', 'sha256=aabbcc', undefined);
    expect(result).toEqual({ valid: false });
  });

  test('body vazio com assinatura correta -> valid', async () => {
    const body = '';
    const sig = await computeSignature(body, SECRET);
    const result = await verifyWhatsAppWebhookSignature(body, sig, SECRET);
    expect(result).toEqual({ valid: true });
  });

  test('body com unicode UTF-8 -> assinatura valida', async () => {
    const body = '{"nome":"José • Ñandú 😀"}';
    const sig = await computeSignature(body, SECRET);
    const result = await verifyWhatsAppWebhookSignature(body, sig, SECRET);
    expect(result).toEqual({ valid: true });
  });

  test('body com newline/whitespace significativo -> assinatura e sobre bytes exatos', async () => {
    const body = '{\n  "a": 1\n}';
    const sig = await computeSignature(body, SECRET);
    // Mesmo JSON, serializado sem os espacos/newlines (semanticamente igual, bytes diferentes)
    const reserialized = JSON.stringify(JSON.parse(body));
    const resultOriginal = await verifyWhatsAppWebhookSignature(body, sig, SECRET);
    const resultReserialized = await verifyWhatsAppWebhookSignature(reserialized, sig, SECRET);
    expect(resultOriginal).toEqual({ valid: true });
    expect(resultReserialized).toEqual({ valid: false }); // prova: assinatura e sobre bytes, nao sobre objeto JSON
  });

  test('aceita Uint8Array diretamente como rawBody', async () => {
    const body = '{"a":1}';
    const bodyBytes = new TextEncoder().encode(body);
    const sig = await computeSignature(bodyBytes, SECRET);
    const result = await verifyWhatsAppWebhookSignature(bodyBytes, sig, SECRET);
    expect(result).toEqual({ valid: true });
  });

  test('nenhum erro/result contem o secret', async () => {
    const body = '{"a":1}';
    const result = await verifyWhatsAppWebhookSignature(body, 'sha256=invalid', SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

const PHONE_NUMBER_ID = '1234567890';

function buildPayload(messages: unknown[], opts: { statuses?: unknown[]; contacts?: unknown[]; changeField?: string } = {}) {
  const value: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '555199999999', phone_number_id: PHONE_NUMBER_ID },
  };
  if (opts.contacts !== undefined) value.contacts = opts.contacts;
  if (messages.length > 0) value.messages = messages;
  if (opts.statuses !== undefined) value.statuses = opts.statuses;

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [{ field: opts.changeField ?? 'messages', value }],
      },
    ],
  };
}

const VALID_MESSAGE = {
  from: '5551992322166',
  id: 'wamid.ABC123',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'Oi' },
};

const VALID_CONTACT = { profile: { name: 'Maria' }, wa_id: '5551992322166' };

describe('parseWhatsAppWebhookPayload — top-level', () => {
  test('object != whatsapp_business_account -> UNSUPPORTED_PAYLOAD', () => {
    const result = parseWhatsAppWebhookPayload({ object: 'page', entry: [] }, new Date());
    expect(result).toEqual({ outcome: 'UNSUPPORTED_PAYLOAD' });
  });

  test('payload null -> UNSUPPORTED_PAYLOAD', () => {
    expect(parseWhatsAppWebhookPayload(null, new Date())).toEqual({ outcome: 'UNSUPPORTED_PAYLOAD' });
  });

  test('payload array -> UNSUPPORTED_PAYLOAD', () => {
    expect(parseWhatsAppWebhookPayload([], new Date())).toEqual({ outcome: 'UNSUPPORTED_PAYLOAD' });
  });

  test('entry ausente -> OK, zero messages, zero issues', () => {
    const result = parseWhatsAppWebhookPayload({ object: 'whatsapp_business_account' }, new Date());
    expect(result).toEqual({ outcome: 'OK', messages: [], statusEvents: [], issues: [], statusOnly: false });
  });

  test('entry nao-array -> OK, tratado como vazio', () => {
    const result = parseWhatsAppWebhookPayload({ object: 'whatsapp_business_account', entry: 'nao-array' }, new Date());
    expect(result).toEqual({ outcome: 'OK', messages: [], statusEvents: [], issues: [], statusOnly: false });
  });

  test('changes ausente -> OK, zero messages', () => {
    const result = parseWhatsAppWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: 'w1' }] }, new Date());
    expect(result).toEqual({ outcome: 'OK', messages: [], statusEvents: [], issues: [], statusOnly: false });
  });

  test('changes nao-array -> OK, tratado como vazio', () => {
    const result = parseWhatsAppWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: 'w1', changes: 'x' }] }, new Date());
    expect(result).toEqual({ outcome: 'OK', messages: [], statusEvents: [], issues: [], statusOnly: false });
  });

  test('change field diferente de messages -> ignorado deterministicamente, zero issue', () => {
    const payload = buildPayload([], { changeField: 'account_update' });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    expect(result).toEqual({ outcome: 'OK', messages: [], statusEvents: [], issues: [], statusOnly: false });
  });
});

describe('parseWhatsAppWebhookPayload — mensagens', () => {
  test('uma mensagem text', () => {
    const payload = buildPayload([VALID_MESSAGE], { contacts: [VALID_CONTACT] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    expect(result.outcome).toBe('OK');
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
    expect(result.statusOnly).toBe(false);
    const msg = result.messages[0];
    expect(msg.provider).toBe('whatsapp');
    expect(msg.externalEventId).toBe('wamid.ABC123');
    expect(msg.externalMessageId).toBe('wamid.ABC123');
    expect(msg.externalAccountId).toBe(PHONE_NUMBER_ID);
    expect(msg.senderPhoneRaw).toBe('5551992322166');
    expect(msg.senderDisplayName).toBe('Maria');
    expect(msg.text).toBe('Oi');
    expect(msg.messageType).toBe('text');
  });

  test('externalEventId === externalMessageId sempre', () => {
    const payload = buildPayload([VALID_MESSAGE]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].externalEventId).toBe(result.messages[0].externalMessageId);
  });

  test('provider e sempre "whatsapp" hardcoded, nunca lido do payload', () => {
    const payload = buildPayload([VALID_MESSAGE]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].provider).toBe('whatsapp');
  });

  test('uma mensagem non-text (image): text=null, messageType preservado', () => {
    const imageMessage = { from: '5551992322166', id: 'wamid.IMG1', timestamp: '1700000000', type: 'image', image: { id: 'media-1' } };
    const payload = buildPayload([imageMessage]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].text).toBeNull();
    expect(result.messages[0].messageType).toBe('image');
  });

  test.each(['audio', 'video', 'document', 'location', 'contacts', 'interactive', 'button', 'reaction', 'sticker', 'order', 'system', 'future_unknown_type'])(
    'tipo nao-texto "%s": text=null, messageType preservado',
    (type) => {
      const message = { from: '5551992322166', id: `wamid.${type}`, timestamp: '1700000000', type };
      const payload = buildPayload([message]);
      const result = parseWhatsAppWebhookPayload(payload, new Date());
      if (result.outcome !== 'OK') throw new Error('unreachable');
      expect(result.messages[0].text).toBeNull();
      expect(result.messages[0].messageType).toBe(type);
    },
  );

  test('multiplas messages no mesmo change', () => {
    const m1 = { ...VALID_MESSAGE, id: 'wamid.1', from: '5551992322166' };
    const m2 = { ...VALID_MESSAGE, id: 'wamid.2', from: '5551992322167' };
    const m3 = { ...VALID_MESSAGE, id: 'wamid.3', from: '5551992322168' };
    const payload = buildPayload([m1, m2, m3]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.externalMessageId)).toEqual(['wamid.1', 'wamid.2', 'wamid.3']);
  });

  test('multiplas entries e multiplas changes -> todas iteradas, nunca somente [0]', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        { id: 'waba-1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'acc-1' }, messages: [{ from: 'p1', id: 'wamid.e0c0', timestamp: '1700000000', type: 'text', text: { body: 'a' } }] } }] },
        {
          id: 'waba-2',
          changes: [
            { field: 'messages', value: { metadata: { phone_number_id: 'acc-2' }, messages: [{ from: 'p2', id: 'wamid.e1c0', timestamp: '1700000000', type: 'text', text: { body: 'b' } }] } },
            { field: 'messages', value: { metadata: { phone_number_id: 'acc-3' }, messages: [{ from: 'p3', id: 'wamid.e1c1', timestamp: '1700000000', type: 'text', text: { body: 'c' } }] } },
          ],
        },
      ],
    };
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.externalMessageId)).toEqual(['wamid.e0c0', 'wamid.e1c0', 'wamid.e1c1']);
    expect(result.messages.map((m) => m.externalAccountId)).toEqual(['acc-1', 'acc-2', 'acc-3']);
  });

  test('missing metadata -> issue missing_phone_number_id, mensagem nao gerada', () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'w1', changes: [{ field: 'messages', value: { messages: [VALID_MESSAGE] } }] }] };
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(0);
    expect(result.issues).toEqual([{ code: 'missing_phone_number_id', entryIndex: 0, changeIndex: 0, messageIndex: 0 }]);
  });

  test('missing phone_number_id explicito -> issue, mensagem nao gerada', () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'w1', changes: [{ field: 'messages', value: { metadata: {}, messages: [VALID_MESSAGE] } }] }] };
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.issues[0].code).toBe('missing_phone_number_id');
  });

  test('missing message id -> issue missing_message_id', () => {
    const { id, ...withoutId } = VALID_MESSAGE;
    const payload = buildPayload([withoutId]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.issues[0].code).toBe('missing_message_id');
    expect(result.messages).toHaveLength(0);
  });

  test('missing from -> issue missing_sender_phone', () => {
    const { from, ...withoutFrom } = VALID_MESSAGE;
    const payload = buildPayload([withoutFrom]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.issues[0].code).toBe('missing_sender_phone');
  });

  test('missing type -> issue missing_message_type', () => {
    const { type, ...withoutType } = VALID_MESSAGE;
    const payload = buildPayload([withoutType]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.issues[0].code).toBe('missing_message_type');
  });

  test('missing timestamp com receivedAt valido -> usa receivedAt como fallback', () => {
    const { timestamp, ...withoutTimestamp } = VALID_MESSAGE;
    const payload = buildPayload([withoutTimestamp]);
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    const result = parseWhatsAppWebhookPayload(payload, receivedAt);
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('timestamp invalido com receivedAt valido -> usa receivedAt', () => {
    const payload = buildPayload([{ ...VALID_MESSAGE, timestamp: 'nao-e-numero' }]);
    const receivedAt = new Date('2026-02-02T00:00:00.000Z');
    const result = parseWhatsAppWebhookPayload(payload, receivedAt);
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].occurredAt).toBe('2026-02-02T00:00:00.000Z');
  });

  test('timestamp invalido sem receivedAt valido -> issue missing_or_invalid_timestamp', () => {
    const payload = buildPayload([{ ...VALID_MESSAGE, timestamp: 'nao-e-numero' }]);
    const result = parseWhatsAppWebhookPayload(payload, undefined);
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.issues[0].code).toBe('missing_or_invalid_timestamp');
    expect(result.messages).toHaveLength(0);
  });

  test('timestamp unix seconds valido -> ISO correto', () => {
    const payload = buildPayload([{ ...VALID_MESSAGE, timestamp: '1700000000' }]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].occurredAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  test('missing contacts -> senderDisplayName undefined (fallback do Engine)', () => {
    const payload = buildPayload([VALID_MESSAGE]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].senderDisplayName).toBeUndefined();
  });

  test('multiple contacts: correlaciona pelo wa_id correto, nunca contacts[0]', () => {
    const outroContact = { profile: { name: 'Nome Errado' }, wa_id: '0000000000000' };
    const payload = buildPayload([VALID_MESSAGE], { contacts: [outroContact, VALID_CONTACT] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].senderDisplayName).toBe('Maria');
  });

  test('display name ausente no contact correlacionado -> undefined', () => {
    const contactSemNome = { profile: {}, wa_id: '5551992322166' };
    const payload = buildPayload([VALID_MESSAGE], { contacts: [contactSemNome] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].senderDisplayName).toBeUndefined();
  });

  test('text body vazio -> preservado exatamente (string vazia, nao null)', () => {
    const payload = buildPayload([{ ...VALID_MESSAGE, text: { body: '' } }]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].text).toBe('');
  });

  test('text body com espacos -> preservado exatamente, nunca trimado', () => {
    const payload = buildPayload([{ ...VALID_MESSAGE, text: { body: '  oi  ' } }]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages[0].text).toBe('  oi  ');
  });

  test('malformed message + valid message no mesmo payload: valida sobrevive, malformada isolada em issue', () => {
    const { id, ...malformed } = VALID_MESSAGE;
    const valid = { ...VALID_MESSAGE, id: 'wamid.VALID' };
    const payload = buildPayload([malformed, valid]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].externalMessageId).toBe('wamid.VALID');
    expect(result.issues).toEqual([{ code: 'missing_message_id', entryIndex: 0, changeIndex: 0, messageIndex: 0 }]);
  });

  test('issue nunca contem telefone/texto/display name — so posicao estrutural + code', () => {
    const { id, ...malformed } = VALID_MESSAGE;
    const payload = buildPayload([malformed]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    const issue = result.issues[0];
    expect(Object.keys(issue).sort()).toEqual(['code', 'entryIndex', 'changeIndex', 'messageIndex'].sort());
  });
});

describe('parseWhatsAppWebhookPayload — status-only e mixed', () => {
  test('status-only payload: zero messages, statusOnly=true, status extraido (timestamp ausente cai para receivedAt)', () => {
    const payload = buildPayload([], { statuses: [{ id: 'wamid.status1', status: 'read', recipient_id: '5551992322166' }] });
    const now = new Date('2026-01-10T12:00:00.000Z');
    const result = parseWhatsAppWebhookPayload(payload, now);
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toEqual([]);
    expect(result.statusOnly).toBe(true);
    expect(result.statusEvents).toEqual([{
      provider: 'whatsapp',
      externalAccountId: PHONE_NUMBER_ID,
      externalMessageId: 'wamid.status1',
      status: 'read',
      occurredAt: now.toISOString(),
      errorCode: undefined,
    }]);
  });

  test('payload vazio (sem messages e sem statuses): statusOnly=false, statusEvents vazio', () => {
    const payload = buildPayload([]);
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    expect(result).toEqual({ outcome: 'OK', messages: [], statusEvents: [], issues: [], statusOnly: false });
  });

  test('mixed: messages + statuses -> ambos extraidos, statusOnly=false', () => {
    const payload = buildPayload([VALID_MESSAGE], { statuses: [{ id: 'wamid.status1', status: 'delivered', timestamp: '1700000100' }] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.messages).toHaveLength(1);
    expect(result.statusEvents).toHaveLength(1);
    expect(result.statusOnly).toBe(false);
  });
});

describe('parseWhatsAppWebhookPayload — eventos de status outbound (Fase 3.5.2.3)', () => {
  test('status sent com timestamp valido -> extraido corretamente', () => {
    const payload = buildPayload([], { statuses: [{ id: 'wamid.OUT1', status: 'sent', timestamp: '1700000200', recipient_id: '5551992322166' }] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents).toEqual([{
      provider: 'whatsapp',
      externalAccountId: PHONE_NUMBER_ID,
      externalMessageId: 'wamid.OUT1',
      status: 'sent',
      occurredAt: new Date(1700000200 * 1000).toISOString(),
      errorCode: undefined,
    }]);
  });

  test('status failed com errors[] -> errorCode extraido do primeiro erro', () => {
    const payload = buildPayload([], {
      statuses: [{
        id: 'wamid.OUT2',
        status: 'failed',
        timestamp: '1700000300',
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      }],
    });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents[0].errorCode).toBe('131026');
  });

  test('status failed SEM errors[] -> errorCode undefined, nunca inventado', () => {
    const payload = buildPayload([], { statuses: [{ id: 'wamid.OUT3', status: 'failed', timestamp: '1700000300' }] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents[0].errorCode).toBeUndefined();
  });

  test('multiplos status no mesmo payload (item obrigatorio) -> todos extraidos, em ordem', () => {
    const payload = buildPayload([], {
      statuses: [
        { id: 'wamid.M1', status: 'sent', timestamp: '1700000100' },
        { id: 'wamid.M2', status: 'delivered', timestamp: '1700000200' },
        { id: 'wamid.M3', status: 'read', timestamp: '1700000300' },
      ],
    });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents.map((e) => [e.externalMessageId, e.status])).toEqual([
      ['wamid.M1', 'sent'],
      ['wamid.M2', 'delivered'],
      ['wamid.M3', 'read'],
    ]);
  });

  test('status entry nao-objeto -> issue invalid_status_entry, nunca lanca', () => {
    const payload = buildPayload([], { statuses: ['nao-e-objeto'] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents).toHaveLength(0);
    expect(result.issues).toEqual([{ code: 'invalid_status_entry', entryIndex: 0, changeIndex: 0, messageIndex: 0 }]);
  });

  test('status sem id -> issue missing_status_message_id', () => {
    const payload = buildPayload([], { statuses: [{ status: 'sent', timestamp: '1700000100' }] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents).toHaveLength(0);
    expect(result.issues[0].code).toBe('missing_status_message_id');
  });

  test('status sem valor de status -> issue missing_status_value', () => {
    const payload = buildPayload([], { statuses: [{ id: 'wamid.X', timestamp: '1700000100' }] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents).toHaveLength(0);
    expect(result.issues[0].code).toBe('missing_status_value');
  });

  test('status com valor nao suportado (ex. "deleted") -> issue unsupported_status_value, nunca propagado', () => {
    const payload = buildPayload([], { statuses: [{ id: 'wamid.X', status: 'deleted', timestamp: '1700000100' }] });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents).toHaveLength(0);
    expect(result.issues[0].code).toBe('unsupported_status_value');
  });

  test('status sem metadata.phone_number_id -> issue missing_phone_number_id, nunca aceita conta sem identificador confiavel', () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'w1', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'sent', timestamp: '1700000100' }] } }] }] };
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents).toHaveLength(0);
    expect(result.issues[0].code).toBe('missing_phone_number_id');
  });

  test('um status malformado nao descarta os demais validos do mesmo payload', () => {
    const payload = buildPayload([], {
      statuses: [
        { id: 'wamid.BOM1', status: 'sent', timestamp: '1700000100' },
        { status: 'delivered', timestamp: '1700000200' }, // sem id
        { id: 'wamid.BOM2', status: 'read', timestamp: '1700000300' },
      ],
    });
    const result = parseWhatsAppWebhookPayload(payload, new Date());
    if (result.outcome !== 'OK') throw new Error('unreachable');
    expect(result.statusEvents.map((e) => e.externalMessageId)).toEqual(['wamid.BOM1', 'wamid.BOM2']);
    expect(result.issues).toHaveLength(1);
  });
});

describe('auditoria estatica de seguranca (whatsappWebhook.ts)', () => {
  const source = readFileSync(new URL('./whatsappWebhook.ts', import.meta.url), 'utf8');
  const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  const forbiddenPatterns = [
    ['Deno.env', /Deno\.env/],
    ['npm: specifier', /npm:/],
    ['supabase client', /createClient|SupabaseClient/],
    ['service_role', /service_role/],
    ['anon key', /anon.?key/i],
    ['fetch(', /fetch\(/],
    ['graph.facebook.com', /graph\.facebook\.com/],
    ['access_token', /access_token/],
    ['console.log', /console\.log/],
    ['Request handler/HTTP server', /Deno\.serve|addEventListener\('fetch'/],
    ['DB query', /\.from\(['"]/],
  ];

  test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
    expect(codeLines).not.toMatch(pattern);
  });
});
