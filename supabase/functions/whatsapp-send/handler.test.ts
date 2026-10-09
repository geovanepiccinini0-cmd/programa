// Fase 3.5.2.2 — Testes adversariais do handler de composição do envio
// WhatsApp (correção pós-auditoria: vínculo seguro de destinatário +
// separação de privilégios). Client 100% fake (nunca Deno/Supabase/
// Meta reais) — prova a ORQUESTRAÇÃO (ordem das chamadas, gating
// antes de chamar a Meta, mapeamento de outcome -> resposta HTTP,
// ausência de vazamento de dados sensíveis, uso do client correto
// para cada operação). As garantias transacionais REAIS (claim/CAS/
// rollback/identidade revalidada) já foram provadas empiricamente
// contra Postgres descartável.
import { describe, expect, test, vi } from 'vitest';
import { handleWhatsappSendRequest, type SendHttpRequest, type WhatsappSendHandlerDeps } from './handler.ts';
import type { GraphSendResult } from '../_shared/whatsappGraphSendAdapter.ts';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const USER_ID = 'user-1';
const LEAD_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_TOKEN = '22222222-2222-2222-2222-222222222222';
const SECRET_TOKEN = 'FAKE_SECRET_TOKEN_NEVER_REAL_abc123';
const CONTACT_PHONE = '5551900000001';
const PHONE_NUMBER_ID = 'phone-number-id-A';
const INBOUND_OCCURRED_AT = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

type RowsByKind = Record<string, unknown[]>;

function makeFakeAuthClient(getUserImpl?: () => Promise<{ data: { user: { id: unknown } | null } | null; error: unknown }>) {
  return {
    auth: {
      getUser: vi.fn(getUserImpl ?? (async () => ({ data: { user: { id: USER_ID } }, error: null }))),
    },
  };
}

function makeFakeServiceClient(opts: {
  rows?: Partial<RowsByKind>;
  rateCount?: number | null;
  rateError?: unknown;
  rpcOverrides?: Record<string, (params: Record<string, unknown>) => { data: unknown; error: unknown }>;
}) {
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];

  const defaultRows: RowsByKind = {
    leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null }],
    whatsapp_messages_latest: [{ integration_account_id: 'acc-1', occurred_at: INBOUND_OCCURRED_AT, contact_phone_normalized: CONTACT_PHONE }],
    whatsapp_messages_window: [{ contact_phone_normalized: CONTACT_PHONE }],
    integration_accounts: [{ id: 'acc-1', active: true, user_id: USER_ID, provider: 'whatsapp', external_account_id: PHONE_NUMBER_ID }],
  };
  const rows = { ...defaultRows, ...(opts.rows ?? {}) };

  const defaultRpc: Record<string, (params: Record<string, unknown>) => { data: unknown; error: unknown }> = {
    reserve_whatsapp_outbound_attempt: () => ({
      data: [{ outcome: 'CLAIMED', message_id: 'msg-1', attempt_number: 1, current_status: 'queued' }],
      error: null,
    }),
    start_whatsapp_outbound_attempt_call: () => ({
      data: [{ outcome: 'STARTED', current_status: 'sending' }],
      error: null,
    }),
    confirm_whatsapp_outbound_sent: () => ({
      data: [{ outcome: 'CONFIRMED', lead_interaction_id: 'int-1' }],
      error: null,
    }),
    mark_whatsapp_outbound_attempt_result: (params) => ({
      data: [{
        outcome: params.p_outcome,
        current_status: params.p_outcome === 'rejected_by_provider' ? 'failed' : 'uncertain',
      }],
      error: null,
    }),
  };
  const rpcImpls = { ...defaultRpc, ...(opts.rpcOverrides ?? {}) };

  function fromImpl(table: string) {
    return {
      select(_columns: string, selectOpts?: { count?: 'exact'; head?: true }) {
        const filters: Record<string, unknown> = {};
        const isCount = Boolean(selectOpts?.count);
        const chain = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return chain;
          },
          gte(_column: string, _value: unknown) {
            if (isCount) {
              return Promise.resolve({ count: opts.rateCount ?? 0, error: opts.rateError ?? null });
            }
            return Promise.resolve({ data: rows.whatsapp_messages_window ?? [], error: null });
          },
          order() {
            return {
              limit: async () => ({ data: rows.whatsapp_messages_latest ?? [], error: null }),
            };
          },
          then(resolve: (value: { data: unknown[] | null; error: unknown }) => unknown) {
            const key = table === 'leads' ? 'leads' : 'integration_accounts';
            const result = { data: rows[key] ?? [], error: null };
            return Promise.resolve(result).then(resolve);
          },
        };
        return chain;
      },
    };
  }

  return {
    from: fromImpl,
    rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      const impl = rpcImpls[fn];
      if (!impl) throw new Error(`unmocked rpc: ${fn}`);
      return impl(params);
    }),
    _rpcCalls: rpcCalls,
  };
}

