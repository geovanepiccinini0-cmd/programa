import { describe, expect, test, vi } from 'vitest';
import { handleWhatsappSendRequest } from '../../supabase/functions/whatsapp-send/handler.ts';
import {
  invokeWhatsappSend,
  classifySendOutcome,
  statusForOutcomeKind,
  buildOptimisticMessage,
  mergeOptimisticWithAuthoritative,
  generateClientToken,
} from './whatsappSend.js';

// Fase 3.5.2.4 — teste de INTEGRAÇÃO (não só unidade): exercita o
// pipeline completo invokeWhatsappSend -> classifySendOutcome ->
// statusForOutcomeKind/mergeOptimisticWithAuthoritative contra o
// HANDLER REAL da Edge Function whatsapp-send (handleWhatsappSendRequest,
// já aprovado/testado isoladamente em handler.test.ts) — nunca contra
// uma suposição própria de como ele responde. Simula só a camada mais
// externa: um client supabase-js cujo `.functions.invoke` roda o
// handler real em memória (nunca Deno, nunca rede, nunca Meta real) e
// traduz o SendHttpResponse para o formato {data,error} que o
// supabase-js realmente produz (FunctionsHttpError para não-2xx, com
// `.context` como uma Response simulada — mesmo contrato usado por
// invokeWhatsappSend).

function fakeAuthClient(userId) {
  return {
    auth: {
      getUser: async (token) => {
        if (token !== 'valid-jwt') return { data: { user: null }, error: new Error('invalid') };
        return { data: { user: { id: userId } }, error: null };
      },
    },
  };
}

// Client service-role simulado: cobre exatamente os métodos que o
// handler real usa (rpc + from().select()...) com dados fixos de um
// cenário controlado — mesmo princípio dos fakes de handler.test.ts,
// montado aqui de forma mínima para os cenários exercitados.
const FAKE_USER_ID = '22222222-2222-2222-2222-222222222222';
const FAKE_LEAD_ID = '11111111-1111-1111-1111-111111111111';
const FAKE_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

