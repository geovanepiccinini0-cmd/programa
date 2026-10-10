import { describe, expect, test, vi } from 'vitest';
import { handleWhatsappWebhookRequest, type WebhookHttpRequest, type WhatsappWebhookHandlerDeps } from './handler.ts';

const APP_SECRET = 'app-secret-test-123';
const VERIFY_TOKEN = 'verify-token-test-456';
const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');

async function computeSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

// ===========================================================================
// FAKE SUPABASE CLIENT — in-memory, fiel aos contratos reais (insert/
// select/eq/in/update/rpc) exigidos pelos repositories já aprovados.
// Nunca reimplementa regra de negocio — so arbitra unicidade/matching
// exatamente como o Postgres real faria para os casos exercitados aqui.
// ===========================================================================
function makeFakeClient(opts: {
  events?: Record<string, unknown>[];
  accounts?: Record<string, unknown>[];
  rpcImpl?: (fn: string, params: Record<string, unknown>, client?: ReturnType<typeof makeFakeClient>) => Promise<{ data: unknown; error: unknown }>;
} = {}) {
  const events: Record<string, unknown>[] = [...(opts.events ?? [])];
  const accounts: Record<string, unknown>[] = [...(opts.accounts ?? [])];
  let idCounter = 1;
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];

  function eventsTable() {
    return {
      insert(row: Record<string, unknown>) {
        return {
          select() {
            const conflictByEventId = events.find((e) => e.provider === row.provider && e.external_event_id === row.external_event_id);
            const conflictByMessageId = row.external_message_id != null
              && events.find((e) => e.provider === row.provider && e.external_message_id === row.external_message_id);
            if (conflictByEventId || conflictByMessageId) {
              return Promise.resolve({ data: null, error: { code: '23505' } });
            }
            const newRow: Record<string, unknown> = {
              id: `evt-${idCounter++}`,
              status: 'received',
              integration_account_id: null,
              resolved_user_id: null,
              resolved_lead_id: null,
              resolved_interaction_id: null,
              processing_started_at: null,
              processed_at: null,
              error_code: null,
              retry_count: 0,
              ...row,
            };
            events.push(newRow);
            return Promise.resolve({ data: [newRow], error: null });
          },
        };
      },
      select() {
        const filters: Array<[string, unknown]> = [];
        function runSelect() {
          const matched = events.filter((e) => filters.every(([c, v]) => e[c] === v));
          return { data: matched, error: null };
        }
        const builder = {
          eq(col: string, val: unknown) {
            filters.push([col, val]);
            const chained: Record<string, unknown> = {
              eq(col2: string, val2: unknown) {
                filters.push([col2, val2]);
                return Promise.resolve(runSelect());
              },
              then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
                return Promise.resolve(runSelect()).then(resolve, reject);
              },
            };
            return chained;
          },
        };
        return builder;
      },
      update(patch: Record<string, unknown>) {
        return {
          eq(col: string, val: unknown) {
            return {
              in(col2: string, vals: readonly string[]) {
                return {
                  select() {
                    const idx = events.findIndex((e) => e[col] === val && vals.includes(e[col2] as string));
                    if (idx === -1) return Promise.resolve({ data: [], error: null });
                    events[idx] = { ...events[idx], ...patch };
                    return Promise.resolve({ data: [{ id: events[idx].id }], error: null });
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  function accountsTable() {
    return {
      select() {
        const filters: Array<[string, unknown]> = [];
        return {
          eq(col: string, val: unknown) {
            filters.push([col, val]);
            return {
              eq(col2: string, val2: unknown) {
                filters.push([col2, val2]);
                const matched = accounts.filter((a) => filters.every(([c, v]) => a[c] === v));
                return Promise.resolve({ data: matched, error: null });
              },
            };
          },
        };
      },
    };
  }

  const client = {
    from(table: string) {
      if (table === 'integration_events') return eventsTable();
      if (table === 'integration_accounts') return accountsTable();
      throw new Error(`fake client: tabela nao suportada: ${table}`);
    },
    rpc(fn: string, params: Record<string, unknown>) {
      rpcCalls.push({ fn, params });
      if (opts.rpcImpl) return opts.rpcImpl(fn, params, client);
      return Promise.resolve({ data: null, error: new Error('rpc nao mockada neste teste') });
    },
    _events: events,
    _rpcCalls: rpcCalls,
  };
  return client;
}

function makeDeps(overrides: Partial<WhatsappWebhookHandlerDeps> = {}, client?: ReturnType<typeof makeFakeClient>) {
  const getServiceClient = vi.fn(() => client ?? makeFakeClient());
  return {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    getServiceClient,
    now: vi.fn(() => FIXED_NOW),
    ...overrides,
  } satisfies WhatsappWebhookHandlerDeps;
}

const RESOLVED_ACCOUNT = {
  id: 'ia-1',
  provider: 'whatsapp',
  external_account_id: 'phone-number-id-1',
  user_id: 'user-1',
  active: true,
};

// Simula o efeito colateral real da RPC hardened (017): marcar o
// integration_event como processed, com os resolved_* preenchidos, na
// MESMA "transacao" (aqui, so a mesma chamada de rpcImpl) que retorna
// o resultado — exatamente como process_inbound_whatsapp_event faz no
// banco real. Sem isso, o fake client nao reproduziria fielmente o
// estado pos-chamada que o handler depende para os testes de matriz.
function rpcSuccess(leadId = 'lead-1', interactionId = 'int-1', wasNewLead = true) {
  return async (_fn: string, params: Record<string, unknown>, client?: ReturnType<typeof makeFakeClient>) => {
    if (client) {
      const idx = client._events.findIndex((e) => e.id === params.p_integration_event_id);
      if (idx !== -1) {
        client._events[idx] = {
          ...client._events[idx],
          status: 'processed',
          resolved_lead_id: leadId,
          resolved_interaction_id: interactionId,
          processed_at: FIXED_NOW.toISOString(),
        };
      }
    }
    return { data: [{ lead_id: leadId, interaction_id: interactionId, was_new_lead: wasNewLead, event_status: 'processed' }], error: null };
  };
}

// Fase 3.6.2 — process_inbound_whatsapp_event agora é sempre seguida,
// em melhor esforço, por uma chamada a
// apply_whatsapp_conversation_operational_event (handler.ts, quando
// PROCESSED) — um eixo secundário, nunca o foco destes testes de
// ingress/idempotência. Esta helper isola só as chamadas à RPC de
// inbound em si, preservando a intenção original de cada assert.
function inboundRpcCalls(client: ReturnType<typeof makeFakeClient>) {
  return client._rpcCalls.filter((c) => c.fn === 'process_inbound_whatsapp_event');
}

function textMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-number-id-1', display_phone_number: '+5551999990000' },
              contacts: [{ wa_id: '5551999990001', profile: { name: 'Cliente Teste' } }],
              messages: [
                { id: 'wamid.MSG1', from: '5551999990001', timestamp: '1735732800', type: 'text', text: { body: 'Oi, quero informacoes' } },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

function statusOnlyPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-number-id-1' },
              statuses: [{ id: 'wamid.MSG1', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
}

async function postRequest(bodyObj: unknown, secret = APP_SECRET): Promise<WebhookHttpRequest> {
  const rawBody = JSON.stringify(bodyObj);
  const signatureHeader = await computeSignature(rawBody, secret);
  return { method: 'POST', rawBody, signatureHeader };
}

// ===========================================================================
// GET — seções 44/36
// ===========================================================================
describe('GET — verificacao Meta', () => {
  test('mode/token/challenge validos -> 200 com challenge, zero client', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'GET', getVerification: { mode: 'subscribe', verifyToken: VERIFY_TOKEN, challenge: 'challenge-abc' } };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res).toEqual({ status: 200, body: 'challenge-abc', contentType: 'text/plain' });
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('mode errado -> 403, zero client', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'GET', getVerification: { mode: 'unsubscribe', verifyToken: VERIFY_TOKEN, challenge: 'x' } };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(403);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('token errado -> 403, zero client', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'GET', getVerification: { mode: 'subscribe', verifyToken: 'token-errado', challenge: 'x' } };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(403);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('token ausente -> 403', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'GET', getVerification: { mode: 'subscribe', verifyToken: undefined, challenge: 'x' } };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(403);
  });

  test('challenge ausente -> 403', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'GET', getVerification: { mode: 'subscribe', verifyToken: VERIFY_TOKEN, challenge: undefined } };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(403);
  });

  test('resposta nunca contem o verify token configurado', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'GET', getVerification: { mode: 'subscribe', verifyToken: 'errado', challenge: 'x' } };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.body).not.toContain(VERIFY_TOKEN);
  });
});

// ===========================================================================
// SIGNATURE — seções 45/35
// ===========================================================================
describe('POST — assinatura', () => {
  test('header ausente -> 401, zero client', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'POST', rawBody: JSON.stringify(textMessagePayload()), signatureHeader: undefined };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('prefixo invalido -> 401, zero client', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'POST', rawBody: JSON.stringify(textMessagePayload()), signatureHeader: 'md5=abcdef' };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('hex invalido -> 401, zero client', async () => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'POST', rawBody: JSON.stringify(textMessagePayload()), signatureHeader: 'sha256=not-hex-zzz' };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('assinatura errada (secret diferente) -> 401, zero client', async () => {
    const deps = makeDeps();
    const req = await postRequest(textMessagePayload(), 'secret-errado');
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('corpo com whitespace diferente invalida a assinatura (byte-exatidao)', async () => {
    const deps = makeDeps();
    const bodyObj = textMessagePayload();
    const originalBody = JSON.stringify(bodyObj);
    const signatureHeader = await computeSignature(originalBody, APP_SECRET);
    const reserializedBody = JSON.stringify(bodyObj, null, 2); // mesmo conteudo semantico, bytes diferentes
    const req: WebhookHttpRequest = { method: 'POST', rawBody: reserializedBody, signatureHeader };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('assinatura correta -> processa (nao fica em 401)', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(deps.getServiceClient).toHaveBeenCalledTimes(1);
  });

  test('secret ausente/vazio -> helper rejeita, 401, zero client', async () => {
    const deps = makeDeps({ appSecret: undefined });
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// DIAGNÓSTICO TEMPORÁRIO DE ASSINATURA — instrumentação mínima,
// ativada SOMENTE quando a assinatura é invalida (handler.ts,
// logWhatsappWebhookSignatureFailure). Nunca loga secret/assinatura/
// cabeçalho completo/corpo — só os 4 indicadores booleanos. Estes
// testes cobrem exatamente os 4 cenários pedidos (ausente, malformada,
// secret ausente, HMAC divergente) e confirmam que o comportamento
// HTTP (status, zero client) permanece idêntico ao já aprovado.
// ===========================================================================
describe('POST — diagnostico de assinatura (instrumentacao temporaria, remover apos a causa raiz confirmada)', () => {
  function lastDiagnosticLog(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse(spy.mock.calls[0][0] as string);
  }

  test('assinatura ausente -> loga hasSignatureHeader=false, nunca o valor de nenhum campo sensivel', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'POST', rawBody: JSON.stringify(textMessagePayload()), signatureHeader: undefined };
    const res = await handleWhatsappWebhookRequest(req, deps);

    expect(res.status).toBe(401); // comportamento HTTP inalterado
    expect(deps.getServiceClient).not.toHaveBeenCalled();

    const logged = lastDiagnosticLog(logSpy);
    expect(logged).toEqual({
      event: 'whatsapp_webhook_signature_invalid',
      hasSignatureHeader: false,
      signatureHeaderWellFormed: false,
      appSecretConfigured: true,
      signatureValid: false,
    });
    logSpy.mockRestore();
  });

  test('assinatura malformada (prefixo errado) -> loga hasSignatureHeader=true, signatureHeaderWellFormed=false', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method: 'POST', rawBody: JSON.stringify(textMessagePayload()), signatureHeader: 'md5=abcdef' };
    const res = await handleWhatsappWebhookRequest(req, deps);

    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();

    const logged = lastDiagnosticLog(logSpy);
    expect(logged).toEqual({
      event: 'whatsapp_webhook_signature_invalid',
      hasSignatureHeader: true,
      signatureHeaderWellFormed: false,
      appSecretConfigured: true,
      signatureValid: false,
    });
    logSpy.mockRestore();
  });

  test('secret ausente em runtime -> loga appSecretConfigured=false', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = makeDeps({ appSecret: undefined });
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);

    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();

    const logged = lastDiagnosticLog(logSpy);
    expect(logged).toEqual({
      event: 'whatsapp_webhook_signature_invalid',
      hasSignatureHeader: true,
      signatureHeaderWellFormed: true,
      appSecretConfigured: false,
      signatureValid: false,
    });
    logSpy.mockRestore();
  });

  test('HMAC divergente (secret incorreto ou corpo diferente do assinado) -> todos os indicadores true, exceto signatureValid', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = makeDeps();
    const req = await postRequest(textMessagePayload(), 'secret-errado'); // bem formado, mas nao bate com APP_SECRET
    const res = await handleWhatsappWebhookRequest(req, deps);

    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();

    const logged = lastDiagnosticLog(logSpy);
    expect(logged).toEqual({
      event: 'whatsapp_webhook_signature_invalid',
      hasSignatureHeader: true,
      signatureHeaderWellFormed: true,
      appSecretConfigured: true,
      signatureValid: false,
    });
    logSpy.mockRestore();
  });

  test('assinatura valida -> NUNCA loga (instrumentacao so dispara em falha)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);

    expect(res.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('log nunca contem o valor do secret nem da assinatura, mesmo serializado por completo', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = makeDeps();
    const req = await postRequest(textMessagePayload(), 'secret-errado-super-secreto-nao-pode-aparecer');
    await handleWhatsappWebhookRequest(req, deps);

    const allLoggedText = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLoggedText).not.toContain('secret-errado-super-secreto-nao-pode-aparecer');
    expect(allLoggedText).not.toContain(APP_SECRET as string);
    logSpy.mockRestore();
  });
});

// ===========================================================================
// PARSE / JSON — seções 46/37/38
// ===========================================================================
describe('POST — parse e JSON', () => {
  test('JSON invalido apos assinatura valida -> 400, zero client', async () => {
    const deps = makeDeps();
    const rawBody = '{ nao e json valido ][';
    const signatureHeader = await computeSignature(rawBody, APP_SECRET);
    const req: WebhookHttpRequest = { method: 'POST', rawBody, signatureHeader };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(400);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('UNSUPPORTED_PAYLOAD (object != whatsapp_business_account) -> ACK 200, zero client', async () => {
    const deps = makeDeps();
    const req = await postRequest({ object: 'outro_objeto' });
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('status-only (statuses, zero messages), conta nao resolvida -> ACK 200, client criado (Fase 3.5.2.3), zero RPC (NOT_FOUND encerra antes)', async () => {
    const client = makeFakeClient();
    const deps = makeDeps({}, client);
    const req = await postRequest(statusOnlyPayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(deps.getServiceClient).toHaveBeenCalledTimes(1);
    expect(client._rpcCalls).toHaveLength(0);
  });

  test('1 mensagem text -> processada, Engine/RPC chamados', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1);
  });

  test('1 mensagem non-text (image) -> content null, messageType preservado, ainda processada', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const payload = textMessagePayload({ messages: [{ id: 'wamid.IMG1', from: '5551999990001', timestamp: '1735732800', type: 'image', image: { id: 'media-1' } }] });
    const req = await postRequest(payload);
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls[0].params.p_content).toBeNull();
    expect(client._rpcCalls[0].params.p_metadata).toEqual({ message_type: 'image' });
  });

  test('multiplas messages no mesmo payload -> cada uma com seu proprio integration_event/RPC', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const payload = textMessagePayload({
      messages: [
        { id: 'wamid.MULTI1', from: '5551999990001', timestamp: '1735732800', type: 'text', text: { body: 'msg 1' } },
        { id: 'wamid.MULTI2', from: '5551999990001', timestamp: '1735732801', type: 'text', text: { body: 'msg 2' } },
      ],
    });
    const req = await postRequest(payload);
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(2);
    expect(client._events).toHaveLength(2);
  });

  test('com contact name -> nome usa o contact; sem contact name -> fallback WhatsApp+digitos', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const payload = textMessagePayload({ contacts: [] }); // sem contato correspondente
    const req = await postRequest(payload);
    await handleWhatsappWebhookRequest(req, deps);
    expect(client._rpcCalls[0].params.p_nome).toBe('WhatsApp • 0001');
  });
});