function makeDeps(overrides: Partial<WhatsappSendHandlerDeps> & {
  authClient?: ReturnType<typeof makeFakeAuthClient>;
  serviceClient?: ReturnType<typeof makeFakeServiceClient>;
} = {}) {
  const authClient = overrides.authClient ?? makeFakeAuthClient();
  const serviceClient = overrides.serviceClient ?? makeFakeServiceClient({});
  const sendGraphMessage = vi.fn(
    overrides.sendGraphMessage
    ?? (async (): Promise<GraphSendResult> => ({ outcome: 'ACCEPTED', externalMessageId: 'wamid.ABC123' })),
  );
  return {
    deps: {
      getAuthClient: () => authClient as never,
      getServiceClient: () => serviceClient as never,
      getMetaCredentials: overrides.getMetaCredentials ?? (() => ({ accessToken: SECRET_TOKEN, phoneNumberId: '' })),
      sendGraphMessage,
      now: overrides.now ?? (() => NOW),
    } satisfies WhatsappSendHandlerDeps,
    authClient,
    serviceClient,
    sendGraphMessage,
  };
}

function makeRequest(body: Record<string, unknown> | string, authorizationHeader: unknown = 'Bearer valid.jwt.token'): SendHttpRequest {
  return {
    method: 'POST',
    authorizationHeader,
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const VALID_BODY = { leadId: LEAD_ID, content: 'Ola, tudo bem?', clientToken: CLIENT_TOKEN };

describe('handleWhatsappSendRequest — método', () => {
  test('GET -> 405 METHOD_NOT_ALLOWED', async () => {
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest({ method: 'GET', authorizationHeader: undefined, rawBody: undefined }, deps);
    expect(response.status).toBe(405);
  });
});

describe('handleWhatsappSendRequest — autenticação e separação de privilégios (itens 1/3)', () => {
  test('JWT inválido -> 401 UNAUTHENTICATED, zero chamada a qualquer RPC', async () => {
    const authClient = makeFakeAuthClient(async () => ({ data: null, error: new Error('invalid') }));
    const serviceClient = makeFakeServiceClient({});
    const { deps } = makeDeps({ authClient, serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).outcome).toBe('UNAUTHENTICATED');
    expect(serviceClient._rpcCalls).toHaveLength(0);
  });

  test('sessão expirada (user null) -> 401 UNAUTHENTICATED', async () => {
    const authClient = makeFakeAuthClient(async () => ({ data: { user: null }, error: null }));
    const { deps } = makeDeps({ authClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(401);
  });

  test('header ausente -> 401 UNAUTHENTICATED, nunca chama o client de auth', async () => {
    const authClient = makeFakeAuthClient();
    const { deps } = makeDeps({ authClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY, null), deps);
    expect(response.status).toBe(401);
    expect(authClient.auth.getUser).not.toHaveBeenCalled();
  });

  test('a verificacao de identidade usa o client de AUTH, nunca o service client, e o service client so e criado DEPOIS da identidade verificada', async () => {
    const authClient = makeFakeAuthClient();
    const serviceClient = makeFakeServiceClient({});
    let serviceClientCreated = false;
    const deps: WhatsappSendHandlerDeps = {
      getAuthClient: () => authClient as never,
      getServiceClient: () => { serviceClientCreated = true; return serviceClient as never; },
      getMetaCredentials: () => ({ accessToken: SECRET_TOKEN, phoneNumberId: '' }),
      sendGraphMessage: async () => ({ outcome: 'ACCEPTED', externalMessageId: 'wamid.X' }),
      now: () => NOW,
    };
    await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(authClient.auth.getUser).toHaveBeenCalledTimes(1);
    expect(serviceClientCreated).toBe(true);
  });

  test('identidade invalida -> service client NUNCA e criado', async () => {
    const authClient = makeFakeAuthClient(async () => ({ data: null, error: new Error('invalid') }));
    let serviceClientCreated = false;
    const deps: WhatsappSendHandlerDeps = {
      getAuthClient: () => authClient as never,
      getServiceClient: () => { serviceClientCreated = true; return makeFakeServiceClient({}) as never; },
      getMetaCredentials: () => ({ accessToken: SECRET_TOKEN, phoneNumberId: '' }),
      sendGraphMessage: vi.fn(),
      now: () => NOW,
    };
    await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(serviceClientCreated).toBe(false);
  });
});

describe('handleWhatsappSendRequest — validação de entrada', () => {
  test('body invalido (JSON malformado) -> 400 INVALID_REQUEST', async () => {
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest('{not json'), deps);
    expect(response.status).toBe(400);
  });

  test('leadId com forma invalida (nao uuid) -> 400 INVALID_REQUEST', async () => {
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest({ ...VALID_BODY, leadId: 'not-a-uuid' }), deps);
    expect(response.status).toBe(400);
  });

  test('content vazio -> 400 INVALID_REQUEST', async () => {
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest({ ...VALID_BODY, content: '   ' }), deps);
    expect(response.status).toBe(400);
  });

  test('content acima do limite -> 400 INVALID_REQUEST', async () => {
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest({ ...VALID_BODY, content: 'x'.repeat(5000) }), deps);
    expect(response.status).toBe(400);
  });

  test('clientToken ausente -> 400 INVALID_REQUEST, zero RPC', async () => {
    const serviceClient = makeFakeServiceClient({});
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest({ leadId: LEAD_ID, content: 'oi' }), deps);
    expect(response.status).toBe(400);
    expect(serviceClient._rpcCalls).toHaveLength(0);
  });

  test('campos extras no body (ex. tentativa de injetar userId/integrationAccountId/destinatario/contactPhoneNormalized) são ignorados (item 2)', async () => {
    const serviceClient = makeFakeServiceClient({});
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    await handleWhatsappSendRequest(
      makeRequest({
        ...VALID_BODY,
        userId: 'atacante-finge-ser-outro-usuario',
        integrationAccountId: 'conta-forjada',
        phoneNumberId: 'numero-forjado',
        contactPhoneNormalized: '+10000000000',
        recipientPhone: '+10000000000',
      }),
      deps,
    );
    // O destinatario REAL usado na chamada e sempre o resolvido do
    // banco (CONTACT_PHONE), nunca o forjado no body.
    expect(sendGraphMessage).toHaveBeenCalledWith(expect.objectContaining({ toE164: CONTACT_PHONE, phoneNumberId: PHONE_NUMBER_ID }));
    const reserveCall = serviceClient._rpcCalls.find((c) => c.fn === 'reserve_whatsapp_outbound_attempt');
    expect(reserveCall?.params.p_user_id).toBe(USER_ID);
    expect(reserveCall?.params.p_integration_account_id).toBe('acc-1');
    expect(reserveCall?.params.p_contact_phone_normalized).toBe(CONTACT_PHONE);
  });
});