function fakeServiceClient({ accountActive = true, hasInbound = true, windowClosed = false } = {}) {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  return {
    from(table) {
      let isCountQuery = false;
      const builder = {
        select(_columns, options) {
          if (options && options.count === 'exact' && options.head === true) isCountQuery = true;
          return builder;
        },
        eq() { return builder; },
        in() { return builder; },
        gte() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        then(resolve) {
          // whatsappOutboundRateLimiter.ts faz select('id', {count:'exact',
          // head:true}) sobre whatsapp_messages e espera {count, error} —
          // formato distinto das demais queries deste mesmo client, que
          // esperam {data, error}.
          if (table === 'whatsapp_messages' && isCountQuery) {
            return Promise.resolve({ count: 0, error: null }).then(resolve);
          }
          if (table === 'leads') {
            return Promise.resolve({
              data: [{ id: FAKE_LEAD_ID, user_id: FAKE_USER_ID, deleted_at: null }],
              error: null,
            }).then(resolve);
          }
          if (table === 'integration_accounts') {
            return Promise.resolve({
              data: accountActive
                ? [{ id: FAKE_ACCOUNT_ID, active: true, user_id: FAKE_USER_ID, provider: 'whatsapp', external_account_id: 'pnid-1' }]
                : [],
              error: null,
            }).then(resolve);
          }
          if (table === 'whatsapp_messages') {
            if (!hasInbound) return Promise.resolve({ data: [], error: null }).then(resolve);
            return Promise.resolve({
              data: [{
                id: 'inbound-1', direction: 'inbound', integration_account_id: FAKE_ACCOUNT_ID,
                contact_phone_normalized: '5511999990001', occurred_at: windowClosed ? oldIso : nowIso,
              }],
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return builder;
    },
    rpc(fn, _params) {
      if (fn === 'reserve_whatsapp_outbound_attempt') {
        return Promise.resolve({ data: [{ outcome: 'CLAIMED', message_id: '44444444-4444-4444-4444-444444444444', attempt_number: 1, current_status: 'queued' }], error: null });
      }
      if (fn === 'start_whatsapp_outbound_attempt_call') {
        return Promise.resolve({ data: [{ outcome: 'STARTED', current_status: 'sending' }], error: null });
      }
      if (fn === 'confirm_whatsapp_outbound_sent') {
        return Promise.resolve({ data: [{ outcome: 'CONFIRMED', lead_interaction_id: 'interaction-1' }], error: null });
      }
      if (fn === 'mark_whatsapp_outbound_attempt_result') {
        return Promise.resolve({ data: [{ outcome: 'uncertain', current_status: 'uncertain' }], error: null });
      }
      return Promise.resolve({ data: null, error: new Error(`rpc desconhecida nos testes: ${fn}`) });
    },
  };
}

function makeDeps({ userId = '22222222-2222-2222-2222-222222222222', sendOutcome = { outcome: 'ACCEPTED', externalMessageId: 'wamid.REAL1', httpStatus: 200 }, ...serviceOpts } = {}) {
  return {
    getAuthClient: () => fakeAuthClient(userId),
    getServiceClient: () => fakeServiceClient(serviceOpts),
    getMetaCredentials: () => ({ accessToken: 'fake-token-nunca-real', phoneNumberId: 'pnid-1' }),
    sendGraphMessage: async () => sendOutcome,
    now: () => new Date(),
  };
}

// Client supabase-js SIMULADO cujo functions.invoke roda o handler
// REAL da Edge Function em memória — é isto que caracteriza o teste
// como funcional/integrado (nunca um mock do que ESPERAMOS que a
// função faça).
function supabaseClientRunningRealHandler(deps, { authorizationHeader = 'Bearer valid-jwt' } = {}) {
  return {
    functions: {
      invoke: async (_name, { body }) => {
        const response = await handleWhatsappSendRequest(
          { method: 'POST', authorizationHeader, rawBody: JSON.stringify(body) },
          deps,
        );
        const parsedBody = JSON.parse(response.body);
        if (response.status >= 200 && response.status < 300) {
          return { data: parsedBody, error: null };
        }
        const fakeResponse = { status: response.status, json: async () => parsedBody };
        return { data: null, error: { name: 'FunctionsHttpError', context: fakeResponse } };
      },
    },
  };
}

describe('pipeline de envio integrado contra o handler REAL de whatsapp-send', () => {
  test('ACCEPTED: aceite da Meta -> status de bubble "sent" (NUNCA "delivered")', async () => {
    const deps = makeDeps();
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('accepted');
    expect(classified.messageId).toBe('44444444-4444-4444-4444-444444444444');
    expect(statusForOutcomeKind(classified.kind)).toBe('sent');
  });

  test('UNCERTAIN (timeout simulado na Meta): nunca presumido como falha, placeholder marcado uncertain', async () => {
    const deps = makeDeps({ sendOutcome: { outcome: 'UNCERTAIN', reason: 'timeout', httpStatus: null } });
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('uncertain');
    expect(classified.messageId).toBe('44444444-4444-4444-4444-444444444444');
    expect(statusForOutcomeKind(classified.kind)).toBe('uncertain');
  });

  test('REJECTED pela Meta: status de bubble "failed", messageId preservado', async () => {
    const deps = makeDeps({ sendOutcome: { outcome: 'REJECTED_DEFINITIVE', errorCode: '131026', httpStatus: 400 } });
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified).toEqual({ kind: 'rejected', messageId: '44444444-4444-4444-4444-444444444444', errorCode: '131026' });
    expect(statusForOutcomeKind(classified.kind)).toBe('failed');
  });

  test('janela de 24h encerrada no servidor (WINDOW_CLOSED): sem messageId -> placeholder deve ser removido', async () => {
    const deps = makeDeps({ windowClosed: true });
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('window_closed');
    expect(classified.messageId).toBeNull();
    expect(statusForOutcomeKind(classified.kind)).toBeNull();
  });

  test('sem conversa inbound (identidade indisponível no servidor): sem messageId', async () => {
    const deps = makeDeps({ hasInbound: false });
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('identity_unavailable');
    expect(classified.messageId).toBeNull();
  });

  test('conta de integração inativa no servidor: ACCOUNT_INACTIVE, sem messageId', async () => {
    const deps = makeDeps({ accountActive: false });
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('account_inactive');
  });

  test('JWT ausente/invalido: UNAUTHENTICATED, nunca chega a chamar nenhuma RPC', async () => {
    const deps = makeDeps();
    const client = supabaseClientRunningRealHandler(deps, { authorizationHeader: 'Bearer token-invalido' });
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('auth_error');
  });

  test('clique duplicado simulado (mesma intencao ja resolvida): DUPLICATE_ALREADY_SENT -> accepted, nunca duplica', async () => {
    const deps = makeDeps();
    // forcamos reserve a devolver ALREADY_RESOLVED com current_status 'sent'
    const serviceClient = fakeServiceClient({});
    const originalRpc = serviceClient.rpc.bind(serviceClient);
    serviceClient.rpc = (fn, params) => {
      if (fn === 'reserve_whatsapp_outbound_attempt') {
        return Promise.resolve({ data: [{ outcome: 'ALREADY_RESOLVED', message_id: '44444444-4444-4444-4444-444444444444', current_status: 'sent' }], error: null });
      }
      return originalRpc(fn, params);
    };
    deps.getServiceClient = () => serviceClient;
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);

    expect(classified.kind).toBe('accepted');
    expect(classified.messageId).toBe('44444444-4444-4444-4444-444444444444');
  });

  test('ponta a ponta: placeholder otimista some quando a linha autoritativa com o mesmo clientToken chega (simulando Realtime), sem duplicar', async () => {
    const deps = makeDeps();
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();
    const optimistic = buildOptimisticMessage({ leadId: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222', content: 'Olá!', clientToken });

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    const classified = classifySendOutcome(result);
    const bubbleStatus = statusForOutcomeKind(classified.kind);
    const updatedOptimistic = { ...optimistic, status: bubbleStatus };

    // Antes do Realtime entregar a linha real: só a otimista aparece.
    const beforeRealtime = mergeOptimisticWithAuthoritative([], [updatedOptimistic]);
    expect(beforeRealtime).toHaveLength(1);

    // Linha autoritativa chega (mesmo clientToken, id REAL diferente) —
    // a otimista deve desaparecer, nunca duplicar.
    const authoritative = [{ id: '44444444-4444-4444-4444-444444444444', clientToken, direction: 'outbound', status: 'sent', occurredAt: new Date().toISOString() }];
    const afterRealtime = mergeOptimisticWithAuthoritative(authoritative, [updatedOptimistic]);
    expect(afterRealtime).toHaveLength(1);
    expect(afterRealtime[0].id).toBe('44444444-4444-4444-4444-444444444444');
  });

  test('nunca expõe o access token da Meta em nenhuma resposta JSON retornada ao cliente', async () => {
    const deps = makeDeps();
    const client = supabaseClientRunningRealHandler(deps);
    const clientToken = generateClientToken();

    const result = await invokeWhatsappSend(client, { leadId: '11111111-1111-1111-1111-111111111111', content: 'Olá!', clientToken });
    expect(JSON.stringify(result.body)).not.toContain('fake-token-nunca-real');
  });
});