// ===========================================================================
// INGRESS RESULT MATRIX — secao 47, nomes reais
// ===========================================================================
describe('POST — matriz de resultado do ingress', () => {
  test('CREATED -> Engine processa, RPC chamada 1x', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1);
    expect(client._events[0].status).toBe('processed');
  });

  test('DUPLICATE processed -> ACK, ZERO account select, ZERO RPC (gate HIGH, sagrado)', async () => {
    const client = makeFakeClient({
      events: [{ id: 'evt-existing', provider: 'whatsapp', external_event_id: 'wamid.MSG1', external_message_id: 'wamid.MSG1', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'processed', received_at: FIXED_NOW.toISOString(), resolved_lead_id: 'lead-x', resolved_interaction_id: 'int-x' }],
      accounts: [RESOLVED_ACCOUNT],
    });
    const accountsSpy = vi.spyOn(client, 'from');
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(0);
    expect(accountsSpy.mock.calls.some((c) => c[0] === 'integration_accounts')).toBe(false);
  });

  test('DUPLICATE ignored -> ACK, zero Engine, zero RPC', async () => {
    const client = makeFakeClient({
      events: [{ id: 'evt-existing', provider: 'whatsapp', external_event_id: 'wamid.MSG1', external_message_id: 'wamid.MSG1', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'ignored', received_at: FIXED_NOW.toISOString(), error_code: 'account_not_found' }],
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(0);
  });

  test('DUPLICATE processing -> ACK, zero Engine, zero RPC', async () => {
    const client = makeFakeClient({
      events: [{ id: 'evt-existing', provider: 'whatsapp', external_event_id: 'wamid.MSG1', external_message_id: 'wamid.MSG1', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'processing', received_at: FIXED_NOW.toISOString() }],
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(0);
  });

  test('DUPLICATE received -> Engine processa normalmente', async () => {
    const client = makeFakeClient({
      events: [{ id: 'evt-existing', provider: 'whatsapp', external_event_id: 'wamid.MSG1', external_message_id: 'wamid.MSG1', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'received', received_at: FIXED_NOW.toISOString() }],
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: rpcSuccess(),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1);
    expect(client._rpcCalls[0].params.p_integration_event_id).toBe('evt-existing');
  });

  test('DUPLICATE failed (sem residuo) -> Engine/RPC tenta retry', async () => {
    const client = makeFakeClient({
      events: [{ id: 'evt-existing', provider: 'whatsapp', external_event_id: 'wamid.MSG1', external_message_id: 'wamid.MSG1', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'failed', received_at: FIXED_NOW.toISOString(), error_code: 'processing_error' }],
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: rpcSuccess(),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1);
  });

  test('IDENTITY_CONFLICT -> NUNCA Engine, ACK (nao gera retry storm), zero RPC', async () => {
    const client = makeFakeClient({
      events: [
        { id: 'evt-a', provider: 'whatsapp', external_event_id: 'wamid.MSG1', external_message_id: 'wamid.OTHER', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'received', received_at: FIXED_NOW.toISOString() },
        { id: 'evt-b', provider: 'whatsapp', external_event_id: 'wamid.OTHER2', external_message_id: 'wamid.MSG1', account_external_id: 'phone-number-id-1', event_type: 'message', status: 'received', received_at: FIXED_NOW.toISOString() },
      ],
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(0);
  });

  test('REPOSITORY_ERROR do ingress (insert nao-23505) -> NUNCA Engine, 500 retryable', async () => {
    const client = makeFakeClient();
    const originalFrom = client.from.bind(client);
    client.from = ((table: string) => {
      const real = originalFrom(table);
      if (table === 'integration_events') {
        return { ...real, insert: () => ({ select: () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }) }) };
      }
      return real;
    }) as typeof client.from;
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
    expect(client._rpcCalls).toHaveLength(0);
  });
});

// ===========================================================================
// ENGINE RESULT MATRIX — secao 48
// ===========================================================================
describe('POST — matriz de resultado do Engine', () => {
  test('PROCESSED -> 200', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
  });

  test('IGNORED (account not found) -> 200, zero RPC', async () => {
    const client = makeFakeClient({ accounts: [] });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(0);
    expect(client._events[0].status).toBe('ignored');
  });

  test('FAILED retryable=true (RPC lanca, fresh read continua received) -> 500', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: async () => { throw new Error('rpc boom'); },
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
    expect(client._events[0].status).toBe('failed');
  });

  test('FAILED retryable=false (account_ambiguous) -> 200 (nao gera retry storm)', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT, { ...RESOLVED_ACCOUNT, id: 'ia-2' }],
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._events[0].status).toBe('failed');
  });

  test('EVENT_RECONCILIATION_FAILED read_failed -> 500 retryable', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: async () => { throw new Error('rpc boom'); },
    });
    const originalFrom = client.from.bind(client);
    let selectCallCount = 0;
    client.from = ((table: string) => {
      const real = originalFrom(table);
      if (table === 'integration_events') {
        return {
          ...real,
          select: (...args: unknown[]) => {
            selectCallCount += 1;
            // primeira leitura (apos insert bem-sucedido nao usa select) -> deixa passar;
            // a releitura de reconciliacao (apos o throw da RPC) falha.
            if (selectCallCount >= 1) {
              return { eq: () => Promise.resolve({ data: null, error: new Error('select boom') }) };
            }
            return (real.select as (...a: unknown[]) => unknown)(...args);
          },
        };
      }
      return real;
    }) as typeof client.from;
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// PRIVACY — secao 49
// ===========================================================================
describe('POST — privacidade das respostas', () => {
  test('resposta de sucesso nunca contem telefone/nome/conteudo/ids internos', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess('lead-secret-id', 'int-secret-id') });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.body).not.toContain('5551999990001');
    expect(res.body).not.toContain('Cliente Teste');
    expect(res.body).not.toContain('Oi, quero informacoes');
    expect(res.body).not.toContain('lead-secret-id');
    expect(res.body).not.toContain('int-secret-id');
    expect(res.body).not.toContain('wamid.MSG1');
  });

  test('resposta de erro (500) nunca contem detalhe interno/secret', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: async () => { throw new Error('detalhe interno sensivel do banco'); } });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('detalhe interno sensivel do banco');
    expect(res.body).not.toContain(APP_SECRET);
    expect(res.body).not.toContain(VERIFY_TOKEN);
  });
});