describe('handleWhatsappSendRequest — configuração de secrets (item obrigatório)', () => {
  test('access token ausente -> 500 CONFIG_ERROR, ZERO chamada a reserve/start/Meta', async () => {
    const serviceClient = makeFakeServiceClient({});
    const { deps, sendGraphMessage } = makeDeps({ serviceClient, getMetaCredentials: () => null });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).outcome).toBe('CONFIG_ERROR');
    expect(serviceClient._rpcCalls).toHaveLength(0);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('access token em branco -> 500 CONFIG_ERROR', async () => {
    const { deps } = makeDeps({ getMetaCredentials: () => ({ accessToken: '   ', phoneNumberId: '' }) });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
  });

  test('getMetaCredentials lança -> 500 CONFIG_ERROR', async () => {
    const { deps } = makeDeps({ getMetaCredentials: () => { throw new Error('boom'); } });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).outcome).toBe('CONFIG_ERROR');
  });
});

describe('handleWhatsappSendRequest — vínculo seguro de destinatário (correção pós-auditoria)', () => {
  test('telefone cadastral do lead editado APÓS o inbound não redireciona: destinatário permanece o contact_phone_normalized original', async () => {
    // O fake nunca expoe leads.phone_normalized em lugar nenhum da
    // query de leads -- se o codigo tentasse le-lo, obteria undefined.
    // O destinatario usado so pode vir de contact_phone_normalized.
    const serviceClient = makeFakeServiceClient({});
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(sendGraphMessage).toHaveBeenCalledWith(expect.objectContaining({ toE164: CONTACT_PHONE }));
  });

  test('identidade indisponivel (linha inbound historica sem contact_phone_normalized) -> 422 IDENTITY_UNAVAILABLE, zero RPC/Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rows: { whatsapp_messages_latest: [{ integration_account_id: 'acc-1', occurred_at: INBOUND_OCCURRED_AT, contact_phone_normalized: null }] },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('IDENTITY_UNAVAILABLE');
    expect(serviceClient._rpcCalls).toHaveLength(0);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('identidades ambiguas (duas contact_phone_normalized distintas na janela) -> 422 IDENTITY_AMBIGUOUS, zero RPC/Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rows: { whatsapp_messages_window: [{ contact_phone_normalized: CONTACT_PHONE }, { contact_phone_normalized: '5551900000099' }] },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('IDENTITY_AMBIGUOUS');
    expect(serviceClient._rpcCalls).toHaveLength(0);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('alteracao concorrente: a RPC reserve revalida de forma independente e recusa (IDENTITY_MISMATCH) mesmo que o contexto ja resolvido pareca valido', async () => {
    // Simula o cenario de corrida do item 4: entre a resolucao de
    // contexto (passo 4) e a reserva (passo 6), uma nova mensagem
    // inbound de outro numero chegou -- a RPC (nao mockada aqui para
    // retornar isso, mas o contrato preve exatamente este outcome)
    // deve bloquear, nunca redirecionar silenciosamente.
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'IDENTITY_MISMATCH', message_id: null, attempt_number: null, current_status: null }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('IDENTITY_MISMATCH');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('conta WhatsApp de OUTRO usuario -> 422 ACCOUNT_INACTIVE, zero RPC/Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rows: { integration_accounts: [{ id: 'acc-1', active: true, user_id: 'outro-usuario', provider: 'whatsapp', external_account_id: PHONE_NUMBER_ID }] },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('ACCOUNT_INACTIVE');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('conta com provider DIFERENTE de whatsapp -> 422 ACCOUNT_INACTIVE, exigencia explicita (item 2)', async () => {
    const serviceClient = makeFakeServiceClient({
      rows: { integration_accounts: [{ id: 'acc-1', active: true, user_id: USER_ID, provider: 'instagram', external_account_id: PHONE_NUMBER_ID }] },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('ACCOUNT_INACTIVE');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('conta inativa -> 422 ACCOUNT_INACTIVE, zero RPC/Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rows: { integration_accounts: [{ id: 'acc-1', active: false, user_id: USER_ID, provider: 'whatsapp', external_account_id: PHONE_NUMBER_ID }] },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('ACCOUNT_INACTIVE');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });
});

describe('handleWhatsappSendRequest — resolução de contexto (lead/janela)', () => {
  test('lead pertencente a outro usuario -> 404 LEAD_NOT_FOUND, zero RPC/Meta', async () => {
    const serviceClient = makeFakeServiceClient({ rows: { leads: [{ id: LEAD_ID, user_id: 'outro-usuario', deleted_at: null }] } });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(404);
    expect(serviceClient._rpcCalls).toHaveLength(0);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('lead excluido (soft delete) -> 410 LEAD_DELETED', async () => {
    const serviceClient = makeFakeServiceClient({ rows: { leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: '2026-01-01T00:00:00.000Z' }] } });
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(410);
  });

  test('sem conversa inbound -> 422 NO_INBOUND_CONVERSATION', async () => {
    const serviceClient = makeFakeServiceClient({ rows: { whatsapp_messages_latest: [] } });
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('NO_INBOUND_CONVERSATION');
  });

  test('janela de 24h encerrada -> 422 WINDOW_CLOSED, zero RPC/Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rows: {
        whatsapp_messages_latest: [{ integration_account_id: 'acc-1', occurred_at: '2026-01-08T00:00:00.000Z', contact_phone_normalized: CONTACT_PHONE }],
        whatsapp_messages_window: [{ contact_phone_normalized: CONTACT_PHONE }],
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('WINDOW_CLOSED');
    expect(serviceClient._rpcCalls).toHaveLength(0);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });
});

describe('handleWhatsappSendRequest — rate limiting (item obrigatório 8)', () => {
  test('acima do limiar -> 429 RATE_LIMITED, zero reserve/Meta', async () => {
    const serviceClient = makeFakeServiceClient({ rateCount: 999 });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(429);
    expect(serviceClient._rpcCalls).toHaveLength(0);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });
});

describe('handleWhatsappSendRequest — duplo clique / concorrência / replay (itens obrigatórios)', () => {
  test('replay com o mesmo clientToken (já enviado) -> 200 DUPLICATE_ALREADY_SENT, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'ALREADY_RESOLVED', message_id: 'msg-1', attempt_number: null, current_status: 'sent' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).outcome).toBe('DUPLICATE_ALREADY_SENT');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('reuso do token com conteudo DIFERENTE -> 409 IDENTITY_CONFLICT, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'IDENTITY_CONFLICT', message_id: 'msg-1', attempt_number: null, current_status: 'queued' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('IDENTITY_CONFLICT');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('duplo clique: reserve ja em andamento -> 409 IN_PROGRESS, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'ALREADY_IN_FLIGHT', message_id: 'msg-1', attempt_number: null, current_status: 'queued' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('IN_PROGRESS');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('crash apos transicao para sending: nova requisicao com o MESMO token -> reserve=ALREADY_CALLING -> 409 IN_PROGRESS, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'ALREADY_CALLING', message_id: 'msg-1', attempt_number: null, current_status: 'sending' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('IN_PROGRESS');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('requisicoes concorrentes perdendo a corrida em start_whatsapp_outbound_attempt_call -> 409 IN_PROGRESS, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        start_whatsapp_outbound_attempt_call: () => ({ data: [{ outcome: 'ALREADY_STARTED_OR_RESOLVED', current_status: 'sending' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('IN_PROGRESS');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('resultado UNCERTAIN_BLOCKED do reserve -> 409 UNCERTAIN, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'UNCERTAIN_BLOCKED', message_id: 'msg-1', attempt_number: null, current_status: 'uncertain' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('UNCERTAIN');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('replay de intencao ja FALHA terminal -> 409 ALREADY_FAILED, ZERO chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'ALREADY_RESOLVED', message_id: 'msg-1', attempt_number: null, current_status: 'failed' }], error: null }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).outcome).toBe('ALREADY_FAILED');
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('nova intencao (token novo) com uncertain pendente para o lead -> aviso de duplicidade anexado na resposta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: [{ outcome: 'CLAIMED_WITH_PRIOR_UNCERTAIN', message_id: 'msg-1', attempt_number: 1, current_status: 'queued' }], error: null }),
      },
    });
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).priorUncertainWarning).toBe(true);
  });
});

describe('handleWhatsappSendRequest — ordem de gating ANTES da Meta (contrato de segurança)', () => {
  test('sendGraphMessage so e chamado DEPOIS de start_whatsapp_outbound_attempt_call retornar STARTED', async () => {
    const callOrder: string[] = [];
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => {
          callOrder.push('reserve');
          return { data: [{ outcome: 'CLAIMED', message_id: 'msg-1', attempt_number: 1, current_status: 'queued' }], error: null };
        },
        start_whatsapp_outbound_attempt_call: () => {
          callOrder.push('start');
          return { data: [{ outcome: 'STARTED', current_status: 'sending' }], error: null };
        },
        confirm_whatsapp_outbound_sent: () => {
          callOrder.push('confirm');
          return { data: [{ outcome: 'CONFIRMED', lead_interaction_id: 'int-1' }], error: null };
        },
      },
    });
    const sendGraphMessage = vi.fn(async () => {
      callOrder.push('meta_call');
      return { outcome: 'ACCEPTED', externalMessageId: 'wamid.X' } as GraphSendResult;
    });
    const { deps } = makeDeps({ serviceClient, sendGraphMessage });
    await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(callOrder).toEqual(['reserve', 'start', 'meta_call', 'confirm']);
  });
});

describe('handleWhatsappSendRequest — envio aceito (sucesso)', () => {
  test('ACCEPTED -> 200, nunca confunde aceite com entrega, nunca vaza o token', async () => {
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.outcome).toBe('ACCEPTED');
    expect(body.externalMessageId).toBe('wamid.ABC123');
    expect(String(body.note).toLowerCase()).toContain('nao confirma entrega');
    expect(response.body).not.toContain(SECRET_TOKEN);
  });
});

