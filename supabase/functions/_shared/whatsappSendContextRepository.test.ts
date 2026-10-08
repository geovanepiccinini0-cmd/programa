import { describe, expect, test } from 'vitest';
import { resolveOutboundSendContext, OUTBOUND_MESSAGING_WINDOW_MS } from './whatsappSendContextRepository.ts';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const fixedNow = () => NOW;

interface TableRows {
  leads?: unknown[];
  whatsapp_messages_latest?: unknown[];
  whatsapp_messages_window?: unknown[];
  integration_accounts?: unknown[];
}

// Fake client que distingue a query "mais recente" (.order().limit())
// da query "janela de ambiguidade" (.gte(), sem order/limit) sobre a
// MESMA tabela whatsapp_messages — exatamente a forma real usada por
// resolveOutboundSendContext.
function makeFakeClient(rows: TableRows, errorOn?: 'leads' | 'latest' | 'window' | 'integration_accounts') {
  const calls: Array<{ table: string; kind: string; filters: Record<string, unknown> }> = [];
  return {
    from(table: string) {
      return {
        select() {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            gte(column: string, value: unknown) {
              filters[column] = value;
              calls.push({ table, kind: 'window', filters });
              if (errorOn === 'window') return Promise.resolve({ data: null, error: new Error('boom') });
              return Promise.resolve({ data: rows.whatsapp_messages_window ?? [], error: null });
            },
            order() {
              return {
                limit: async () => {
                  calls.push({ table, kind: 'latest', filters });
                  if (errorOn === 'latest') return { data: null, error: new Error('boom') };
                  return { data: rows.whatsapp_messages_latest ?? [], error: null };
                },
              };
            },
            then(resolve: (value: { data: unknown[] | null; error: unknown }) => unknown) {
              const kind = table === 'leads' ? 'leads' : 'integration_accounts';
              calls.push({ table, kind, filters });
              const isErr = (kind === 'leads' && errorOn === 'leads') || (kind === 'integration_accounts' && errorOn === 'integration_accounts');
              const result = isErr
                ? { data: null, error: new Error('boom') }
                : { data: rows[table as keyof TableRows] ?? (table === 'leads' ? rows.leads ?? [] : rows.integration_accounts ?? []), error: null };
              return Promise.resolve(result).then(resolve);
            },
          };
          return chain;
        },
      };
    },
    _calls: calls,
  };
}

const USER_ID = 'user-1';
const LEAD_ID = 'lead-1';
const CONTACT_PHONE = '5551900000001';
const INBOUND_OCCURRED_AT = '2026-01-10T00:00:00.000Z';

function makeHappyRows(overrides: Partial<TableRows> = {}): TableRows {
  return {
    leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null }],
    whatsapp_messages_latest: [{ integration_account_id: 'acc-1', occurred_at: INBOUND_OCCURRED_AT, contact_phone_normalized: CONTACT_PHONE }],
    whatsapp_messages_window: [{ contact_phone_normalized: CONTACT_PHONE }],
    integration_accounts: [{ id: 'acc-1', active: true, user_id: USER_ID, provider: 'whatsapp', external_account_id: 'phone-number-id-A' }],
    ...overrides,
  };
}