// ===========================================================================
// METHOD — secao 50
// ===========================================================================
describe('Metodos nao suportados', () => {
  test.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s -> 405, zero client', async (method) => {
    const deps = makeDeps();
    const req: WebhookHttpRequest = { method };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(405);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// EXCECOES INESPERADAS — nunca propagam throw, nunca 2xx indevido
// ===========================================================================
describe('Excecoes inesperadas', () => {
  test('getServiceClient lanca -> 500, nunca propaga throw', async () => {
    const deps = makeDeps({ getServiceClient: vi.fn(() => { throw new Error('client boom'); }) });
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
  });

  test('Engine lanca excecao inesperada (nao-RPC) -> 500, nunca propaga', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT] });
    const originalFrom = client.from.bind(client);
    client.from = ((table: string) => {
      if (table === 'integration_accounts') throw new Error('account repo boom');
      return originalFrom(table);
    }) as typeof client.from;
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// REENTREGA REAL END-TO-END — Fase 3.3.3 (fechamento da homologacao de
// idempotencia). Diferente da "matriz de resultado do ingress" acima
// (que pre-semeia `events` com uma linha duplicada ja existente), os
// testes abaixo chamam handleWhatsappWebhookRequest MAIS DE UMA VEZ,
// sequencialmente, contra a MESMA instancia de client/deps, com o MESMO
// rawBody/signatureHeader — exatamente como a Meta reenviando o mesmo
// webhook delivery. Prova o caminho completo parse -> ingress -> gate
// de status terminal do handler -> Engine -> RPC-mock, nao apenas a
// logica de cada camada isolada.
//
// LIMITE CONHECIDO (documentado, nunca escondido): o fake client é
// sincrono/single-threaded (JS) — seu check-then-push de unicidade em
// eventsTable().insert().select() roda inteiro antes de qualquer
// `await`, entao mesmo duas chamadas via Promise.all() contra ele nunca
// produzem uma corrida real. Ele prova a LOGICA de deduplicacao (os
// mesmos branches que o Postgres real exercitaria via 23505), nunca a
// ATOMICIDADE sob concorrencia genuina — essa garantia depende somente
// do UNIQUE INDEX e do SELECT...FOR UPDATE do Postgres real (migrations
// 016/017), ja validados empiricamente em fase anterior contra Postgres
// local descartavel, nunca neste arquivo e nunca contra producao.
// ===========================================================================
describe('POST — reentrega real end-to-end (homologacao de idempotencia)', () => {
  test('1a entrega valida -> 200, 1 evento processed, exatamente 1 chamada a RPC', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());

    const res = await handleWhatsappWebhookRequest(req, deps);

    expect(res.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1);
    expect(client._events).toHaveLength(1);
    expect(client._events[0].status).toBe('processed');
  });

  test('2a entrega com corpo e assinatura IDENTICOS (mesmo client) -> 200, ZERO nova chamada a RPC, ZERO novo evento', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());

    const firstRes = await handleWhatsappWebhookRequest(req, deps);
    expect(firstRes.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1);
    expect(client._events).toHaveLength(1);

    // Reentrega real: MESMO objeto de requisicao (rawBody + signatureHeader
    // identicos byte-a-byte), MESMO client/deps — nunca um novo fixture
    // pre-semeado, nunca um novo client.
    const secondRes = await handleWhatsappWebhookRequest(req, deps);

    expect(secondRes.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(1); // nenhuma nova chamada a RPC de inbound
    expect(client._events).toHaveLength(1); // nenhum novo evento inserido
    expect(client._events[0].status).toBe('processed'); // estado terminal preservado
    expect(client._events[0].resolved_lead_id).toBe('lead-1');
    expect(client._events[0].resolved_interaction_id).toBe('int-1');
  });

  test('falha transitoria na 1a entrega -> retry legitimo processa -> reentrega subsequente apos sucesso e bloqueada', async () => {
    let rpcCallCount = 0;
    const succeed = rpcSuccess();
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      // 1a chamada: falha transitoria (ex. timeout/erro de rede simulado).
      // 2a chamada em diante: sucesso real, com o mesmo efeito colateral
      // que process_inbound_whatsapp_event teria no banco real.
      rpcImpl: async (fn, params, c) => {
        rpcCallCount += 1;
        if (rpcCallCount === 1) {
          throw new Error('erro transitorio simulado (ex. timeout de rede)');
        }
        return succeed(fn, params, c);
      },
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());

    // 1a entrega: RPC lanca -> Engine reconcilia (leitura fresca ainda
    // 'received') -> finaliza como 'failed' retryable -> 500.
    const firstRes = await handleWhatsappWebhookRequest(req, deps);
    expect(firstRes.status).toBe(500);
    expect(client._events).toHaveLength(1);
    expect(client._events[0].status).toBe('failed');
    expect(client._events[0].resolved_lead_id).toBeNull();
    expect(client._events[0].resolved_interaction_id).toBeNull();

    // Retry legitimo: MESMO corpo/assinatura (Meta reentrega apos 500) ->
    // ingress reconhece DUPLICATE failed (sem residuo) -> Engine tenta de
    // novo -> 2a chamada a RPC agora sucede -> 200, evento processed.
    const retryRes = await handleWhatsappWebhookRequest(req, deps);
    expect(retryRes.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(2);
    expect(client._events).toHaveLength(1);
    expect(client._events[0].status).toBe('processed');
    expect(client._events[0].resolved_lead_id).toBe('lead-1');
    expect(client._events[0].resolved_interaction_id).toBe('int-1');

    // Reentrega subsequente (3a chamada HTTP) apos o sucesso: evento ja
    // 'processed' -> ACK direto, bloqueada ANTES do Engine/RPC. Prova que
    // o bloqueio pos-sucesso e real, nao so um efeito colateral do mock
    // de falha ja ter sido "consumido".
    const thirdRes = await handleWhatsappWebhookRequest(req, deps);
    expect(thirdRes.status).toBe(200);
    expect(inboundRpcCalls(client)).toHaveLength(2); // nenhuma 3a chamada a RPC de inbound
    expect(client._events).toHaveLength(1);
  });

  test('o fake client nunca e confundido com uma transacao Postgres real — nao ha lock/atomicidade genuina sob Promise.all', async () => {
    // Documenta explicitamente o limite descrito no comentario de topo
    // deste describe: chamar o handler duas vezes "concorrentemente" via
    // Promise.all contra o MESMO client ainda produz exatamente o mesmo
    // resultado deduplicado que a chamada sequencial acima — porque o
    // fake client e sincrono (JS, single-threaded), nunca porque ele
    // implementa um UNIQUE INDEX ou um SELECT...FOR UPDATE reais. Este
    // teste prova que o mock e honesto sobre o que ele cobre (a logica
    // de branch de deduplicacao) e nunca finge cobrir atomicidade real
    // de banco — essa garantia continua dependendo exclusivamente do
    // Postgres real (migrations 016/017), validada empiricamente em fase
    // anterior contra Postgres local descartavel, nunca neste arquivo.
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT], rpcImpl: rpcSuccess() });
    const deps = makeDeps({}, client);
    const req = await postRequest(textMessagePayload());

    const [resA, resB] = await Promise.all([
      handleWhatsappWebhookRequest(req, deps),
      handleWhatsappWebhookRequest(req, deps),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Zero duplicacao observavel — mas isto e uma propriedade do
    // JavaScript ser single-threaded (cada microtask do fake client
    // roda do inicio ao fim sem interrupcao), nunca uma prova de
    // locking real. Nenhuma asserção aqui deve ser lida como "prova de
    // concorrencia" — ver comentario de topo do describe.
    expect(client._events).toHaveLength(1);
    expect(client._rpcCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// POST — PROCESSAMENTO DE STATUS OUTBOUND (Fase 3.5.2.3)
// ===========================================================================
function statusPayload(statuses: Record<string, unknown>[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-number-id-1' },
              statuses,
            },
          },
        ],
      },
    ],
  };
}