describe('handleWhatsappSendRequest — resultado incerto (itens obrigatórios: timeout, 5xx, 2xx sem wamid)', () => {
  test('timeout depois da Meta aceitar (resultado UNCERTAIN do adapter) -> 200 UNCERTAIN, marca uncertain via RPC', async () => {
    const serviceClient = makeFakeServiceClient({});
    const { deps } = makeDeps({
      serviceClient,
      sendGraphMessage: async () => ({ outcome: 'UNCERTAIN', reason: 'timeout', httpStatus: null }),
    });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).outcome).toBe('UNCERTAIN');
    const markCall = serviceClient._rpcCalls.find((c) => c.fn === 'mark_whatsapp_outbound_attempt_result');
    expect(markCall?.params.p_outcome).toBe('uncertain');
    expect(markCall?.params.p_error_code).toBe('timeout');
  });

  test('HTTP 5xx (resultado UNCERTAIN do adapter) -> 200 UNCERTAIN, nunca presumido como falha definitiva', async () => {
    const { deps } = makeDeps({
      sendGraphMessage: async () => ({ outcome: 'UNCERTAIN', reason: 'unclassified_http_status_500', httpStatus: 500 }),
    });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).outcome).toBe('UNCERTAIN');
  });

  test('2xx sem wamid valido (resultado UNCERTAIN do adapter) -> 200 UNCERTAIN, nunca presumido como aceite', async () => {
    const { deps } = makeDeps({
      sendGraphMessage: async () => ({ outcome: 'UNCERTAIN', reason: 'accepted_without_valid_wamid', httpStatus: 200 }),
    });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).outcome).toBe('UNCERTAIN');
  });
});