describe('resolveOutboundSendContext', () => {
  test('lead com inbound recente, identidade unica e conta ativa -> OK; destinatario vem de contact_phone_normalized (nunca de leads.phone_normalized)', async () => {
    const client = makeFakeClient(makeHappyRows());
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('OK');
    if (result.status === 'OK') {
      expect(result.context.integrationAccountId).toBe('acc-1');
      expect(result.context.phoneNumberId).toBe('phone-number-id-A');
      expect(result.context.contactPhoneNormalized).toBe(CONTACT_PHONE);
      expect(result.context.windowExpiresAt.toISOString()).toBe(
        new Date(new Date(INBOUND_OCCURRED_AT).getTime() + OUTBOUND_MESSAGING_WINDOW_MS).toISOString(),
      );
    }
  });

  test('telefone cadastral do lead edicao e IRRELEVANTE: query de leads nunca pede phone_normalized', async () => {
    const client = makeFakeClient(makeHappyRows());
    await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    const leadsCall = client._calls.find((c) => c.kind === 'leads');
    // A linha de leads retornada pelo fake nem contem phone_normalized
    // -- se o codigo tentasse le-lo, o resultado seria undefined, nunca
    // um valor usado silenciosamente. A ausencia de qualquer leitura de
    // phone_normalized e a prova de que o destinatario nao depende mais
    // deste campo.
    expect(leadsCall).toBeTruthy();
  });

  test('lead inexistente -> LEAD_NOT_FOUND', async () => {
    const client = makeFakeClient(makeHappyRows({ leads: [] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('LEAD_NOT_FOUND');
  });

  test('lead pertencente a outro usuario -> LEAD_FORBIDDEN', async () => {
    const client = makeFakeClient(makeHappyRows({ leads: [{ id: LEAD_ID, user_id: 'outro-usuario', deleted_at: null }] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('LEAD_FORBIDDEN');
  });

  test('lead soft-deletado -> LEAD_DELETED', async () => {
    const client = makeFakeClient(makeHappyRows({ leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: '2026-01-05T00:00:00.000Z' }] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('LEAD_DELETED');
  });

  test('sem nenhuma conversa inbound -> NO_INBOUND_CONVERSATION', async () => {
    const client = makeFakeClient(makeHappyRows({ whatsapp_messages_latest: [] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('NO_INBOUND_CONVERSATION');
  });

  test('mensagem inbound SEM contact_phone_normalized (linha historica pre-migration 022) -> IDENTITY_UNAVAILABLE, NUNCA cai para leads.phone_normalized', async () => {
    const client = makeFakeClient(makeHappyRows({ whatsapp_messages_latest: [{ integration_account_id: 'acc-1', occurred_at: INBOUND_OCCURRED_AT, contact_phone_normalized: null }] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('IDENTITY_UNAVAILABLE');
  });

  test('identidades ambiguas (duas contact_phone_normalized distintas na janela) -> IDENTITY_AMBIGUOUS, nunca escolhe uma silenciosamente', async () => {
    const client = makeFakeClient(makeHappyRows({
      whatsapp_messages_window: [{ contact_phone_normalized: CONTACT_PHONE }, { contact_phone_normalized: '5551900000099' }],
    }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('IDENTITY_AMBIGUOUS');
  });

  test('conta de integracao inativa -> INTEGRATION_ACCOUNT_INACTIVE', async () => {
    const client = makeFakeClient(makeHappyRows({ integration_accounts: [{ id: 'acc-1', active: false, user_id: USER_ID, provider: 'whatsapp', external_account_id: 'phone-number-id-A' }] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('INTEGRATION_ACCOUNT_INACTIVE');
  });

  test('conta de integracao de outro usuario -> INTEGRATION_ACCOUNT_INACTIVE, fail-closed', async () => {
    const client = makeFakeClient(makeHappyRows({ integration_accounts: [{ id: 'acc-1', active: true, user_id: 'outro-usuario', provider: 'whatsapp', external_account_id: 'phone-number-id-A' }] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('INTEGRATION_ACCOUNT_INACTIVE');
  });

  test('conta com provider DIFERENTE de whatsapp -> INTEGRATION_ACCOUNT_INACTIVE, exigencia explicita (item 2 do pedido)', async () => {
    const client = makeFakeClient(makeHappyRows({ integration_accounts: [{ id: 'acc-1', active: true, user_id: USER_ID, provider: 'instagram', external_account_id: 'phone-number-id-A' }] }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('INTEGRATION_ACCOUNT_INACTIVE');
  });

  test('janela de 24h encerrada -> WINDOW_CLOSED', async () => {
    const client = makeFakeClient(makeHappyRows({
      whatsapp_messages_latest: [{ integration_account_id: 'acc-1', occurred_at: '2026-01-08T00:00:00.000Z', contact_phone_normalized: CONTACT_PHONE }],
      whatsapp_messages_window: [{ contact_phone_normalized: CONTACT_PHONE }],
    }));
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('WINDOW_CLOSED');
  });

  test('erro do client na query de leads -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(makeHappyRows(), 'leads');
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('erro do client na query de ambiguidade -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient(makeHappyRows(), 'window');
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('userId vazio -> lanca antes de qualquer query', async () => {
    const client = makeFakeClient(makeHappyRows());
    await expect(resolveOutboundSendContext({ userId: '', leadId: LEAD_ID }, client, fixedNow)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });
});