function statusRpcImpl(byWamid: Record<string, { outcome: string; message_id: string | null }>) {
  return async (fn: string, params: Record<string, unknown>) => {
    if (fn !== 'apply_whatsapp_outbound_status_event') {
      return { data: null, error: new Error(`rpc inesperada: ${fn}`) };
    }
    const result = byWamid[params.p_external_message_id as string];
    if (!result) {
      return { data: null, error: new Error(`wamid nao mockado: ${params.p_external_message_id}`) };
    }
    return { data: [result], error: null };
  };
}

describe('POST — status outbound (Fase 3.5.2.3)', () => {
  test('sent -> delivered -> read (3 eventos no mesmo payload) -> todos aplicados em ordem, ACK 200', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({
        'wamid.SEQ1': { outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', message_id: 'msg-1' },
      }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([
      { id: 'wamid.SEQ1', status: 'sent', timestamp: '1700000100' },
      { id: 'wamid.SEQ1', status: 'delivered', timestamp: '1700000200' },
      { id: 'wamid.SEQ1', status: 'read', timestamp: '1700000300' },
    ]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(3);
    expect(client._rpcCalls.map((c) => c.params.p_new_status)).toEqual(['sent', 'delivered', 'read']);
  });

  test('read recebido ANTES de delivered -> aplicado normalmente (RPC decide a validade da transicao, handler so repassa)', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.OOO1': { outcome: 'APPLIED', message_id: 'msg-1' } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.OOO1', status: 'read', timestamp: '1700000100' }]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(1);
  });

  test('evento duplicado (IGNORED_OUT_OF_ORDER_OR_DUPLICATE) -> ACK 200, nunca tratado como erro', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.DUP1': { outcome: 'IGNORED_OUT_OF_ORDER_OR_DUPLICATE', message_id: 'msg-1' } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.DUP1', status: 'delivered', timestamp: '1700000100' }]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
  });

  test('multiplos status de wamids DIFERENTES no mesmo payload -> todos processados independentemente', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({
        'wamid.A': { outcome: 'APPLIED', message_id: 'msg-a' },
        'wamid.B': { outcome: 'APPLIED', message_id: 'msg-b' },
        'wamid.C': { outcome: 'PENDING_WAMID', message_id: null },
      }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([
      { id: 'wamid.A', status: 'delivered', timestamp: '1700000100' },
      { id: 'wamid.B', status: 'read', timestamp: '1700000200' },
      { id: 'wamid.C', status: 'sent', timestamp: '1700000300' },
    ]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(3);
  });

  test('status recebido ANTES da confirmacao local (PENDING_WAMID) -> ACK 200, nunca tratado como erro, nunca cria nada no handler', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.EARLY1': { outcome: 'PENDING_WAMID', message_id: null } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.EARLY1', status: 'delivered', timestamp: '1700000100' }]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
  });

  test('wamid desconhecido permanece PENDING_WAMID -> ACK 200 (rastreavel no staging, nao e erro do webhook)', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.UNKNOWN1': { outcome: 'PENDING_WAMID', message_id: null } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.UNKNOWN1', status: 'failed', timestamp: '1700000100' }]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
  });

  test('conta incorreta (ACCOUNT_MISMATCH) -> ACK 200 (nao retentavel), nunca propagado como 500', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.MISMATCH1': { outcome: 'ACCOUNT_MISMATCH', message_id: null } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.MISMATCH1', status: 'delivered', timestamp: '1700000100' }]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
  });

  test('assinatura invalida -> 401, zero client, mesmo com payload de status valido', async () => {
    const client = makeFakeClient({ accounts: [RESOLVED_ACCOUNT] });
    const deps = makeDeps({}, client);
    const rawBody = JSON.stringify(statusPayload([{ id: 'wamid.X', status: 'sent', timestamp: '1700000100' }]));
    const req: WebhookHttpRequest = { method: 'POST', rawBody, signatureHeader: 'sha256=0000000000000000000000000000000000000000000000000000000000000000' };
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(401);
    expect(deps.getServiceClient).not.toHaveBeenCalled();
  });

  test('payload malformado (status sem id em UM dos eventos) -> o evento malformado nunca chega a RPC, os demais sao processados normalmente', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.BOM1': { outcome: 'APPLIED', message_id: 'msg-1' } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([
      { id: 'wamid.BOM1', status: 'delivered', timestamp: '1700000100' },
      { status: 'read', timestamp: '1700000200' }, // sem id -- descartado pelo parser
    ]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls).toHaveLength(1);
  });

  test('falha de entrega com codigo de erro -> errorCode repassado para a RPC como p_error_code', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.FAIL1': { outcome: 'APPLIED', message_id: 'msg-1' } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([
      { id: 'wamid.FAIL1', status: 'failed', timestamp: '1700000100', errors: [{ code: 131026, title: 'Undeliverable' }] },
    ]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls[0].params.p_error_code).toBe('131026');
  });

  test('erro de transporte na RPC (REPOSITORY_ERROR) -> 500, permite redelivery segura', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: async () => ({ data: null, error: new Error('transport down') }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.ERR1', status: 'delivered', timestamp: '1700000100' }]));
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(500);
  });

  test('mensagem (inbound) e status (outbound) no mesmo payload -> ambos processados, uma falha no status nunca bloqueia a mensagem', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: async (fn: string, params: Record<string, unknown>, c?: ReturnType<typeof makeFakeClient>) => {
        if (fn === 'process_inbound_whatsapp_event') return rpcSuccess()(fn, params, c);
        if (fn === 'apply_whatsapp_outbound_status_event') return { data: [{ outcome: 'APPLIED', message_id: 'msg-1' }], error: null };
        // Fase 3.6.2 — apply_whatsapp_conversation_operational_event,
        // chamada em melhor esforço após a mensagem inbound ser
        // processada (ver handler.ts). Sucesso aqui nunca é exigido
        // pelo teste (é um eixo secundário) — só não deve lançar.
        if (fn === 'apply_whatsapp_conversation_operational_event') return { data: [{ status: 'pendente_resposta' }], error: null };
        return { data: null, error: new Error(`rpc inesperada: ${fn}`) };
      },
    });
    const deps = makeDeps({}, client);
    const payload = textMessagePayload({ statuses: [{ id: 'wamid.MIXED1', status: 'sent', timestamp: '1700000100' }] });
    const req = await postRequest(payload);
    const res = await handleWhatsappWebhookRequest(req, deps);
    expect(res.status).toBe(200);
    expect(client._rpcCalls.map((c) => c.fn).sort()).toEqual([
      'apply_whatsapp_conversation_operational_event',
      'apply_whatsapp_outbound_status_event',
      'process_inbound_whatsapp_event',
    ]);
  });

  test('integration_account_id NUNCA vem do payload -- so e passado para a RPC apos resolucao propria via phone_number_id', async () => {
    const client = makeFakeClient({
      accounts: [RESOLVED_ACCOUNT],
      rpcImpl: statusRpcImpl({ 'wamid.RES1': { outcome: 'APPLIED', message_id: 'msg-1' } }),
    });
    const deps = makeDeps({}, client);
    const req = await postRequest(statusPayload([{ id: 'wamid.RES1', status: 'delivered', timestamp: '1700000100' }]));
    await handleWhatsappWebhookRequest(req, deps);
    expect(client._rpcCalls[0].params.p_integration_account_id).toBe(RESOLVED_ACCOUNT.id);
  });
});