describe('handleWhatsappSendRequest — falha definitiva', () => {
  test('REJECTED_DEFINITIVE -> 422 REJECTED, marca rejected_by_provider via RPC', async () => {
    const serviceClient = makeFakeServiceClient({});
    const { deps } = makeDeps({
      serviceClient,
      sendGraphMessage: async () => ({ outcome: 'REJECTED_DEFINITIVE', errorCode: '131026', httpStatus: 400 }),
    });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).outcome).toBe('REJECTED');
    const markCall = serviceClient._rpcCalls.find((c) => c.fn === 'mark_whatsapp_outbound_attempt_result');
    expect(markCall?.params.p_outcome).toBe('rejected_by_provider');
  });
});

describe('handleWhatsappSendRequest — confirmação transacional falhando após aceite da Meta (item obrigatório)', () => {
  test('confirm retorna CONFLICT_DIFFERENT_WAMID -> 500 CONFIRMATION_CONFLICT, nunca reportado como sucesso simples', async () => {
    const { deps } = makeDeps({
      serviceClient: makeFakeServiceClient({
        rpcOverrides: {
          confirm_whatsapp_outbound_sent: () => ({ data: [{ outcome: 'CONFLICT_DIFFERENT_WAMID', lead_interaction_id: 'int-original' }], error: null }),
        },
      }),
    });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).outcome).toBe('CONFIRMATION_CONFLICT');
  });

  test('confirm falha por erro de transporte (REPOSITORY_ERROR) na 1a tentativa mas sucede na 2a -> retry seguro, 200 ACCEPTED', async () => {
    let calls = 0;
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        confirm_whatsapp_outbound_sent: () => {
          calls += 1;
          if (calls === 1) return { data: null, error: new Error('transport blip') };
          return { data: [{ outcome: 'CONFIRMED', lead_interaction_id: 'int-1' }], error: null };
        },
      },
    });
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).outcome).toBe('ACCEPTED');
    expect(calls).toBe(2);
  });

  test('confirm falha por erro de transporte em TODAS as tentativas -> 500 CONFIRMATION_UNCERTAIN_RETRY_EXHAUSTED, preserva externalMessageId para reconciliacao', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        confirm_whatsapp_outbound_sent: () => ({ data: null, error: new Error('transport down') }),
      },
    });
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.outcome).toBe('CONFIRMATION_UNCERTAIN_RETRY_EXHAUSTED');
    expect(body.externalMessageId).toBe('wamid.ABC123');
    const confirmCalls = serviceClient._rpcCalls.filter((c) => c.fn === 'confirm_whatsapp_outbound_sent');
    expect(confirmCalls).toHaveLength(3);
  });
});

describe('handleWhatsappSendRequest — ausência de vazamento de dados sensíveis (item obrigatório)', () => {
  test('nenhuma resposta, em NENHUM cenario testado acima, contem o access token', async () => {
    const scenarios: Array<() => Promise<void>> = [
      async () => { await handleWhatsappSendRequest(makeRequest(VALID_BODY), makeDeps().deps); },
      async () => { await handleWhatsappSendRequest(makeRequest(VALID_BODY), makeDeps({ sendGraphMessage: async () => ({ outcome: 'UNCERTAIN', reason: 'timeout', httpStatus: null }) }).deps); },
      async () => { await handleWhatsappSendRequest(makeRequest(VALID_BODY), makeDeps({ sendGraphMessage: async () => ({ outcome: 'REJECTED_DEFINITIVE', errorCode: '1', httpStatus: 400 }) }).deps); },
      async () => { await handleWhatsappSendRequest(makeRequest(VALID_BODY), makeDeps({ getMetaCredentials: () => null }).deps); },
    ];

    for (const scenario of scenarios) {
      // eslint-disable-next-line no-await-in-loop
      await scenario();
    }

    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.body).not.toContain(SECRET_TOKEN);
  });

  test('conteudo da mensagem nunca aparece na resposta HTTP', async () => {
    const distinctiveContent = 'CONTEUDO_SENSIVEL_NUNCA_DEVE_APARECER_NA_RESPOSTA';
    const { deps } = makeDeps();
    const response = await handleWhatsappSendRequest(makeRequest({ ...VALID_BODY, content: distinctiveContent }), deps);
    expect(response.body).not.toContain(distinctiveContent);
  });
});

describe('handleWhatsappSendRequest — erros internos fail-closed', () => {
  test('erro REPOSITORY_ERROR no reserve -> 500 INTERNAL_ERROR', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => ({ data: null, error: new Error('boom') }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('erro REPOSITORY_ERROR no start_whatsapp_outbound_attempt_call -> 500 INTERNAL_ERROR, zero chamada a Meta', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        start_whatsapp_outbound_attempt_call: () => ({ data: null, error: new Error('boom') }),
      },
    });
    const { deps, sendGraphMessage } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    expect(sendGraphMessage).not.toHaveBeenCalled();
  });

  test('excecao inesperada em qualquer ponto -> 500 INTERNAL_ERROR, nunca propaga stack trace no corpo', async () => {
    const serviceClient = makeFakeServiceClient({
      rpcOverrides: {
        reserve_whatsapp_outbound_attempt: () => { throw new Error('unexpected throw'); },
      },
    });
    const { deps } = makeDeps({ serviceClient });
    const response = await handleWhatsappSendRequest(makeRequest(VALID_BODY), deps);
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('unexpected throw');
  });
});
